import { spawn, type ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { resolve } from 'node:path';

import { CloudIncidentRepository } from '../../incidents/CloudIncidentRepository';
import { SessionCoordinator, type SessionStore } from '../SessionCoordinator';

/** Concurrencia y refresh obsoleto contra el backend didáctico local (127.0.0.1, puerto libre). */
const nodeHttpFetch = ((url: string, init: RequestInit = {}) =>
  new Promise<Response>((done, fail) => {
    const req = request(url, { method: init.method ?? 'GET', headers: init.headers as Record<string, string> }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', fail);
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        done({
          status,
          ok: status >= 200 && status < 300,
          headers: { get: (name: string) => (res.headers[name.toLowerCase()] as string | undefined) ?? null },
          text: async () => Buffer.concat(chunks).toString('utf8'),
        } as unknown as Response);
      });
    });
    req.on('error', fail);
    if (typeof init.body === 'string') req.write(init.body);
    req.end();
  })) as unknown as typeof fetch;

const SERVER = resolve(__dirname, '../../../../course-backend/server.mjs');
let backend: ChildProcess;
let baseUrl: string;

beforeAll(async () => {
  backend = spawn(process.execPath, [SERVER], {
    env: { ...process.env, COURSE_BACKEND_HOST: '127.0.0.1', COURSE_BACKEND_PORT: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  baseUrl = await new Promise<string>((done, fail) => {
    backend.stdout!.on('data', (chunk: Buffer) => {
      const match = /listening at (http:\/\/[^\s]+)/.exec(chunk.toString());
      if (match) done(match[1]!);
    });
    backend.once('exit', () => fail(new Error('el backend didáctico terminó antes de iniciar')));
  });
});

afterAll(() => {
  backend?.kill();
});

function setup() {
  let stored: string | null = null;
  const store: SessionStore = {
    save: async (value) => void (stored = value),
    read: async () => stored,
    clear: async () => void (stored = null),
  };
  let now = 1_000_000;
  const paths: string[] = [];
  const countingFetch = ((url: string, init?: RequestInit) => {
    paths.push(new URL(url).pathname);
    return nodeHttpFetch(url, init);
  }) as unknown as typeof fetch;
  const onSessionExpired = jest.fn();
  const coordinator = new SessionCoordinator({ baseUrl, fetchImpl: countingFetch, store, now: () => now, onSessionExpired });
  return {
    coordinator,
    onSessionExpired,
    stored: () => stored,
    advance: (ms: number) => void (now += ms),
    count: (path: string) => paths.filter((value) => value === path).length,
    repository: (actorId: string) =>
      new CloudIncidentRepository(actorId, '', baseUrl, { fetchImpl: countingFetch, session: coordinator }),
  };
}

describe('Sesión concurrente contra el backend didáctico', () => {
  test('be-01 a los 60 s, tres peticiones simultáneas usan UN refresh real y todas responden', async () => {
    const ctx = setup();
    const { actorId } = await ctx.coordinator.login('reporter-1');
    const repo = ctx.repository(actorId);
    ctx.advance(60_000);

    const results = await Promise.all([repo.getAll(), repo.getAll(), repo.getAll()]);

    expect(results.map((items) => items.length)).toEqual([1, 1, 1]);
    expect(ctx.count('/v1/session/refresh')).toBe(1);
    expect(ctx.stored()).toBe('course-refresh-1');
  });

  test('be-02 refresh token rotado (obsoleto): el backend responde invalid_grant y la app vuelve a no autenticado', async () => {
    const ctx = setup();
    const { actorId } = await ctx.coordinator.login('reporter-1');
    const repo = ctx.repository(actorId);

    ctx.advance(60_000);
    await repo.getAll(); // consume course-refresh-0 → course-refresh-1
    ctx.advance(60_000);
    const outcomes = await Promise.allSettled([repo.getAll(), repo.getAll(), repo.getAll()]);

    expect(outcomes.every((outcome) => outcome.status === 'rejected')).toBe(true);
    expect(ctx.count('/v1/session/refresh')).toBe(2);
    expect(ctx.onSessionExpired).toHaveBeenCalledTimes(1);
    expect(ctx.stored()).toBeNull();
    expect(ctx.coordinator.getSession()).toBeNull();
  });

  test('be-03 logout real: no queda refresh token guardado y la siguiente petición no renueva', async () => {
    const ctx = setup();
    const { actorId } = await ctx.coordinator.login('coordinator-1');
    const repo = ctx.repository(actorId);
    await expect(repo.getAll()).resolves.toBeDefined();

    await ctx.coordinator.logout();

    expect(ctx.stored()).toBeNull();
    await expect(repo.getAll()).rejects.toMatchObject({ failure: { kind: 'http', status: 401 } });
    expect(ctx.count('/v1/session/refresh')).toBe(0);
  });
});
