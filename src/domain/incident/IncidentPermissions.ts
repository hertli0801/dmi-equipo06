import type { CampusRole, IncidentStatus } from '../../campusops/contracts';
import type { Incident } from './Incident';

export type IncidentAction = 'start' | 'resolve' | 'assign' | 'prioritize' | 'close' | 'reopen';

export type Actor = Readonly<{ actorId: string; role: CampusRole }>;

/** Lo mínimo que hace falta de una incidencia para decidir permisos y versionar la acción. */
export type IncidentWorkSnapshot = Readonly<{
  version: number;
  status: IncidentStatus;
  assignedTechnicianId: string | null;
}>;


/** Opciones de envío. `idempotencyKey` permite que un reintento (o la cola) reutilice la misma clave. */
export type PerformActionOptions = Readonly<{ idempotencyKey?: string }>;

/** Puerto aparte de IncidentRepository para no romper a quienes ya lo implementan. */
export interface IncidentActionsPort {
  getWork(id: string): Promise<IncidentWorkSnapshot | null>;
  performAction(
    id: string,
    action: IncidentAction,
    baseVersion: number,
       extra?: Readonly<Record<string, unknown>>,
    options?: PerformActionOptions,
  ): Promise<Incident>;
}

const COORDINATOR_ACTIONS: readonly IncidentAction[] = ['assign', 'prioritize', 'close', 'reopen'];

/** Regla de negocio: el coordinador abre/cierra; el técnico solo trabaja incidencias asignadas a él. */
export function canPerform(actor: Actor, action: IncidentAction, work: IncidentWorkSnapshot): boolean {
  if (COORDINATOR_ACTIONS.includes(action)) return actor.role === 'coordinator';
  return actor.role === 'technician' && work.assignedTechnicianId === actor.actorId;
}

export class ForbiddenActionError extends Error {
  readonly action: IncidentAction;

  constructor(action: IncidentAction) {
    super(`Acción no permitida: ${action}`);
    this.name = 'ForbiddenActionError';
    this.action = action;
  }
}