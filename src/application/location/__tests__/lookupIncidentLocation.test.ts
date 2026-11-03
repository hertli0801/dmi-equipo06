import type { GeocodingAttempt, GeocodingProvider } from '../../../domain/location/GeocodingProvider';
import type { Telemetry } from '../../telemetry/Telemetry';
import { GeocodingCache, normalizeGeocodingQuery } from '../GeocodingCache';
import { createLocationLookup } from '../lookupIncidentLocation';

const VALID = { label: 'Edificio de prueba A', latitude: 0, longitude: 0 };

/** Doble del proveedor: devuelve la secuencia programada y cuenta llamadas. */
function scriptedProvider(...script: GeocodingAttempt[]): GeocodingProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: 'scripted',
    calls,
    async geocode(query) {
      calls.push(query);
      return script[Math.min(calls.length - 1, script.length - 1)] as GeocodingAttempt;
    },
  };
}

function recordingTelemetry(): Telemetry & { entries: Record<string, unknown>[] } {
  const entries: Record<string, unknown>[] = [];
  return {
    entries,
    info: (event, context = {}) => entries.push({ event, ...context }),
    error: (event, _error, context = {}) => entries.push({ event, ...context }),
  };
}

const sleeps: number[] = [];
const fakeSleep = async (ms: number) => {
  sleeps.push(ms);
};

beforeEach(() => {
  sleeps.length = 0;
});

describe('createLocationLookup: caché', () => {
  test('la segunda consulta igual (mayúsculas/espacios) no llama a la red', async () => {
    const provider = scriptedProvider({ ok: true, value: VALID });
    const find = createLocationLookup({ provider, sleep: fakeSleep });
    expect(await find('Edificio A')).toEqual(VALID);
    expect(await find('  edificio   a ')).toEqual(VALID);
    expect(provider.calls).toHaveLength(1);
  });

  test('una entrada expirada vuelve a consultar al proveedor', async () => {
    let now = 0;
    const provider = scriptedProvider({ ok: true, value: VALID });
    const cache = new GeocodingCache({ ttlMs: 1000, nowMs: () => now });
    const find = createLocationLookup({ provider, cache, sleep: fakeSleep });
    await find('Edificio A');
    now = 999;
    await find('Edificio A');
    expect(provider.calls).toHaveLength(1);
    now = 1000;
    await find('Edificio A');
    expect(provider.calls).toHaveLength(2);
  });

  test.each<[string, GeocodingAttempt]>([
    ['incompleta', { ok: true, value: { label: 'Zona ficticia' } }],
    ['coordenadas inválidas', { ok: true, value: { label: 'Zona ficticia', latitude: 999, longitude: null } }],
    ['malformada', { ok: true, value: null }],
    ['no reintentable 422', { ok: false, status: 422 }],
  ])('no guarda respuesta %s en caché', async (_name, attempt) => {
    const provider = scriptedProvider(attempt);
    const cache = new GeocodingCache();
    const find = createLocationLookup({ provider, cache, sleep: fakeSleep });
    expect(await find('Edificio A')).toBeNull();
    expect(await find('Edificio A')).toBeNull();
    expect(cache.size).toBe(0);
    expect(provider.calls).toHaveLength(2);
  });

  test('normalizeGeocodingQuery y límite de entradas', () => {
    expect(normalizeGeocodingQuery('  Edificio \n  A ')).toBe('edificio a');
    const cache = new GeocodingCache({ maxEntries: 2 });
    cache.set('a', VALID);
    cache.set('b', VALID);
    cache.set('c', VALID);
    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBeNull();
    expect(cache.get('c')).toEqual(VALID);
  });
});

describe('createLocationLookup: reintentos con retryWithPolicy', () => {
  test('429 con Retry-After: espera exactamente lo indicado y luego obtiene resultado', async () => {
    const provider = scriptedProvider({ ok: false, status: 429, retryAfterMs: 1000 }, { ok: true, value: VALID });
    const find = createLocationLookup({ provider, sleep: fakeSleep });
    expect(await find('Edificio A')).toEqual(VALID);
    expect(provider.calls).toHaveLength(2);
    expect(sleeps).toEqual([1000]);
  });

  test.each<[string, GeocodingAttempt]>([
    ['timeout/desconexión', { ok: false, status: 'timeout' }],
    ['500', { ok: false, status: 500 }],
    ['429 persistente', { ok: false, status: 429, retryAfterMs: 1000 }],
  ])('%s persistente: se detiene tras el intento 4 (3 reintentos), esperas finitas y luego null', async (_name, attempt) => {
    const provider = scriptedProvider(attempt);
    const telemetry = recordingTelemetry();
    const find = createLocationLookup({ provider, sleep: fakeSleep, telemetry });
    expect(await find('Edificio A')).toBeNull();
    expect(provider.calls).toHaveLength(4);
    expect(sleeps).toHaveLength(3);
    expect(sleeps.every((ms) => Number.isFinite(ms) && ms <= 30_000)).toBe(true);
    expect(telemetry.entries.at(-1)).toMatchObject({ event: 'geocoding.lookup', outcome: 'gave_up', attempt: 4 });
  });

  test('backoff progresivo sin Retry-After (500, 1000, 2000 ms)', async () => {
    const provider = scriptedProvider({ ok: false, status: 503 });
    await createLocationLookup({ provider, sleep: fakeSleep })('Edificio A');
    expect(sleeps).toEqual([500, 1000, 2000]);
    expect(provider.calls).toHaveLength(4);
  });

  test('la política es configurable: con noRetryFromAttempt=2 hay un solo reintento', async () => {
    const provider = scriptedProvider({ ok: false, status: 'timeout' });
    const find = createLocationLookup({
      provider,
      sleep: fakeSleep,
      policy: { noRetryFromAttempt: 2, baseDelayMs: 100, maxDelayMs: 1000 },
    });
    expect(await find('Edificio A')).toBeNull();
    expect(provider.calls).toHaveLength(2);
    expect(sleeps).toEqual([100]);
  });

  test('Retry-After mayor al tope no se acorta: se deja de reintentar', async () => {
    const provider = scriptedProvider({ ok: false, status: 429, retryAfterMs: 120_000 });
    expect(await createLocationLookup({ provider, sleep: fakeSleep })('Edificio A')).toBeNull();
    expect(provider.calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  test('un proveedor que lanza no rompe la UI y los logs no llevan consulta ni coordenadas', async () => {
    const telemetry = recordingTelemetry();
    const provider: GeocodingProvider = {
      name: 'throws',
      geocode: async () => {
        throw new Error('red caída');
      },
    };
    expect(await createLocationLookup({ provider, sleep: fakeSleep, telemetry })('Calle Secreta 123')).toBeNull();
    const ok = createLocationLookup({ provider: scriptedProvider({ ok: true, value: VALID }), telemetry, sleep: fakeSleep });
    await ok('Calle Secreta 123');
    const logged = JSON.stringify(telemetry.entries);
    expect(logged).not.toMatch(/Secreta|latitude|longitude|Edificio de prueba/);
  });

  test('consulta vacía no llama al proveedor', async () => {
    const provider = scriptedProvider({ ok: true, value: VALID });
    expect(await createLocationLookup({ provider })('   ')).toBeNull();
    expect(provider.calls).toHaveLength(0);
  });
});
