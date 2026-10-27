import { spawn, type ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { resolve } from 'node:path';

import { IncidentRemoteError } from '../../../domain/incident/IncidentRemoteError';
import { CloudIncidentRepository } from '../../../infrastructure/incidents/CloudIncidentRepository';
import { openOfflineStore, type OfflineStore } from '../../../infrastructure/persistence/openOfflineStore';
import { createTempDatabaseFile, type TempDatabaseFile } from '../../../infrastructure/persistence/testing/sqliteFixtures';
import { performOrEnqueue, withLocalCache } from '../performOrEnqueue';
import { syncPendingOperations } from '../syncPendingOperations';

/**
 * Escenarios de la semana 8 contra el backend didáctico real (127.0.0.1, puerto libre).
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

// Cola REAL (SQLite en un archivo temporal), como la que usa la app.
beforeEach(async () => {
  file = createTempDatabaseFile();
  store = await openOfflineStore(file.open());
});
afterEach(async () => {
  await store.close();
  file.remove();
});

async function detail(baseUrl: string) {
  const response = await nodeHttpFetch(`${baseUrl}/v1/incidents/campus-inc-001`, {
    headers: { Authorization: `Bearer ${TOKEN}`, 'X-Course-Actor': 'coordinator-1' } as Record<string, string>,
  });
  return JSON.parse(await response.text()) as {
    version: number;
    payload: { assignedTechnicianId: string; history: { operationId: string; actorId: string; action: string }[] };
  };
}

jest.setTimeout(30000);

describe('reasignación concurrente (backend real + cola SQLite real)', () => {
  let backend: Awaited<ReturnType<typeof startBackend>>;
  beforeAll(async () => { backend = await startBackend(); });
  afterAll(() => backend.stop());

  it('técnico sin conexión + reasignación remota → conflicto, sin sobrescribir ni perder nada', async () => {
    let online = true;
    const flakyFetch = ((url: string, init?: RequestInit) =>
      online ? nodeHttpFetch(url, init) : Promise.reject(new TypeError('Network request failed'))) as typeof fetch;

    const tech = new CloudIncidentRepository('technician-1', TOKEN, backend.baseUrl, { fetchImpl: flakyFetch, sleep: noSleep });
    const coordinator = new CloudIncidentRepository('coordinator-1', TOKEN, backend.baseUrl, { fetchImpl: nodeHttpFetch, sleep: noSleep });
    const actor = { actorId: 'technician-1', role: 'technician' } as const;
    const port = withLocalCache(tech, store.incidents);

    // 1. El técnico ve campus-inc-001 (versión 1, asignada a él): queda en la copia local. Luego pierde la conexión.
    expect(await port.getWork('campus-inc-001')).toMatchObject({ version: 1, assignedTechnicianId: 'technician-1' });
    online = false;

    // 2. Inicia la atención sin red: la acción queda en la cola con baseVersion 1.
    const outcome = await performOrEnqueue({ port, queue: store.queue, incidents: store.incidents }, actor, 'campus-inc-001', 'start');
    expect(outcome.kind).toBe('queued');
    const operationId = (outcome as { operationId: string }).operationId;

    // La app se cierra y se vuelve a abrir: la operación sigue ahí con el mismo operationId.
    await store.close();
    store = await openOfflineStore(file.open());
    expect((await store.queue.list())[0]).toMatchObject({ operationId, baseVersion: 1, status: 'pending', content: { action: 'start' } });

    // 3. Mientras tanto, el coordinador reasigna a technician-2 (versión 2).
    await coordinator.performAction('campus-inc-001', 'assign', 1, { technicianId: 'technician-2' });

    // 4. Lo que el backend responde DE VERDAD al envío del técnico (se anota en el reporte).
    online = true;
    const observed = await tech
      .performAction('campus-inc-001', 'start', 1, {}, { idempotencyKey: 'op-observado-1' })
      .then(() => 'sin error', (error: unknown) => (error instanceof IncidentRemoteError ? JSON.stringify(error.failure) : String(error)));
    console.log(`BACKEND DEVUELVE EN LA REASIGNACIÓN: ${observed}`);

    // 5. La sincronización real: conflicto declarado, la operación permanece y nada remoto cambia.
    const report = await syncPendingOperations({
      queue: store.queue,
      port: tech,
      resolve: () => ({ kind: 'conflict', fields: ['work'] }), // se cambia por la lógica real (resolveSync) cuando el equipo la entregue
    });
    expect(report.conflicts).toHaveLength(1);
    expect((await store.queue.list())[0]).toMatchObject({
      operationId, status: 'conflict', baseVersion: 1, content: { action: 'start' }, conflict: { fields: ['work'] },
    });

    const remote = await detail(backend.baseUrl);
    expect(remote.payload.assignedTechnicianId).toBe('technician-2'); // la asignación remota no se sobrescribió
    expect(remote.version).toBe(2);
    expect(remote.payload.history.map((h) => h.action)).toEqual(['assign']); // el "start" local nunca se aplicó
    expect(['{"kind":"http","status":403}', '{"kind":"http","status":409}']).toContain(observed);
  });
});

describe('operación repetida con timeout_after_commit (backend real + cola SQLite real)', () => {
  let backend: Awaited<ReturnType<typeof startBackend>>;
  beforeAll(async () => { backend = await startBackend(); });
  afterAll(() => backend.stop());

  it('misma clave reenviada → un solo efecto en el historial; lo no confirmado sigue pendiente', async () => {
    await store.queue.enqueue({
      operationId: 'op-idempotente-0001', incidentId: 'campus-inc-001',
      author: { actorId: 'technician-1', role: 'technician' },
      content: { action: 'start', note: null, photos: [], extra: {} },
      baseVersion: 1, enqueuedAt: '2026-10-26T12:00:00.000Z',
    });

    // Intento 1: el servidor confirma pero responde tarde; el cliente (300 ms) se rinde por timeout.
    const slowTech = new CloudIncidentRepository('technician-1', TOKEN, backend.baseUrl, {
      fetchImpl: nodeHttpFetch, sleep: noSleep, timeoutMs: 300, maxAttempts: 1,
      extraHeaders: { 'X-Course-Scenario': 'timeout_after_commit' },
    });
    const first = await syncPendingOperations({ queue: store.queue, port: slowTech });
    expect(first.pending).toEqual(['op-idempotente-0001']);
    expect(await store.queue.list()).toHaveLength(1); // sin confirmación del cliente, sigue en la cola

    // Intento 2: misma operación, misma clave, red normal → el servidor responde duplicate:true.
    const tech = new CloudIncidentRepository('technician-1', TOKEN, backend.baseUrl, { fetchImpl: nodeHttpFetch, sleep: noSleep });
    const second = await syncPendingOperations({ queue: store.queue, port: tech });
    expect(second.confirmed).toEqual(['op-idempotente-0001']);
    expect(await store.queue.list()).toHaveLength(0);

    // Un solo efecto: una sola entrada con ese operationId y versión 2 (no 3).
    const remote = await detail(backend.baseUrl);
    expect(remote.payload.history.filter((h) => h.operationId === 'op-idempotente-0001')).toHaveLength(1);
    expect(remote.version).toBe(2);
  });
});
