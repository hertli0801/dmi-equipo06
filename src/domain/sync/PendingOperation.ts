import type { CampusRole } from '../../campusops/contracts';
import type { IncidentAction } from '../incident/IncidentPermissions';

/**
 * Referencia a una fotografía que sigue en el dispositivo. Sólo identifica un recurso
 * pendiente: `pending_upload` es el único estado posible aquí, nunca "ya subida".
 */
export type PendingPhotoReference = Readonly<{
  photoId: string;
  localUri: string;
  uploadState: 'pending_upload';
}>;

export type OperationAuthor = Readonly<{ actorId: string; role: CampusRole }>;

export type PendingOperationContent = Readonly<{
  action: IncidentAction;
  note: string | null;
  photos: readonly PendingPhotoReference[];
  extra: Readonly<Record<string, unknown>>;
}>;

/** `conflict` sigue en la cola: un conflicto no autoriza descartar la intención local. */
export type PendingOperationStatus = 'pending' | 'conflict';

export type OperationConflict = Readonly<{
  fields: readonly string[];
  remoteVersion: number;
  detectedAt: string;
}>;

export type PendingOperation = Readonly<{
  /** Identidad estable: no cambia al reintentar ni al reiniciar la app (Idempotency-Key). */
  operationId: string;
  incidentId: string;
  author: OperationAuthor;
  content: PendingOperationContent;
  /** Versión de la incidencia sobre la que se hizo el cambio. */
  baseVersion: number;
  status: PendingOperationStatus;
  attempts: number;
  conflict: OperationConflict | null;
  enqueuedAt: string;
}>;

export type NewPendingOperation = Pick<
  PendingOperation,
  'operationId' | 'incidentId' | 'author' | 'content' | 'baseVersion' | 'enqueuedAt'
>;

/** Puerto de la cola persistente. Infrastructure la guarda en SQLite; nunca sólo en memoria. */
export interface PendingOperationQueue {
  /** Repetir un operationId con el mismo contenido devuelve la primera; con otro contenido es error. */
  enqueue(operation: NewPendingOperation): Promise<PendingOperation>;
  /** En orden de llegada (FIFO). */
  list(): Promise<readonly PendingOperation[]>;
  get(operationId: string): Promise<PendingOperation | null>;
  recordAttempt(operationId: string): Promise<void>;
  markConflict(operationId: string, conflict: OperationConflict): Promise<void>;
  /** Único camino para retirar una operación: sólo después de que el servidor la confirmó. */
  removeConfirmed(operationId: string): Promise<void>;
}

export class OperationIdentityError extends Error {
  readonly operationId: string;

  constructor(operationId: string) {
    super(`operationId reutilizado con contenido distinto: ${operationId}`);
    this.name = 'OperationIdentityError';
    this.operationId = operationId;
  }
}

/** Compara por contenido JSON (no por referencia) lo que define a una operación. */
export function sameOperationIntent(a: NewPendingOperation, b: NewPendingOperation): boolean {
  const intent = (op: NewPendingOperation) =>
    JSON.stringify([op.incidentId, op.author, op.baseVersion, op.content]);
  return intent(a) === intent(b);
}
