import type { Incident } from '../../domain/incident/Incident';
import type { IncidentRepository } from '../../domain/incident/IncidentRepository';
import { remoteFailureKind } from '../../domain/incident/IncidentRemoteError';
import { noopTelemetry, type Telemetry } from '../telemetry/Telemetry';

export async function listIncidents(
  repository: IncidentRepository,
  telemetry: Telemetry = noopTelemetry,
): Promise<readonly Incident[]> {
  const startedAt = Date.now();
  try {
    const incidents = await repository.getAll();
    telemetry.info('incidents.list_loaded', { count: incidents.length, durationMs: Date.now() - startedAt });
    return incidents;
  } catch (error) {
    telemetry.error('incidents.list_failed', error, {
      failureKind: remoteFailureKind(error),
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}
