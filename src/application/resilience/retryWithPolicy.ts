import { DEFAULT_RETRY_POLICY, planRetry, type RetryPolicy } from '../../course-evaluation';
import { noopTelemetry, type Telemetry } from '../telemetry/Telemetry';

export type AttemptContext = Readonly<{ attempt: number; idempotencyKey?: string }>;

export type AttemptResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; status: number | 'timeout'; retryAfterMs?: number }>;

export type AttemptLog = Readonly<{
  attempt: number;
  result: 'ok' | number | 'timeout';
  /** Espera planificada antes del siguiente intento; null si no hubo otro intento. */
  plannedDelayMs: number | null;
  durationMs: number;
}>;

export type RetryResult<T> =
  | Readonly<{ outcome: 'success'; value: T; attempts: readonly AttemptLog[]; totalDelayMs: number }>
  | Readonly<{
      outcome: 'gave_up' | 'not_retryable';
      lastStatus: number | 'timeout';
      attempts: readonly AttemptLog[];
      totalDelayMs: number;
    }>;

export type RetryDeps = Readonly<{
  method: 'GET' | 'POST';
  /** Obligatoria para POST: la misma clave se usa en todos los intentos. */
  idempotencyKey?: string;
  policy?: RetryPolicy;
  sleep?: (ms: number) => Promise<void>;
  nowMs?: () => number;
  telemetry?: Telemetry;
}>;

const isTransient = (status: number | 'timeout') =>
  status === 'timeout' || status === 408 || status === 429 || (status >= 500 && status <= 599);

export async function retryWithPolicy<T>(
  run: (context: AttemptContext) => Promise<AttemptResult<T>>,
  deps: RetryDeps,
): Promise<RetryResult<T>> {
  const policy = deps.policy ?? DEFAULT_RETRY_POLICY;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const nowMs = deps.nowMs ?? (() => Date.now());
  const telemetry = deps.telemetry ?? noopTelemetry;
  const key = deps.idempotencyKey;
  const attempts: AttemptLog[] = [];
  let totalDelayMs = 0;
  let lastStatus: number | 'timeout' = 'timeout';

  // Tope duro: el bucle nunca excede noRetryFromAttempt iteraciones.
  const hardCap = Math.max(1, policy.noRetryFromAttempt);
  for (let attempt = 1; attempt <= hardCap; attempt += 1) {
    const started = nowMs();
    let result: AttemptResult<T>;
    try {
      result = await run({ attempt, ...(key === undefined ? {} : { idempotencyKey: key }) });
    } catch {
      // Sin red o fallo inesperado: un timeout no prueba que el servidor no ejecutó la operación.
      result = { ok: false, status: 'timeout' };
    }
    const durationMs = Math.max(0, nowMs() - started);

    if (result.ok) {
      attempts.push({ attempt, result: 'ok', plannedDelayMs: null, durationMs });
      telemetry.info('retry.attempt', { attempt, result: 'ok', durationMs });
      return { outcome: 'success', value: result.value, attempts, totalDelayMs };
    }

    lastStatus = result.status;
    const plan = planRetry(
      {
        method: deps.method,
        status: result.status,
        attempt,
        ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }),
        ...(key === undefined ? {} : { idempotencyKey: key }),
      },
      policy,
    );
    attempts.push({
      attempt,
      result: result.status,
      plannedDelayMs: plan.retry ? plan.delayMs : null,
      durationMs,
    });
    telemetry.info('retry.attempt', { attempt, result: result.status, durationMs, retry: plan.retry });

    if (!plan.retry) {
      return {
        outcome: isTransient(result.status) ? 'gave_up' : 'not_retryable',
        lastStatus: result.status,
        attempts,
        totalDelayMs,
      };
    }
    await sleep(plan.delayMs);
    totalDelayMs += plan.delayMs;
  }

  return { outcome: 'gave_up', lastStatus, attempts, totalDelayMs };
}
