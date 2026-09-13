import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { getIncidentDetail } from '../../application/incidents/getIncidentDetail';
import type { Incident } from '../../domain/incident/Incident';
import type { IncidentRepository } from '../../domain/incident/IncidentRepository';

export type IncidentDetailScreenProps = Readonly<{
  repository: IncidentRepository;
  incidentId: string;
  onBack: () => void;
}>;

export function IncidentDetailScreen({ repository, incidentId, onBack }: IncidentDetailScreenProps) {
  const [incident, setIncident] = useState<Incident | null | 'loading'>('loading');

  useEffect(() => {
    let active = true;
    getIncidentDetail(repository, incidentId).then((result) => {
      if (active) setIncident(result);
    });
    return () => {
      active = false;
    };
  }, [repository, incidentId]);

  return (
    <View style={styles.container} testID="incident-detail-screen">
      <Pressable onPress={onBack} testID="incident-detail-back">
        <Text style={styles.back}>‹ Volver</Text>
      </Pressable>
      {incident === 'loading' && <Text>Cargando…</Text>}
      {incident === null && <Text>Incidencia no encontrada.</Text>}
      {incident !== 'loading' && incident !== null && (
        <View>
          <Text style={styles.title}>{incident.categoria}</Text>
          <Text>{incident.descripcion}</Text>
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
