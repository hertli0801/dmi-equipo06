import { coordinateRefresh } from '../../../course-evaluation';
import type { AuthEvent } from '../../../course-evaluation/contracts';
import { IncidentRemoteError } from '../../../domain/incident/IncidentRemoteError';
import { SessionCoordinator, type SessionStore } from '../../session/SessionCoordinator';
import { CloudIncidentRepository } from '../CloudIncidentRepository';

/**
 * Cliente real + SessionCoordinator real, con un fetch simulado que cuenta llamadas.
 * Las peticiones concurrentes que reciben 401 deben compartir UN refresh y reintentar una sola vez.
 */
const DTO = { id: 'campus-inc-001', version: 1, status: 'assigned', payload: { category: 'connectivity', description: 'Sin red', location: 'A', assignedTechnicianId: 'technician-1' } };
const LOGIN_OK = { actorId: 'technician-1', role: 'technician', accessToken: 'course-valid-token', refreshToken: 'course-refresh-0', expiresIn: 60 };
const REFRESH_OK = { accessToken: 'course-valid-token-2', refreshToken: 'course-refresh-1', expiresIn: 60 };

function reply(status: number, body: unknown): Response {
  return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, text: async () => JSON.stringify(body) } as unknown as Response;
}

type Backend = Readonly<{
  /** Token que el backend acepta en este momento. */
  validToken: () => string;
  refresh: () => Promise<Response>;
}>;

function setup(backend: Backend) {
  let stored: string | null = null;
  const store: SessionStore = {
    save: async (value) => void (stored = value),
    read: async () => stored,
    clear: async () => void (stored = null),
  };
  let now = 1_000_000;
  const events: AuthEvent[] = [];
  const log = { refresh: 0, incidents: 0, authorization: [] as string[] };
  const onSessionExpired = jest.fn();

  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const path = url.replace('http://stub.invalid', '');
    if (path === '/v1/session/login') return reply(200, LOGIN_OK);
    if (path === '/v1/session/refresh') {
      log.refresh += 1;
      return backend.refresh();
    }
    log.incidents += 1;
    const authorization = (init.headers as Record<string, string>).Authorization!;
    log.authorization.push(authorization);
    if (authorization !== `Bearer ${backend.validToken()}`) return reply(401, { code: 'unauthorized' });
    return path === '/v1/incidents' ? reply(200, { items: [DTO] }) : reply(200, DTO);
  }) as unknown as typeof fetch;

  const coordinator = new SessionCoordinator({
    baseUrl: 'http://stub.invalid',
    fetchImpl,
    store,
    now: () => now,
    onSessionExpired,
    onEvent: (event) => events.push(event),
  });
  const repository = new CloudIncidentRepository('technician-1', '', 'http://stub.invalid', {
    fetchImpl,
    session: coordinator,
    sleep: async () => {},
  });
  return {
    coordinator,
    repository,
    events,
    log,
    onSessionExpired,
    stored: () => stored,
    advance: (ms: number) => void (now += ms),
  };
}

describe('Concurrencia de 401 — cliente real con SessionCoordinator', () => {
  test('cc-01 tres peticiones con 401 simultáneo comparten UN refresh y cada una reintenta una vez', async () => {
    let valid = 'course-valid-token';
    const ctx = setup({
      validToken: () => valid,
      refresh: async () => reply(200, REFRESH_OK),
    });
    await ctx.coordinator.login('technician-1');
    valid = 'course-valid-token-2'; // el servidor invalida el token actual: todas reciben 401

    const results = await Promise.all([
      ctx.repository.getAll(),
      ctx.repository.getById('campus-inc-001'),
      ctx.repository.getAll(),
    ]);

    expect(results[0]).toHaveLength(1);
    expect(results[1]).toMatchObject({ id: 'campus-inc-001' });
    expect(ctx.log.refresh).toBe(1);
    expect(ctx.log.incidents).toBe(6); // 3 intentos + 3 reintentos, ni uno más
    expect(ctx.log.authorization.filter((value) => value === 'Bearer course-valid-token-2')).toHaveLength(3);
    expect(coordinateRefresh(ctx.events)).toMatchObject({
      status: 'authenticated',
      refreshCalls: 1,
      retriedRequestIds: ['req-1', 'req-2', 'req-3'],
    });
  });

  test('cc-02 cinco peticiones concurrentes: sigue habiendo un solo refresh', async () => {
    let valid = 'course-valid-token';
    const ctx = setup({ validToken: () => valid, refresh: async () => reply(200, REFRESH_OK) });
    await ctx.coordinator.login('technician-1');
    valid = 'course-valid-token-2';

    await Promise.all(Array.from({ length: 5 }, () => ctx.repository.getAll()));

    expect(ctx.log.refresh).toBe(1);
    expect(ctx.log.incidents).toBe(10);
  });

  test('cc-03 refresh fallido con 3 peticiones en espera: todas terminan en 401, sesión limpia, sin bucle', async () => {
    const ctx = setup({
      validToken: () => 'otro-token',
      refresh: async () => reply(401, { code: 'invalid_grant' }),
    });
    await ctx.coordinator.login('technician-1');

    const outcomes = await Promise.allSettled([
      ctx.repository.getAll(),
      ctx.repository.getById('campus-inc-001'),
      ctx.repository.getAll(),
    ]);

    for (const outcome of outcomes) {
      expect(outcome.status).toBe('rejected');
      const reason = (outcome as PromiseRejectedResult).reason as IncidentRemoteError;
      expect(reason).toBeInstanceOf(IncidentRemoteError);
      expect(reason.failure).toEqual({ kind: 'http', status: 401 });
    }
    expect(ctx.log.refresh).toBe(1);
    expect(ctx.log.incidents).toBe(3); // nadie reintenta con un refresh fallido
    expect(ctx.onSessionExpired).toHaveBeenCalledTimes(1);
    expect(ctx.stored()).toBeNull();
    expect(ctx.coordinator.getSession()).toBeNull();
    expect(coordinateRefresh(ctx.events)).toMatchObject({ status: 'anonymous', refreshCalls: 1, persistedToken: null });

    // Una petición posterior ya no intenta renovar: falla directo con 401.
    await expect(ctx.repository.getAll()).rejects.toMatchObject({ failure: { kind: 'http', status: 401 } });
    expect(ctx.log.refresh).toBe(1);
  });

  test('cc-04 el reintento que vuelve a recibir 401 no provoca otro refresh (reintentos limitados)', async () => {
    const ctx = setup({
      validToken: () => 'nunca-coincide',
      refresh: async () => reply(200, REFRESH_OK),
    });
    await ctx.coordinator.login('technician-1');

    const outcomes = await Promise.allSettled([ctx.repository.getAll(), ctx.repository.getAll(), ctx.repository.getAll()]);

    expect(outcomes.every((outcome) => outcome.status === 'rejected')).toBe(true);
    expect(ctx.log.refresh).toBe(1);
    expect(ctx.log.incidents).toBe(6); // cada petición: 1 intento + 1 reintento
  });

  test('cc-05 expiración por reloj: peticiones concurrentes renuevan antes de enviar, un solo refresh y cero 401', async () => {
    const ctx = setup({ validToken: () => 'course-valid-token-2', refresh: async () => reply(200, REFRESH_OK) });
    await ctx.coordinator.login('technician-1');
    ctx.advance(60_000);

    await Promise.all([ctx.repository.getAll(), ctx.repository.getAll(), ctx.repository.getById('campus-inc-001')]);

    expect(ctx.log.refresh).toBe(1);
    expect(ctx.log.incidents).toBe(3);
    expect(ctx.log.authorization).toEqual(Array(3).fill('Bearer course-valid-token-2'));
  });

  test('cc-06 una petición que llega tarde con la generación vieja reutiliza el token nuevo sin otro refresh', async () => {
    let valid = 'course-valid-token';
    const ctx = setup({ validToken: () => valid, refresh: async () => reply(200, REFRESH_OK) });
    await ctx.coordinator.login('technician-1');
    const oldGeneration = ctx.coordinator.getGeneration();
    valid = 'course-valid-token-2';

    await ctx.repository.getAll();
    await expect(ctx.coordinator.refresh(oldGeneration, 'tarde')).resolves.toBe('course-valid-token-2');

    expect(ctx.log.refresh).toBe(1);
  });
});
