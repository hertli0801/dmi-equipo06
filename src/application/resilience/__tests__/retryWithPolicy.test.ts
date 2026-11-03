import { retryWithPolicy, type AttemptContext, type AttemptResult } from '../retryWithPolicy';

type Step = AttemptResult<string> | 'throw';

function harness(steps: Step[]) {
  const keys: (string | undefined)[] = [];
  const sleeps: number[] = [];
  let index = 0;
  let clock = 0;
  const run = async (context: AttemptContext): Promise<AttemptResult<string>> => {
    keys.push(context.idempotencyKey);
    const step = steps[Math.min(index, steps.length - 1)];
    index += 1;
    if (step === undefined) throw new Error('guion vacio');
    if (step === 'throw') throw new Error('network');
    return step;
  };
  const deps = {
    sleep: async (ms: number) => { sleeps.push(ms); },
    nowMs: () => (clock += 10),
  };
  return { run, keys, sleeps, deps };
}

const ok: AttemptResult<string> = { ok: true, value: 'listo' };
const fail = (status: number | 'timeout', retryAfterMs?: number): AttemptResult<string> =>
  retryAfterMs === undefined ? { ok: false, status } : { ok: false, status, retryAfterMs };

test('exito al primer intento: una llamada y sin espera', async () => {
  const h = harness([ok]);
  const result = await retryWithPolicy(h.run, { method: 'GET', ...h.deps });
  expect(result.outcome).toBe('success');
  expect(result.attempts).toHaveLength(1);
  expect(h.sleeps).toEqual([]);
});

test('429 con Retry-After espera lo indicado y luego tiene exito', async () => {
  const h = harness([fail(429, 800), ok]);
  const result = await retryWithPolicy(h.run, { method: 'GET', ...h.deps });
  expect(result.outcome).toBe('success');
  expect(h.sleeps).toEqual([800]);
  expect(result.totalDelayMs).toBe(800);
});

test('500 persistente: maximo 4 solicitudes y espera progresiva finita', async () => {
  const h = harness([fail(500)]);
  const result = await retryWithPolicy(h.run, { method: 'GET', ...h.deps });
  expect(result.outcome).toBe('gave_up');
  expect(h.keys).toHaveLength(4);
  expect(h.sleeps).toEqual([500, 1000, 2000]);
});

test('POST reintenta siempre con la misma clave', async () => {
  const h = harness([fail('timeout'), fail(503), ok]);
  const result = await retryWithPolicy(h.run, { method: 'POST', idempotencyKey: 'resolve-campus-inc-001-op-1', ...h.deps });
  expect(result.outcome).toBe('success');
  expect(h.keys).toEqual(['resolve-campus-inc-001-op-1', 'resolve-campus-inc-001-op-1', 'resolve-campus-inc-001-op-1']);
});

test('POST sin clave no se reintenta', async () => {
  const h = harness([fail(503), ok]);
  const result = await retryWithPolicy(h.run, { method: 'POST', ...h.deps });
  expect(result.outcome).toBe('gave_up');
  expect(h.keys).toHaveLength(1);
  expect(h.sleeps).toEqual([]);
});

test('409 y 403 no se reintentan', async () => {
  for (const status of [409, 403]) {
    const h = harness([fail(status), ok]);
    const result = await retryWithPolicy(h.run, { method: 'POST', idempotencyKey: 'k', ...h.deps });
    expect(result.outcome).toBe('not_retryable');
    expect(h.keys).toHaveLength(1);
  }
});

test('una excepcion de red cuenta como timeout y se reintenta', async () => {
  const h = harness(['throw', ok]);
  const result = await retryWithPolicy(h.run, { method: 'GET', ...h.deps });
  expect(result.outcome).toBe('success');
  expect(h.keys).toHaveLength(2);
});

test('Retry-After mayor al tope no espera ni reintenta', async () => {
  const h = harness([fail(429, 120_000), ok]);
  const result = await retryWithPolicy(h.run, { method: 'GET', ...h.deps });
  expect(result.outcome).toBe('gave_up');
  expect(h.keys).toHaveLength(1);
  expect(h.sleeps).toEqual([]);
});

test('la politica es configurable', async () => {
  const h = harness([fail(500)]);
  const result = await retryWithPolicy(h.run, {
    method: 'GET',
    policy: { noRetryFromAttempt: 2, baseDelayMs: 100, maxDelayMs: 1000 },
    ...h.deps,
  });
  expect(result.outcome).toBe('gave_up');
  expect(h.keys).toHaveLength(2);
  expect(h.sleeps).toEqual([100]);
});

test('registra duracion y espera planificada por intento', async () => {
  const h = harness([fail(500), ok]);
  const result = await retryWithPolicy(h.run, { method: 'GET', ...h.deps });
  expect(result.attempts).toEqual([
    { attempt: 1, result: 500, plannedDelayMs: 500, durationMs: 10 },
    { attempt: 2, result: 'ok', plannedDelayMs: null, durationMs: 10 },
  ]);
});
