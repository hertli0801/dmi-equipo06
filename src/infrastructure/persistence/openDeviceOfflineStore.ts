import { ExpoSqliteDatabase } from './ExpoSqliteDatabase';
import { openOfflineStore, type OfflineStore } from './openOfflineStore';

/** Base local real del dispositivo (expo-sqlite), ya migrada a la última versión de esquema. */
export async function openDeviceOfflineStore(): Promise<OfflineStore> {
  return openOfflineStore(await ExpoSqliteDatabase.open());
}
