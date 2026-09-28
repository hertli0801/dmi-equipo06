import { redactForTelemetry } from './redactForTelemetry';

export type TelemetryLevel = 'info' | 'error';

/** Entrada ya sanitizada; es lo único que llega a un destino de logs. */
export type TelemetryEntry = Readonly<{
  level: TelemetryLevel;
  event: string;
  timestamp: string;
  context: unknown;
  error?: Readonly<{ name: string; message: string }>;
}>;

/** Destino de los logs (consola, archivo, servicio). Lo provee Infrastructure. */
export interface TelemetrySink {
  write(entry: TelemetryEntry): void;
}

export interface Telemetry {
  info(event: string, context?: Readonly<Record<string, unknown>>): void;
  error(event: string, error: unknown, context?: Readonly<Record<string, unknown>>): void;
}

const TEXT_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[REDACTED_EMAIL]'],
  [/(\/\/)[^/\s:@]+:[^/\s@]+@/g, '$1[REDACTED]@'],
  [/\b(token|password|access_?token|refresh_?token)=([^&\s]+)/gi, '$1=[REDACTED]'],
];

/**
 * Los mensajes de error son texto libre: pueden traer el header Authorization,
 * un correo o credenciales en una URL. Se limpian antes de registrarlos.
 */
export function scrubTelemetryText(text: string): string {
  return TEXT_PATTERNS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text);
}

function describeError(error: unknown): Readonly<{ name: string; message: string }> {
  if (error instanceof Error) {
    return { name: error.name, message: scrubTelemetryText(error.message) };
  }
  // Un valor lanzado que no es Error puede ser un objeto con datos personales:
  // no se registra su contenido, sólo su tipo.
  return { name: 'NonError', message: `thrown value of type ${typeof error}` };
}

export function createTelemetry(sink: TelemetrySink, now: () => Date = () => new Date()): Telemetry {
  function write(entry: TelemetryEntry): void {
    try {
      sink.write(entry);
    } catch {
      // Un fallo del destino de logs nunca debe tumbar el flujo de la app.
    }
  }

  return {
    info(event, context = {}) {
      write({ level: 'info', event, timestamp: now().toISOString(), context: redactForTelemetry(context) });
    },
    error(event, error, context = {}) {
      write({
        level: 'error',
        event,
        timestamp: now().toISOString(),
        context: redactForTelemetry(context),
        error: describeError(error),
      });
    },
  };
}

export const noopTelemetry: Telemetry = {
  info() {},
  error() {},
};
