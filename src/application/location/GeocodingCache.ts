import type { ProviderLocation } from '../../domain/location/selectIncidentLocation';

export const DEFAULT_GEOCODING_CACHE_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_GEOCODING_CACHE_MAX_ENTRIES = 100;

/** Llave de caché: misma consulta sin importar mayúsculas ni espacios extra. */
export function normalizeGeocodingQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ');
}

export type GeocodingCacheOptions = Readonly<{
  ttlMs?: number;
  maxEntries?: number;
  nowMs?: () => number;
}>;

/**
 * Caché en memoria con TTL. Sólo guarda ubicaciones ya validadas: nunca errores,
 * null ni respuestas incompletas (si no, un fallo pasajero quedaría "pegado").
 */
export class GeocodingCache {
  private readonly entries = new Map<string, { value: ProviderLocation; expiresAt: number }>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly nowMs: () => number;

  constructor(options: GeocodingCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_GEOCODING_CACHE_TTL_MS;
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_GEOCODING_CACHE_MAX_ENTRIES);
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  get(query: string): ProviderLocation | null {
    const key = normalizeGeocodingQuery(query);
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (this.nowMs() >= entry.expiresAt) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  set(query: string, value: ProviderLocation): void {
    const key = normalizeGeocodingQuery(query);
    this.entries.delete(key);
    if (this.entries.size >= this.maxEntries) {
      // Expulsa la entrada más antigua (Map conserva orden de inserción).
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: this.nowMs() + this.ttlMs });
  }

  get size(): number {
    return this.entries.size;
  }
}
