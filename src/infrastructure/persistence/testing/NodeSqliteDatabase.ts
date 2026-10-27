// Sólo para pruebas: el mismo motor SQLite (node:sqlite) sobre un archivo real en disco,
// para poder cerrar y volver a abrir la base como lo haría la app al reiniciarse.
import { DatabaseSync } from 'node:sqlite';

import type { SqlDatabase, SqlExecutor, SqlValue } from '../SqlDatabase';

export class NodeSqliteDatabase implements SqlDatabase {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async run(sql: string, params: readonly SqlValue[] = []): Promise<void> {
    this.db.prepare(sql).run(...params);
  }

  async all<T>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...params).map((row) => ({ ...row }) as T);
  }

  async first<T>(sql: string, params: readonly SqlValue[] = []): Promise<T | null> {
    const row = this.db.prepare(sql).get(...params);
    return row ? ({ ...row } as T) : null;
  }

  async transaction(work: (tx: SqlExecutor) => Promise<void>): Promise<void> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      await work(this);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
