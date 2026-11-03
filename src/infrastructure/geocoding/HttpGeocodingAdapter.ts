import type { GeocodingAttempt, GeocodingProvider } from '../../domain/location/GeocodingProvider';

const DEFAULT_URL = 'http://127.0.0.1:4310';
export const DEFAULT_GEOCODING_TIMEOUT_MS = 3000;

export type HttpGeocodingAdapterOptions = Readonly<{
  baseUrl?: string;
  /** Token del doble controlado del curso (no es una credencial real). */
  accessToken?: string;
  actorId?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Sólo pruebas/reportes: `X-Course-Scenario` para reproducir fallas del doble. */
  scenario?: string;
}>;

/** Convierte `Retry-After` (segundos o fecha HTTP) a milisegundos; undefined si no es válido. */
export function parseRetryAfterMs(header: string | null, nowMs: number = Date.now()): number | undefined {
  if (header === null || header.trim() === '') return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : undefined;
  const date = Date.parse(header);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - nowMs);
}

/**
 * Adaptador del doble de proveedor `GET /v1/geocoding?q=...` (docs/CAMPUSOPS_API.md).
 * Un intento por llamada con timeout propio vía AbortController.
 */
export class HttpGeocodingAdapter implements GeocodingProvider {
  readonly name = 'campusops-geocoding-double';
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpGeocodingAdapterOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_GEOCODING_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
  }

  async geocode(query: string): Promise<GeocodingAttempt> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${this.options.accessToken ?? 'course-valid-token'}`,
      'X-Course-Actor': this.options.actorId ?? 'reporter-1',
    };
    if (this.options.scenario) headers['X-Course-Scenario'] = this.options.scenario;

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/geocoding?q=${encodeURIComponent(query)}`, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      if (response.status < 200 || response.status >= 300) {
        const retryAfterMs = response.status === 429 ? parseRetryAfterMs(response.headers.get('retry-after')) : undefined;
        return retryAfterMs === undefined
          ? { ok: false, status: response.status }
          : { ok: false, status: response.status, retryAfterMs };
      }
      const text = await response.text();
      try {
        return { ok: true, value: JSON.parse(text) as unknown };
      } catch {
        // Cuerpo malformado: no es transitorio; se presenta como "sin resultado".
        return { ok: true, value: null };
      }
    } catch {
      // Abort por timeout o red caída: no se propaga a la UI.
      return { ok: false, status: 'timeout' };
    } finally {
      clearTimeout(timer);
    }
  }
}
