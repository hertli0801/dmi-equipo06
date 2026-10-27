import * as SQLite from 'expo-sqlite';

import type { SqlDatabase, SqlExecutor, SqlValue } from './SqlDatabase';

export const CAMPUSOPS_DATABASE_NAME = 'campusops.db';

/** Adaptador de expo-sqlite: el archivo vive en el almacenamiento privado de la app. */
export class ExpoSqliteDatabase implements SqlDatabase {
  constructor(private readonly db: SQLite.SQLiteDatabase) {}

  static async open(name: string = CAMPUSOPS_DATABASE_NAME): Promise<ExpoSqliteDatabase> {
    return new ExpoSqliteDatabase(await SQLite.openDatabaseAsync(name));
  }

  exec(sql: string): Promise<void> {
    return this.db.execAsync(sql);
  }

  async run(sql: string, params: readonly SqlValue[] = []): Promise<void> {
    await this.db.runAsync(sql, [...params]);
  }

  all<T>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
    return this.db.getAllAsync<T>(sql, [...params]);
  }

  first<T>(sql: string, params: readonly SqlValue[] = []): Promise<T | null> {
    return this.db.getFirstAsync<T>(sql, [...params]);
  }

  /** Exclusiva: ninguna otra consulta de la app se intercala con la migración o el encolado. */
  transaction(work: (tx: SqlExecutor) => Promise<void>): Promise<void> {
    return this.db.withExclusiveTransactionAsync((txn) => work(new ExpoSqliteDatabase(txn)));
  }

  close(): Promise<void> {
    return this.db.closeAsync();
  }
}
