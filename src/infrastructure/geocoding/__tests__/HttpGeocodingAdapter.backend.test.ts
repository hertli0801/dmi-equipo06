import { spawn, type ChildProcess } from 'node:child_process';
import { request, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';

import { selectIncidentLocation } from '../../../domain/location/selectIncidentLocation';
import { HttpGeocodingAdapter, parseRetryAfterMs } from '../HttpGeocodingAdapter';

/**
 * Escenarios de geocodificación contra el doble controlado del curso (127.0.0.1, puerto libre).
 * jest-expo reemplaza `fetch`; se inyecta uno mínimo sobre node:http que respeta AbortSignal.
 */
const nodeHttpFetch = ((url: string, init: RequestInit = {}) =>
  new Promise<Response>((done, fail) => {
    const req = request(url, { method: init.method ?? 'GET', headers: init.headers as Record<string, string> }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', fail);
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        done({
          status,
          ok: status >= 200 && status < 300,
          headers: { get: (name: string) => (res.headers[name.toLowerCase()] as string | undefined) ?? null },
          text: async () => Buffer.concat(chunks).toString('utf8'),
        } as unknown as Response);
      });
    });
    init.signal?.addEventListener('abort', () => {
      req.destroy();
      fail(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
    req.on('error', fail);
    req.end();
  })) as unknown as typeof fetch;

const SERVER = resolve(__dirname, '../../../../course-backend/server.mjs');
const QUERY = 'Edificio ficticio A';
const MANUAL = 'Edificio A, pasillo norte (ficticio)';

let backend: { baseUrl: string; stop: () => void };

async function startBackend(): Promise<{ baseUrl: string; stop: () => void }> {
  const child: ChildProcess = spawn(process.execPath, [SERVER], {
    env: { ...process.env, COURSE_BACKEND_HOST: '127.0.0.1', COURSE_BACKEND_PORT: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const baseUrl = await new Promise<string>((done, fail) => {
    const timer = setTimeout(() => fail(new Error('el backend no arrancó')), 10_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      const match = /listening at (http:\/\/[^\s]+)/.exec(chunk.toString());
      if (match?.[1]) {
        clearTimeout(timer);
        done(match[1].replace(/\/$/, ''));
      }
    });
    child.on('error', fail);
  });
  return {
    baseUrl,
    stop: () => {
      child.stdout?.destroy();
      child.kill();
    },
  };
}

function adapter(scenario: string, timeoutMs = 3000, baseUrl = backend.baseUrl) {
  return new HttpGeocodingAdapter({ baseUrl, scenario, timeoutMs, fetchImpl: nodeHttpFetch });
}

beforeAll(async () => {
  backend = await startBackend();
}, 15_000);

afterAll(() => backend?.stop());

describe('HttpGeocodingAdapter contra el doble del curso', () => {
  test('success: resultado válido (0,0) → ubicación del proveedor', async () => {
    const attempt = await adapter('success').geocode(QUERY);
    expect(attempt).toEqual({ ok: true, value: { label: 'Edificio de prueba A', latitude: 0, longitude: 0 } });
    expect(selectIncidentLocation(attempt.ok ? attempt.value : null, MANUAL)).toMatchObject({ source: 'provider' });
  });

  test.each(['incomplete', 'invalid_coordinates', 'malformed'])(
    '%s: 200 sin datos útiles → ok pero la selección queda manual',
    async (scenario) => {
      const attempt = await adapter(scenario).geocode(QUERY);
      expect(attempt.ok).toBe(true);
      expect(selectIncidentLocation(attempt.ok ? attempt.value : null, MANUAL)).toEqual({ source: 'manual', label: MANUAL });
    },
  );

  test('rate_limited: 429 con Retry-After convertido a milisegundos', async () => {
    expect(await adapter('rate_limited').geocode(QUERY)).toEqual({ ok: false, status: 429, retryAfterMs: 1000 });
  });

  test('server_error: 500 como dato, sin lanzar', async () => {
    expect(await adapter('server_error').geocode(QUERY)).toEqual({ ok: false, status: 500 });
  });

  test('slow: el timeout propio (300 ms) aborta antes de los 1200 ms del doble', async () => {
    const started = Date.now();
    expect(await adapter('slow', 300).geocode(QUERY)).toEqual({ ok: false, status: 'timeout' });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test('consulta vacía: 422 del doble se devuelve como dato no reintentable', async () => {
    expect(await adapter('success').geocode('')).toEqual({ ok: false, status: 422 });
  });

  test('desconexión: servidor cerrado → timeout como dato, sin excepción', async () => {
    const closed = createServer();
    await new Promise<void>((done) => closed.listen(0, '127.0.0.1', done));
    const { port } = closed.address() as AddressInfo;
    await new Promise<void>((done) => closed.close(() => done()));
    expect(await adapter('success', 1000, `http://127.0.0.1:${port}`).geocode(QUERY)).toEqual({ ok: false, status: 'timeout' });
  });
});

describe('parseRetryAfterMs', () => {
  test('segundos, fecha HTTP e inválidos', () => {
    expect(parseRetryAfterMs('1')).toBe(1000);
    expect(parseRetryAfterMs('0')).toBe(0);
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs('-5')).toBeUndefined();
    expect(parseRetryAfterMs('pronto')).toBeUndefined();
    const now = Date.parse('2026-11-02T10:00:00Z');
    expect(parseRetryAfterMs('Mon, 02 Nov 2026 10:00:02 GMT', now)).toBe(2000);
  });
});
