import { spawn, type ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { resolve } from 'node:path';

import { IncidentRemoteError } from '../../../domain/incident/IncidentRemoteError';
import { CloudIncidentRepository } from '../../../infrastructure/incidents/CloudIncidentRepository';
import { openOfflineStore, type OfflineStore } from '../../../infrastructure/persistence/openOfflineStore';
import { createTempDatabaseFile, type TempDatabaseFile } from '../../../infrastructure/persistence/testing/sqliteFixtures';
import { syncPendingOperations } from '../syncPendingOperations';

/**
 * Respuesta perdida (semana 9) contra el backend didáctico real (127.0.0.1, puerto libre).
 * jest-expo reemplaza `fetch`; se inyecta uno mínimo sobre node:http (igual que en la semana 5).
 */
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
    init.signal?.addEventListener('abort', () => {
      req.destroy();
      fail(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
    req.on('error', fail);
    if (typeof init.body === 'string') req.write(init.body);
    req.end();
  })) as unknown as typeof fetch;

const SERVER = resolve(__dirname, '../../../../course-backend/server.mjs');
const TOKEN = 'course-valid-token';
const noSleep = async () => undefined;

async function startBackend(): Promise<{ baseUrl: string; stop: () => void }> {
  const child: ChildProcess = spawn(process.execPath, [SERVER], {
    env: { ...process.env, COURSE_BACKEND_HOST: '127.0.0.1', COURSE_BACKEND_PORT: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const baseUrl = await new Promise<string>((done, fail) => {
    child.stdout!.on('data', (chunk: Buffer) => {
      const match = /listening at (http:\/\/[^\s]+)/.exec(chunk.toString());
      if (match) done(match[1]!);
    });
    child.once('exit', () => fail(new Error('el backend didáctico terminó antes de iniciar')));
  });
  return { baseUrl, stop: () => child.kill() };
}

let file: TempDatabaseFile;
let store: OfflineStore;

beforeEach(async () => {
  file = createTempDatabaseFile();
  store = await openOfflineStore(file.open());
});
afterEach(async () => {
  await store.close();
  file.remove();
});

type Detail = {
  version: number;
  status: string;
  payload: {
    history: { operationId: string; actorId: string; action: string }[];
    evidence: unknown[];
    notes: unknown[];
  };
};

async function detail(baseUrl: string): Promise<Detail> {
  const response = await nodeHttpFetch(`${baseUrl}/v1/incidents/campus-inc-001`, {
    headers: { Authorization: `Bearer ${TOKEN}`, 'X-Course-Actor': 'coordinator-1' } as Record<string, string>,
  });
  return JSON.parse(await response.text()) as Detail;
}

jest.setTimeout(30000);

describe('respuesta perdida tras guardar (backend real + cola SQLite real)', () => {
  let backend: Awaited<ReturnType<typeof startBackend>>;
  beforeAll(async () => { backend = await startBackend(); });
  afterAll(() => backend.stop());

  it('resolve: la operación sigue en la cola, se reenvía con la misma clave y no se duplica nada', async () => {
    const normal = new CloudIncidentRepository('technician-1', TOKEN, backend.baseUrl, { fetchImpl: nodeHttpFetch, sleep: noSleep });

    // campus-inc-001 empieza asignada: primero `start` (clave distinta) para que `resolve` sea válido.
    await normal.performAction('campus-inc-001', 'start', 1, {}, { idempotencyKey: 'op-start-0001' });

    const diagnosis = 'Cable de red flojo (dato ficticio)';
    await store.queue.enqueue({
      operationId: 'op-resolve-0001', incidentId: 'campus-inc-001',
      author: { actorId: 'technician-1', role: 'technician' },
      content: { action: 'resolve', note: null, photos: [], extra: { diagnosis } },
      baseVersion: 2, enqueuedAt: '2026-11-02T12:00:00.000Z',
    });

    // Intento 1: el servidor guarda pero responde tarde; el cliente aborta a los 300 ms.
    const slowTech = new CloudIncidentRepository('technician-1', TOKEN, backend.baseUrl, {
      fetchImpl: nodeHttpFetch, sleep: noSleep, timeoutMs: 300, maxAttempts: 1,
      extraHeaders: { 'X-Course-Scenario': 'timeout_after_commit' },
    });
    const first = await syncPendingOperations({ queue: store.queue, port: slowTech });
    expect(first.confirmed).toEqual([]);
    expect(first.pending).toEqual(['op-resolve-0001']);
    expect(await store.queue.list()).toHaveLength(1); // sin confirmación, sigue en la cola

    // Intento 2: misma operationId y mismo contenido → el servidor responde duplicate:true.
    const second = await syncPendingOperations({ queue: store.queue, port: normal });
    expect(second.confirmed).toEqual(['op-resolve-0001']);
    expect(await store.queue.list()).toHaveLength(0); // ahora sí sale de la cola

    // Un solo efecto en el servidor.
    const remote = await detail(backend.baseUrl);
    expect(remote.status).toBe('resolved');
    expect(remote.version).toBe(3); // start (2) + resolve (3), no 4
    expect(remote.payload.history.filter((h) => h.operationId === 'op-resolve-0001')).toHaveLength(1);
    expect(remote.payload.evidence).toHaveLength(0);
    expect(remote.payload.notes).toHaveLength(0);
  });

  it('misma clave con contenido distinto → 409 y no se trata como éxito', async () => {
    const normal = new CloudIncidentRepository('technician-1', TOKEN, backend.baseUrl, { fetchImpl: nodeHttpFetch, sleep: noSleep });
    const before = await detail(backend.baseUrl);

    const outcome = await normal
      .performAction('campus-inc-001', 'resolve', 2, { diagnosis: 'Otro diagnóstico distinto' }, { idempotencyKey: 'op-resolve-0001' })
      .then(() => 'sin error', (error: unknown) => (error instanceof IncidentRemoteError ? error.failure : error));

    expect(outcome).not.toBe('sin error');
    expect(outcome).toMatchObject({ kind: 'http', status: 409 });

    const after = await detail(backend.baseUrl);
    expect(after.version).toBe(before.version);
    expect(after.payload.history).toHaveLength(before.payload.history.length);
  });
});
