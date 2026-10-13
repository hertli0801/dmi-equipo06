import { createTelemetry, type TelemetryEntry } from '../../../application/telemetry/Telemetry';
import type { AuthEvent } from '../../../course-evaluation/contracts';
import { SessionCoordinator, type SessionStore } from '../SessionCoordinator';

/** Ciclo de vida de la sesión con reloj controlable: expiración, refresh obsoleto y logout. */
function reply(status: number, body: unknown): Response {
  return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) } as unknown as Response;
}

function memoryStore() {
  let token: string | null = null;
  const writes: (string | null)[] = [];
  const store: SessionStore = {
    save: async (value) => {
      token = value;
      writes.push(value);
    },
    read: async () => token,
    clear: async () => {
      token = null;
      writes.push(null);
    },
  };
  return { store, current: () => token, writes };
}

/** Reloj manual: el tiempo sólo avanza cuando la prueba lo pide. */
function manualClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => void (now += ms) };
}

/** Respuesta que la prueba libera cuando quiere, para simular un refresh lento. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

const LOGIN_OK = { actorId: 'technician-1', role: 'technician', accessToken: 'course-valid-token', refreshToken: 'course-refresh-0', expiresIn: 60 };
const REFRESH_OK = { accessToken: 'course-valid-token-2', refreshToken: 'course-refresh-1', expiresIn: 60 };

function build(handler: (path: string) => Promise<Response>) {
  const calls: string[] = [];
  const events: AuthEvent[] = [];
  const memory = memoryStore();
  const clock = manualClock();
  const onSessionExpired = jest.fn();
  const coordinator = new SessionCoordinator({
    baseUrl: 'http://stub.invalid',
    fetchImpl: ((url: string) => {
      const path = url.replace('http://stub.invalid', '');
      calls.push(path);
      return handler(path);
    }) as unknown as typeof fetch,
    store: memory.store,
    now: clock.now,
    onSessionExpired,
    onEvent: (event) => events.push(event),
  });
  const refreshCalls = () => calls.filter((path) => path === '/v1/session/refresh').length;
  return { coordinator, calls, events, memory, clock, onSessionExpired, refreshCalls };
}

describe('SessionCoordinator — expiración con reloj controlable', () => {
  test('auth-01 login válido: sesión vigente durante expiresIn', async () => {
    const { coordinator, clock } = build(async () => reply(200, LOGIN_OK));
    await coordinator.login('technician-1');
    expect(coordinator.isExpired()).toBe(false);
    clock.advance(59_999);
    expect(coordinator.isExpired()).toBe(false);
  });

  test('auth-02 límite exacto: a los 60 s el access token se considera expirado', async () => {
    const { coordinator, clock } = build(async () => reply(200, LOGIN_OK));
    await coordinator.login('technician-1');
    clock.advance(60_000);
    expect(coordinator.isExpired()).toBe(true);
  });

  test('auth-03 un refresh exitoso reinicia la ventana de expiración desde el reloj actual', async () => {
    const { coordinator, clock } = build(async (path) =>
      path === '/v1/session/login' ? reply(200, LOGIN_OK) : reply(200, REFRESH_OK),
    );
    await coordinator.login('technician-1');
    clock.advance(60_000);
    await coordinator.refresh(coordinator.getGeneration(), 'a');
    expect(coordinator.isExpired()).toBe(false);
    clock.advance(59_999);
    expect(coordinator.isExpired()).toBe(false);
    clock.advance(1);
    expect(coordinator.isExpired()).toBe(true);
  });

  test('auth-04 sin sesión no hay nada que expire ni renovar', () => {
    const { coordinator, refreshCalls } = build(async () => reply(200, LOGIN_OK));
    expect(coordinator.isExpired()).toBe(false);
    expect(refreshCalls()).toBe(0);
  });
});

describe('SessionCoordinator — refresh obsoleto y logout', () => {
  test('auth-05 logout mientras un refresh está en vuelo: la respuesta tardía NO vuelve a persistir tokens', async () => {
    const slowRefresh = deferred<Response>();
    const { coordinator, memory, onSessionExpired } = build((path) =>
      path === '/v1/session/login' ? Promise.resolve(reply(200, LOGIN_OK)) : slowRefresh.promise,
    );
    await coordinator.login('technician-1');
    const pending = coordinator.refresh(coordinator.getGeneration(), 'a');

    await coordinator.logout();
    slowRefresh.resolve(reply(200, REFRESH_OK));

    await expect(pending).resolves.toBeNull();
    expect(memory.current()).toBeNull();
    expect(coordinator.getAccessToken()).toBeNull();
    expect(coordinator.getSession()).toBeNull();
    expect(onSessionExpired).not.toHaveBeenCalled();
  });

  test('auth-06 refresh fallido obsoleto (de antes de un nuevo login) no cierra la sesión nueva', async () => {
    const slowRefresh = deferred<Response>();
    const { coordinator, memory, onSessionExpired } = build((path) =>
      path === '/v1/session/login' ? Promise.resolve(reply(200, LOGIN_OK)) : slowRefresh.promise,
    );
    await coordinator.login('technician-1');
    const stale = coordinator.refresh(coordinator.getGeneration(), 'viejo');

    await coordinator.logout();
    await coordinator.login('technician-1');
    slowRefresh.resolve(reply(401, { code: 'invalid_grant' }));

    await expect(stale).resolves.toBeNull();
    expect(coordinator.getSession()).toEqual({ actorId: 'technician-1', role: 'technician' });
    expect(coordinator.getAccessToken()).toBe('course-valid-token');
    expect(memory.current()).toBe('course-refresh-0');
    expect(onSessionExpired).not.toHaveBeenCalled();
  });

  test('auth-07 refresh token rotado/obsoleto: el servidor lo rechaza, se limpia la sesión una sola vez', async () => {
    const { coordinator, memory, onSessionExpired, refreshCalls } = build(async (path) =>
      path === '/v1/session/login' ? reply(200, LOGIN_OK) : reply(401, { code: 'invalid_grant' }),
    );
    await coordinator.login('technician-1');
    const generation = coordinator.getGeneration();

    await expect(coordinator.refresh(generation, 'a')).resolves.toBeNull();
    await expect(coordinator.refresh(generation, 'b')).resolves.toBeNull();

    expect(refreshCalls()).toBe(1);
    expect(memory.current()).toBeNull();
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });

  test('auth-08 logout: no queda token persistido ni en memoria, y un 401 posterior no dispara refresh', async () => {
    const { coordinator, memory, refreshCalls } = build(async () => reply(200, LOGIN_OK));
    await coordinator.login('technician-1');
    expect(memory.current()).toBe('course-refresh-0');

    await coordinator.logout();

    expect(memory.current()).toBeNull();
    expect(memory.writes.at(-1)).toBeNull();
    expect(coordinator.getAccessToken()).toBeNull();
    expect(coordinator.isExpired()).toBe(false);
    await expect(coordinator.refresh(coordinator.getGeneration(), 'tarde')).resolves.toBeNull();
    expect(refreshCalls()).toBe(0);
  });
});

describe('Tokens fuera de logs y eventos', () => {
  test('auth-09 los eventos de sesión y la telemetría del ciclo completo no contienen tokens', async () => {
    const entries: TelemetryEntry[] = [];
    const telemetry = createTelemetry({ write: (entry) => entries.push(entry) });
    const { coordinator, events } = build(async (path) =>
      path === '/v1/session/login' ? reply(200, LOGIN_OK) : reply(200, REFRESH_OK),
    );
    const consoleSpies = (['log', 'info', 'warn', 'error'] as const).map((method) =>
      jest.spyOn(console, method).mockImplementation(() => undefined),
    );

    await coordinator.login('technician-1');
    await coordinator.refresh(coordinator.getGeneration(), 'a');
    telemetry.error('session.refresh_failed', new Error('401 con Authorization: Bearer course-valid-token-2'), {
      accessToken: coordinator.getAccessToken(),
      refreshToken: 'course-refresh-1',
    });
    await coordinator.logout();

    const printed = JSON.stringify({ entries, events, console: consoleSpies.map((spy) => spy.mock.calls) });
    consoleSpies.forEach((spy) => spy.mockRestore());
    expect(printed).not.toMatch(/course-valid-token|course-refresh-\d/);
  });
});
