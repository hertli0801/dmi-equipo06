import type { Incident } from '../../domain/incident/Incident';
import {
  canPerform,
  ForbiddenActionError,
  type Actor,
  type IncidentAction,
  type IncidentActionsPort,
  type PerformActionOptions
} from '../../domain/incident/IncidentPermissions';
import { IncidentRemoteError } from '../../domain/incident/IncidentRemoteError';
import { noopTelemetry, type Telemetry } from '../telemetry/Telemetry';

/** La autorización vive aquí (lógica), no en ocultar botones: sin permiso ni se llama al servidor. */
export async function performIncidentAction(
  port: IncidentActionsPort,
  actor: Actor,
  incidentId: string,
  action: IncidentAction,
  extra: Readonly<Record<string, unknown>> = {},
  telemetry: Telemetry = noopTelemetry,
  options?: PerformActionOptions,
): Promise<Incident> {
  let work;
  try {
    work = await port.getWork(incidentId);
  } catch (error) {
    // El servidor ya oculta incidencias ajenas (403): se trata igual que una acción no permitida.
    if (error instanceof IncidentRemoteError && error.failure.kind === 'http' && error.failure.status === 403) {
      telemetry.info('incidents.action_denied', { incidentId, action, role: actor.role });
      throw new ForbiddenActionError(action);
    }
    throw error;
  }
  if (!work) throw new IncidentRemoteError({ kind: 'http', status: 404 });

  if (!canPerform(actor, action, work)) {
    telemetry.info('incidents.action_denied', { incidentId, action, role: actor.role });
    throw new ForbiddenActionError(action);
  }

    // Sin opciones se llama igual que en la semana 6 (4 argumentos); solo la cola agrega la clave.
  const incident = options
    ? await port.performAction(incidentId, action, work.version, extra, options)
    : await port.performAction(incidentId, action, work.version, extra);
  telemetry.info('incidents.action_succeeded', { incidentId, action });
  return incident;
}