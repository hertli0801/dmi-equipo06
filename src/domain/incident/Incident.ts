import type { IncidentCategory, IncidentStatus } from '../../campusops/contracts';

export type Incident = Readonly<{
  id: string;
  categoria: IncidentCategory;
  descripcion: string;
  estado: IncidentStatus;
}>;
