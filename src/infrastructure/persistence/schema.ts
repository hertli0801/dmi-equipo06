import type { SqlDatabase, SqlExecutor } from './SqlDatabase';

/**
 * Versión de esquema guardada en `PRAGMA user_version` (cabecera del archivo SQLite).
 * Se escribe dentro de la misma transacción que la migración: si ésta se revierte,
 * la versión también.
 */
export const LATEST_SCHEMA_VERSION = 2;

/**
 * Esquema v1 (anterior): la incidencia guardaba `work_json` y la cola (`outbox`)
 * metía acción, nota y URIs de fotos en un solo `body_json`.
 */
export const SCHEMA_V1 = `
CREATE TABLE incidents (
  id TEXT PRIMARY KEY NOT NULL,
  version INTEGER NOT NULL,
  work_json TEXT NOT NULL,
  detalle_json TEXT,
  synced_at TEXT NOT NULL
);
CREATE TABLE outbox (
  operation_id TEXT PRIMARY KEY NOT NULL,
  incident_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  base_version INTEGER NOT NULL,
  body_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

/** Esquema v2 (actual): columnas explícitas, estado de la operación y fotos pendientes aparte. */
const SCHEMA_V2_TABLES = `
CREATE TABLE incidents_v2 (
  id TEXT PRIMARY KEY NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 0),
  status TEXT NOT NULL,
  assigned_technician_id TEXT,
  categoria TEXT,
  descripcion TEXT,
  synced_at TEXT NOT NULL
);
CREATE TABLE pending_operations_v2 (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL UNIQUE,
  incident_id TEXT NOT NULL,
  author_actor_id TEXT NOT NULL,
  author_role TEXT NOT NULL,
  action TEXT NOT NULL,
  note TEXT,
  extra_json TEXT NOT NULL DEFAULT '{}',
  base_version INTEGER NOT NULL CHECK (base_version >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'conflict')),
  attempts INTEGER NOT NULL DEFAULT 0,
  conflict_json TEXT,
  enqueued_at TEXT NOT NULL
);
CREATE TABLE pending_photos_v2 (
  photo_id TEXT PRIMARY KEY NOT NULL,
  operation_id TEXT NOT NULL REFERENCES pending_operations_v2(operation_id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  local_uri TEXT NOT NULL,
  upload_state TEXT NOT NULL CHECK (upload_state = 'pending_upload')
);
`;

// Al renombrar, SQLite reescribe la FK de pending_photos para que apunte a pending_operations.
const RENAME_V2_TABLES = `
ALTER TABLE incidents_v2 RENAME TO incidents;
ALTER TABLE pending_operations_v2 RENAME TO pending_operations;
ALTER TABLE pending_photos_v2 RENAME TO pending_photos;
CREATE INDEX pending_operations_by_incident ON pending_operations(incident_id);
CREATE INDEX pending_photos_by_operation ON pending_photos(operation_id, position);
`;

export type MigrationStep =
  | 'create_v2_tables'
  | 'copy_incidents'
  | 'copy_operations'
  | 'copy_photos'
  | 'drop_v1_tables'
  | 'rename_v2_tables'
  | 'set_version';

export type MigrationOptions = Readonly<{
  /** Punto de inyección de fallas: se llama antes de cada paso, dentro de la transacción. */
  beforeStep?: (step: MigrationStep) => void | Promise<void>;
}>;

export type MigrationResult = Readonly<{ from: number; to: number }>;

export class MigrationFailedError extends Error {
  readonly fromVersion: number;
  readonly step: MigrationStep | null;

  constructor(fromVersion: number, step: MigrationStep | null, cause: unknown) {
    super(`La migración desde v${fromVersion} falló en ${step ?? 'inicio'} y se revirtió`, { cause });
    this.name = 'MigrationFailedError';
    this.fromVersion = fromVersion;
    this.step = step;
  }
}

export async function readSchemaVersion(db: SqlExecutor): Promise<number> {
  const row = await db.first<{ user_version: number }>('PRAGMA user_version');
  return row?.user_version ?? 0;
}

/**
 * Lleva la base a LATEST_SCHEMA_VERSION en una sola transacción. Si algo falla,
 * SQLite revierte DDL, datos y `user_version`: la base queda exactamente en la
 * versión anterior y el siguiente arranque vuelve a intentar la migración.
 */
export async function migrateToLatest(db: SqlDatabase, options: MigrationOptions = {}): Promise<MigrationResult> {
  const from = await readSchemaVersion(db);
  if (from === LATEST_SCHEMA_VERSION) return { from, to: from };
  if (from > LATEST_SCHEMA_VERSION || from < 0) {
    throw new MigrationFailedError(from, null, new Error(`Versión de esquema desconocida: ${from}`));
  }

  let current: MigrationStep | null = null;
  const step = async (name: MigrationStep, work: () => Promise<void>) => {
    current = name;
    await options.beforeStep?.(name);
    await work();
  };

  try {
    await db.transaction(async (tx) => {
      if (from === 0) {
        // Instalación nueva: se crea directamente el esquema actual.
        await step('create_v2_tables', () => tx.exec(SCHEMA_V2_TABLES));
        await step('rename_v2_tables', () => tx.exec(RENAME_V2_TABLES));
      } else {
        await migrateV1ToV2(tx, step);
      }
      await step('set_version', () => tx.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION}`));
    });
  } catch (error) {
    throw new MigrationFailedError(from, current, error);
  }
  return { from, to: LATEST_SCHEMA_VERSION };
}

type V1Incident = { id: string; version: number; work_json: string; detalle_json: string | null; synced_at: string };
type V1Operation = {
  operation_id: string;
  incident_id: string;
  actor_id: string;
  actor_role: string;
  base_version: number;
  body_json: string;
  created_at: string;
};
type V1Body = { action: string; note?: string | null; photoUris?: string[]; extra?: Record<string, unknown> };

async function migrateV1ToV2(
  tx: SqlExecutor,
  step: (name: MigrationStep, work: () => Promise<void>) => Promise<void>,
): Promise<void> {
  await step('create_v2_tables', () => tx.exec(SCHEMA_V2_TABLES));

  await step('copy_incidents', async () => {
    for (const row of await tx.all<V1Incident>('SELECT * FROM incidents ORDER BY id')) {
      const work = JSON.parse(row.work_json) as { status: string; assignedTechnicianId: string | null };
      const detalle = row.detalle_json
        ? (JSON.parse(row.detalle_json) as { categoria?: string | null; descripcion?: string | null })
        : {};
      await tx.run(
        `INSERT INTO incidents_v2 (id, version, status, assigned_technician_id, categoria, descripcion, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [row.id, row.version, work.status, work.assignedTechnicianId, detalle.categoria ?? null, detalle.descripcion ?? null, row.synced_at],
      );
    }
  });

  // rowid conserva el orden de llegada de la cola anterior.
  const operations = await tx.all<V1Operation>('SELECT * FROM outbox ORDER BY rowid');

  await step('copy_operations', async () => {
    for (const row of operations) {
      const body = JSON.parse(row.body_json) as V1Body;
      await tx.run(
        `INSERT INTO pending_operations_v2
           (operation_id, incident_id, author_actor_id, author_role, action, note, extra_json, base_version, status, enqueued_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        [
          row.operation_id,
          row.incident_id,
          row.actor_id,
          row.actor_role,
          body.action,
          body.note ?? null,
          JSON.stringify(body.extra ?? {}),
          row.base_version,
          row.created_at,
        ],
      );
    }
  });

  await step('copy_photos', async () => {
    for (const row of operations) {
      const uris = (JSON.parse(row.body_json) as V1Body).photoUris ?? [];
      for (const [position, uri] of uris.entries()) {
        // ID derivado y determinista: repetir la migración produce las mismas referencias.
        await tx.run(
          `INSERT INTO pending_photos_v2 (photo_id, operation_id, position, local_uri, upload_state)
           VALUES (?, ?, ?, ?, 'pending_upload')`,
          [`${row.operation_id}#photo-${position}`, row.operation_id, position, uri],
        );
      }
    }
  });

  await step('drop_v1_tables', () => tx.exec('DROP TABLE outbox; DROP TABLE incidents;'));
  await step('rename_v2_tables', () => tx.exec(RENAME_V2_TABLES));
}
