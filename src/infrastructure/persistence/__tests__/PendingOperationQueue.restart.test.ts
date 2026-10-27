import { recordOfflineIncidentWork } from '../../../application/offline/recordOfflineIncidentWork';
import { ForbiddenActionError } from '../../../domain/incident/IncidentPermissions';
import { OperationIdentityError } from '../../../domain/sync/PendingOperation';
import { openOfflineStore, type OfflineStore } from '../openOfflineStore';
import { createTempDatabaseFile, type TempDatabaseFile } from '../testing/sqliteFixtures';

const technician1 = { actorId: 'technician-1', role: 'technician' } as const;
const technician2 = { actorId: 'technician-2', role: 'technician' } as const;
const fixedNow = () => new Date('2026-10-25T15:00:00.000Z');

let file: TempDatabaseFile;
let store: OfflineStore;

beforeEach(async () => {
  file = createTempDatabaseFile();
  store = await openOfflineStore(file.open());
  await store.incidents.save({
    id: 'campus-inc-001',
    version: 1,
    status: 'assigned',
    assignedTechnicianId: 'technician-1',
    categoria: 'electrical',
    descripcion: 'Contacto sin energía en laboratorio ficticio',
    syncedAt: '2026-10-25T14:00:00.000Z',
  });
});

afterEach(async () => {
  await store.close().catch(() => undefined);
  file.remove();
});

/** Simula cerrar la app y volver a abrirla: nueva conexión e instancias nuevas sobre el mismo archivo. */
async function restartApp(): Promise<OfflineStore> {
  await store.close();
  store = await openOfflineStore(file.open());
  return store;
}

test('offline start with note and pending photo survives an app restart with the same identity and content', async () => {
  const queued = await recordOfflineIncidentWork({ ...store, now: fixedNow }, technician1, 'campus-inc-001', {
    operationId: 'op-start-7f3a',
    action: 'start',
    note: 'Llegué al edificio ficticio B; sin cobertura',
    photos: [{ photoId: 'photo-tablero-1', localUri: 'file:///synthetic/tablero-1.jpg' }],
  });

  const restarted = await restartApp();
  const recovered = await restarted.queue.list();

  expect(recovered).toEqual([queued]);
  expect(recovered[0]).toEqual({
    operationId: 'op-start-7f3a',
    incidentId: 'campus-inc-001',
    author: technician1,
    baseVersion: 1,
    status: 'pending',
    attempts: 0,
    conflict: null,
    enqueuedAt: '2026-10-25T15:00:00.000Z',
    content: {
      action: 'start',
      note: 'Llegué al edificio ficticio B; sin cobertura',
      // La referencia sigue pendiente de subir: no se presenta como ya subida.
      photos: [{ photoId: 'photo-tablero-1', localUri: 'file:///synthetic/tablero-1.jpg', uploadState: 'pending_upload' }],
      extra: {},
    },
  });
  expect(restarted.schemaVersion).toBe(2);
});

test('keeps FIFO order, attempts and conflict state across restarts; only a confirmed operation leaves the queue', async () => {
  const deps = { ...store, now: fixedNow };
  await recordOfflineIncidentWork(deps, technician1, 'campus-inc-001', { operationId: 'op-a', action: 'start' });
  await recordOfflineIncidentWork(deps, technician1, 'campus-inc-001', {
    operationId: 'op-b',
    action: 'resolve',
    photos: [{ photoId: 'photo-b', localUri: 'file:///synthetic/b.jpg' }],
    extra: { diagnosis: 'Fusible reemplazado' },
  });
  await store.queue.recordAttempt('op-a');
  await store.queue.markConflict('op-a', { fields: ['work'], remoteVersion: 2, detectedAt: '2026-10-25T16:00:00.000Z' });

  let restarted = await restartApp();
  expect((await restarted.queue.list()).map((op) => [op.operationId, op.status, op.attempts])).toEqual([
    ['op-a', 'conflict', 1],
    ['op-b', 'pending', 0],
  ]);
  expect((await restarted.queue.get('op-a'))?.conflict).toEqual({
    fields: ['work'],
    remoteVersion: 2,
    detectedAt: '2026-10-25T16:00:00.000Z',
  });

  await restarted.queue.removeConfirmed('op-b');
  restarted = await restartApp();
  expect((await restarted.queue.list()).map((op) => op.operationId)).toEqual(['op-a']);
});

test('re-enqueuing the same operationId keeps the first operation; reusing it with other content is rejected', async () => {
  const deps = { ...store, now: fixedNow };
  const input = { operationId: 'op-repeat', action: 'start', note: 'misma intención' } as const;
  const first = await recordOfflineIncidentWork(deps, technician1, 'campus-inc-001', input);
  const again = await recordOfflineIncidentWork(
    { ...store, now: () => new Date('2026-10-25T18:00:00.000Z') },
    technician1,
    'campus-inc-001',
    input,
  );

  expect(again).toEqual(first);
  await expect(
    recordOfflineIncidentWork(deps, technician1, 'campus-inc-001', { ...input, note: 'otro contenido' }),
  ).rejects.toBeInstanceOf(OperationIdentityError);
  expect(await store.queue.list()).toEqual([first]);
});

test('week 6 authorization still applies offline: a technician not assigned cannot queue work', async () => {
  await expect(
    recordOfflineIncidentWork(store, technician2, 'campus-inc-001', { operationId: 'op-denied', action: 'start' }),
  ).rejects.toBeInstanceOf(ForbiddenActionError);
  await expect(
    recordOfflineIncidentWork(store, technician1, 'campus-inc-001', { operationId: 'op-assign', action: 'assign' }),
  ).rejects.toBeInstanceOf(ForbiddenActionError);
  expect(await (await restartApp()).queue.list()).toEqual([]);
});

test('an operation and its photo references are written atomically', async () => {
  // photoId duplicado: la segunda foto viola la PK y la transacción completa se revierte.
  await expect(
    recordOfflineIncidentWork(store, technician1, 'campus-inc-001', {
      operationId: 'op-atomic',
      action: 'start',
      photos: [
        { photoId: 'photo-dup', localUri: 'file:///synthetic/1.jpg' },
        { photoId: 'photo-dup', localUri: 'file:///synthetic/2.jpg' },
      ],
    }),
  ).rejects.toThrow();
  expect(await (await restartApp()).queue.list()).toEqual([]);
});
