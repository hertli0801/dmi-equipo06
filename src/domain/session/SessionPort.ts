/** Contrato que usa el cliente HTTP para renovar la sesión sin conocer cómo se renueva. */
export interface SessionPort {
  /** Access token vigente (solo en memoria). `null` si no hay sesión. */
  getAccessToken(): string | null;
  /** Generación de la sesión: sube con cada login o refresh exitoso. */
  getGeneration(): number;
  /**
   * Pide renovar tras un 401. Devuelve el token nuevo, o `null` si la sesión ya no es válida.
   * Varias llamadas con la misma generación comparten UN solo refresh.
   */
  refresh(requestGeneration: number, requestId: string): Promise<string | null>;
}