import type { Incident } from '../../domain/incident/Incident';
import type { Actor, IncidentAction, IncidentActionsPort } from '../../domain/incident/IncidentPermissions';
import type { LocalIncidentCache } from '../../domain/sync/LocalIncidentCache';
import type { PendingOperationQueue } from '../../domain/sync/PendingOperation';
import { performIncidentAction } from '../incidents/performIncidentAction';
import { recordOfflineIncidentWork } from '../offline/recordOfflineIncidentWork';
import { noopTelemetry, type Telemetry } from '../telemetry/Telemetry';
import { classifyFailure } from './classifyFailure';

/** Acciones que un técnico puede dejar en cola sin conexión. */
export const QUEUEABLE_ACTIONS: readonly IncidentAction[] = ['start', 'resolve'];

export type ActionOutcome =
  | Readonly<{ kind: 'done'; incident: Incident }>
  | Readonly<{ kind: 'queued'; operationId: string }>;

/**
 * Decorador: cada getWork exitoso guarda la versión confirmada en la copia local (SQLite).
 * Sin red no se puede volver a leer la versión, y la cola la necesita como `baseVersion`.
 */
export function withLocalCache(
  port: IncidentActionsPort,
  incidents: LocalIncidentCache,
  now: () => Date = () => new Date(),
): IncidentActionsPort {
  return {
    performAction: (id, action, baseVersion, extra, options) =>
      port.performAction(id, action, baseVersion, extra, options),
    async getWork(id) {
      const work = await port.getWork(id);
      if (work) {
        try {
          const previous = await incidents.get(id);
          await incidents.save({
            id,
            version: work.version,
            status: work.status,
            assignedTechnicianId: work.assignedTechnicianId,
            categoria: previous?.categoria ?? null,
            descripcion: previous?.descripcion ?? null,
            syncedAt: now().toISOString(),
          });
        } catch {
          // La copia local es de apoyo: si falla guardarla, la acción en línea no debe fallar.
        }
      }
      return work;
    },
  };
}

export type PerformOrEnqueueDeps = Readonly<{
  port: IncidentActionsPort;
  queue: PendingOperationQueue;
  incidents: LocalIncidentCache;
  telemetry?: Telemetry;
  now?: () => Date;
  newOperationId?: () => string;
}>;

const defaultOperationId = () => `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

/**
 * Flujo real de la app: intenta la acción en línea; si falla por conectividad, la deja en la cola.
 * El operationId se crea ANTES del primer intento y es también la Idempotency-Key: si el servidor
 * alcanzó a confirmar pero la respuesta se perdió, el reenvío con la misma clave no duplica el efecto.
 */
export async function performOrEnqueue(
  deps: PerformOrEnqueueDeps,
  actor: Actor,
  incidentId: string,
  action: IncidentAction,
  extra: Readonly<Record<string, unknown>> = {},
): Promise<ActionOutcome> {
  const telemetry = deps.telemetry ?? noopTelemetry;
  const operationId = (deps.newOperationId ?? defaultOperationId)();
  try {
    const incident = await performIncidentAction(deps.port, actor, incidentId, action, extra, telemetry, {
      idempotencyKey: operationId,
    });
    return { kind: 'done', incident };
  } catch (error) {
    if (classifyFailure(error) !== 'retry' || !QUEUEABLE_ACTIONS.includes(action)) throw error;
    // Sin una versión conocida no se puede encolar con seguridad: se relanza el error original.
    if (!(await deps.incidents.getWork(incidentId))) throw error;
    // recordOfflineIncidentWork (Alberto) autoriza con canPerform contra la copia local y encola.
    await recordOfflineIncidentWork(
      { queue: deps.queue, incidents: deps.incidents, telemetry, ...(deps.now ? { now: deps.now } : {}) },
      actor,
      incidentId,
      { operationId, action, extra },
    );
    return { kind: 'queued', operationId };
  }
}
