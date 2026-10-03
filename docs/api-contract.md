# Contrato de datos — Cliente cloud de CampusOps (Semana 5)

## Alcance

Este documento describe qué datos envía y recibe la aplicación al consultar lista, detalle y crear incidencias contra el backend didáctico de CampusOps (`docs/CAMPUSOPS_API.md`), y cómo se traduce esa respuesta cruda del servidor al modelo de dominio que usa el resto de la app.

## Endpoints consumidos

### `GET /v1/incidents`

Devuelve `{ items: [...] }`, donde cada elemento trae el sobre `{ id, version, status, payload }` descrito abajo. El reportante ve solo sus reportes, el técnico sus asignaciones, el coordinador todos — el filtrado ocurre en el servidor según el actor autenticado, no en el cliente.

### `GET /v1/incidents/:id`

Devuelve un único sobre `{ id, version, status, payload }` para la incidencia solicitada, si es visible para el actor actual.

### `POST /v1/incidents`

El reportante crea una incidencia nueva con categoría válida, descripción no vacía y `location` textual. Requiere un header `Idempotency-Key` estable: el mismo valor en reintentos debe devolver el mismo resultado sin duplicar la incidencia, no generar una clave nueva en cada intento.

## El límite entre DTO y dominio

El servidor devuelve un **sobre** (`DTO`, "Data Transfer Object") con esta forma:

```ts
{ id: string; version: number; status: string; payload: JsonObject | null }
```

Este sobre es intencionalmente genérico: `version` es el control de concurrencia optimista del servidor, `status` es el estado crudo tal como lo representa el backend, y `payload` es un objeto libre (o `null`) con los datos propios de la incidencia.

El dominio de la aplicación (`src/domain/incident/Incident.ts`) define un tipo distinto y más específico:

```ts
{ id: string; categoria: IncidentCategory; descripcion: string; estado: IncidentStatus }
```

**Por qué no se usa el DTO directamente en las pantallas:**

- El DTO es *forward-compatible* por diseño: puede traer campos nuevos que el cliente todavía no conoce (`parseRemoteResource` los ignora a propósito). El dominio, en cambio, es un contrato cerrado y específico de lo que la UI necesita mostrar.
- `payload` en el DTO es un objeto sin forma garantizada más allá de "objeto o null" — construir pantallas directamente sobre ese objeto crudo obligaría a repetir validaciones de forma en cada pantalla. En cambio, una sola capa de traducción (en `infrastructure/incidents`) convierte el DTO ya validado en un `Incident` de dominio, y las pantallas solo conocen ese tipo estable.
- Un `payload` igual a `null` es un estado **válido** del servidor (por ejemplo, una incidencia archivada sin detalle adicional), no un error. Si las pantallas leyeran el DTO crudo, sería fácil confundir "no hay payload" con "la respuesta falló". Al pasar primero por `parseRemoteResource`, ese caso queda representado explícitamente como `payload: null` dentro de un resultado `ok: true` — nunca como un error.
- Separar DTO y dominio también aísla a la app de cambios en el contrato del servidor: si el backend agrega o renombra un campo dentro de `payload`, solo cambia la capa de traducción, no cada pantalla que use `Incident`.

## Representación de errores

`parseRemoteResource` solo puede devolver dos formas, nunca lanzar una excepción:

```ts
{ ok: true; value: { id, version, status, payload } }
{ ok: false; error: 'contract' }
```

`error: 'contract'` cubre cualquier violación de forma del sobre (id/status vacío, version no entera o negativa, payload de tipo incorrecto). Los demás tipos de fallo — reservados para la capa de cliente HTTP, fuera de esta función — se distinguen como:

- `{ kind: 'malformed' }` — la respuesta no es JSON válido.
- `{ kind: 'timeout' }` — la petición no obtuvo respuesta dentro del límite esperado.
- `{ kind: 'serverError', status: number }` — el servidor respondió con un código de error (ej. 500).

Ningún caso de error se representa lanzando una excepción sin capturar: todos quedan como datos tipados que el cliente puede inspeccionar y la UI puede mostrar de forma distinta (reintentar, avisar que no hay conexión, etc.).
