import type { LocalIncidentCache } from '../../domain/sync/LocalIncidentCache';
import type { PendingOperationQueue } from '../../domain/sync/PendingOperation';
import { migrateToLatest, readSchemaVersion, type MigrationOptions } from './schema';
import { SqliteIncidentCache } from './SqliteIncidentCache';
import { SqlitePendingOperationQueue } from './SqlitePendingOperationQueue';
import type { SqlDatabase } from './SqlDatabase';

export type OfflineStore = Readonly<{
  queue: PendingOperationQueue;
  incidents: LocalIncidentCache;
  schemaVersion: number;
  close(): Promise<void>;
}>;

/**
 * Abre la base local y la migra antes de entregarla. Si la migración falla se lanza
 * MigrationFailedError: la base queda en su versión anterior y no se usa a medias.
 */
export async function openOfflineStore(db: SqlDatabase, options: MigrationOptions = {}): Promise<OfflineStore> {
  try {
    await db.exec('PRAGMA foreign_keys = ON');
    await migrateToLatest(db, options);
  } catch (error) {
    await db.close();
    throw error;
  }
  return {
    queue: new SqlitePendingOperationQueue(db),
    incidents: new SqliteIncidentCache(db),
    schemaVersion: await readSchemaVersion(db),
    close: () => db.close(),
  };
}
