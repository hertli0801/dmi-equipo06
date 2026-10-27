import { IncidentRemoteError } from '../../domain/incident/IncidentRemoteError';
import type { IncidentActionsPort } from '../../domain/incident/IncidentPermissions';
import type { PendingOperation, PendingOperationQueue } from '../../domain/sync/PendingOperation';
import { resolveSync } from '../../course-evaluation';
import type { JsonObject, SyncRecord } from '../../course-evaluation/contracts';
import { noopTelemetry, type Telemetry } from '../telemetry/Telemetry';
import { classifyFailure } from './classifyFailure';

type Decision = ReturnType<typeof resolveSync>;

export type SyncDeps = Readonly<{
  queue: PendingOperationQueue;
  port: IncidentActionsPort;
  telemetry?: Telemetry;
  now?: () => Date;
  /** Por defecto la lógica real (src/course-evaluation). Se inyecta solo en pruebas. */
  resolve?: (base: SyncRecord, local: SyncRecord, remote: SyncRecord) => Decision;
}>;

export type SyncReport = {
  confirmed: string[];
  conflicts: { operationId: string; fields: readonly string[] }[];
  rebased: string[];
  pending: string[];
};

// Estado de trabajo antes y después de cada acción que se puede encolar.
const BASE_STATUS = { start: 'assigned', resolve: 'in_progress' } as const;
const LOCAL_STATUS = { start: 'in_progress', resolve: 'resolved' } as const;

const work = (assignedTechnicianId: string | null, status: string): JsonObject => ({
  work: { assignedTechnicianId, status },
});

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Lee el estado remoto; si el servidor ya no deja verlo (403 por reasignación) equivale a "ya no es mía". */
async function readRemote(port: IncidentActionsPort, op: PendingOperation, baseStatus: string): Promise<SyncRecord> {
  try {
    const remote = await port.getWork(op.incidentId);
    if (remote) {
      return {
        id: op.incidentId,
        version: remote.version,
        fields: work(remote.assignedTechnicianId, remote.status),
      };
    }
  } catch (error) {
    if (!(error instanceof IncidentRemoteError)) throw error;
  }
  return { id: op.incidentId, version: op.baseVersion + 1, fields: work(null, baseStatus) };
}

export async function syncPendingOperations(deps: SyncDeps): Promise<SyncReport> {
  const { queue, port } = deps;
  const telemetry = deps.telemetry ?? noopTelemetry;
  const resolve = deps.resolve ?? resolveSync;
  const now = deps.now ?? (() => new Date());
  const report: SyncReport = { confirmed: [], conflicts: [], rebased: [], pending: [] };

  // Misma clave siempre: operationId. Un reenvío ya confirmado vuelve como `duplicate: true`.
  const send = (op: PendingOperation, baseVersion: number) =>
    port.performAction(op.incidentId, op.content.action, baseVersion, op.content.extra, {
      idempotencyKey: op.operationId,
    });

  const operations = await queue.list();
  // Mientras una incidencia tenga un conflicto sin resolver, sus demás operaciones esperan.
  const blocked = new Set(operations.filter((op) => op.status === 'conflict').map((op) => op.incidentId));
  let halted = false;

  for (const op of operations) {
    if (op.status !== 'pending') continue;
    if (halted || blocked.has(op.incidentId) || !(op.content.action in BASE_STATUS)) {
      report.pending.push(op.operationId);
      continue;
    }
    await queue.recordAttempt(op.operationId);
    try {
      await send(op, op.baseVersion);
      await queue.removeConfirmed(op.operationId);
      report.confirmed.push(op.operationId);
      telemetry.info('sync.operation_confirmed', { operationId: op.operationId });
    } catch (error) {
      const kind = classifyFailure(error);
      if (kind !== 'conflict') {
        report.pending.push(op.operationId);
        if (kind === 'retry') halted = true; // sin red no tiene caso seguir probando las demás
        telemetry.info('sync.operation_pending', { operationId: op.operationId, failure: kind });
        continue;
      }

      const action = op.content.action as keyof typeof BASE_STATUS;
      const actorId = op.author.actorId;
      const base: SyncRecord = { id: op.incidentId, version: op.baseVersion, fields: work(actorId, BASE_STATUS[action]) };
      const local: SyncRecord = { id: op.incidentId, version: op.baseVersion, fields: work(actorId, LOCAL_STATUS[action]) };
      const remote = await readRemote(port, op, BASE_STATUS[action]);
      const decision = resolve(base, local, remote);

      if (decision.kind === 'conflict') {
        // Permanece en la cola con el detalle del conflicto; nada local ni remoto se borra ni se sobrescribe.
        await queue.markConflict(op.operationId, {
          fields: decision.fields,
          remoteVersion: remote.version,
          detectedAt: now().toISOString(),
        });
        blocked.add(op.incidentId);
        report.conflicts.push({ operationId: op.operationId, fields: decision.fields });
        telemetry.info('sync.operation_conflict', { operationId: op.operationId, fields: decision.fields });
      } else if (sameJson(remote.fields.work, local.fields.work)) {
        await queue.removeConfirmed(op.operationId); // el servidor ya tiene exactamente ese cambio
        report.confirmed.push(op.operationId);
      } else {
        // Cambios independientes: se reenvía sobre la versión nueva, con la misma clave.
        try {
          await send(op, remote.version);
          await queue.removeConfirmed(op.operationId);
          report.rebased.push(op.operationId);
          report.confirmed.push(op.operationId);
        } catch {
          report.pending.push(op.operationId);
        }
      }
    }
  }
  return report;
}
