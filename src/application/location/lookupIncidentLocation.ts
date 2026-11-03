import type { RetryPolicy } from '../../course-evaluation';
import type { GeocodingProvider } from '../../domain/location/GeocodingProvider';
import { parseProviderLocation, type ProviderLocation } from '../../domain/location/selectIncidentLocation';
import { retryWithPolicy } from '../resilience/retryWithPolicy';
import { noopTelemetry, type Telemetry } from '../telemetry/Telemetry';
import { GeocodingCache } from './GeocodingCache';

export type LocationLookupDeps = Readonly<{
  provider: GeocodingProvider;
  cache?: GeocodingCache;
  policy?: RetryPolicy;
  sleep?: (ms: number) => Promise<void>;
  nowMs?: () => number;
  telemetry?: Telemetry;
}>;

/**
 * Crea `findLocation(query)` para la pantalla de crear incidencia:
 * 1) caché; 2) proveedor con `retryWithPolicy` (GET, intentos acotados, respeta Retry-After);
 * 3) valida; sólo un resultado válido se guarda en caché.
 * Nunca lanza: si el proveedor no sirve devuelve null y la UI usa la ubicación manual.
 * Los logs sólo llevan datos técnicos (nunca la consulta ni coordenadas).
 */
export function createLocationLookup(deps: LocationLookupDeps): (query: string) => Promise<ProviderLocation | null> {
  const cache = deps.cache ?? new GeocodingCache();
  const telemetry = deps.telemetry ?? noopTelemetry;
  const nowMs = deps.nowMs ?? (() => Date.now());

  return async function findLocation(query: string): Promise<ProviderLocation | null> {
    if (query.trim() === '') return null;

    const cached = cache.get(query);
    if (cached) {
      telemetry.info('geocoding.lookup', { provider: deps.provider.name, outcome: 'cache_hit', attempt: 0, durationMs: 0 });
      return cached;
    }

    const started = nowMs();
    try {
      const result = await retryWithPolicy(() => deps.provider.geocode(query), {
        method: 'GET',
        ...(deps.policy ? { policy: deps.policy } : {}),
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
        ...(deps.nowMs ? { nowMs: deps.nowMs } : {}),
      });
      const attempts = result.attempts.length;
      const durationMs = Math.max(0, nowMs() - started);

      if (result.outcome !== 'success') {
        telemetry.info('geocoding.lookup', {
          provider: deps.provider.name,
          outcome: result.outcome,
          status: result.lastStatus,
          attempt: attempts,
          durationMs,
        });
        return null;
      }

      const location = parseProviderLocation(result.value);
      telemetry.info('geocoding.lookup', {
        provider: deps.provider.name,
        outcome: location ? 'valid' : 'invalid_or_incomplete',
        attempt: attempts,
        durationMs,
      });
      if (location) cache.set(query, location);
      return location;
    } catch (error) {
      telemetry.error('geocoding.lookup_failed', error, { provider: deps.provider.name });
      return null;
    }
  };
}
