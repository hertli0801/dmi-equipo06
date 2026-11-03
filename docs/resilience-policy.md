# Política de resiliencia — Semana 9

Cómo CampusOps sigue siendo útil cuando el servicio de ubicación falla y cómo reintenta sólo cuando es seguro.
Todos los datos de este documento son ficticios; no se registran consultas, coordenadas, tokens ni IDs reales.

## 1. Proveedor de ubicación y ejecución externa

**Arquitectura (puerto + adaptadores).**

| Capa | Archivo | Responsabilidad |
|---|---|---|
| Dominio | `src/domain/location/GeocodingProvider.ts` | Puerto `geocode(query) → GeocodingAttempt`. Un intento por llamada; **nunca lanza**. |
| Dominio | `src/domain/location/selectIncidentLocation.ts` | Valida el resultado externo (`parseProviderLocation`) y decide proveedor vs. manual. `src/course-evaluation/index.ts` delega aquí. |
| Infraestructura | `src/infrastructure/geocoding/HttpGeocodingAdapter.ts` | Doble controlado del curso: `GET /v1/geocoding?q=<consulta codificada>` con `Authorization: Bearer course-valid-token` y `X-Course-Actor`. |
| Infraestructura | `src/infrastructure/geocoding/NominatimGeocodingAdapter.ts` | Proveedor externo real (OpenStreetMap Nominatim). Traduce `[{display_name, lat, lon}]` al formato común `{label, latitude, longitude}`. |
| Aplicación | `src/application/location/lookupIncidentLocation.ts` | `createLocationLookup()` → `findLocation(query)`: caché → proveedor con `retryWithPolicy` (GET) → validación. Devuelve ubicación válida o `null`. |

**Cómo se traduce cada respuesta del proveedor** (adaptador → `GeocodingAttempt`):

| Situación | Resultado del adaptador | Qué ve la UI |
|---|---|---|
| 2xx con `{label, latitude, longitude}` válido | `{ ok: true, value }` | Ubicación del proveedor |
| 2xx incompleto / coordenadas inválidas | `{ ok: true, value }` (la validación lo rechaza) | Manual |
| 2xx con JSON malformado | `{ ok: true, value: null }` (no es transitorio, no se reintenta) | Manual |
| 429 | `{ ok: false, status: 429, retryAfterMs }` (`Retry-After` en segundos o fecha HTTP → ms) | Manual si se agotan intentos |
| 5xx | `{ ok: false, status }` | Manual si se agotan intentos |
| Timeout propio (`AbortController`, 3000 ms por defecto) o red caída | `{ ok: false, status: 'timeout' }` | Manual |
| 4xx distinto de 408/429 (p. ej. 422 consulta vacía) | `{ ok: false, status }` → no reintentable | Manual |

**Restricciones del proveedor externo (Nominatim, política pública de uso):** sin credenciales; máximo 1 solicitud por segundo;
`User-Agent` que identifique la aplicación (obligatorio); prohibido el uso masivo o el autocompletado; el resultado
debe cachearse y atribuirse a OpenStreetMap (licencia ODbL). Por eso **las pruebas nunca llaman al proveedor real**: los fallos se
reproducen con el doble controlado (`X-Course-Scenario`), sin depender de cuotas ni disponibilidad externa.

**Ejecución real (una sola solicitud, consulta genérica ficticia):**

```bash
LIVE_GEOCODING=1 npx jest --testMatch '**/scripts/week-09-geocoding-live.ts' --no-watchman --ci --runInBand
```

| Campo | Valor observado |
|---|---|
| Fecha y hora | 2026-11-03T03:03:13Z (2026-11-02 21:03 hora de CDMX) |
| Proveedor | OpenStreetMap Nominatim |
| URL base | `https://nominatim.openstreetmap.org` (`/search?format=jsonv2&limit=1&q=…`) |
| Consulta | genérica, de ciudad (no ligada a ninguna persona); no se registra |
| Estado HTTP | 2xx (intento `ok`) |
| Intentos | 1 (política `noRetryFromAttempt: 1` para respetar la cuota) |
| Latencia aproximada | 679 ms |
| ¿Resultado con coordenadas válidas? | **sí** (validado con `parseProviderLocation`; no se pegan las coordenadas) |
| Segunda consulta igual | servida desde caché (0 solicitudes adicionales) |

Salida sanitizada del script: `WEEK09_LIVE_GEOCODING {"provider":"OpenStreetMap Nominatim",…,"attempts":1,"attemptResults":["ok"],"latencyMs":679,"validCoordinates":"sí","secondLookupServedFromCache":true}`.
El script está excluido de la suite normal (`test.skip` si no se define `LIVE_GEOCODING=1`).

## 2. Caché

`src/application/location/GeocodingCache.ts` — caché en memoria con TTL.

- **Llave:** consulta normalizada: `trim().toLowerCase()` y espacios colapsados (`"  Edificio   A "` y `"edificio a"` son la misma llave).
- **TTL:** 10 minutos por defecto (`ttlMs` configurable, reloj `nowMs` inyectable). Al expirar, la siguiente consulta vuelve a la red.
- **Tamaño máximo:** 100 entradas (`maxEntries`); se expulsa la más antigua.
- **Qué se guarda:** **sólo** ubicaciones ya validadas. Nunca errores, `null`, respuestas incompletas, coordenadas inválidas ni JSON malformado:
  un fallo pasajero no debe quedar "pegado" durante todo el TTL.
- **Por qué:** reduce solicitudes (cuota de 1 req/s del proveedor real) y hace instantánea una consulta repetida.

Pruebas (`src/application/location/__tests__/lookupIncidentLocation.test.ts`): la 2.ª consulta igual no llama a la red; con TTL de 1000 ms
la consulta en t=999 sale de caché y en t=1000 vuelve al proveedor; incompleta/inválida/malformada/422 no se guardan (`cache.size === 0`).

## 3. Ubicación manual (alternativa)

`selectIncidentLocation(provider, manualLabel)` (`src/domain/location/selectIncidentLocation.ts`) acepta **únicamente** un objeto (no arreglo) con
`label` de texto no vacío (no sólo espacios) y `latitude`/`longitude` numéricas finitas dentro de [-90, 90] y [-180, 180]
(`0, 0` es válido: no se valida con `!latitude`). Devuelve `{ source: 'provider', label, latitude, longitude }`.

En cualquier otro caso — `null`, error como dato (`{ status: 429 }`), incompleto, `NaN`, `Infinity`, coordenadas como texto, fuera de rango,
arreglo, `label` vacío — devuelve `{ source: 'manual', label: manualLabel }` **sin coordenadas**: nunca se inventan.

Flujo en la app: `findLocation(query)` de `createLocationLookup` se inyecta en la pantalla de crear incidencia (`findLocation` /
`selectLocation`). El campo "edificio, zona o referencia" está siempre disponible; si el proveedor falla o tarda, la UI no se bloquea
y muestra "Ubicación del servicio no disponible, escríbela manualmente". **Pantalla (C).** `src/ui/screens/CreateIncidentScreen.tsx` recibe `findLocation` y `selectLocation` por props (en `App.tsx` se inyectan `createLocationLookup` y `selectIncidentLocation`). Al crear, consulta al proveedor con un tope de 3 s; cualquier fallo, rechazo o demora se trata como "no disponible" y se sigue con la etiqueta manual. Si no hay ubicación manual ni del proveedor, no se crea y se pide escribirla. Pruebas en `src/ui/screens/__tests__/CreateIncidentScreen.test.tsx`: proveedor que falla, proveedor lento, sin ubicación y error del repositorio (mensaje genérico, sin token).

Pruebas: `src/domain/location/__tests__/selectIncidentLocation.test.ts` (18 casos inválidos + bordes) y
`src/infrastructure/geocoding/__tests__/HttpGeocodingAdapter.backend.test.ts` contra el doble real: `success`, `incomplete`,
`invalid_coordinates`, `malformed`, `rate_limited`, `server_error`, `slow` (timeout de 300 ms < 1200 ms del doble) y desconexión (puerto cerrado).

## 4. Reglas de reintento y fallo

_Pendiente (B)._

## 5. Respuesta perdida e idempotencia

### Escenario
El cliente envía una acción de escritura (por ejemplo `resolve`) y el servidor **sí la guarda**, pero la respuesta no llega a tiempo y el cliente aborta por su propio timeout. El cliente no sabe si el cambio se aplicó. El backend didáctico simula esto con `X-Course-Scenario: timeout_after_commit`.

### Regla
- Cada operación lleva una clave estable: `idempotencyKey = operationId`. Se reutiliza tal cual en cada reintento y nunca se genera una clave nueva por intento.
- Sin confirmación del servidor, la operación **permanece en la cola** de la semana 8. Solo sale de la cola cuando se confirma.
- Reintentar con la **misma clave y el mismo contenido** devuelve el resultado ya guardado (`duplicate: true`) y no agrega eventos.
- Reutilizar la misma clave con **contenido distinto** devuelve `409` (`idempotency_key_reused`). El cliente no lo trata como éxito.

### Evidencia manual (curl)
Ejecutada el 2 nov 2026, backend recién iniciado, datos ficticios, incidencia `campus-inc-001` (empieza `assigned`, versión 1). Los encabezados `Authorization` y `X-Course-Actor` se omiten de este reporte.

| # | Comando (resumen) | Resultado observado |
|---|---|---|
| 1 | `POST /actions` `start`, clave `curl-start-0001`, `baseVersion 1` | versión 2, `in_progress`, `duplicate:false` |
| 2 | `POST /actions` `resolve`, clave `curl-resolve-0001`, `X-Course-Scenario: timeout_after_commit`, `curl -m 0.3` | sin respuesta; `curl` termina con código 28 (timeout) |
| 3 | `GET /v1/incidents/campus-inc-001` | versión 3, `resolved`; el historial tiene **un solo** evento `curl-resolve-0001` |
| 4 | Mismo `resolve`, misma clave y mismo contenido | `duplicate:true`, versión 3, sin evento nuevo |
| 5 | Misma clave, `diagnosis` distinto | `409 Conflict`, `{"code":"idempotency_key_reused"}` |

Conclusión: aunque el cliente nunca recibió la respuesta del paso 2, el cambio quedó aplicado una sola vez, y el reintento del paso 4 no lo duplicó.

### Evidencia automatizada
`src/application/sync/__test__/lostResponse.test.ts` (backend real y cola SQLite real):
1. Intento 1 con `timeout_after_commit` y timeout de 300 ms: la operación queda `pending` y **sigue en la cola**.
2. Intento 2 con la misma `operationId` y el mismo contenido: se confirma y **sale de la cola**. El servidor queda en versión 3 con un solo evento para esa operación, `evidence` vacío y `notes` vacío (sin duplicados).
3. Misma clave con contenido distinto: `409`, la versión y el historial no cambian.

Las pruebas de la semana 8 (cola, migración, sincronización) siguen pasando.

### Límites
- El backend didáctico no tiene un concepto de notificaciones; solo guarda `history`, `evidence` y `notes`. "Sin duplicados" se verificó sobre esos tres campos.
- La prueba automatizada usa un transporte con timeout corto, no una red real con pérdida de paquetes.
- La integración con `retryWithPolicy` / `sendWithRetries` no forma parte de este PR; la semana 8 envía con una sola clave estable por operación.

## 6. Qué se registra y qué se oculta

_Pendiente (B)._ Aporte de la parte de ubicación: el evento `geocoding.lookup` sólo registra `provider`, `outcome`
(`cache_hit`, `valid`, `invalid_or_incomplete`, `gave_up`, `not_retryable`), `status`, `attempt` y `durationMs`; nunca la consulta,
el `label` ni coordenadas (prueba: "los logs no llevan consulta ni coordenadas").
