import type { Incident } from '../../domain/incident/Incident';
import type { IncidentRepository } from '../../domain/incident/IncidentRepository';
import { remoteFailureKind } from '../../domain/incident/IncidentRemoteError';
import { noopTelemetry, type Telemetry } from '../telemetry/Telemetry';

export async function createIncident(
  repository: IncidentRepository,
  input: { categoria: string; descripcion: string; location: string },
  telemetry: Telemetry = noopTelemetry,
): Promise<Incident> {
  const startedAt = Date.now();
  try {
    const incident = await repository.create(input);
    telemetry.info('incidents.create_succeeded', { incidentId: incident.id, durationMs: Date.now() - startedAt });
    return incident;
  } catch (error) {
    telemetry.error('incidents.create_failed', error, {
      failureKind: remoteFailureKind(error),
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}
