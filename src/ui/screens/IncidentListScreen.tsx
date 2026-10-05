import { useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { listIncidents } from '../../application/incidents/listIncidents';
import type { Incident } from '../../domain/incident/Incident';
import type { IncidentRepository } from '../../domain/incident/IncidentRepository';
import type { Telemetry } from '../../application/telemetry/Telemetry';

export type IncidentListScreenProps = Readonly<{
  repository: IncidentRepository;
  onSelectIncident: (incidentId: string) => void;
  telemetry?: Telemetry;
}>;

export function IncidentListScreen({ repository, onSelectIncident, telemetry }: IncidentListScreenProps) {
  const [incidents, setIncidents] = useState<readonly Incident[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    listIncidents(repository, telemetry)
      .then((result) => {
        if (active) setIncidents(result);
      })
      // El detalle técnico ya quedó sanitizado en telemetría; la UI sólo muestra un mensaje genérico.
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [repository, telemetry]);

  return (
    <View style={styles.container} testID="incident-list-screen">
      <Text style={styles.heading}>Incidencias</Text>
      {failed && <Text testID="incident-list-error">No se pudieron cargar las incidencias.</Text>}
      <FlatList
        data={incidents}
        keyExtractor={(incident) => incident.id}
        renderItem={({ item }) => (
          <Pressable
            testID={`incident-item-${item.id}`}
            style={styles.item}
            onPress={() => onSelectIncident(item.id)}
          >
            <Text style={styles.itemTitle}>{item.categoria ?? 'Sin categoría'}</Text>
            <Text>{item.descripcion ?? 'Sin detalle disponible.'}</Text>
            <Text style={styles.itemStatus}>{item.estado}</Text>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 24 },
  heading: { fontSize: 18, fontWeight: '600', marginBottom: 8 },
  item: { paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#ccc' },
  itemTitle: { fontWeight: '600' },
  itemStatus: { color: '#555' },
});
