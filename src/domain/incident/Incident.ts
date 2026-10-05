import type { IncidentCategory, IncidentStatus } from '../../campusops/contracts';

/**
 * `categoria` y `descripcion` son `null` cuando el servidor envía un payload `null`
 * válido: la app muestra "sin detalle" en lugar de inventar datos.
 */
export type Incident = Readonly<{
  id: string;
  categoria: IncidentCategory | null;
  descripcion: string | null;
  estado: IncidentStatus;
}>;
