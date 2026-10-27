import { IncidentRemoteError } from '../../domain/incident/IncidentRemoteError';

/**
 * - retry: sin red, timeout, 500 o 429 → la operación sigue `pending`.
 * - conflict: 409 (versión obsoleta) o 403 (reasignada) → pasa a `conflict` y se queda en la cola.
 * - other: 401, 404, 422, contrato roto… → no se borra nada; sigue `pending` y se reporta.
 */
export type FailureClass = 'retry' | 'conflict' | 'other';

export function classifyFailure(error: unknown): FailureClass {
  if (!(error instanceof IncidentRemoteError)) return 'other';
  const failure = error.failure;
  if (failure.kind === 'network' || failure.kind === 'timeout' || failure.kind === 'serverError') return 'retry';
  if (failure.kind === 'http' && failure.status === 429) return 'retry';
  if (failure.kind === 'http' && (failure.status === 409 || failure.status === 403)) return 'conflict';
  return 'other';
}
