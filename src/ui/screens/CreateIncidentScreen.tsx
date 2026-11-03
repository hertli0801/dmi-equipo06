import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { createIncident } from '../../application/incidents/createIncident';
import type { Telemetry } from '../../application/telemetry/Telemetry';
import type { IncidentCategory, IncidentLocation } from '../../campusops/contracts';
import type { Incident } from '../../domain/incident/Incident';
import type { IncidentRepository } from '../../domain/incident/IncidentRepository';

const CATEGORIES: readonly { id: IncidentCategory; label: string }[] = [
  { id: 'electrical', label: 'Eléctrica' },
  { id: 'laboratory', label: 'Laboratorio' },
  { id: 'water', label: 'Agua' },
  { id: 'connectivity', label: 'Conectividad' },
  { id: 'equipment', label: 'Equipo' },
  { id: 'safety', label: 'Seguridad' },
  { id: 'maintenance', label: 'Mantenimiento' },
];

/** Sin proveedor, la ubicación es siempre la que escribe la persona. */
const manualOnly = (_provider: unknown, manualLabel: string): IncidentLocation => ({
  source: 'manual',
  label: manualLabel,
});

/** Tiempo máximo de espera al proveedor; pasado esto se sigue con la ubicación manual. */
const LOOKUP_TIMEOUT_MS = 3000;

export const LOCATION_UNAVAILABLE_MESSAGE = 'Ubicación del servicio no disponible, escríbela manualmente';

export type CreateIncidentScreenProps = Readonly<{
  repository: IncidentRepository;
  onCreated: (incident: Incident) => void;
  onCancel: () => void;
  telemetry?: Telemetry;
  /** Consulta al proveedor de geocodificación (adaptador de A). Debe devolver null si no hay resultado. */
  findLocation?: (query: string) => Promise<unknown>;
  /** `selectIncidentLocation` (de A). Por defecto solo ubicación manual. */
  selectLocation?: (provider: unknown, manualLabel: string) => IncidentLocation;
  lookupTimeoutMs?: number;
}>;

async function lookupWithTimeout(
  find: ((query: string) => Promise<unknown>) | undefined,
  query: string,
  timeoutMs: number,
): Promise<unknown> {
  if (!find) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    // Nunca lanza hacia la UI: cualquier fallo del proveedor equivale a "no disponible".
    return await Promise.race([find(query).catch(() => null), timeout]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function CreateIncidentScreen({
  repository,
  onCreated,
  onCancel,
  telemetry,
  findLocation,
  selectLocation = manualOnly,
  lookupTimeoutMs = LOOKUP_TIMEOUT_MS,
}: CreateIncidentScreenProps) {
  const [categoria, setCategoria] = useState<IncidentCategory>('maintenance');
  const [descripcion, setDescripcion] = useState('');
  const [manualLabel, setManualLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [providerUnavailable, setProviderUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    if (descripcion.trim() === '') {
      setError('Escribe una descripción.');
      return;
    }
    setBusy(true);
    try {
      const provider = await lookupWithTimeout(findLocation, manualLabel.trim(), lookupTimeoutMs);
      const location = selectLocation(provider, manualLabel.trim());
      setProviderUnavailable(location.source === 'manual');
      if (location.label.trim() === '') {
        setError('Escribe el edificio, zona o referencia.');
        return;
      }
      const incident = await createIncident(
        repository,
        { categoria, descripcion: descripcion.trim(), location: location.label.trim() },
        telemetry,
      );
      onCreated(incident);
    } catch {
      // El detalle técnico ya quedó sanitizado en telemetría; la UI solo muestra un mensaje genérico.
      setError('No se pudo crear la incidencia.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.container} testID="create-incident-screen">
      <Text style={styles.heading}>Nueva incidencia</Text>
      <View style={styles.row}>
        {CATEGORIES.map((item) => (
          <Pressable
            key={item.id}
            testID={`create-category-${item.id}`}
            accessibilityState={{ selected: categoria === item.id }}
            style={[styles.chip, categoria === item.id && styles.chipSelected]}
            onPress={() => setCategoria(item.id)}
          >
            <Text>{item.label}</Text>
          </Pressable>
        ))}
      </View>
      <TextInput
        testID="create-description-input"
        style={styles.input}
        placeholder="Descripción"
        value={descripcion}
        onChangeText={setDescripcion}
        multiline
      />
      {/* Siempre disponible: la ubicación manual nunca depende del proveedor. */}
      <TextInput
        testID="create-location-input"
        style={styles.input}
        placeholder="Edificio, zona o referencia"
        value={manualLabel}
        onChangeText={setManualLabel}
      />
      {providerUnavailable ? <Text testID="location-unavailable">{LOCATION_UNAVAILABLE_MESSAGE}</Text> : null}
      {error ? <Text testID="create-incident-error">{error}</Text> : null}
      <Pressable testID="create-incident-submit" disabled={busy} style={styles.button} onPress={() => void submit()}>
        <Text style={styles.buttonText}>{busy ? 'Creando…' : 'Crear incidencia'}</Text>
      </Pressable>
      <Pressable testID="create-incident-cancel" onPress={onCancel}>
        <Text style={styles.link}>Cancelar</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 24, gap: 12 },
  heading: { fontSize: 18, fontWeight: '600' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingVertical: 6, paddingHorizontal: 10, borderWidth: 1, borderColor: '#ccc', borderRadius: 16 },
  chipSelected: { borderColor: '#2563eb', backgroundColor: '#dbeafe' },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 6, padding: 8 },
  button: { backgroundColor: '#2563eb', padding: 12, borderRadius: 6 },
  buttonText: { color: '#fff', textAlign: 'center' },
  link: { color: '#2563eb' },
});
