import type { Incident } from '../../domain/incident/Incident';
import type { IncidentRepository } from '../../domain/incident/IncidentRepository';

export function getIncidentDetail(
  repository: IncidentRepository,
  incidentId: string,
): Promise<Incident | null> {
  return repository.getById(incidentId);
}
