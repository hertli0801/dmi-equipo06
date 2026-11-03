import { NominatimGeocodingAdapter } from '../NominatimGeocodingAdapter';

describe('NominatimGeocodingAdapter (mapeo con fetch simulado, sin red)', () => {
  const fakeFetch = (status: number, body: string, headers: Record<string, string> = {}) =>
    (async () =>
      ({
        status,
        headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
        text: async () => body,
      }) as unknown as Response) as unknown as typeof fetch;

  test('traduce display_name/lat/lon al formato común', async () => {
    const adapter = new NominatimGeocodingAdapter({
      userAgent: 'test',
      fetchImpl: fakeFetch(200, JSON.stringify([{ display_name: 'Lugar ficticio', lat: '10.5', lon: '-20.25' }])),
    });
    expect(await adapter.geocode('x')).toEqual({ ok: true, value: { label: 'Lugar ficticio', latitude: 10.5, longitude: -20.25 } });
  });

  test('sin resultados, malformado y 429', async () => {
    expect(await new NominatimGeocodingAdapter({ userAgent: 't', fetchImpl: fakeFetch(200, '[]') }).geocode('x')).toEqual({ ok: true, value: null });
    expect(await new NominatimGeocodingAdapter({ userAgent: 't', fetchImpl: fakeFetch(200, '{') }).geocode('x')).toEqual({ ok: true, value: null });
    expect(
      await new NominatimGeocodingAdapter({ userAgent: 't', fetchImpl: fakeFetch(429, '', { 'retry-after': '2' }) }).geocode('x'),
    ).toEqual({ ok: false, status: 429, retryAfterMs: 2000 });
  });
});
