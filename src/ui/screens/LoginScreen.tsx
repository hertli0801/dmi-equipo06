import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

// Actores del backend didáctico (selector de prueba, NO autenticación institucional).
const ACTORS: readonly { id: string; label: string }[] = [
  { id: 'reporter-1', label: 'Reportante 1' },
  { id: 'reporter-2', label: 'Reportante 2' },
  { id: 'technician-1', label: 'Técnico 1' },
  { id: 'technician-2', label: 'Técnico 2' },
  { id: 'coordinator-1', label: 'Coordinador 1' },
];

export type LoginScreenProps = Readonly<{
  onLogin: (actorId: string) => Promise<void>;
  notice?: string | null;
}>;

export function LoginScreen({ onLogin, notice }: LoginScreenProps) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function enter(actorId: string) {
    setBusy(true);
    setFailed(false);
    try {
      await onLogin(actorId);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.container} testID="login-screen">
      <Text style={styles.heading}>Iniciar sesión</Text>
      {notice ? <Text testID="login-notice">{notice}</Text> : null}
      {failed ? <Text testID="login-error">No se pudo iniciar sesión.</Text> : null}
      {ACTORS.map((actor) => (
        <Pressable
          key={actor.id}
          testID={`login-${actor.id}`}
          disabled={busy}
          style={styles.button}
          onPress={() => void enter(actor.id)}
        >
          <Text style={styles.buttonText}>{actor.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 24, gap: 8 },
  heading: { fontSize: 18, fontWeight: '600' },
  button: { backgroundColor: '#2563eb', padding: 12, borderRadius: 6 },
  buttonText: { color: '#fff', fontWeight: '600' },
});