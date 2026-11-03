/**
 * Genera reports/week-09/fault-injection.json ejecutando fallos REALES contra el backend didactico:
 * 8 casos de geocodificacion (adaptador + cache + retryWithPolicy + selectIncidentLocation) y 2 de
 * respuesta perdida tras guardar (misma clave estable). Sin coordenadas, consultas ni tokens en el reporte.
 * Uso: npx jest --testMatch '**\/scripts/week-09-fault-injection.ts' --no-watchman --ci --runInBand
 * El commitSha sale de WEEK09_SHA o, si no existe, de `git rev-parse HEAD`.
 */
import { execSync, spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createLocationLookup } from '../src/application/location/lookupIncidentLocation';
import { retryWithPolicy, type AttemptResult } from '../src/application/resilience/retryWithPolicy';
import { createTelemetry, type TelemetryEntry } from '../src/application/telemetry/Telemetry';
import { DEFAULT_RETRY_POLICY } from '../src/course-evaluation';
import { selectIncidentLocation } from '../src/domain/location/selectIncidentLocation';
import { HttpGeocodingAdapter } from '../src/infrastructure/geocoding/HttpGeocodingAdapter';

jest.useRealTimers();
jest.setTimeout(120_000);

const COMMAND = "npx jest --testMatch '**/scripts/week-09-fault-injection.ts' --no-watchman --ci --runInBand";
const INCIDENT = '/v1/incidents/campus-inc-001';
const QUERY = 'Edificio ficticio A';
const MANUAL = 'Edificio A, pasillo norte (ficticio)';
const MAX_REQUESTS = DEFAULT_RETRY_POLICY.noRetryFromAttempt;

type Reply = Readonly<{ status: number; body: unknown }>;
type Check = {
  id: string;
  status: 'pass' | 'fail';
  scenarioType: 'nominal' | 'boundary' | 'failure';
  command: string;
  evidence: string;
};

// jest-expo reemplaza `fetch`; se inyecta uno minimo sobre node:http que respeta AbortSignal.
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

function startBackend(): Promise<{ port: number; stop: () => void }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['course-backend/server.mjs'], {
      env: { ...process.env, COURSE_BACKEND_HOST: '127.0.0.1', COURSE_BACKEND_PORT: '0' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let done = false;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('el backend no arranco en 10 s'));
    }, 10_000);
    child.stdout.on('data', (chunk: Buffer) => {
      const match = /listening at http:\/\/[^:]+:(\d+)/.exec(chunk.toString());
      if (match && !done) {
        done = true;
        clearTimeout(timer);
        resolve({
          port: Number(match[1]),
          stop: () => {
            child.stdout.destroy();
            child.kill();
          },
        });
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

type CallOptions = Readonly<{ scenario?: string; key?: string; body?: unknown; timeoutMs: number }>;

function call(port: number, method: 'GET' | 'POST', path: string, options: CallOptions): Promise<Reply | 'timeout'> {
  return new Promise((resolve) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const headers: Record<string, string> = { authorization: 'Bearer course-valid-token', 'x-course-actor': 'technician-1' };
    if (options.scenario !== undefined) headers['x-course-scenario'] = options.scenario;
    if (options.key !== undefined) headers['idempotency-key'] = options.key;
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(payload));
    }
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        let body: unknown = null;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          body = null;
        }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    // El cliente aborta por su PROPIO timeout; el servidor puede haber guardado ya el cambio.
    req.setTimeout(options.timeoutMs, () => {
      req.destroy();
      resolve('timeout');
    });
    req.on('error', () => resolve('timeout'));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

type IncidentView = { version: number; status: string; payload: { history: { operationId: string }[] } };

async function readIncident(port: number): Promise<IncidentView> {
  const reply = await call(port, 'GET', INCIDENT, { timeoutMs: 3000 });
  if (reply === 'timeout' || reply.status !== 200) throw new Error('no se pudo leer la incidencia de prueba');
  return reply.body as IncidentView;
}

type GeoRun = Readonly<{
  outcome: string;
  source: string;
  hasCoordinates: boolean;
  usableLabel: boolean;
  requests: number;
  elapsedMs: number;
}>;

/** Ejecuta la busqueda real (adaptador -> reintentos -> validacion) y la eleccion final de ubicacion. */
async function runGeocoding(baseUrl: string, scenario: string | undefined, timeoutMs: number): Promise<GeoRun> {
  let requests = 0;
  const entries: TelemetryEntry[] = [];
  const telemetry = createTelemetry({ write: (entry) => void entries.push(entry) });
  const provider = new HttpGeocodingAdapter({
    baseUrl,
    timeoutMs,
    fetchImpl: ((...args: Parameters<typeof fetch>) => {
      requests += 1;
      return nodeHttpFetch(...args);
    }) as typeof fetch,
    ...(scenario === undefined ? {} : { scenario }),
  });
  const findLocation = createLocationLookup({ provider, telemetry });
  const started = Date.now();
  const found = await findLocation(QUERY);
  const elapsedMs = Date.now() - started;
  const selected = selectIncidentLocation(found, MANUAL);
  const lookup = entries.find((entry) => entry.event === 'geocoding.lookup');
  const outcome = String((lookup?.context as Record<string, unknown> | undefined)?.outcome ?? 'sin_registro');
  return {
    outcome,
    source: selected.source,
    hasCoordinates: selected.latitude !== undefined || selected.longitude !== undefined,
    usableLabel: selected.label.trim().length > 0,
    requests,
    elapsedMs,
  };
}

test('genera reports/week-09/fault-injection.json con ejecuciones reales', async () => {
  const backend = await startBackend();
  const { port } = backend;
  const baseUrl = `http://127.0.0.1:${port}`;
  const checks: Check[] = [];

  const geo = (
    id: string,
    scenarioType: Check['scenarioType'],
    scenarioLabel: string,
    run: GeoRun,
    expectation: boolean,
    expected: string,
  ) => {
    checks.push({
      id,
      status: expectation ? 'pass' : 'fail',
      scenarioType,
      command: COMMAND,
      evidence: `${scenarioLabel}: ${expected}. Observado: outcome=${run.outcome}; ubicacion=${run.source}; coordenadas ${
        run.hasCoordinates ? 'incluidas' : 'no incluidas'
      }; etiqueta utilizable=${run.usableLabel ? 'si' : 'no'}; solicitudes=${run.requests} (limite ${MAX_REQUESTS}); duracion=${run.elapsedMs} ms`,
    });
  };

  try {
    // --- Geocodificacion: 8 casos ---
    const success = await runGeocoding(baseUrl, 'success', 3000);
    geo('geocoding-success', 'nominal', 'X-Course-Scenario=success (coordenadas 0,0 validas)', success,
      success.outcome === 'valid' && success.source === 'provider' && success.hasCoordinates && success.requests === 1,
      'ubicacion del proveedor, una sola solicitud');

    const incomplete = await runGeocoding(baseUrl, 'incomplete', 3000);
    geo('geocoding-incomplete', 'failure', 'X-Course-Scenario=incomplete (solo label)', incomplete,
      incomplete.outcome === 'invalid_or_incomplete' && incomplete.source === 'manual' && !incomplete.hasCoordinates && incomplete.usableLabel && incomplete.requests === 1,
      'se rechaza, se usa la etiqueta manual sin inventar coordenadas y no se reintenta');

    const invalid = await runGeocoding(baseUrl, 'invalid_coordinates', 3000);
    geo('geocoding-invalid-coordinates', 'failure', 'X-Course-Scenario=invalid_coordinates', invalid,
      invalid.outcome === 'invalid_or_incomplete' && invalid.source === 'manual' && !invalid.hasCoordinates && invalid.usableLabel && invalid.requests === 1,
      'coordenadas fuera de rango o nulas se rechazan; ubicacion manual');

    const malformed = await runGeocoding(baseUrl, 'malformed', 3000);
    geo('geocoding-malformed', 'failure', 'X-Course-Scenario=malformed (JSON roto)', malformed,
      malformed.source === 'manual' && !malformed.hasCoordinates && malformed.usableLabel && malformed.requests === 1,
      'JSON malformado no es transitorio: no se reintenta y se usa la ubicacion manual');

    const limited = await runGeocoding(baseUrl, 'rate_limited', 3000);
    geo('geocoding-rate-limited', 'boundary', 'X-Course-Scenario=rate_limited (429 con Retry-After)', limited,
      limited.outcome === 'gave_up' && limited.source === 'manual' && limited.usableLabel && limited.requests >= 2 && limited.requests <= MAX_REQUESTS,
      'se respeta Retry-After, se agotan los intentos acotados y se usa la ubicacion manual');

    const serverError = await runGeocoding(baseUrl, 'server_error', 3000);
    geo('geocoding-server-error', 'boundary', 'X-Course-Scenario=server_error (500 persistente)', serverError,
      serverError.outcome === 'gave_up' && serverError.source === 'manual' && serverError.usableLabel && serverError.requests === MAX_REQUESTS,
      'se llega exactamente al limite de solicitudes y se usa la ubicacion manual');

    const slow = await runGeocoding(baseUrl, 'slow', 300);
    geo('geocoding-timeout', 'failure', 'X-Course-Scenario=slow con timeout propio de 300 ms', slow,
      slow.outcome === 'gave_up' && slow.source === 'manual' && slow.usableLabel && slow.requests >= 2 && slow.requests <= MAX_REQUESTS,
      'el timeout propio aborta, se reintenta de forma acotada y no se bloquea la UI');

    const down = await runGeocoding('http://127.0.0.1:1', undefined, 3000);
    geo('geocoding-disconnected', 'failure', 'servidor inalcanzable (puerto cerrado)', down,
      down.outcome === 'gave_up' && down.source === 'manual' && down.usableLabel && down.requests >= 2 && down.requests <= MAX_REQUESTS,
      'la desconexion no lanza excepcion; se usa la ubicacion manual');

    // --- Respuesta perdida tras guardar ---
    const start = await call(port, 'POST', `${INCIDENT}/actions`, {
      key: 'fi-start-0001',
      body: { action: 'start', baseVersion: 1 },
      timeoutMs: 3000,
    });
    if (start === 'timeout' || start.status < 200 || start.status >= 300) {
      throw new Error(`no se pudo preparar la incidencia (start): ${start === 'timeout' ? 'timeout' : start.status}`);
    }

    const KEY = 'fi-resolve-0001';
    const BODY = { action: 'resolve', baseVersion: 2, diagnosis: 'Diagnostico ficticio' };
    const sentKeys: (string | undefined)[] = [];
    const scenarios: string[] = [];
    const lost = await retryWithPolicy<Reply>(
      async ({ attempt, idempotencyKey }) => {
        sentKeys.push(idempotencyKey);
        scenarios.push(attempt === 1 ? 'timeout_after_commit' : 'normal');
        const reply = await call(port, 'POST', `${INCIDENT}/actions`, {
          ...(attempt === 1 ? { scenario: 'timeout_after_commit' } : {}),
          ...(idempotencyKey === undefined ? {} : { key: idempotencyKey }),
          body: BODY,
          timeoutMs: 300,
        });
        const result: AttemptResult<Reply> =
          reply === 'timeout'
            ? { ok: false, status: 'timeout' }
            : reply.status >= 200 && reply.status < 300
              ? { ok: true, value: reply }
              : { ok: false, status: reply.status };
        return result;
      },
      { method: 'POST', idempotencyKey: KEY },
    );
    await pause(1500); // el servidor termina de responder tarde en el intento 1
    const after = await readIncident(port);
    const events = after.payload.history.filter((item) => item.operationId === KEY).length;
    const duplicate =
      lost.outcome === 'success' && typeof lost.value.body === 'object' && lost.value.body !== null
        ? (lost.value.body as { duplicate?: unknown }).duplicate
        : undefined;
    checks.push({
      id: 'lost-response-resolve',
      status:
        lost.outcome === 'success' &&
        lost.attempts.length === 2 &&
        lost.attempts[0]?.result === 'timeout' &&
        sentKeys.every((item) => item === KEY) &&
        duplicate === true &&
        events === 1 &&
        after.version === 3 &&
        after.status === 'resolved'
          ? 'pass'
          : 'fail',
      scenarioType: 'boundary',
      command: COMMAND,
      evidence: `POST resolve con X-Course-Scenario=timeout_after_commit y timeout de cliente de 300 ms: intento 1=timeout (el servidor ya guardo); intento 2 con la MISMA clave y contenido responde duplicate=${String(duplicate)}; intentos=${lost.attempts.length}; claves distintas usadas=${new Set(sentKeys).size}; eventos con esa clave en el historial=${events}; version final=${after.version}, estado=${after.status}`,
    });

    const clash = await call(port, 'POST', `${INCIDENT}/actions`, {
      key: KEY,
      body: { ...BODY, diagnosis: 'Otro diagnostico ficticio' },
      timeoutMs: 3000,
    });
    const final = await readIncident(port);
    const code =
      clash !== 'timeout' && typeof clash.body === 'object' && clash.body !== null
        ? (clash.body as { code?: unknown }).code
        : undefined;
    checks.push({
      id: 'same-key-different-body',
      status:
        clash !== 'timeout' && clash.status === 409 && code === 'idempotency_key_reused' && final.version === after.version && final.payload.history.length === after.payload.history.length
          ? 'pass'
          : 'fail',
      scenarioType: 'failure',
      command: COMMAND,
      evidence: `POST resolve con la misma clave y diagnostico distinto: HTTP ${clash === 'timeout' ? 'timeout' : clash.status}, code=${String(code)}; version antes=${after.version}, despues=${final.version}; eventos antes=${after.payload.history.length}, despues=${final.payload.history.length} (no se trata como exito ni se aplica)`,
    });
  } finally {
    backend.stop();
  }

  const commitSha = process.env.WEEK09_SHA ?? execSync('git rev-parse HEAD').toString().trim();
  mkdirSync('reports/week-09', { recursive: true });
  writeFileSync(
    'reports/week-09/fault-injection.json',
    `${JSON.stringify({ schemaVersion: 1, week: 9, commitSha, generatedAt: new Date().toISOString(), checks }, null, 2)}\n`,
  );
  expect(checks.filter((check) => check.status === 'fail')).toEqual([]);
});
