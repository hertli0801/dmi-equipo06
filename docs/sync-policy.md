# Política de sincronización — CampusOps (semana 8)
Responsable: lógica pura de combinación/conflicto (paso 5) y coordinación de cierre.

## 1. Qué se combina y qué requiere resolución
`resolveSync(base, local, remote)` compara campo por campo (contenido JSON, no identidad de objeto):

- Si solo un lado cambió un campo respecto a `base`, se usa ese cambio (combinación).
- Si ambos lados cambiaron el mismo campo **al mismo valor**, no es conflicto.
- Si ambos lados cambiaron el mismo campo **a valores distintos**, se reporta como conflicto, listando los nombres de campo en orden alfabético.
- En CampusOps, `work` agrupa `{ assignedTechnicianId, status }`: un inicio local (`status`) y una reasignación remota (`assignedTechnicianId`) son cambios distintos sobre el mismo campo compuesto → conflicto sobre `work`.
- Prueba: `course-tests/public/week-08.test.ts` — "CampusOps detects offline start versus remote reassignment without mutating either record" y "merges independent field changes and reports same-field conflict".

## 2. Autorización
Antes de encolar, `recordOfflineIncidentWork` autoriza con `canPerform` (misma regla de la semana 6) contra la última copia confirmada en la caché local. El servidor vuelve a autorizar al sincronizar; esto no sustituye esa comprobación.
Prueba: `src/infrastructure/persistence/__tests__/PendingOperationQueue.restart.test.ts` — "week 6 authorization still applies offline: a technician not assigned cannot queue work".

## 3. Identidad estable y reintento
Cada operación tiene un `operationId` que no cambia al reintentar ni al reiniciar la app; viaja como `Idempotency-Key` hacia el servidor. Reutilizar la misma clave con el mismo contenido no crea una segunda operación; reutilizarla con contenido distinto es un error (`OperationIdentityError`).
Prueba: `src/infrastructure/persistence/__tests__/PendingOperationQueue.restart.test.ts` — "re-enqueuing the same operationId keeps the first operation; reusing it with other content is rejected".

`deduplicateOperations` aplica la misma regla de identidad a cualquier lista de operaciones: conserva la primera aparición de cada `operationId`, en orden, sin mutar las entradas.
Prueba: `course-tests/public/week-08.test.ts` — "deduplicates a replayed operation by stable identity".

## 4. Cuándo se retira una operación de la cola
Solo `removeConfirmed` saca una operación de la cola, y solo se llama tras confirmación explícita del servidor (incluida una respuesta `duplicate: true`). Un 409/403 marca la operación como `conflict` y permanece en la cola; un timeout, error de red, 500 o 429 la deja `pending`. Ni un error ni un conflicto autorizan descartarla.
Prueba: `src/infrastructure/persistence/__tests__/PendingOperationQueue.restart.test.ts` — "keeps FIFO order, attempts and conflict state across restarts; only a confirmed operation leaves the queue".

## 5. Resultado del conflicto hacia el usuario
Una operación en `conflict` se muestra como "Conflicto" en el detalle de la incidencia; el resto de pendientes, como "Pendiente". No se sobrescribe la asignación remota ni se borra la intención local.
