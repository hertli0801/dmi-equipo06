import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { openOfflineStore } from '../openOfflineStore';
import { LATEST_SCHEMA_VERSION, MigrationFailedError, migrateToLatest, type MigrationStep } from '../schema';
import {
  captureState,
  createTempDatabaseFile,
  seedSchemaV1,
  type DatabaseState,
  type TempDatabaseFile,
} from '../testing/sqliteFixtures';

let file: TempDatabaseFile;

beforeEach(() => {
  file = createTempDatabaseFile();
});

afterEach(() => {
  file.remove();
});

async function seededV1File(): Promise<DatabaseState> {
  const db = file.open();
  await seedSchemaV1(db);
  const state = await captureState(db);
  await db.close();
  return state;
}

test('migrates v1 to v2 keeping incidents and pending operations in order', async () => {
  const before = await seededV1File();
  expect(before.userVersion).toBe(1);
  expect(before.tables).toEqual(['incidents', 'outbox']);

  const store = await openOfflineStore(file.open());
  expect(store.schemaVersion).toBe(LATEST_SCHEMA_VERSION);

  expect(await store.incidents.list()).toEqual([
    {
      id: 'campus-inc-001',
      version: 1,
      status: 'assigned',
      assignedTechnicianId: 'technician-1',
      categoria: 'electrical',
      descripcion: 'Contacto sin energía en laboratorio ficticio',
      syncedAt: '2026-10-24T18:00:00.000Z',
    },
    {
      id: 'campus-inc-002',
      version: 3,
      status: 'in_progress',
      assignedTechnicianId: 'technician-2',
      categoria: null,
      descripcion: null,
      syncedAt: '2026-10-24T18:05:00.000Z',
    },
  ]);

  const queue = await store.queue.list();
  expect(queue.map((op) => op.operationId)).toEqual(['op-v1-start-001', 'op-v1-resolve-002']);
  expect(queue[0]).toEqual({
    operationId: 'op-v1-start-001',
    incidentId: 'campus-inc-001',
    author: { actorId: 'technician-1', role: 'technician' },
    baseVersion: 1,
    status: 'pending',
    attempts: 0,
    conflict: null,
    enqueuedAt: '2026-10-24T18:10:00.000Z',
    content: {
      action: 'start',
      note: 'Inicio en sitio sin cobertura',
      photos: [
        {
          photoId: 'op-v1-start-001#photo-0',
          localUri: 'file:///synthetic/tablero-1.jpg',
          uploadState: 'pending_upload',
        },
      ],
      extra: {},
    },
  });
  expect(queue[1]?.content).toEqual({ action: 'resolve', note: null, photos: [], extra: { diagnosis: 'Fusible reemplazado' } });
  await store.close();
});

const STEPS: readonly MigrationStep[] = [
  'create_v2_tables',
  'copy_incidents',
  'copy_operations',
  'copy_photos',
  'drop_v1_tables',
  'rename_v2_tables',
  'set_version',
];

test.each(STEPS)('a failure injected before %s rolls back to the intact v1 schema', async (failingStep) => {
  const before = await seededV1File();

  const db = file.open();
  const failure = await migrateToLatest(db, {
    beforeStep: (step) => {
      if (step === failingStep) throw new Error(`falla inyectada en ${step}`);
    },
  }).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(MigrationFailedError);
  expect(failure).toMatchObject({ fromVersion: 1, step: failingStep });
  const afterFailure = await captureState(db);
  // Ni tablas *_v2 ni filas copiadas: exactamente el estado anterior.
  expect(afterFailure).toEqual(before);
  await db.close();
});

test('records the state before, after the injected failure and after recovering on the next start', async () => {
  const before = await seededV1File();

  // Primer arranque: la migración falla a mitad (tablas nuevas ya creadas e incidencias copiadas).
  await expect(
    openOfflineStore(file.open(), {
      beforeStep: (step) => {
        if (step === 'copy_photos') throw new Error('falla inyectada: app cerrada a mitad de la migración');
      },
    }),
  ).rejects.toMatchObject({ name: 'MigrationFailedError', step: 'copy_photos' });

  // Se reabre el archivo como en un reinicio real.
  const reopened = file.open();
  const afterFailure = await captureState(reopened);
  await reopened.close();
  expect(afterFailure).toEqual(before);

  // Segundo arranque sin falla: recuperación controlada reintentando la misma migración.
  const store = await openOfflineStore(file.open());
  await store.close();
  const check = file.open();
  const afterRecovery = await captureState(check);
  await check.close();

  expect(afterRecovery.userVersion).toBe(2);
  expect(afterRecovery.tables).toEqual(['incidents', 'pending_operations', 'pending_photos']);
  expect(afterRecovery.rows.incidents).toHaveLength(2);
  expect((afterRecovery.rows.pending_operations as { operation_id: string }[]).map((row) => row.operation_id)).toEqual([
    'op-v1-start-001',
    'op-v1-resolve-002',
  ]);
  expect(afterRecovery.rows.pending_photos).toEqual([
    {
      photo_id: 'op-v1-start-001#photo-0',
      operation_id: 'op-v1-start-001',
      position: 0,
      local_uri: 'file:///synthetic/tablero-1.jpg',
      upload_state: 'pending_upload',
    },
  ]);

  // Con WEEK08_STATE_LOG=<ruta> se guardan los tres estados para el reporte de la semana.
  const logPath = process.env.WEEK08_STATE_LOG;
  if (logPath) {
    mkdirSync(join(logPath, '..'), { recursive: true });
    writeFileSync(logPath, JSON.stringify({ injectedAt: 'copy_photos', before, afterFailure, afterRecovery }, null, 2) + '\n');
  }
});

test('the migrated queue keeps working after restart (foreign key renamed with the table)', async () => {
  await seededV1File();
  let store = await openOfflineStore(file.open());
  await store.queue.removeConfirmed('op-v1-start-001');
  await store.close();

  store = await openOfflineStore(file.open());
  expect((await store.queue.list()).map((op) => op.operationId)).toEqual(['op-v1-resolve-002']);
  const db = file.open();
  // ON DELETE CASCADE apunta a pending_operations tras el rename: no quedan fotos huérfanas.
  expect(await db.all('SELECT * FROM pending_photos')).toEqual([]);
  await db.close();
  await store.close();
});

test('a fresh install creates the latest schema directly', async () => {
  const store = await openOfflineStore(file.open());
  expect(store.schemaVersion).toBe(2);
  expect(await store.queue.list()).toEqual([]);
  await store.close();
});

test('an unknown newer schema is refused without touching the data', async () => {
  const db = file.open();
  await seedSchemaV1(db);
  await db.exec('PRAGMA user_version = 9');
  const before = await captureState(db);

  await expect(migrateToLatest(db)).rejects.toMatchObject({ name: 'MigrationFailedError', fromVersion: 9, step: null });
  expect(await captureState(db)).toEqual(before);
  await db.close();
});
