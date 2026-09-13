import { useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { listIncidents } from '../../application/incidents/listIncidents';
import type { Incident } from '../../domain/incident/Incident';
import type { IncidentRepository } from '../../domain/incident/IncidentRepository';

export type IncidentListScreenProps = Readonly<{
  repository: IncidentRepository;
  onSelectIncident: (incidentId: string) => void;
}>;

export function IncidentListScreen({ repository, onSelectIncident }: IncidentListScreenProps) {
  const [incidents, setIncidents] = useState<readonly Incident[]>([]);

  useEffect(() => {
    let active = true;
    listIncidents(repository).then((result) => {
      if (active) setIncidents(result);
    });
    return () => {
      active = false;
    };
  }, [repository]);

  return (
    <View style={styles.container} testID="incident-list-screen">
      <Text style={styles.heading}>Incidencias</Text>
      <FlatList
        data={incidents}
        keyExtractor={(incident) => incident.id}
        renderItem={({ item }) => (
          <Pressable
            testID={`incident-item-${item.id}`}
            style={styles.item}
            onPress={() => onSelectIncident(item.id)}
          >
            <Text style={styles.itemTitle}>{item.categoria}</Text>
            <Text>{item.descripcion}</Text>
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
