import type { Incident } from '../../domain/incident/Incident';
import type { IncidentRepository } from '../../domain/incident/IncidentRepository';

const FAKE_INCIDENTS: readonly Incident[] = [
  { id: 'inc-001', categoria: 'electrical', descripcion: 'Corto circuito en el laboratorio B2', estado: 'open' },
  { id: 'inc-002', categoria: 'water', descripcion: 'Fuga de agua en el pasillo del edificio A', estado: 'assigned' },
  { id: 'inc-003', categoria: 'connectivity', descripcion: 'Sin señal WiFi en la biblioteca', estado: 'in_progress' },
  { id: 'inc-004', categoria: 'equipment', descripcion: 'Proyector dañado en el salón 204', estado: 'resolved' },
];

/** Fake, deterministic implementation of IncidentRepository for the Week 2 skeleton. */
export class InMemoryIncidentRepository implements IncidentRepository {
  private readonly created: Incident[] = [];

  private all(): readonly Incident[] {
    return [...FAKE_INCIDENTS, ...this.created];
  }

  async getAll(): Promise<readonly Incident[]> {
    return this.all();
  }

  async getById(id: string): Promise<Incident | null> {
    return this.all().find((incident) => incident.id === id) ?? null;
  }

  async create(input: { categoria: string; descripcion: string; location: string }): Promise<Incident> {
    const incident: Incident = {
      id: `inc-${String(FAKE_INCIDENTS.length + this.created.length + 1).padStart(3, '0')}`,
      categoria: input.categoria as Incident['categoria'],
      descripcion: input.descripcion,
      estado: 'open',
    };
    this.created.push(incident);
    return incident;
  }
}