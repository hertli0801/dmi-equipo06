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
y muestra "Ubicación del servicio no disponible, escríbela manualmente". _(La pantalla y su prueba con proveedor fallando: sección a cargo de C.)_

Pruebas: `src/domain/location/__tests__/selectIncidentLocation.test.ts` (18 casos inválidos + bordes) y
`src/infrastructure/geocoding/__tests__/HttpGeocodingAdapter.backend.test.ts` contra el doble real: `success`, `incomplete`,
`invalid_coordinates`, `malformed`, `rate_limited`, `server_error`, `slow` (timeout de 300 ms < 1200 ms del doble) y desconexión (puerto cerrado).

## 4. Reglas de reintento y fallo

La decisión vive en `planRetry` (`src/course-evaluation/index.ts`) y `retryWithPolicy` (`src/application/resilience/retryWithPolicy.ts`) la aplica en un bucle acotado.

| Situación | Decisión |
|---|---|
| Timeout, sin red, 408, 429 o 5xx | Se reintenta |
| 400, 401, 403, 404, 409, 422 y cualquier otro estado | No se reintenta; se informa el fallo |
| POST sin clave de idempotencia (vacía o con espacios) | No se reintenta |
| POST con clave estable | Se reintenta con la misma clave y el mismo contenido |
| `Retry-After` válido (finito y ≥ 0) dentro del tope | Se espera exactamente ese tiempo |
| `Retry-After` mayor al tope (30 s) | No se acorta ni se reintenta; se informa y se usa la alternativa |
| `Retry-After` inválido (negativo, NaN, infinito) | Se ignora y se usa el backoff |
| Backoff | `base · 2^(intento−1)` con tope: 500, 1000 y 2000 ms |
| Límite | Desde el intento 4 no se reintenta: como máximo 4 solicitudes |

**Configuración.** `RetryPolicy` tiene `noRetryFromAttempt` (4), `baseDelayMs` (500) y `maxDelayMs` (30 000). `retryWithPolicy` acepta una política distinta, un `sleep` y un reloj inyectables, por lo que los límites se comprueban en pruebas sin esperar.

**Por qué un POST necesita clave.** Un timeout no prueba que el servidor no ejecutó la operación. Reenviar con la misma clave y contenido devuelve el resultado ya guardado (`duplicate: true`) y no duplica eventos. Con la misma clave y contenido distinto el servidor responde 409, que no se reintenta ni se trata como éxito.

**Por qué no se acorta un `Retry-After` excesivo.** Reintentar antes de lo que pide el servicio lo saturaría y podría agravar el bloqueo. Si el tiempo pedido supera el tope, se deja de reintentar y se informa al usuario.

**Alternativas descartadas.** Reintento infinito (satura y puede duplicar), no reintentar nunca (mala experiencia con fallos pasajeros), reintentar POST sin clave (duplica efectos) y demora fija (golpea al servicio).

**Evidencia.** `reports/week-09/retry-metrics.json`, generado por `scripts/week-09-collect.ts` contra el backend del curso con esperas reales.

## 5. Respuesta perdida e idempotencia

_Pendiente (C)._

## 6. Qué se registra y qué se oculta

`retryWithPolicy` registra por intento el evento `retry.attempt` con el número de intento, el resultado (`ok`, estado HTTP o `timeout`), la duración en milisegundos y si se reintentará.

No se registra la URL, la consulta, cabeceras, el cuerpo de la solicitud o respuesta, ubicaciones, coordenadas, tokens ni identificadores de usuario. Las claves de idempotencia de los reportes son sintéticas (por ejemplo `resolve-campus-inc-001-op-1`) y el registro de intentos no las incluye.

Aporte de la parte de ubicación: el evento `geocoding.lookup` sólo registra `provider`, `outcome`
(`cache_hit`, `valid`, `invalid_or_incomplete`, `gave_up`, `not_retryable`), `status`, `attempt` y `durationMs`; nunca la consulta,
el `label` ni coordenadas (prueba: "los logs no llevan consulta ni coordenadas").
