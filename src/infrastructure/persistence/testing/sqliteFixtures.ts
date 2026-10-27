// Sólo para pruebas: archivos SQLite temporales y fotografía del estado completo de la base.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SCHEMA_V1 } from '../schema';
import type { SqlExecutor } from '../SqlDatabase';
import { NodeSqliteDatabase } from './NodeSqliteDatabase';

export type TempDatabaseFile = Readonly<{ path: string; open(): NodeSqliteDatabase; remove(): void }>;

export function createTempDatabaseFile(): TempDatabaseFile {
  const dir = mkdtempSync(join(tmpdir(), 'campusops-week08-'));
  const path = join(dir, 'campusops.db');
  return { path, open: () => new NodeSqliteDatabase(path), remove: () => rmSync(dir, { recursive: true, force: true }) };
}

export type DatabaseState = Readonly<{
  userVersion: number;
  tables: readonly string[];
  rows: Readonly<Record<string, readonly unknown[]>>;
}>;

export async function captureState(db: SqlExecutor): Promise<DatabaseState> {
  const version = await db.first<{ user_version: number }>('PRAGMA user_version');
  const tables = (
    await db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
  ).map((row) => row.name);
  const rows: Record<string, unknown[]> = {};
  for (const table of tables) rows[table] = await db.all(`SELECT * FROM ${table} ORDER BY rowid`);
  return { userVersion: version?.user_version ?? 0, tables, rows };
}

/** Datos ficticios del contrato público guardados con el esquema anterior (v1). */
export async function seedSchemaV1(db: SqlExecutor): Promise<void> {
  await db.exec(SCHEMA_V1);
  await db.run('INSERT INTO incidents VALUES (?, ?, ?, ?, ?)', [
    'campus-inc-001',
    1,
    JSON.stringify({ status: 'assigned', assignedTechnicianId: 'technician-1' }),
    JSON.stringify({ categoria: 'electrical', descripcion: 'Contacto sin energía en laboratorio ficticio' }),
    '2026-10-24T18:00:00.000Z',
  ]);
  await db.run('INSERT INTO incidents VALUES (?, ?, ?, ?, ?)', [
    'campus-inc-002',
    3,
    JSON.stringify({ status: 'in_progress', assignedTechnicianId: 'technician-2' }),
    null,
    '2026-10-24T18:05:00.000Z',
  ]);
  await db.run('INSERT INTO outbox VALUES (?, ?, ?, ?, ?, ?, ?)', [
    'op-v1-start-001',
    'campus-inc-001',
    'technician-1',
    'technician',
    1,
    JSON.stringify({ action: 'start', note: 'Inicio en sitio sin cobertura', photoUris: ['file:///synthetic/tablero-1.jpg'] }),
    '2026-10-24T18:10:00.000Z',
  ]);
  await db.run('INSERT INTO outbox VALUES (?, ?, ?, ?, ?, ?, ?)', [
    'op-v1-resolve-002',
    'campus-inc-001',
    'technician-1',
    'technician',
    1,
    JSON.stringify({ action: 'resolve', note: null, extra: { diagnosis: 'Fusible reemplazado' } }),
    '2026-10-24T18:20:00.000Z',
  ]);
  await db.exec('PRAGMA user_version = 1');
}
