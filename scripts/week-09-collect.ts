/**
 * Genera reports/week-09/retry-metrics.json ejecutando escenarios REALES contra el backend didactico.
 * Uso: npx jest --runTestsByPath scripts/week-09-collect.ts
 * El commitSha sale de WEEK09_SHA o, si no existe, de `git rev-parse HEAD`.
 */
import { execSync, spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { retryWithPolicy, type AttemptResult, type RetryResult } from '../src/application/resilience/retryWithPolicy';
import { DEFAULT_RETRY_POLICY } from '../src/course-evaluation';

jest.useRealTimers();
jest.setTimeout(120_000);

const COMMAND = "npx jest --testMatch '**/scripts/week-09-collect.ts' --no-watchman --ci --runInBand";
const INCIDENT = '/v1/incidents/campus-inc-001';
const KEY = 'resolve-campus-inc-001-op-1';

type Reply = Readonly<{ status: number; headers: Record<string, string | string[] | undefined>; body: unknown }>;
type CallOptions = Readonly<{ scenario?: string; key?: string; body?: unknown; timeoutMs: number }>;
type IncidentView = Readonly<{ status: string; version: number; payload: { history: { operationId: string; action: string }[] } }>;

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
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
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

function toAttempt(reply: Reply | 'timeout'): AttemptResult<Reply> {
  if (reply === 'timeout') return { ok: false, status: 'timeout' };
  if (reply.status >= 200 && reply.status < 300) return { ok: true, value: reply };
  const raw = reply.headers['retry-after'];
  const seconds = typeof raw === 'string' ? Number(raw) : Number.NaN;
  return Number.isFinite(seconds) && seconds >= 0
    ? { ok: false, status: reply.status, retryAfterMs: seconds * 1000 }
    : { ok: false, status: reply.status };
}

type Observed = Readonly<{ result: RetryResult<Reply>; waits: number[]; requests: number; keys: (string | undefined)[] }>;

async function observe(
  method: 'GET' | 'POST',
  key: string | undefined,
  send: (attempt: number) => Promise<Reply | 'timeout'>,
): Promise<Observed> {
  const waits: number[] = [];
  const keys: (string | undefined)[] = [];
  const result = await retryWithPolicy<Reply>(
    async ({ attempt, idempotencyKey }) => {
      keys.push(idempotencyKey);
      return toAttempt(await send(attempt));
    },
    {
      method,
      ...(key === undefined ? {} : { idempotencyKey: key }),
      // Espera REAL; se mide cuanto tardo de verdad.
      sleep: async (ms) => {
        const started = Date.now();
        await new Promise<void>((done) => setTimeout(done, ms));
        waits.push(Date.now() - started);
      },
    },
  );
  return { result, waits, requests: keys.length, keys };
}

function rows(observed: Observed) {
  const waits = [...observed.waits];
  return observed.result.attempts.map((a) => ({
    attempt: a.attempt,
    result: a.result,
    plannedDelayMs: a.plannedDelayMs,
    observedDelayMs: a.plannedDelayMs === null ? null : (waits.shift() ?? null),
    requestMs: a.durationMs,
  }));
}

async function readIncident(port: number): Promise<IncidentView> {
  const reply = await call(port, 'GET', INCIDENT, { timeoutMs: 3000 });
  if (reply === 'timeout' || reply.status !== 200) throw new Error('no se pudo leer la incidencia de prueba');
  return reply.body as IncidentView;
}

type Check = {
  id: string;
  status: 'pass' | 'fail';
  scenarioType: 'nominal' | 'boundary' | 'failure';
  command: string;
  evidence: string;
  maxAttemptsPolicy: number;
  idempotencyKey: string | null;
  attempts: ReturnType<typeof rows>;
};

test('genera reports/week-09/retry-metrics.json con ejecuciones reales', async () => {
  const backend = await startBackend();
  const { port } = backend;
  const checks: Check[] = [];
  const maxRequests = DEFAULT_RETRY_POLICY.noRetryFromAttempt;

  try {
    // 1) 429 + Retry-After: el intento 1 falla, espera lo indicado y el intento 2 tiene exito.
    const limited = await observe('GET', undefined, (attempt) =>
      call(port, 'GET', INCIDENT, { ...(attempt === 1 ? { scenario: 'rate_limited' } : {}), timeoutMs: 3000 }),
    );
    const limitedRows = rows(limited);
    checks.push({
      id: 'rate-limited-retry-after-honored',
      status:
        limited.result.outcome === 'success' &&
        limited.requests === 2 &&
        limitedRows[0]?.result === 429 &&
        limitedRows[0]?.plannedDelayMs === 1000 &&
        (limitedRows[0]?.observedDelayMs ?? 0) >= 990
          ? 'pass'
          : 'fail',
      scenarioType: 'failure',
      command: COMMAND,
      evidence: `GET con X-Course-Scenario=rate_limited: intento 1=429 con Retry-After de 1 s; espera planificada ${limitedRows[0]?.plannedDelayMs} ms, observada ${limitedRows[0]?.observedDelayMs} ms; intento 2 sin falla; resultado=${limited.result.outcome}; solicitudes=${limited.requests}`,
      maxAttemptsPolicy: maxRequests,
      idempotencyKey: null,
      attempts: limitedRows,
    });

    // 2) 500 persistente: se detiene en el limite (no se reintenta desde el intento 4).
    const failing = await observe('GET', undefined, () =>
      call(port, 'GET', INCIDENT, { scenario: 'server_error', timeoutMs: 3000 }),
    );
    const failingRows = rows(failing);
    checks.push({
      id: 'server-error-attempt-limit',
      status:
        failing.result.outcome === 'gave_up' &&
        failing.requests === maxRequests &&
        JSON.stringify(failingRows.map((r) => r.plannedDelayMs)) === JSON.stringify([500, 1000, 2000, null])
          ? 'pass'
          : 'fail',
      scenarioType: 'boundary',
      command: COMMAND,
      evidence: `GET con X-Course-Scenario=server_error: ${failing.requests} solicitudes (limite ${maxRequests}); esperas planificadas ${failingRows.map((r) => r.plannedDelayMs).join('/')} ms, observadas ${failing.waits.join('/')} ms; resultado=${failing.result.outcome} sin intento 5`,
      maxAttemptsPolicy: maxRequests,
      idempotencyKey: null,
      attempts: failingRows,
    });

    // 3) POST sin clave de idempotencia: no se reintenta.
    const keyless = await observe('POST', undefined, () =>
      call(port, 'POST', `${INCIDENT}/actions`, { scenario: 'server_error', body: { action: 'resolve', baseVersion: 1, diagnosis: 'Diagnóstico de prueba' }, timeoutMs: 3000 }),
    );
    checks.push({
      id: 'post-without-key-no-retry',
      status: keyless.result.outcome === 'gave_up' && keyless.requests === 1 && keyless.waits.length === 0 ? 'pass' : 'fail',
      scenarioType: 'boundary',
      command: COMMAND,
      evidence: `POST sin Idempotency-Key con fallo 500: ${keyless.requests} solicitud, 0 esperas, resultado=${keyless.result.outcome}`,
      maxAttemptsPolicy: maxRequests,
      idempotencyKey: null,
      attempts: rows(keyless),
    });

    // 4) Respuesta perdida: el servidor guarda, el cliente aborta, el reintento usa la MISMA clave y contenido.
    let incident = await readIncident(port);
    if (incident.status === 'assigned') {
      const started = await call(port, 'POST', `${INCIDENT}/actions`, {
        key: 'start-campus-inc-001-op-0',
        body: { action: 'start', baseVersion: incident.version },
        timeoutMs: 3000,
      });
      if (started === 'timeout' || started.status >= 300) throw new Error('no se pudo preparar la incidencia (start)');
      incident = await readIncident(port);
    }
    if (incident.status !== 'in_progress') throw new Error(`estado inicial inesperado: ${incident.status}`);

    const resolveBody = { action: 'resolve', baseVersion: incident.version, diagnosis: 'Diagnóstico de prueba' };
    const lost = await observe('POST', KEY, (attempt) =>
      call(port, 'POST', `${INCIDENT}/actions`, {
        ...(attempt === 1 ? { scenario: 'timeout_after_commit' } : {}),
        key: KEY,
        body: resolveBody,
        timeoutMs: attempt === 1 ? 500 : 3000,
      }),
    );
    const afterLost = await readIncident(port);
    const eventsForKey = afterLost.payload.history.filter((e) => e.operationId === KEY).length;
    const resolveEvents = afterLost.payload.history.filter((e) => e.action === 'resolve').length;
    const lostRows = rows(lost);
    const duplicateFlag =
      lost.result.outcome === 'success' ? (lost.result.value.body as { duplicate?: boolean } | null)?.duplicate : undefined;
    checks.push({
      id: 'lost-response-same-key-no-duplicates',
      status:
        lost.result.outcome === 'success' &&
        lost.requests === 2 &&
        lostRows[0]?.result === 'timeout' &&
        lost.keys[0] === KEY &&
        lost.keys[1] === KEY &&
        duplicateFlag === true &&
        eventsForKey === 1 &&
        resolveEvents === 1
          ? 'pass'
          : 'fail',
      scenarioType: 'failure',
      command: COMMAND,
      evidence: `POST resolve con X-Course-Scenario=timeout_after_commit: intento 1 abortado por timeout del cliente (500 ms) tras guardar; intento 2 con la misma clave y contenido respondio duplicate=${String(duplicateFlag)}; eventos con esa clave en el historial=${eventsForKey}; eventos resolve totales=${resolveEvents}`,
      maxAttemptsPolicy: maxRequests,
      idempotencyKey: KEY,
      attempts: lostRows,
    });

    // 5) Misma clave con contenido distinto: 409, no se reintenta ni se trata como exito.
    const conflict = await observe('POST', KEY, () =>
      call(port, 'POST', `${INCIDENT}/actions`, {
        key: KEY,
        body: { ...resolveBody, diagnosis: 'OTRO diagnóstico' },
        timeoutMs: 3000,
      }),
    );
    const afterConflict = await readIncident(port);
    const eventsAfterConflict = afterConflict.payload.history.filter((e) => e.operationId === KEY).length;
    checks.push({
      id: 'same-key-different-body-409-no-retry',
      status:
        conflict.result.outcome === 'not_retryable' && conflict.requests === 1 && eventsAfterConflict === 1 ? 'pass' : 'fail',
      scenarioType: 'boundary',
      command: COMMAND,
      evidence: `POST con la misma clave y diagnostico distinto: estado ${conflict.result.outcome === 'success' ? 'inesperado' : String(conflict.result.lastStatus)}, ${conflict.requests} solicitud, resultado=${conflict.result.outcome}; eventos con esa clave siguen en ${eventsAfterConflict}`,
      maxAttemptsPolicy: maxRequests,
      idempotencyKey: KEY,
      attempts: rows(conflict),
    });
  } finally {
    backend.stop();
  }

  const commitSha = process.env.WEEK09_SHA ?? execSync('git rev-parse HEAD').toString().trim();
  mkdirSync('reports/week-09', { recursive: true });
  writeFileSync(
    'reports/week-09/retry-metrics.json',
    `${JSON.stringify({ schemaVersion: 1, week: 9, commitSha, generatedAt: new Date().toISOString(), policy: DEFAULT_RETRY_POLICY, checks }, null, 2)}\n`,
  );

  expect(checks.map((c) => `${c.id}:${c.status}`)).toEqual(checks.map((c) => `${c.id}:pass`));
});
