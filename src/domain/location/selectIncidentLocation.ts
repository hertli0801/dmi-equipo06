import type { IncidentLocation } from '../../campusops/contracts';

export type ProviderLocation = Readonly<{ label: string; latitude: number; longitude: number }>;

function isCoordinate(value: unknown, limit: number): value is number {
  // `0` es una coordenada válida: no se valida con `!value`.
  return typeof value === 'number' && Number.isFinite(value) && value >= -limit && value <= limit;
}

/**
 * Valida un resultado externo desconocido. Sólo acepta un objeto (no arreglo) con
 * `label` de texto no vacío y latitud/longitud numéricas finitas dentro de rango.
 */
export function parseProviderLocation(input: unknown): ProviderLocation | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const { label, latitude, longitude } = input as Record<string, unknown>;
  if (typeof label !== 'string' || label.trim().length === 0) return null;
  if (!isCoordinate(latitude, 90) || !isCoordinate(longitude, 180)) return null;
  return { label, latitude, longitude };
}

/**
 * Usa la ubicación del proveedor sólo si es válida; en cualquier otro caso
 * (null, error como dato, incompleta, inválida) conserva la etiqueta manual
 * sin inventar coordenadas.
 */
export function selectIncidentLocation(provider: unknown, manualLabel: string): IncidentLocation {
  const parsed = parseProviderLocation(provider);
  if (parsed) return { source: 'provider', ...parsed };
  return { source: 'manual', label: manualLabel };
}
