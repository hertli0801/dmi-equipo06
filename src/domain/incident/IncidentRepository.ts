import type { Incident } from './Incident';

/** Contract Application depends on; Infrastructure provides an implementation. */
export interface IncidentRepository {
  getAll(): Promise<readonly Incident[]>;
  getById(id: string): Promise<Incident | null>;
    create(input: { categoria: string; descripcion: string; location: string }): Promise<Incident>;

}
