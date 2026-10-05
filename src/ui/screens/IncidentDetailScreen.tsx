import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { getIncidentDetail } from '../../application/incidents/getIncidentDetail';
import type { Incident } from '../../domain/incident/Incident';
import type { IncidentRepository } from '../../domain/incident/IncidentRepository';
import type { Telemetry } from '../../application/telemetry/Telemetry';

export type IncidentDetailScreenProps = Readonly<{
  repository: IncidentRepository;
  incidentId: string;
  onBack: () => void;
  telemetry?: Telemetry;
}>;

export function IncidentDetailScreen({ repository, incidentId, onBack, telemetry }: IncidentDetailScreenProps) {
  const [incident, setIncident] = useState<Incident | null | 'loading' | 'error'>('loading');

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
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 24 },
  back: { color: '#2563eb', marginBottom: 8 },
  title: { fontSize: 18, fontWeight: '600' },
  status: { color: '#555' },
});
