import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';

import { getBackendHealth } from './src/api/courseBackend';
import { createTelemetry } from './src/application/telemetry/Telemetry';
import { InMemoryIncidentRepository } from './src/infrastructure/incidents/InMemoryIncidentRepository';
import { ConsoleTelemetrySink } from './src/infrastructure/telemetry/ConsoleTelemetrySink';
import { IncidentDetailScreen } from './src/ui/screens/IncidentDetailScreen';
import { IncidentListScreen } from './src/ui/screens/IncidentListScreen';

// Composition root: the only place allowed to know about the Infrastructure implementation.
const incidentRepository = new InMemoryIncidentRepository();
// Todo log pasa por redactForTelemetry antes de llegar a la consola.
const telemetry = createTelemetry(new ConsoleTelemetrySink());

type Route = Readonly<{ name: 'list' }> | Readonly<{ name: 'detail'; incidentId: string }>;

export default function App() {
  const [status, setStatus] = useState<'checking' | 'available' | 'offline'>('checking');
  const [route, setRoute] = useState<Route>({ name: 'list' });

  useEffect(() => {
    let active = true;
    getBackendHealth()
      .then(() => active && setStatus('available'))
      .catch((error: unknown) => {
        telemetry.error('backend.health_failed', error);
        if (active) setStatus('offline');
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <View style={styles.screen}>
      <View accessibilityRole="summary" style={styles.card}>
        <Text style={styles.title}>CampusOps</Text>
        <Text>Incidencias del campus · entorno académico ficticio</Text>
        <Text testID="backend-status">Backend: {status}</Text>
      </View>
      {route.name === 'list' ? (
        <IncidentListScreen
          repository={incidentRepository}
          telemetry={telemetry}
          onSelectIncident={(incidentId) => setRoute({ name: 'detail', incidentId })}
        />
      ) : (
        <IncidentDetailScreen
          key={route.incidentId}
          repository={incidentRepository}
          telemetry={telemetry}
          incidentId={route.incidentId}
          onBack={() => setRoute({ name: 'list' })}
        />
      )}
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 24 },
  card: { gap: 12, paddingBottom: 20 },
  title: { fontSize: 24, fontWeight: '700' },
});
