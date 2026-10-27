import type { IncidentCategory, IncidentStatus } from '../../campusops/contracts';
import type { IncidentWorkSnapshot } from '../../domain/incident/IncidentPermissions';
import type { CachedIncident, LocalIncidentCache } from '../../domain/sync/LocalIncidentCache';
import type { SqlDatabase } from './SqlDatabase';

type IncidentRow = {
  id: string;
  version: number;
  status: string;
  assigned_technician_id: string | null;
  categoria: string | null;
  descripcion: string | null;
  synced_at: string;
};

export class SqliteIncidentCache implements LocalIncidentCache {
  constructor(private readonly db: SqlDatabase) {}

  async save(incident: CachedIncident): Promise<void> {
    await this.db.run(
      `INSERT INTO incidents (id, version, status, assigned_technician_id, categoria, descripcion, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         version = excluded.version, status = excluded.status,
         assigned_technician_id = excluded.assigned_technician_id,
         categoria = excluded.categoria, descripcion = excluded.descripcion, synced_at = excluded.synced_at`,
      [
        incident.id,
        incident.version,
        incident.status,
        incident.assignedTechnicianId,
        incident.categoria,
        incident.descripcion,
        incident.syncedAt,
      ],
    );
  }

  async get(id: string): Promise<CachedIncident | null> {
    const row = await this.db.first<IncidentRow>('SELECT * FROM incidents WHERE id = ?', [id]);
    return row ? toIncident(row) : null;
  }

  async list(): Promise<readonly CachedIncident[]> {
    return (await this.db.all<IncidentRow>('SELECT * FROM incidents ORDER BY id')).map(toIncident);
  }

  async getWork(id: string): Promise<IncidentWorkSnapshot | null> {
    const incident = await this.get(id);
    return incident
      ? { version: incident.version, status: incident.status, assignedTechnicianId: incident.assignedTechnicianId }
      : null;
  }
}

function toIncident(row: IncidentRow): CachedIncident {
  return {
    id: row.id,
    version: row.version,
    status: row.status as IncidentStatus,
    assignedTechnicianId: row.assigned_technician_id,
    categoria: row.categoria as IncidentCategory | null,
    descripcion: row.descripcion,
    syncedAt: row.synced_at,
  };
}
