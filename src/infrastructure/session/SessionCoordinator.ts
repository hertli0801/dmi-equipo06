import type { CampusRole } from '../../campusops/contracts';
import type { AuthEvent } from '../../course-evaluation/contracts';
import { IncidentRemoteError } from '../../domain/incident/IncidentRemoteError';
import type { SessionPort } from '../../domain/session/SessionPort';
import { clearSession, readRefreshToken, saveRefreshToken } from './secureSession';

const DEFAULT_URL = 'http://127.0.0.1:4310';
const TIMEOUT_MS = 8000;
const DEFAULT_EXPIRES_IN_S = 60;
const ROLES: readonly CampusRole[] = ['reporter', 'technician', 'coordinator'];

export type Session = Readonly<{ actorId: string; role: CampusRole }>;

export type SessionStore = Readonly<{
  save: (refreshToken: string) => Promise<void>;
  read: () => Promise<string | null>;
  clear: () => Promise<void>;
}>;

export type SessionCoordinatorOptions = Readonly<{
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  store?: SessionStore;
  /** Reloj inyectable: las pruebas avanzan el tiempo sin esperar de verdad. */
  now?: () => number;
  /** La app vuelve al login (sin bucle) cuando el refresh falla. */
  onSessionExpired?: () => void;
  /** Eventos compatibles con coordinateRefresh (sin tokens), útiles para pruebas y evidencia. */
  onEvent?: (event: AuthEvent) => void;
}>;

type Reply = Readonly<{ ok: boolean; status: number; body: Record<string, unknown> | null }>;

const defaultStore: SessionStore = { save: saveRefreshToken, read: readRefreshToken, clear: clearSession };

/** Dueño de la sesión: login, refresh single-flight por generación y logout. */
export class SessionCoordinator implements SessionPort {
  private accessToken: string | null = null;
  private session: Session | null = null;
  private generation = 0;
  private inflight: Promise<string | null> | null = null;
  private expiresAt = 0;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly store: SessionStore;
  private readonly now: () => number;

  constructor(private readonly options: SessionCoordinatorOptions = {}) {
    this.baseUrl = options.baseUrl ?? process.env.EXPO_PUBLIC_COURSE_BACKEND_URL ?? DEFAULT_URL;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.store = options.store ?? defaultStore;
    this.now = options.now ?? Date.now;
  }

  getAccessToken(): string | null {
    return this.accessToken;
  }

  getGeneration(): number {
    return this.generation;
  }

  getSession(): Session | null {
    return this.session;
  }

  /** true cuando hay sesión y el access token ya alcanzó su `expiresIn` según el reloj. */
  isExpired(): boolean {
    return this.session !== null && this.now() >= this.expiresAt;
  }

  async login(actorId: string): Promise<Session> {
    const reply = await this.post('/v1/session/login', { actorId });
    const body = reply.body;
    if (!reply.ok) throw new IncidentRemoteError({ kind: 'http', status: reply.status });
    if (
      !body ||
      typeof body.accessToken !== 'string' ||
      typeof body.refreshToken !== 'string' ||
      typeof body.actorId !== 'string' ||
      !ROLES.includes(body.role as CampusRole)
    ) {
      throw new IncidentRemoteError({ kind: 'contract' });
    }
    await this.store.save(body.refreshToken);
    this.accessToken = body.accessToken;
    this.session = { actorId: body.actorId, role: body.role as CampusRole };
    this.generation += 1;
    this.startExpiry(body.expiresIn);
    return this.session;
  }

  refresh(requestGeneration: number, requestId: string): Promise<string | null> {
    this.emit({ type: 'request401', requestId, generation: requestGeneration });
    if (this.session === null) return Promise.resolve(null); // sesión cerrada o expirada: no hay nada que renovar
    if (requestGeneration < this.generation) return Promise.resolve(this.accessToken); // otro ya renovó
    if (this.inflight === null) {
      this.inflight = this.runRefresh(requestGeneration).finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight; // peticiones concurrentes: misma promesa, un solo refresh
  }

  async logout(): Promise<void> {
    this.accessToken = null;
    this.session = null;
    this.generation += 1;
    await this.store.clear().catch(() => undefined);
    this.emit({ type: 'logout' });
  }

  private async runRefresh(generation: number): Promise<string | null> {
    try {
      const refreshToken = await this.store.read();
      if (!refreshToken) throw new Error('sin refresh token');
      const reply = await this.post('/v1/session/refresh', { refreshToken });
      const body = reply.body;
      // Respuesta obsoleta: hubo logout o un login nuevo mientras volaba. Se descarta sin persistir nada.
      if (this.isStale(generation)) return null;
      if (!reply.ok || !body || typeof body.accessToken !== 'string' || typeof body.refreshToken !== 'string') {
        throw new Error('refresh rechazado');
      }
      await this.store.save(body.refreshToken);
      this.accessToken = body.accessToken;
      this.generation = generation + 1;
      this.startExpiry(body.expiresIn);
      this.emit({ type: 'refreshSucceeded', generation: this.generation });
      return this.accessToken;
    } catch {
      // Un fallo de una sesión que ya no está vigente no debe cerrar la sesión nueva.
      if (!this.isStale(generation)) await this.expire(generation);
      return null;
    }
  }

  private isStale(generation: number): boolean {
    return this.session === null || this.generation !== generation;
  }

  private startExpiry(expiresIn: unknown): void {
    const seconds = typeof expiresIn === 'number' && expiresIn > 0 ? expiresIn : DEFAULT_EXPIRES_IN_S;
    this.expiresAt = this.now() + seconds * 1000;
  }

  private async expire(generation: number): Promise<void> {
    this.accessToken = null;
    this.session = null;
    await this.store.clear().catch(() => undefined);
    this.emit({ type: 'refreshFailed', generation });
    this.options.onSessionExpired?.();
  }

  private emit(event: AuthEvent): void {
    this.options.onEvent?.(event);
  }

  private async post(path: string, payload: Record<string, unknown>): Promise<Reply> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch {
        throw new IncidentRemoteError({ kind: 'network' });
      }
      if (response.status >= 500) throw new IncidentRemoteError({ kind: 'serverError', status: response.status });
      let body: Record<string, unknown> | null = null;
      try {
        body = JSON.parse(await response.text()) as Record<string, unknown>;
      } catch {
        if (response.ok) throw new IncidentRemoteError({ kind: 'malformed' });
      }
      return { ok: response.ok, status: response.status, body };
    } finally {
      clearTimeout(timer);
    }
  }
}