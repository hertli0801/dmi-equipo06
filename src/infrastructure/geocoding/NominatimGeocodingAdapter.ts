import type { GeocodingAttempt, GeocodingProvider } from '../../domain/location/GeocodingProvider';
import { DEFAULT_GEOCODING_TIMEOUT_MS, parseRetryAfterMs } from './HttpGeocodingAdapter';

export type NominatimAdapterOptions = Readonly<{
  /** Política de Nominatim: identificar la aplicación con un User-Agent propio. */
  userAgent: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}>;

/**
 * Proveedor externo real (OpenStreetMap Nominatim, sin credenciales). Traduce su
 * respuesta `[{ display_name, lat, lon }]` al mismo formato `{ label, latitude, longitude }`
 * que el doble controlado, para que el resto de la app no dependa del proveedor.
 * Uso: sólo ejecuciones manuales puntuales (máx. 1 solicitud/segundo); las pruebas usan el doble.
 */
export class NominatimGeocodingAdapter implements GeocodingProvider {
  readonly name = 'nominatim';
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: NominatimAdapterOptions) {
    this.baseUrl = (options.baseUrl ?? 'https://nominatim.openstreetmap.org').replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_GEOCODING_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
  }

  async geocode(query: string): Promise<GeocodingAttempt> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(
        `${this.baseUrl}/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`,
        { method: 'GET', headers: { Accept: 'application/json', 'User-Agent': this.options.userAgent }, signal: controller.signal },
      );
      if (response.status < 200 || response.status >= 300) {
        const retryAfterMs = response.status === 429 ? parseRetryAfterMs(response.headers.get('retry-after')) : undefined;
        return retryAfterMs === undefined
          ? { ok: false, status: response.status }
          : { ok: false, status: response.status, retryAfterMs };
      }
      let body: unknown;
      try {
        body = JSON.parse(await response.text());
      } catch {
        return { ok: true, value: null };
      }
      const first = Array.isArray(body) ? (body[0] as Record<string, unknown> | undefined) : undefined;
      if (!first || typeof first !== 'object') return { ok: true, value: null };
      // Nominatim entrega lat/lon como texto; si no son números válidos, la validación los rechaza.
      const toNumber = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v);
      return {
        ok: true,
        value: { label: first.display_name, latitude: toNumber(first.lat), longitude: toNumber(first.lon) },
      };
    } catch {
      return { ok: false, status: 'timeout' };
    } finally {
      clearTimeout(timer);
    }
  }
}
