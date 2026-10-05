import type { IncidentCategory, IncidentStatus } from '../../campusops/contracts';
import type { Incident } from '../../domain/incident/Incident';
import type { IncidentRepository } from '../../domain/incident/IncidentRepository';
import { IncidentRemoteError } from '../../domain/incident/IncidentRemoteError';
import { parseRemoteResource } from '../../course-evaluation';

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

/** Dependencias sustituibles: las pruebas usan un fetch simulado y no necesitan Internet. */
export type CloudIncidentRepositoryOptions = Readonly<{
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Headers adicionales, p. ej. `X-Course-Scenario` para reproducir fallas del backend didáctico. */
  extraHeaders?: Readonly<Record<string, string>>;
  sleep?: (ms: number) => Promise<void>;
}>;

type RawResponse = Readonly<{ status: number; body: unknown }>;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function retryDelayMs(error: IncidentRemoteError, attempt: number): number {
  const retryAfter = error.failure.kind === 'http' ? error.failure.retryAfter : undefined;
  const seconds = retryAfter == null ? NaN : Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_DELAY_MS);
  return Math.min(300 * 2 ** (attempt - 1), MAX_DELAY_MS);
}

function isRetryable(error: IncidentRemoteError): boolean {
  const { failure } = error;
  return (
    failure.kind === 'timeout' ||
    failure.kind === 'network' ||
    failure.kind === 'serverError' ||
    (failure.kind === 'http' && failure.status === 429)
  );
}

/** DTO validado → objeto de dominio. Un payload `null` válido no se rellena con datos inventados. */
function toIncident(resource: Resource): Incident {
  if (!STATUSES.includes(resource.status as IncidentStatus)) {
    throw new IncidentRemoteError({ kind: 'contract' });
  }
  const p = resource.payload;
  if (p === null) {
    return { id: resource.id, categoria: null, descripcion: null, estado: resource.status as IncidentStatus };
  }
  if (
    typeof p.category !== 'string' ||
    !CATEGORIES.includes(p.category as IncidentCategory) ||
    typeof p.description !== 'string' ||
    p.description.trim() === ''
  ) {
    throw new IncidentRemoteError({ kind: 'contract' });
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
  if (!parsed.ok) throw new IncidentRemoteError({ kind: 'contract' });
  return toIncident(parsed.value as Resource);
}

export class CloudIncidentRepository implements IncidentRepository {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly extraHeaders: Readonly<Record<string, string>>;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly actorId: string,
    private readonly accessToken: string,
    private readonly baseUrl: string = process.env.EXPO_PUBLIC_COURSE_BACKEND_URL ?? DEFAULT_URL,
    options: CloudIncidentRepositoryOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    this.maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
    this.extraHeaders = options.extraHeaders ?? {};
    this.sleep = options.sleep ?? defaultSleep;
  }

  private authHeaders(): Record<string, string> {
    return {
      ...this.extraHeaders,
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.accessToken}`,
      'X-Course-Actor': this.actorId,
    };
  }

  /**
   * Única salida HTTP del cliente. Toda falla se convierte en IncidentRemoteError;
   * nunca se propaga un AbortError, TypeError o SyntaxError sin clasificar.
   */
  private async send(path: string, init: RequestInit = {}): Promise<RawResponse> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          ...init,
          headers: { ...this.authHeaders(), ...(init.headers as Record<string, string> | undefined) },
          signal: controller.signal,
        });
      } catch {
        throw new IncidentRemoteError(timedOut ? { kind: 'timeout', timeoutMs: this.timeoutMs } : { kind: 'network' });
      }
      if (response.status >= 500) throw new IncidentRemoteError({ kind: 'serverError', status: response.status });
      if (response.status === 404) return { status: 404, body: null };
      if (!response.ok) {
        const retryAfter = response.headers?.get('Retry-After');
        throw new IncidentRemoteError(
          retryAfter == null
            ? { kind: 'http', status: response.status }
            : { kind: 'http', status: response.status, retryAfter },
        );
      }

      let text: string;
      try {
        text = await response.text();
      } catch {
        throw new IncidentRemoteError(timedOut ? { kind: 'timeout', timeoutMs: this.timeoutMs } : { kind: 'network' });
      }
      try {
        return { status: response.status, body: JSON.parse(text) as unknown };
      } catch {
        throw new IncidentRemoteError({ kind: 'malformed' });
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async getAll(): Promise<readonly Incident[]> {
    const { body } = await this.send('/v1/incidents');
    const items = (body as { items?: unknown } | null)?.items;
    if (!Array.isArray(items)) throw new IncidentRemoteError({ kind: 'contract' });
    // Un solo elemento corrupto invalida la respuesta: no se muestra una lista parcial como si estuviera completa.
    return items.map(parseIncident);
  }

  async getById(id: string): Promise<Incident | null> {
    const { status, body } = await this.send(`/v1/incidents/${encodeURIComponent(id)}`);
    if (status === 404) return null;
    return parseIncident(body);
  }

  async create(input: { categoria: string; descripcion: string; location: string }): Promise<Incident> {
    // UNA clave por intento de creación, generada fuera del bucle: los reintentos la reutilizan.
    const idempotencyKey = `inc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    const body = JSON.stringify({
      category: input.categoria,
      description: input.descripcion,
      location: input.location,
    });

    for (let attempt = 1; ; attempt++) {
      try {
        const response = await this.send('/v1/incidents', {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotencyKey },
          body,
        });
        if (response.status === 404) throw new IncidentRemoteError({ kind: 'http', status: 404 });
        return parseIncident((response.body as { incident?: unknown } | null)?.incident);
      } catch (error) {
        if (!(error instanceof IncidentRemoteError) || !isRetryable(error) || attempt >= this.maxAttempts) {
          throw error;
        }
        await this.sleep(retryDelayMs(error, attempt));
      }
    }
  }
}
