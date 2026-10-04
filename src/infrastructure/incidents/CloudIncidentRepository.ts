import type { IncidentCategory, IncidentStatus } from '../../campusops/contracts';
import type { Incident } from '../../domain/incident/Incident';
import type { IncidentRepository } from '../../domain/incident/IncidentRepository';
import { parseRemoteResource } from '../../course-evaluation'; // ajusta el import real una vez que exista en main

const DEFAULT_URL = 'http://127.0.0.1:4310';
const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 8000;
const MAX_DELAY_MS = 5000;

const CATEGORIES: readonly IncidentCategory[] = [
  'electrical', 'laboratory', 'water', 'connectivity',
  'equipment', 'safety', 'maintenance',
];
const STATUSES: readonly IncidentStatus[] = [
  'open', 'assigned', 'in_progress', 'resolved', 'closed',
];

type Resource = { id: string; status: string; payload: Record<string, unknown> | null };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function retryDelayMs(response: Response | null, attempt: number): number {
  const header = response?.headers.get('Retry-After');
  const seconds = header == null ? NaN : Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_DELAY_MS);
  return Math.min(300 * 2 ** (attempt - 1), MAX_DELAY_MS);
}

function toIncident(resource: Resource): Incident {
  const p = resource.payload;
  if (
    p === null ||
    typeof p.category !== 'string' ||
    !CATEGORIES.includes(p.category as IncidentCategory) ||
    typeof p.description !== 'string' ||
    p.description.trim() === '' ||
    !STATUSES.includes(resource.status as IncidentStatus)
  ) {
    throw new Error('Incidencia remota inválida');
  }
  return {
    id: resource.id,
    categoria: p.category as IncidentCategory,
    descripcion: p.description,
    estado: resource.status as IncidentStatus,
  };
}

function parseIncident(raw: unknown): Incident {
  const parsed = parseRemoteResource(raw);
  if (!parsed.ok) throw new Error('Respuesta del servidor no cumple el contrato esperado');
  return toIncident(parsed.value as Resource);
}

export class CloudIncidentRepository implements IncidentRepository {
  constructor(
    private readonly actorId: string,
    private readonly accessToken: string,
    private readonly baseUrl: string = process.env.EXPO_PUBLIC_COURSE_BACKEND_URL ?? DEFAULT_URL,
  ) {}

  private authHeaders() {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.accessToken}`,
      'X-Course-Actor': this.actorId,
    };
  }

  async getAll(): Promise<readonly Incident[]> {
    const response = await fetch(`${this.baseUrl}/v1/incidents`, { headers: this.authHeaders() });
    if (!response.ok) throw new Error(`No fue posible listar incidencias (${response.status})`);
    const raw: unknown = await response.json();
    const items = Array.isArray((raw as { items?: unknown })?.items)
      ? (raw as { items: unknown[] }).items
      : [];
    const result: Incident[] = [];
    for (const item of items) {
      try {
        result.push(parseIncident(item));
      } catch {
        // descarta el elemento inválido; no registres datos sensibles aquí
      }
    }
    return result;
  }

  async getById(id: string): Promise<Incident | null> {
    const response = await fetch(`${this.baseUrl}/v1/incidents/${encodeURIComponent(id)}`, {
      headers: this.authHeaders(),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`No fue posible consultar la incidencia (${response.status})`);
    return parseIncident(await response.json());
  }

  async create(input: { categoria: string; descripcion: string; location: string }): Promise<Incident> {
    const idempotencyKey = `inc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`; // UNA vez, fuera del bucle // UNA vez, fuera del bucle de reintentos
    const body = JSON.stringify({
      category: input.categoria,
      description: input.descripcion,
      location: input.location,
    });

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let response: Response | null = null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        response = await fetch(`${this.baseUrl}/v1/incidents`, {
          method: 'POST',
          headers: { ...this.authHeaders(), 'Idempotency-Key': idempotencyKey }, // misma clave siempre
          body,
          signal: controller.signal,
        });
      } catch {
        response = null; // timeout o red caída: el servidor pudo haber guardado
      } finally {
        clearTimeout(timer);
      }

           if (response?.ok) {
        const raw: unknown = await response.json();
        const envelope = (raw as { incident?: unknown })?.incident;
        return parseIncident(envelope);
      }

      const retryable = response === null || response.status === 429 || response.status >= 500;
      if (!retryable || attempt === MAX_ATTEMPTS) {
        throw new Error(`No fue posible crear la incidencia (${response?.status ?? 'sin respuesta'})`);
      }
      await sleep(retryDelayMs(response, attempt));
    }
    throw new Error('No fue posible crear la incidencia');
  }
}