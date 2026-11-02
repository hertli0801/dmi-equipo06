import { planRetry, DEFAULT_RETRY_POLICY } from '../index';

const get = (status: number | 'timeout', attempt: number, retryAfterMs?: number) =>
  planRetry({ method: 'GET', status, attempt, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });

test('backoff progresivo y finito en intentos 1 a 3', () => {
  expect([1, 2, 3].map((n) => get(500, n).delayMs)).toEqual([500, 1000, 2000]);
});

test('desde el intento 4 no se reintenta', () => {
  expect(get(500, 4).retry).toBe(false);
  expect(get('timeout', 5).retry).toBe(false);
});

test('Retry-After valido se respeta', () => {
  expect(get(429, 2, 1200)).toEqual({ retry: true, delayMs: 1200, requiresStableIdempotencyKey: false });
});

test.each([-1, NaN, Infinity])('Retry-After invalido (%p) cae al backoff', (value) => {
  expect(get(429, 1, value).delayMs).toBe(500);
});

test('Retry-After mayor al tope no reintenta', () => {
  expect(get(429, 1, DEFAULT_RETRY_POLICY.maxDelayMs + 1).retry).toBe(false);
});

test.each([400, 401, 403, 404, 409, 422])('estado %p no se reintenta', (status) => {
  expect(get(status, 1).retry).toBe(false);
});

test('POST sin clave o con clave vacia no se reintenta', () => {
  for (const idempotencyKey of [undefined, '', '   ']) {
    expect(planRetry({ method: 'POST', status: 503, attempt: 1, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) })).toEqual({
      retry: false, delayMs: 0, requiresStableIdempotencyKey: true,
    });
  }
});

test('POST con clave estable si se reintenta', () => {
  expect(planRetry({ method: 'POST', status: 'timeout', attempt: 2, idempotencyKey: 'k1' }).retry).toBe(true);
});

test('el limite es configurable', () => {
  const policy = { ...DEFAULT_RETRY_POLICY, noRetryFromAttempt: 3 };
  expect(planRetry({ method: 'GET', status: 500, attempt: 3 }, policy).retry).toBe(false);
  expect(planRetry({ method: 'GET', status: 500, attempt: 2 }, policy).retry).toBe(true);
});

test('intentos invalidos no reintentan', () => {
  for (const attempt of [0, 1.5, NaN]) expect(get(500, attempt).retry).toBe(false);
});
