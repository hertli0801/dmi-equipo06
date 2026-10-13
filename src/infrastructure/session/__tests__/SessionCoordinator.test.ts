import { coordinateRefresh } from '../../../course-evaluation';
import type { AuthEvent } from '../../../course-evaluation/contracts';
import { SessionCoordinator, type SessionStore } from '../SessionCoordinator';

function reply(status: number, body: unknown): Response {
  return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) } as unknown as Response;
}

function memoryStore(initial: string | null = null) {
  let token = initial;
  const store: SessionStore = {
    save: async (value) => void (token = value),
    read: async () => token,
    clear: async () => void (token = null),
  };
  return { store, current: () => token };
}

const LOGIN_OK = { actorId: 'technician-1', role: 'technician', accessToken: 'course-valid-token', refreshToken: 'course-refresh-0', expiresIn: 60 };
const REFRESH_OK = { accessToken: 'course-valid-token-2', refreshToken: 'course-refresh-1', expiresIn: 60 };

function build(handler: (path: string) => Promise<Response>) {
  const calls: string[] = [];
  const events: AuthEvent[] = [];
  const memory = memoryStore();
  const onSessionExpired = jest.fn();
  const coordinator = new SessionCoordinator({
    baseUrl: 'http://stub.invalid',
    fetchImpl: ((url: string) => {
      const path = url.replace('http://stub.invalid', '');
      calls.push(path);
      return handler(path);
    }) as unknown as typeof fetch,
    store: memory.store,
    onSessionExpired,
    onEvent: (event) => events.push(event),
  });
  return { coordinator, calls, events, memory, onSessionExpired };
}

describe('SessionCoordinator', () => {
  test('login guarda el refresh token y deja la sesión en memoria', async () => {
    const { coordinator, memory } = build(async () => reply(200, LOGIN_OK));
    const session = await coordinator.login('technician-1');
    expect(session).toEqual({ actorId: 'technician-1', role: 'technician' });
    expect(coordinator.getAccessToken()).toBe('course-valid-token');
    expect(memory.current()).toBe('course-refresh-0');
  });

  test('login con actor desconocido (401) lanza error y no deja sesión', async () => {
    const { coordinator } = build(async () => reply(401, { code: 'unknown_fixture_actor' }));
    await expect(coordinator.login('nadie')).rejects.toMatchObject({ failure: { kind: 'http', status: 401 } });
    expect(coordinator.getSession()).toBeNull();
  });

  test('3 peticiones con 401 en la misma generación disparan UN solo refresh', async () => {
    const { coordinator, calls, events } = build(async (path) =>
      path === '/v1/session/login' ? reply(200, LOGIN_OK) : reply(200, REFRESH_OK),
    );
    await coordinator.login('technician-1');
    const generation = coordinator.getGeneration();

    const results = await Promise.all([
      coordinator.refresh(generation, 'a'),
      coordinator.refresh(generation, 'b'),
      coordinator.refresh(generation, 'c'),
    ]);

    expect(results).toEqual(['course-valid-token-2', 'course-valid-token-2', 'course-valid-token-2']);
    expect(calls.filter((path) => path === '/v1/session/refresh')).toHaveLength(1);
    // Mismo resultado que el modelo de Lilia (coordinateRefresh) con los mismos eventos.
    expect(coordinateRefresh(events)).toMatchObject({ status: 'authenticated', refreshCalls: 1, retriedRequestIds: ['a', 'b', 'c'] });
  });

  test('una petición con generación vieja usa el token nuevo sin otro refresh', async () => {
    const { coordinator, calls } = build(async (path) =>
      path === '/v1/session/login' ? reply(200, LOGIN_OK) : reply(200, REFRESH_OK),
    );
    await coordinator.login('technician-1');
    const oldGeneration = coordinator.getGeneration();
    await coordinator.refresh(oldGeneration, 'a');
    await expect(coordinator.refresh(oldGeneration, 'late')).resolves.toBe('course-valid-token-2');
    expect(calls.filter((path) => path === '/v1/session/refresh')).toHaveLength(1);
  });

  test('refresh fallido: borra la sesión, avisa una vez y no vuelve a intentar (sin bucle)', async () => {
    const { coordinator, calls, memory, onSessionExpired } = build(async (path) =>
      path === '/v1/session/login' ? reply(200, LOGIN_OK) : reply(401, { code: 'invalid_grant' }),
    );
    await coordinator.login('technician-1');
    const generation = coordinator.getGeneration();

    const results = await Promise.all([coordinator.refresh(generation, 'a'), coordinator.refresh(generation, 'b')]);
    expect(results).toEqual([null, null]);
    expect(await coordinator.refresh(generation, 'c')).toBeNull();

    expect(calls.filter((path) => path === '/v1/session/refresh')).toHaveLength(1);
    expect(memory.current()).toBeNull();
    expect(coordinator.getAccessToken()).toBeNull();
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });

  test('logout borra el token persistido y la sesión', async () => {
    const { coordinator, memory } = build(async () => reply(200, LOGIN_OK));
    await coordinator.login('technician-1');
    await coordinator.logout();
    expect(memory.current()).toBeNull();
    expect(coordinator.getSession()).toBeNull();
    await expect(coordinator.refresh(coordinator.getGeneration(), 'x')).resolves.toBeNull();
  });
});