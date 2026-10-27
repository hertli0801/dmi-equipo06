import type {
  AuthEvent,
  JsonObject,
  ParseResult,
  PermissionEvent,
  RemoteResponse,
  SyncRecord,
} from './contracts';
import type { IncidentLocation } from '../campusops/contracts';
import { redactForTelemetry as redactCampusOpsTelemetry } from '../application/telemetry/redactForTelemetry';

function pending(name: string): never {
  throw new Error(`${name} must be implemented in the assigned week`);
}

/** Week 04: delegates to the same sanitizer used by the app's telemetry. */
export function redactForTelemetry(input: unknown): unknown {
  return redactCampusOpsTelemetry(input);
}

export function parseRemoteResource(input: unknown): ParseResult {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: 'contract' };
  }

  const { id, version, status, payload } = input as Record<string, unknown>;

  if (typeof id !== 'string' || id.length === 0) {
    return { ok: false, error: 'contract' };
  }

  if (typeof status !== 'string' || status.length === 0) {
    return { ok: false, error: 'contract' };
  }

  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    return { ok: false, error: 'contract' };
  }

  if (payload !== null && (typeof payload !== 'object' || Array.isArray(payload))) {
    return { ok: false, error: 'contract' };
  }

  return { ok: true, value: { id, version, status, payload: payload as JsonObject | null } };
}

export function coordinateRefresh(events: readonly AuthEvent[]): Readonly<{
  status: 'anonymous' | 'authenticated';
  activeGeneration: number | null;
  refreshCalls: number;
  retriedRequestIds: readonly string[];
  persistedToken: string | null;
}> {
  let status: 'anonymous' | 'authenticated' = 'anonymous';
  let activeGeneration: number | null = null;
  let refreshCalls = 0;
  let persistedToken: string | null = null;
  // Tras logout o refresh fallido la sesión queda cerrada: no se renueva más (sin bucle)
  // y una respuesta tardía no puede volver a persistir un token.
  let closed = false;
  let latestGeneration = -1;
  const retriedRequestIds: string[] = [];

  const pendingByGeneration = new Map<number, string[]>();
  const refreshStartedForGeneration = new Set<number>();

  for (const event of events) {
    switch (event.type) {
      case 'request401': {
        if (closed) break;
        const generation = event.generation ?? 0;
        // La petición usaba un token ya renovado: se reintenta con el vigente, sin otro refresh.
        if (activeGeneration !== null && generation < activeGeneration) {
          if (event.requestId) retriedRequestIds.push(event.requestId);
          break;
        }
        if (!pendingByGeneration.has(generation)) {
          pendingByGeneration.set(generation, []);
        }
        if (event.requestId) {
          pendingByGeneration.get(generation)!.push(event.requestId);
        }
        if (!refreshStartedForGeneration.has(generation)) {
          refreshStartedForGeneration.add(generation);
          refreshCalls += 1;
        }
        break;
      }

      case 'refreshSucceeded': {
        const newGeneration: number = event.generation ?? (activeGeneration ?? 0) + 1;
        // Respuesta obsoleta: no pisa una generación más nueva ni revive una sesión cerrada.
        if (closed || newGeneration <= latestGeneration) break;
        const previousGeneration = newGeneration - 1;
        const waiting = pendingByGeneration.get(previousGeneration) ?? [];
        retriedRequestIds.push(...waiting);
        pendingByGeneration.delete(previousGeneration);
        activeGeneration = newGeneration;
        latestGeneration = newGeneration;
        persistedToken = event.token ?? persistedToken;
        status = 'authenticated';
        break;
      }

      case 'refreshFailed': {
        const failedGeneration = event.generation ?? activeGeneration ?? 0;
        // Un fallo de una generación ya superada no cierra la sesión vigente.
        if (failedGeneration < latestGeneration) break;
        pendingByGeneration.clear();
        status = 'anonymous';
        activeGeneration = null;
        persistedToken = null;
        closed = true;
        break;
      }

      case 'logout': {
        status = 'anonymous';
        activeGeneration = null;
        persistedToken = null;
        closed = true;
        pendingByGeneration.clear();
        refreshStartedForGeneration.clear();
        break;
      }
    }
  }

  return { status, activeGeneration, refreshCalls, retriedRequestIds, persistedToken };
}

export function resolveSync(
  base: SyncRecord,
  local: SyncRecord,
  remote: SyncRecord,
): Readonly<{ kind: 'merged'; fields: JsonObject } | { kind: 'conflict'; fields: readonly string[] }> {
  const fieldNames = new Set<string>([
    ...Object.keys(base.fields),
    ...Object.keys(local.fields),
    ...Object.keys(remote.fields),
  ]);

  const merged: Record<string, unknown> = {};
  const conflicts: string[] = [];

  for (const field of fieldNames) {
    const baseJson = JSON.stringify(base.fields[field]);
    const localJson = JSON.stringify(local.fields[field]);
    const remoteJson = JSON.stringify(remote.fields[field]);

    const localChanged = localJson !== baseJson;
    const remoteChanged = remoteJson !== baseJson;

    if (localChanged && remoteChanged) {
      if (localJson === remoteJson) {
        merged[field] = local.fields[field];
      } else {
        conflicts.push(field);
      }
    } else if (localChanged) {
      merged[field] = local.fields[field];
    } else if (remoteChanged) {
      merged[field] = remote.fields[field];
    } else {
      merged[field] = base.fields[field];
    }
  }

  if (conflicts.length > 0) {
    return { kind: 'conflict', fields: conflicts.sort() };
  }

  return { kind: 'merged', fields: merged as JsonObject };
}

export function deduplicateOperations<T extends Readonly<{ operationId: string }>>(
  operations: readonly T[],
): readonly T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const operation of operations) {
    if (seen.has(operation.operationId)) continue;
    seen.add(operation.operationId);
    result.push(operation);
  }
  return result;
}

export function planRetry(_input: Readonly<{
  method: 'GET' | 'POST';
  status: number | 'timeout';
  attempt: number;
  retryAfterMs?: number;
  idempotencyKey?: string;
}>): Readonly<{ retry: boolean; delayMs: number; requiresStableIdempotencyKey: boolean }> {
  return pending('planRetry');
}

export function reduceRemoteResponses(_input: Readonly<{
  activeRequestId: string;
  responses: readonly RemoteResponse[];
}>): Readonly<{ state: 'success' | 'error' | 'loading'; value?: unknown; error?: string }> {
  return pending('reduceRemoteResponses');
}

export function reducePermissionLifecycle(
  _events: readonly PermissionEvent[],
): Readonly<{ status: 'available' | 'denied' | 'blocked'; resourceActive: boolean }> {
  return pending('reducePermissionLifecycle');
}

/** Week 09: see docs/CAMPUSOPS_API.md; this is not a completed solution. */
export function selectIncidentLocation(_provider: unknown, _manualLabel: string): IncidentLocation {
  return pending('selectIncidentLocation');
}
