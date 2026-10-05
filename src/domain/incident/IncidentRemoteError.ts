/**
 * Fallas distinguibles al consultar o crear incidencias en el backend
 * (nombres alineados con docs/api-contract.md).
 *
 * - `contract`: la respuesta es JSON válido pero no cumple el sobre DTO
 *   (parseRemoteResource la rechaza) o el payload no se puede traducir al dominio.
 * - `malformed`: el cuerpo no es JSON válido.
 * - `timeout`: el servidor no respondió dentro del límite del cliente.
 * - `serverError`: el servidor respondió 5xx.
 * - `http`: otro código de error no reintentable (401, 403, 409, 422, 429...).
 * - `network`: no hubo respuesta (servidor apagado, sin red).
 *
 * Un payload `null` válido NO es una falla: llega al dominio como incidencia sin detalle.
 */
export type IncidentRemoteFailure =
  | Readonly<{ kind: 'contract' }>
  | Readonly<{ kind: 'malformed' }>
  | Readonly<{ kind: 'timeout'; timeoutMs: number }>
  | Readonly<{ kind: 'serverError'; status: number }>
  | Readonly<{ kind: 'http'; status: number; retryAfter?: string }>
  | Readonly<{ kind: 'network' }>;

export type IncidentRemoteFailureKind = IncidentRemoteFailure['kind'];

const MESSAGES: Readonly<Record<IncidentRemoteFailureKind, string>> = {
  contract: 'La respuesta del servidor no cumple el contrato de incidencias',
  malformed: 'La respuesta del servidor no es JSON válido',
  timeout: 'El servidor no respondió a tiempo',
  serverError: 'El servidor respondió con un error interno',
  http: 'El servidor rechazó la solicitud',
  network: 'No fue posible contactar al servidor',
};

/**
 * Error tipado que lanza la capa de cliente. El mensaje es fijo: nunca incluye
 * la URL, headers ni el cuerpo de la respuesta, así que puede registrarse sin filtrar datos.
 */
export class IncidentRemoteError extends Error {
  readonly failure: IncidentRemoteFailure;

  constructor(failure: IncidentRemoteFailure) {
    const status = 'status' in failure ? ` (${failure.status})` : '';
    super(`${MESSAGES[failure.kind]}${status}`);
    this.name = 'IncidentRemoteError';
    this.failure = failure;
  }
}

export function remoteFailureKind(error: unknown): IncidentRemoteFailureKind | 'unknown' {
  return error instanceof IncidentRemoteError ? error.failure.kind : 'unknown';
}
