/**
 * Puerto hacia un proveedor de geocodificación. Cada llamada es UN intento:
 * los reintentos los decide la capa de aplicación con `retryWithPolicy`.
 *
 * Contrato: `geocode` nunca lanza. Timeout, desconexión, 429, 5xx o un cuerpo
 * malformado se devuelven como dato para que la UI siga con la ubicación manual.
 */
export type GeocodingAttempt =
  | Readonly<{ ok: true; value: unknown }>
  | Readonly<{ ok: false; status: number | 'timeout'; retryAfterMs?: number }>;

export interface GeocodingProvider {
  /** Nombre corto del proveedor para logs técnicos (nunca incluye la consulta). */
  readonly name: string;
  geocode(query: string): Promise<GeocodingAttempt>;
}
