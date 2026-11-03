/**
 * Ejecución REAL y puntual contra un proveedor externo (OpenStreetMap Nominatim, sin credenciales).
 * No forma parte de la suite normal: sólo corre si se pide explícitamente.
 *   LIVE_GEOCODING=1 npx jest --testMatch '**\/scripts/week-09-geocoding-live.ts' --no-watchman --ci --runInBand
 * Hace UNA solicitud con una consulta genérica ficticia y un User-Agent propio (política de Nominatim).
 * Sólo imprime datos técnicos sanitizados: nunca la respuesta, el label ni las coordenadas.
 */
import { request } from 'node:https';

import { createLocationLookup } from '../src/application/location/lookupIncidentLocation';
import type { GeocodingAttempt, GeocodingProvider } from '../src/domain/location/GeocodingProvider';
import { NominatimGeocodingAdapter } from '../src/infrastructure/geocoding/NominatimGeocodingAdapter';

jest.useRealTimers();
jest.setTimeout(30_000);

const QUERY = 'Ciudad de Mexico';
const USER_AGENT = 'CampusOps-DMI-equipo06/1.0 (proyecto academico; contacto via repositorio)';

/** jest-expo reemplaza `fetch`: fetch mínimo sobre node:https que respeta AbortSignal. */
const nodeHttpsFetch = ((url: string, init: RequestInit = {}) =>
  new Promise<Response>((done, fail) => {
    const req = request(url, { method: init.method ?? 'GET', headers: init.headers as Record<string, string> }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', fail);
      res.on('end', () =>
        done({
          status: res.statusCode ?? 0,
          headers: { get: (name: string) => (res.headers[name.toLowerCase()] as string | undefined) ?? null },
          text: async () => Buffer.concat(chunks).toString('utf8'),
        } as unknown as Response),
      );
    });
    init.signal?.addEventListener('abort', () => {
      req.destroy();
      fail(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
    req.on('error', fail);
    req.end();
  })) as unknown as typeof fetch;

const live = process.env.LIVE_GEOCODING === '1' ? test : test.skip;

live('una consulta real a Nominatim con el adaptador y la política de la app', async () => {
  const statuses: (number | 'timeout' | 'ok')[] = [];
  const nominatim = new NominatimGeocodingAdapter({ userAgent: USER_AGENT, timeoutMs: 5000, fetchImpl: nodeHttpsFetch });
  // Envoltura sólo para observar el estado de cada intento (sin guardar datos de la respuesta).
  const observed: GeocodingProvider = {
    name: nominatim.name,
    async geocode(query): Promise<GeocodingAttempt> {
      const attempt = await nominatim.geocode(query);
      statuses.push(attempt.ok ? 'ok' : attempt.status);
      return attempt;
    },
  };
  // Un solo intento: respetar la cuota pública (máx. 1 solicitud/segundo).
  const find = createLocationLookup({ provider: observed, policy: { noRetryFromAttempt: 1, baseDelayMs: 0, maxDelayMs: 0 } });

  const startedAt = new Date();
  const t0 = Date.now();
  const location = await find(QUERY);
  const latencyMs = Date.now() - t0;
  const cachedAgain = await find(QUERY);

  const summary = {
    provider: 'OpenStreetMap Nominatim',
    baseUrl: 'https://nominatim.openstreetmap.org',
    executedAt: startedAt.toISOString(),
    query: 'consulta genérica ficticia (no se registra)',
    attempts: statuses.length,
    attemptResults: statuses,
    latencyMs,
    validCoordinates: location !== null ? 'sí' : 'no',
    secondLookupServedFromCache: cachedAgain !== null && statuses.length === 1,
  };
  console.log(`WEEK09_LIVE_GEOCODING ${JSON.stringify(summary)}`);
  expect(statuses.length).toBe(1);
});
