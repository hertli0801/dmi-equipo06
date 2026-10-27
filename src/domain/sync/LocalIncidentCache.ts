import type { IncidentCategory, IncidentStatus } from '../../campusops/contracts';
import type { IncidentWorkSnapshot } from '../incident/IncidentPermissions';

/** Copia local de una incidencia, tal como la confirmó el servidor por última vez. */
export type CachedIncident = Readonly<{
  id: string;
  version: number;
  status: IncidentStatus;
  assignedTechnicianId: string | null;
  categoria: IncidentCategory | null;
  descripcion: string | null;
  syncedAt: string;
}>;

/** Puerto de las incidencias consultables sin conexión. */
export interface LocalIncidentCache {
  save(incident: CachedIncident): Promise<void>;
  get(id: string): Promise<CachedIncident | null>;
  list(): Promise<readonly CachedIncident[]>;
  getWork(id: string): Promise<IncidentWorkSnapshot | null>;
}
