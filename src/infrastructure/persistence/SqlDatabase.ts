export type SqlValue = string | number | null;

export interface SqlExecutor {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: readonly SqlValue[]): Promise<void>;
  all<T>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
  first<T>(sql: string, params?: readonly SqlValue[]): Promise<T | null>;
}

/**
 * Lo mínimo que la persistencia necesita de SQLite. La app usa expo-sqlite;
 * las pruebas usan el mismo motor SQLite de Node sobre un archivo real.
 */
export interface SqlDatabase extends SqlExecutor {
  /** Todo o nada: si `work` lanza, se hace ROLLBACK y se relanza el error. */
  transaction(work: (tx: SqlExecutor) => Promise<void>): Promise<void>;
  close(): Promise<void>;
}
