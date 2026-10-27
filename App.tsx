import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';

import { getBackendHealth } from './src/api/courseBackend';
import { performOrEnqueue, withLocalCache } from './src/application/sync/performOrEnqueue';
import { syncPendingOperations } from './src/application/sync/syncPendingOperations';
import { createTelemetry } from './src/application/telemetry/Telemetry';
import { CloudIncidentRepository } from './src/infrastructure/incidents/CloudIncidentRepository';
import { openDeviceOfflineStore } from './src/infrastructure/persistence/openDeviceOfflineStore';
import type { OfflineStore } from './src/infrastructure/persistence/openOfflineStore';
import { SessionCoordinator, type Session } from './src/infrastructure/session/SessionCoordinator';
import { ConsoleTelemetrySink } from './src/infrastructure/telemetry/ConsoleTelemetrySink';
import { IncidentDetailScreen } from './src/ui/screens/IncidentDetailScreen';
import { IncidentListScreen } from './src/ui/screens/IncidentListScreen';
import { LoginScreen } from './src/ui/screens/LoginScreen';

// Todo log pasa por redactForTelemetry antes de llegar a la consola.
const telemetry = createTelemetry(new ConsoleTelemetrySink());

type Route = Readonly<{ name: 'list' }> | Readonly<{ name: 'detail'; incidentId: string }>;

/** Una incidencia con algún conflicto se muestra como "Conflicto"; si no, como "Pendiente". */
function toSyncStates(
  operations: readonly Readonly<{ incidentId: string; status: 'pending' | 'conflict' }>[],
): Record<string, 'pending' | 'conflict'> {
  const next: Record<string, 'pending' | 'conflict'> = {};
  for (const op of operations) {
    if (next[op.incidentId] !== 'conflict') next[op.incidentId] = op.status;
  }
  return next;
}

export default function App() {
  const [status, setStatus] = useState<'checking' | 'available' | 'offline'>('checking');
  const [route, setRoute] = useState<Route>({ name: 'list' });
  const [session, setSession] = useState<Session | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [offlineStore, setOfflineStore] = useState<OfflineStore | null>(null);
  const [offlineStatus, setOfflineStatus] = useState<'opening' | 'ready' | 'unavailable'>('opening');
  // Estado de sincronización por incidencia, tomado de la cola persistente.
  const [syncStates, setSyncStates] = useState<Readonly<Record<string, 'pending' | 'conflict'>>>({});

  // Composition root: único lugar que conoce las implementaciones de Infrastructure.
  const coordinator = useMemo(
    () =>
      new SessionCoordinator({
        onSessionExpired: () => {
          setSession(null);
          setRoute({ name: 'list' });
          setNotice('Tu sesión expiró. Inicia sesión de nuevo.');
        },
      }),
    [],
  );
  const repository = useMemo(
    () =>
      session
        ? new CloudIncidentRepository(session.actorId, coordinator.getAccessToken() ?? '', undefined, {
            session: coordinator,
          })
        : null,
    [session, coordinator],
  );

  // Las lecturas en línea de cada incidencia dejan su versión en la copia local (SQLite):
  // sin ella no se puede encolar una acción sin conexión.
  const port = useMemo(
    () => (repository && offlineStore ? withLocalCache(repository, offlineStore.incidents) : null),
    [repository, offlineStore],
  );

  async function refreshSyncStates() {
    if (!offlineStore) return;
    setSyncStates(toSyncStates(await offlineStore.queue.list()));
  }

  async function handleSync() {
    if (!repository || !offlineStore) return;
    const report = await syncPendingOperations({ queue: offlineStore.queue, port: repository, telemetry });
    telemetry.info('sync.finished', {
      confirmed: report.confirmed.length,
      conflicts: report.conflicts.length,
      pending: report.pending.length,
    });
    await refreshSyncStates();
  }

  // Al iniciar sesión (con la base lista) se reenvía lo que haya quedado pendiente.
  useEffect(() => {
    if (!repository || !offlineStore) return;
    let active = true;
    syncPendingOperations({ queue: offlineStore.queue, port: repository, telemetry })
      .then(async () => {
        const operations = await offlineStore.queue.list();
        if (active) setSyncStates(toSyncStates(operations));
      })
      .catch((error: unknown) => telemetry.error('sync.failed', error));
    return () => {
      active = false;
    };
  }, [repository, offlineStore]);

  // Al abrir una incidencia en línea se guarda su versión para poder trabajarla sin conexión.
  useEffect(() => {
    if (route.name === 'detail' && port) void port.getWork(route.incidentId).catch(() => undefined);
  }, [route, port]);

  // La base local se migra al abrir; si la migración falla queda en su versión anterior (rollback).
  useEffect(() => {
    let active = true;
    let opened: OfflineStore | null = null;
    openDeviceOfflineStore()
      .then(async (store) => {
        opened = store;
        const pending = await store.queue.list();
        telemetry.info('offline_store.ready', { schemaVersion: store.schemaVersion, pendingOperations: pending.length });
        if (!active) return;
        setOfflineStore(store);
        setOfflineStatus('ready');
      })
      .catch((error: unknown) => {
        telemetry.error('offline_store.open_failed', error);
        if (active) setOfflineStatus('unavailable');
      });
    return () => {
      active = false;
      void opened?.close();
    };
  }, []);

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

  async function handleLogin(actorId: string) {
    const next = await coordinator.login(actorId);
    setNotice(null);
    setRoute({ name: 'list' });
    setSession(next);
  }

  async function handleLogout() {
    await coordinator.logout();
    setSession(null);
    setRoute({ name: 'list' });
    setNotice(null);
  }

  return (
    <View style={styles.screen}>
      <View accessibilityRole="summary" style={styles.card}>
        <Text style={styles.title}>CampusOps</Text>
        <Text>Incidencias del campus · entorno académico ficticio</Text>
        <Text testID="backend-status">Backend: {status}</Text>
        <Text testID="offline-store-status">
          Datos locales: {offlineStatus}
          {offlineStore ? ` (esquema v${offlineStore.schemaVersion})` : ''}
        </Text>
        {session && offlineStore ? (
          <Pressable
            testID="sync-now"
            onPress={() => void handleSync().catch((error: unknown) => telemetry.error('sync.failed', error))}
          >
            <Text style={styles.link}>Sincronizar pendientes ({Object.keys(syncStates).length})</Text>
          </Pressable>
        ) : null}
        {session ? (
          <Pressable testID="logout-button" onPress={() => void handleLogout()}>
            <Text style={styles.link}>
              {session.actorId} ({session.role}) · Cerrar sesión
            </Text>
          </Pressable>
        ) : null}
      </View>
      {!session || !repository ? (
        <LoginScreen onLogin={handleLogin} notice={notice} />
      ) : route.name === 'list' ? (
        <IncidentListScreen
          repository={repository}
          telemetry={telemetry}
          onSelectIncident={(incidentId) => setRoute({ name: 'detail', incidentId })}
        />
      ) : (
        <IncidentDetailScreen
          key={route.incidentId}
          repository={repository}
          telemetry={telemetry}
          incidentId={route.incidentId}
          actor={session}
          actions={port ?? repository}
          syncStatus={syncStates[route.incidentId] ?? null}
          onPerform={
            port && offlineStore
              ? async (action, extra) => {
                  try {
                    return await performOrEnqueue(
                      { port, queue: offlineStore.queue, incidents: offlineStore.incidents, telemetry },
                      session,
                      route.incidentId,
                      action,
                      extra,
                    );
                  } finally {
                    await refreshSyncStates();
                  }
                }
              : undefined
          }
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
  link: { color: '#2563eb' },
});