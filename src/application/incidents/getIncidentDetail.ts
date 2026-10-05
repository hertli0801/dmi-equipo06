import type { Incident } from '../../domain/incident/Incident';
import type { IncidentRepository } from '../../domain/incident/IncidentRepository';
import { remoteFailureKind } from '../../domain/incident/IncidentRemoteError';
import { noopTelemetry, type Telemetry } from '../telemetry/Telemetry';

export async function getIncidentDetail(
  repository: IncidentRepository,
  incidentId: string,
  telemetry: Telemetry = noopTelemetry,
): Promise<Incident | null> {
  const startedAt = Date.now();
  try {
    const incident = await repository.getById(incidentId);
    telemetry.info('incidents.detail_loaded', {
      incidentId,
      status: incident?.estado ?? 'not_found',
      durationMs: Date.now() - startedAt,
    });
    return incident;
  } catch (error) {
    telemetry.error('incidents.detail_failed', error, {
      incidentId,
      failureKind: remoteFailureKind(error),
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}
