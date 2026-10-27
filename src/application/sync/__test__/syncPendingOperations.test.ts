import type { Incident } from '../../../domain/incident/Incident';
import { ForbiddenActionError, type IncidentActionsPort } from '../../../domain/incident/IncidentPermissions';
import { IncidentRemoteError, type IncidentRemoteFailure } from '../../../domain/incident/IncidentRemoteError';
import type { NewPendingOperation } from '../../../domain/sync/PendingOperation';
import { openOfflineStore, type OfflineStore } from '../../../infrastructure/persistence/openOfflineStore';
import { createTempDatabaseFile, type TempDatabaseFile } from '../../../infrastructure/persistence/testing/sqliteFixtures';
import { performOrEnqueue, withLocalCache } from '../performOrEnqueue';
import { syncPendingOperations } from '../syncPendingOperations';

/**
 * Se usa la cola REAL (SQLite sobre un archivo temporal) y un servidor simulado:
 * así se comprueba lo que de verdad queda guardado, también tras cerrar y reabrir la base.
 */
const INCIDENT: Incident = { id: 'campus-inc-001', categoria: 'connectivity', descripcion: 'sin red', estado: 'in_progress' };
const TECH = { actorId: 'technician-1', role: 'technician' } as const;
const fail = (failure: IncidentRemoteFailure) => new IncidentRemoteError(failure);
const conflictDecision = () => ({ kind: 'conflict' as const, fields: ['work'] });

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

const newOp = (operationId: string, overrides: Partial<NewPendingOperation> = {}): NewPendingOperation => ({
  operationId,
  incidentId: 'campus-inc-001',
  author: { actorId: 'technician-1', role: 'technician' },
  content: { action: 'start', note: null, photos: [], extra: {} },
  baseVersion: 1,
  enqueuedAt: '2026-10-26T12:00:00.000Z',
  ...overrides,
});

function portWith(
  performAction: IncidentActionsPort['performAction'],
  getWork?: IncidentActionsPort['getWork'],
): IncidentActionsPort {
  return {
    performAction,
    getWork: getWork ?? (async () => ({ version: 1, status: 'assigned', assignedTechnicianId: 'technician-1' })),
  };
}

describe('syncPendingOperations: qué pasa con cada respuesta del servidor', () => {
  it('confirmada: se retira de la cola y viaja con su operationId como Idempotency-Key', async () => {
    await store.queue.enqueue(newOp('op-aaaa0001'));
    const performAction = jest.fn(async () => INCIDENT);
    const report = await syncPendingOperations({ queue: store.queue, port: portWith(performAction) });
    expect(performAction).toHaveBeenCalledWith('campus-inc-001', 'start', 1, {}, { idempotencyKey: 'op-aaaa0001' });
    expect(report.confirmed).toEqual(['op-aaaa0001']);
    expect(await store.queue.list()).toHaveLength(0);
  });

  it.each([
    ['409', { kind: 'http', status: 409 } as const],
    ['403', { kind: 'http', status: 403 } as const],
  ])('%s: pasa a conflict, permanece en la cola y sobrevive a reiniciar la base', async (_name, failure) => {
    await store.queue.enqueue(newOp('op-aaaa0002'));
    const port = portWith(
      async () => { throw fail(failure); },
      async () => { throw fail({ kind: 'http', status: 403 }); }, // el técnico ya no puede ver la incidencia
    );
    const report = await syncPendingOperations({
      queue: store.queue, port, resolve: conflictDecision, now: () => new Date('2026-10-26T13:00:00.000Z'),
    });
    expect(report.conflicts).toEqual([{ operationId: 'op-aaaa0002', fields: ['work'] }]);

    await store.close();
    store = await openOfflineStore(file.open()); // "reinicio" de la app
    const [stored] = await store.queue.list();
    expect(stored).toMatchObject({
      operationId: 'op-aaaa0002', status: 'conflict', baseVersion: 1, content: { action: 'start' },
      conflict: { fields: ['work'], detectedAt: '2026-10-26T13:00:00.000Z' },
    });
  });

  it.each([
    ['timeout', { kind: 'timeout', timeoutMs: 300 } as const],
    ['red', { kind: 'network' } as const],
    ['500', { kind: 'serverError', status: 500 } as const],
    ['429', { kind: 'http', status: 429 } as const],
  ])('%s: la operación sigue pending, con un intento registrado, y no se pierde', async (_name, failure) => {
    await store.queue.enqueue(newOp('op-aaaa0003'));
    const report = await syncPendingOperations({ queue: store.queue, port: portWith(async () => { throw fail(failure); }) });
    expect(report.pending).toEqual(['op-aaaa0003']);
    expect((await store.queue.list())[0]).toMatchObject({ status: 'pending', operationId: 'op-aaaa0003', attempts: 1 });
  });

  it('sin red se detiene: no intenta las demás y todas siguen en la cola', async () => {
    await store.queue.enqueue(newOp('op-aaaa0004'));
    await store.queue.enqueue(newOp('op-aaaa0005', { incidentId: 'campus-inc-002' }));
    const performAction = jest.fn(async () => { throw fail({ kind: 'network' }); });
    const report = await syncPendingOperations({ queue: store.queue, port: portWith(performAction) });
    expect(performAction).toHaveBeenCalledTimes(1);
    expect(report.pending).toEqual(['op-aaaa0004', 'op-aaaa0005']);
    expect(await store.queue.list()).toHaveLength(2);
  });

  it('mientras una incidencia tiene un conflicto, sus otras operaciones esperan', async () => {
    await store.queue.enqueue(newOp('op-aaaa0006'));
    await store.queue.markConflict('op-aaaa0006', { fields: ['work'], remoteVersion: 2, detectedAt: '2026-10-26T13:00:00.000Z' });
    await store.queue.enqueue(newOp('op-aaaa0007', { content: { action: 'resolve', note: null, photos: [], extra: {} } }));
    const performAction = jest.fn(async () => INCIDENT);
    const report = await syncPendingOperations({ queue: store.queue, port: portWith(performAction) });
    expect(performAction).not.toHaveBeenCalled();
    expect(report.pending).toEqual(['op-aaaa0007']);
  });

  it('cambios independientes (merged): se reenvía con la MISMA clave sobre la versión nueva', async () => {
    await store.queue.enqueue(newOp('op-aaaa0008'));
    const performAction = jest.fn()
      .mockRejectedValueOnce(fail({ kind: 'http', status: 409 }))
      .mockResolvedValueOnce(INCIDENT);
    const port = portWith(performAction, async () => ({ version: 3, status: 'assigned', assignedTechnicianId: 'technician-1' }));
    const report = await syncPendingOperations({ queue: store.queue, port, resolve: () => ({ kind: 'merged', fields: {} }) });
    expect(performAction).toHaveBeenNthCalledWith(2, 'campus-inc-001', 'start', 3, {}, { idempotencyKey: 'op-aaaa0008' });
    expect(report.rebased).toEqual(['op-aaaa0008']);
    expect(await store.queue.list()).toHaveLength(0);
  });

  it('si el servidor ya tiene exactamente ese cambio, la operación se retira sin reenviar', async () => {
    await store.queue.enqueue(newOp('op-aaaa0009'));
    const performAction = jest.fn().mockRejectedValue(fail({ kind: 'http', status: 409 }));
    const port = portWith(performAction, async () => ({ version: 2, status: 'in_progress', assignedTechnicianId: 'technician-1' }));
    const report = await syncPendingOperations({ queue: store.queue, port, resolve: () => ({ kind: 'merged', fields: {} }) });
    expect(performAction).toHaveBeenCalledTimes(1);
    expect(report.confirmed).toEqual(['op-aaaa0009']);
    expect(await store.queue.list()).toHaveLength(0);
  });

  it('un 422 no borra nada: la operación sigue pending', async () => {
    await store.queue.enqueue(newOp('op-aaaa0010'));
    const report = await syncPendingOperations({
      queue: store.queue,
      port: portWith(async () => { throw fail({ kind: 'http', status: 422 }); }),
    });
    expect(report.pending).toEqual(['op-aaaa0010']);
    expect(await store.queue.list()).toHaveLength(1);
  });
});

describe('performOrEnqueue: acción sin conexión en la app real', () => {
  const seedCache = () =>
    store.incidents.save({
      id: 'campus-inc-001', version: 1, status: 'assigned', assignedTechnicianId: 'technician-1',
      categoria: 'connectivity', descripcion: 'sin red', syncedAt: '2026-10-26T11:00:00.000Z',
    });
  const offline = () => async () => { throw fail({ kind: 'network' }); };

  it('sin red encola con la versión de la copia local y la MISMA clave del primer intento', async () => {
    await seedCache();
    const performAction = jest.fn(offline());
    const outcome = await performOrEnqueue(
      { port: portWith(performAction, offline()), queue: store.queue, incidents: store.incidents, newOperationId: () => 'op-bbbb0001' },
      TECH, 'campus-inc-001', 'start',
    );
    expect(outcome).toEqual({ kind: 'queued', operationId: 'op-bbbb0001' });
    expect(performAction).not.toHaveBeenCalled(); // getWork falló antes: nunca se envió nada
    expect(await store.queue.list()).toEqual([
      expect.objectContaining({
        operationId: 'op-bbbb0001', baseVersion: 1, status: 'pending',
        author: { actorId: 'technician-1', role: 'technician' },
      }),
    ]);
  });

  it('en línea ejecuta directo, usa el operationId como Idempotency-Key y deja copia local', async () => {
    const performAction = jest.fn(async () => INCIDENT);
    const port = withLocalCache(portWith(performAction), store.incidents);
    const outcome = await performOrEnqueue(
      { port, queue: store.queue, incidents: store.incidents, newOperationId: () => 'op-bbbb0002' },
      TECH, 'campus-inc-001', 'start',
    );
    expect(outcome.kind).toBe('done');
    expect(performAction).toHaveBeenCalledWith('campus-inc-001', 'start', 1, {}, { idempotencyKey: 'op-bbbb0002' });
    expect(await store.queue.list()).toHaveLength(0);
    expect(await store.incidents.getWork('campus-inc-001')).toMatchObject({ version: 1, assignedTechnicianId: 'technician-1' });
  });

  it('sin versión conocida no encola (relanza el error original)', async () => {
    await expect(
      performOrEnqueue({ port: portWith(offline(), offline()), queue: store.queue, incidents: store.incidents }, TECH, 'campus-inc-001', 'start'),
    ).rejects.toBeInstanceOf(IncidentRemoteError);
    expect(await store.queue.list()).toHaveLength(0);
  });

  it('sin permiso no encola: la autorización de la semana 6 se mantiene', async () => {
    await store.incidents.save({
      id: 'campus-inc-001', version: 1, status: 'assigned', assignedTechnicianId: 'technician-2',
      categoria: null, descripcion: null, syncedAt: '2026-10-26T11:00:00.000Z',
    });
    await expect(
      performOrEnqueue({ port: portWith(offline(), offline()), queue: store.queue, incidents: store.incidents }, TECH, 'campus-inc-001', 'start'),
    ).rejects.toBeInstanceOf(ForbiddenActionError);
    expect(await store.queue.list()).toHaveLength(0);
  });

  it('un error que no es de conectividad no se encola', async () => {
    await seedCache();
    const port = portWith(async () => { throw fail({ kind: 'http', status: 422 }); });
    await expect(
      performOrEnqueue({ port, queue: store.queue, incidents: store.incidents }, TECH, 'campus-inc-001', 'start'),
    ).rejects.toBeInstanceOf(IncidentRemoteError);
    expect(await store.queue.list()).toHaveLength(0);
  });
});
