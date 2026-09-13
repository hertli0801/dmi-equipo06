import type { Incident } from '../../domain/incident/Incident';
import type { IncidentRepository } from '../../domain/incident/IncidentRepository';

export function listIncidents(repository: IncidentRepository): Promise<readonly Incident[]> {
  return repository.getAll();
}
