import type { TelemetryEntry, TelemetrySink } from '../../application/telemetry/Telemetry';

/** Escribe en consola entradas que Application ya sanitizó; nunca recibe datos crudos. */
export class ConsoleTelemetrySink implements TelemetrySink {
  write(entry: TelemetryEntry): void {
    const line = JSON.stringify(entry);
    if (entry.level === 'error') console.warn(line);
    else console.info(line);
  }
}
