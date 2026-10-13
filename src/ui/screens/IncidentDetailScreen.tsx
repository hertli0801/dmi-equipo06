import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { getIncidentDetail } from '../../application/incidents/getIncidentDetail';
import { performIncidentAction } from '../../application/incidents/performIncidentAction';
import type { Incident } from '../../domain/incident/Incident';
import {
  ForbiddenActionError,
  type Actor,
  type IncidentAction,
  type IncidentActionsPort,
} from '../../domain/incident/IncidentPermissions';
import type { IncidentRepository } from '../../domain/incident/IncidentRepository';
import type { Telemetry } from '../../application/telemetry/Telemetry';

export type IncidentDetailScreenProps = Readonly<{
  repository: IncidentRepository;
  incidentId: string;
  onBack: () => void;
  telemetry?: Telemetry;
  /** Opcionales: sin ellos la pantalla es de solo lectura (como en las semanas anteriores). */
  actor?: Actor;
  actions?: IncidentActionsPort;
}>;

export function IncidentDetailScreen({ repository, incidentId, onBack, telemetry, actor, actions }: IncidentDetailScreenProps) {
  const [incident, setIncident] = useState<Incident | null | 'loading' | 'error'>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const [diagnosis, setDiagnosis] = useState('');

  useEffect(() => {
    let active = true;
    getIncidentDetail(repository, incidentId, telemetry)
      .then((result) => {
        if (active) setIncident(result);
      })
      .catch(() => {
        if (active) setIncident('error');
      });
    return () => {
      active = false;
    };
  }, [repository, incidentId, telemetry]);

  async function run(action: IncidentAction, extra: Record<string, unknown> = {}) {
    if (!actions || !actor) return;
    setMessage(null);
    try {
      // La autorización real se valida en performIncidentAction, no solo ocultando botones.
      setIncident(await performIncidentAction(actions, actor, incidentId, action, extra, telemetry));
      setMessage('Acción realizada.');
    } catch (error) {
      setMessage(
        error instanceof ForbiddenActionError
          ? 'No tienes permiso para esta acción.'
          : 'No se pudo completar la acción.',
      );
    }
  }

  return (
    <View style={styles.container} testID="incident-detail-screen">
      <Pressable onPress={onBack} testID="incident-detail-back">
        <Text style={styles.back}>‹ Volver</Text>
      </Pressable>
      {incident === 'loading' && <Text>Cargando…</Text>}
      {incident === null && <Text>Incidencia no encontrada.</Text>}
      {incident === 'error' && <Text testID="incident-detail-error">No se pudo cargar la incidencia.</Text>}
      {incident !== 'loading' && incident !== 'error' && incident !== null && (
        <View>
          <Text style={styles.title}>{incident.categoria ?? 'Sin categoría'}</Text>
          <Text>{incident.descripcion ?? 'Sin detalle disponible.'}</Text>
          <Text style={styles.status}>Estado: {incident.estado}</Text>
        </View>
      )}
      {actions && actor && typeof incident === 'object' && incident !== null && (
        <View style={styles.actions}>
          {actor.role === 'technician' && (
            <>
              <Pressable testID="action-start" onPress={() => void run('start')}>
                <Text style={styles.back}>Iniciar trabajo</Text>
              </Pressable>
              <TextInput
                testID="action-diagnosis"
                placeholder="Diagnóstico"
                value={diagnosis}
                onChangeText={setDiagnosis}
                style={styles.input}
              />
              <Pressable testID="action-resolve" onPress={() => void run('resolve', { diagnosis })}>
                <Text style={styles.back}>Resolver</Text>
              </Pressable>
            </>
          )}
          {actor.role === 'coordinator' && (
            <Pressable testID="action-close" onPress={() => void run('close')}>
              <Text style={styles.back}>Cerrar incidencia</Text>
            </Pressable>
          )}
          {message ? <Text testID="action-message">{message}</Text> : null}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 24 },
  back: { color: '#2563eb', marginBottom: 8 },
  title: { fontSize: 18, fontWeight: '600' },
  status: { color: '#555' },
  actions: { gap: 8, marginTop: 12 },
  input: { borderWidth: StyleSheet.hairlineWidth, borderColor: '#999', padding: 8 },
});