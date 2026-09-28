// Almacenamiento seguro de la sesión (capa infrastructure).
// Usa expo-secure-store: cifra los datos en el dispositivo
// (Keychain en iOS, Keystore en Android).
import * as SecureStore from 'expo-secure-store';

const REFRESH_TOKEN_KEY = 'campusops.refreshToken';

/** Guarda el token de refresco cifrado en el dispositivo. */
export async function saveRefreshToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token);
}

/** Lee el token de refresco. Devuelve null si no hay sesión guardada. */
export async function readRefreshToken(): Promise<string | null> {
  return SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
}

/** Borra la sesión guardada (para cerrar sesión). */
export async function clearSession(): Promise<void> {
  await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
}