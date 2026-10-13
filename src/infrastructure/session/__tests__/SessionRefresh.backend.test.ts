import { spawn, type ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { resolve } from 'node:path';

import { performIncidentAction } from '../../../application/incidents/performIncidentAction';
import { ForbiddenActionError } from '../../../domain/incident/IncidentPermissions';
import type { SessionPort } from '../../../domain/session/SessionPort';
import { CloudIncidentRepository } from '../../incidents/CloudIncidentRepository';
import { SessionCoordinator, type SessionStore } from '../SessionCoordinator';

/** Flujo completo contra el backend didáctico local: login → 401 → refresh → reintento → acciones por rol. */
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

function newCoordinator() {
  let token: string | null = null;
  const store: SessionStore = {
    save: async (value) => void (token = value),
    read: async () => token,
    clear: async () => void (token = null),
  };
  return new SessionCoordinator({ baseUrl, fetchImpl: nodeHttpFetch, store });
}

/** Simula un access token caducado: el primer uso va con un token inválido y el backend responde 401. */
function withExpiredToken(real: SessionCoordinator) {
  let refreshes = 0;
  const session: SessionPort = {
    getAccessToken: () => (refreshes === 0 ? 'token-caducado' : real.getAccessToken()),
    getGeneration: () => real.getGeneration(),
    refresh: async (generation, requestId) => {
      refreshes += 1;
      return real.refresh(generation, requestId);
    },
  };
  return { session, refreshes: () => refreshes };
}

describe('Sesión real contra el backend didáctico', () => {
  test('401 por token caducado → refresh real → reintento exitoso', async () => {
    const coordinator = newCoordinator();
    const { actorId } = await coordinator.login('reporter-1');
    const { session, refreshes } = withExpiredToken(coordinator);
    const repo = new CloudIncidentRepository(actorId, 'x', baseUrl, { fetchImpl: nodeHttpFetch, session });

    await expect(repo.getAll()).resolves.toHaveLength(1);
    expect(refreshes()).toBe(1);
    expect(coordinator.getAccessToken()).toBe('course-valid-token');
  });

  test('técnico asignado inicia la incidencia; técnico no asignado queda rechazado', async () => {
    const tech1 = newCoordinator();
    const s1 = await tech1.login('technician-1');
    const repo1 = new CloudIncidentRepository(s1.actorId, 'x', baseUrl, { fetchImpl: nodeHttpFetch, session: tech1 });
    await expect(performIncidentAction(repo1, s1, 'campus-inc-001', 'start')).resolves.toMatchObject({ estado: 'in_progress' });

    const tech2 = newCoordinator();
    const s2 = await tech2.login('technician-2');
    const repo2 = new CloudIncidentRepository(s2.actorId, 'x', baseUrl, { fetchImpl: nodeHttpFetch, session: tech2 });
    await expect(performIncidentAction(repo2, s2, 'campus-inc-001', 'resolve', { diagnosis: 'x' })).rejects.toBeInstanceOf(
      ForbiddenActionError,
    );
  });
});