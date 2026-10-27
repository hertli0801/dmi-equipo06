import type { CampusRole } from '../../campusops/contracts';
import type { IncidentAction } from '../../domain/incident/IncidentPermissions';
import {
  OperationIdentityError,
  sameOperationIntent,
  type NewPendingOperation,
  type OperationConflict,
  type PendingOperation,
  type PendingOperationQueue,
  type PendingOperationStatus,
} from '../../domain/sync/PendingOperation';
import type { SqlDatabase, SqlExecutor } from './SqlDatabase';

type OperationRow = {
  operation_id: string;
  incident_id: string;
  author_actor_id: string;
  author_role: string;
  action: string;
  note: string | null;
  extra_json: string;
  base_version: number;
  status: string;
  attempts: number;
  conflict_json: string | null;
  enqueued_at: string;
};

type PhotoRow = { photo_id: string; operation_id: string; local_uri: string };

/** Cola persistente en SQLite: sobrevive al cierre de la app con el mismo operationId y contenido. */
export class SqlitePendingOperationQueue implements PendingOperationQueue {
  constructor(private readonly db: SqlDatabase) {}

  async enqueue(operation: NewPendingOperation): Promise<PendingOperation> {
    const existing = await this.get(operation.operationId);
    if (existing) {
      // Repetir la misma intención no crea otra operación; reutilizar la clave con otro contenido es error.
      if (!sameOperationIntent(existing, operation)) throw new OperationIdentityError(operation.operationId);
      return existing;
    }

    // Operación y fotos en una sola transacción: nunca queda una operación sin sus referencias.
    await this.db.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO pending_operations
           (operation_id, incident_id, author_actor_id, author_role, action, note, extra_json, base_version, status, enqueued_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        [
          operation.operationId,
          operation.incidentId,
          operation.author.actorId,
          operation.author.role,
          operation.content.action,
          operation.content.note,
          JSON.stringify(operation.content.extra),
          operation.baseVersion,
          operation.enqueuedAt,
        ],
      );
      for (const [position, photo] of operation.content.photos.entries()) {
        await tx.run(
          `INSERT INTO pending_photos (photo_id, operation_id, position, local_uri, upload_state)
           VALUES (?, ?, ?, ?, 'pending_upload')`,
          [photo.photoId, operation.operationId, position, photo.localUri],
        );
      }
    });

    const stored = await this.get(operation.operationId);
    if (!stored) throw new Error(`La operación ${operation.operationId} no quedó guardada`);
    return stored;
  }

  async list(): Promise<readonly PendingOperation[]> {
    const rows = await this.db.all<OperationRow>('SELECT * FROM pending_operations ORDER BY seq');
    const photos = await this.db.all<PhotoRow>(
      'SELECT photo_id, operation_id, local_uri FROM pending_photos ORDER BY operation_id, position',
    );
    return rows.map((row) => toOperation(row, photos.filter((photo) => photo.operation_id === row.operation_id)));
  }

  async get(operationId: string): Promise<PendingOperation | null> {
    return findOperation(this.db, operationId);
  }

  async recordAttempt(operationId: string): Promise<void> {
    await this.db.run('UPDATE pending_operations SET attempts = attempts + 1 WHERE operation_id = ?', [operationId]);
  }

  async markConflict(operationId: string, conflict: OperationConflict): Promise<void> {
    await this.db.run(`UPDATE pending_operations SET status = 'conflict', conflict_json = ? WHERE operation_id = ?`, [
      JSON.stringify(conflict),
      operationId,
    ]);
  }

  async removeConfirmed(operationId: string): Promise<void> {
    // ON DELETE CASCADE retira también sus referencias de fotos.
    await this.db.run('DELETE FROM pending_operations WHERE operation_id = ?', [operationId]);
  }
}

async function findOperation(db: SqlExecutor, operationId: string): Promise<PendingOperation | null> {
  const row = await db.first<OperationRow>('SELECT * FROM pending_operations WHERE operation_id = ?', [operationId]);
  if (!row) return null;
  const photos = await db.all<PhotoRow>(
    'SELECT photo_id, operation_id, local_uri FROM pending_photos WHERE operation_id = ? ORDER BY position',
    [operationId],
  );
  return toOperation(row, photos);
}

function toOperation(row: OperationRow, photos: readonly PhotoRow[]): PendingOperation {
  return {
    operationId: row.operation_id,
    incidentId: row.incident_id,
    author: { actorId: row.author_actor_id, role: row.author_role as CampusRole },
    content: {
      action: row.action as IncidentAction,
      note: row.note,
      photos: photos.map((photo) => ({ photoId: photo.photo_id, localUri: photo.local_uri, uploadState: 'pending_upload' })),
      extra: JSON.parse(row.extra_json) as Record<string, unknown>,
    },
    baseVersion: row.base_version,
    status: row.status as PendingOperationStatus,
    attempts: row.attempts,
    conflict: row.conflict_json ? (JSON.parse(row.conflict_json) as OperationConflict) : null,
    enqueuedAt: row.enqueued_at,
  };
}
