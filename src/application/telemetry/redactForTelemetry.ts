/**
 * Sanitización de telemetría (contrato de docs/CAMPUSOPS_API.md, semana 4).
 *
 * Recorre objetos y listas anidados y devuelve una COPIA: la entrada original
 * nunca se modifica, porque la app la sigue usando después de registrar el log.
 */
export const REDACTED = '[REDACTED]';

/** Claves del contrato público, ya normalizadas (minúsculas, sin `_` ni `-`). */
const CONTRACT_KEYS = [
  'authorization',
  'password',
  'token',
  'accesstoken',
  'refreshtoken',
  'email',
  'displayname',
  'name',
  'userid',
  'reporterid',
  'technicianid',
  'assignedtechnicianid',
  'location',
  'latitude',
  'longitude',
  'photos',
  'evidence',
  'internalcomments',
  'assignmenthistory',
];

/**
 * Ampliación del equipo: alias en español del dominio CampusOps, campos del
 * backend didáctico que guardan comentarios (`notes`) e historial (`history`)
 * y texto libre, que puede contener nombres o ubicaciones escritos a mano.
 */
const TEAM_KEYS = [
  'nombre',
  'correo',
  'contrasena',
  'ubicacion',
  'latitud',
  'longitud',
  'fotos',
  'evidencia',
  'comentariosinternos',
  'historialasignaciones',
  'notes',
  'history',
  'description',
  'descripcion',
  'diagnosis',
  'diagnostico',
  'comment',
  'comments',
  'comentario',
  'comentarios',
];

const SENSITIVE_KEYS: ReadonlySet<string> = new Set([...CONTRACT_KEYS, ...TEAM_KEYS]);

export function normalizeTelemetryKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

export function isSensitiveTelemetryKey(key: string): boolean {
  return SENSITIVE_KEYS.has(normalizeTelemetryKey(key));
}

export function redactForTelemetry(input: unknown): unknown {
  return redactValue(input, new WeakSet<object>());
}

function redactValue(value: unknown, ancestors: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') {
    // Funciones y símbolos no son contexto técnico serializable.
    return typeof value === 'function' || typeof value === 'symbol' ? undefined : value;
  }
  if (ancestors.has(value)) return '[Circular]';
  if (value instanceof Date) return value.toISOString();

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactValue(item, ancestors));
    }
    const output: Record<string, unknown> = {};
    if (value instanceof Error) output.name = value.name;
    for (const [key, item] of Object.entries(value)) {
      output[key] = isSensitiveTelemetryKey(key) ? REDACTED : redactValue(item, ancestors);
    }
    return output;
  } finally {
    // Sólo se marcan los ancestros: un mismo objeto referenciado dos veces
    // (sin ciclo) se copia normalmente en ambas posiciones.
    ancestors.delete(value);
  }
}
