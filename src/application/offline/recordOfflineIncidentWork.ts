import {
  canPerform,
  ForbiddenActionError,
  type Actor,
  type IncidentAction,
} from '../../domain/incident/IncidentPermissions';
import { IncidentRemoteError } from '../../domain/incident/IncidentRemoteError';
import type { LocalIncidentCache } from '../../domain/sync/LocalIncidentCache';
import type { PendingOperation, PendingOperationQueue } from '../../domain/sync/PendingOperation';
import { noopTelemetry, type Telemetry } from '../telemetry/Telemetry';

export type OfflineWorkInput = Readonly<{
  operationId: string;
  action: IncidentAction;
  note?: string | null;
  /** Fotos que siguen en el dispositivo; se guardan como `pending_upload`. */
  photos?: readonly Readonly<{ photoId: string; localUri: string }>[];
  extra?: Readonly<Record<string, unknown>>;
}>;

export type OfflineWorkDeps = Readonly<{
  queue: PendingOperationQueue;
  incidents: LocalIncidentCache;
  now?: () => Date;
  telemetry?: Telemetry;
}>;

/**
 * Registra un cambio hecho sin conexión. Se autoriza contra la última copia confirmada
 * (la misma regla canPerform de la semana 6) y se encola con esa versión como base.
 * El servidor vuelve a autorizar al sincronizar: esto no sustituye su comprobación.
 */
export async function recordOfflineIncidentWork(
  deps: OfflineWorkDeps,
  actor: Actor,
  incidentId: string,
  input: OfflineWorkInput,
): Promise<PendingOperation> {
  const telemetry = deps.telemetry ?? noopTelemetry;
  const work = await deps.incidents.getWork(incidentId);
  if (!work) throw new IncidentRemoteError({ kind: 'http', status: 404 });

  if (!canPerform(actor, input.action, work)) {
    telemetry.info('incidents.offline_action_denied', { incidentId, action: input.action, role: actor.role });
    throw new ForbiddenActionError(input.action);
  }

  const operation = await deps.queue.enqueue({
    operationId: input.operationId,
    incidentId,
    author: { actorId: actor.actorId, role: actor.role },
    baseVersion: work.version,
    enqueuedAt: (deps.now ?? (() => new Date()))().toISOString(),
    content: {
      action: input.action,
      note: input.note ?? null,
      photos: (input.photos ?? []).map((photo) => ({ ...photo, uploadState: 'pending_upload' as const })),
      extra: input.extra ?? {},
    },
  });
  telemetry.info('incidents.offline_action_queued', { incidentId, action: input.action });
  return operation;
}
