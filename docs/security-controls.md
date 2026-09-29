# Controles de seguridad y privacidad — CampusOps

## Controles implementados

### 1. Sanitización de telemetría (redactForTelemetry)
Se conectó `redactForTelemetry` a la lógica real de logging (`Telemetry.ts` y `ConsoleTelemetrySink.ts`), aplicando el contrato de `docs/CAMPUSOPS_API.md` a objetos anidados y listas. Oculta: nombre, ubicación, correo, IDs de asignación, fotos, comentarios internos y tokens de autorización — tanto en eventos normales como en mensajes de error, sin modificar el objeto original (verificado con `Object.freeze` recursivo en la prueba `neg-05`).

**Relación con amenazas (`docs/threat-model.md`):**
- **T1 — Exponer credenciales:** los mensajes de error que antes incluían el header `Authorization: Bearer ...` en texto plano ahora quedan como `Bearer [REDACTED]` (pruebas `neg-09`, `neg-10`, `neg-15`).
- **T2 — Filtrar datos en registros (logs):** nombre, ubicación, fotos y comentarios internos quedan `[REDACTED]` incluso en estructuras anidadas y listas (pruebas `neg-02`, `neg-03`, `neg-13`).

### 2. Almacenamiento seguro de sesión
Se usó `expo-secure-store` para el almacenamiento de la sesión, en vez de guardarla en memoria o en `AsyncStorage` sin cifrar.

**Relación con amenazas:** T1 (exponer credenciales) — reduce el riesgo de que la sesión quede accesible si el dispositivo es comprometido físicamente.

### 3. Búsqueda de secretos (secret scan)
Se confirmó que ningún secreto real quedó hardcodeado en el código, con un ciclo de prueba controlado (`reports/week-04/secret-scan.json`): un secreto ficticio de prueba fue detectado correctamente (`fail`), y tras eliminarlo el escaneo volvió a pasar (`pass`).

## Elección del mecanismo de almacenamiento

**Alternativas consideradas:**
1. **`expo-secure-store`** (elegida): cifra los datos usando el almacenamiento seguro nativo del sistema operativo (Keychain en iOS, Keystore en Android).
2. **`AsyncStorage` sin cifrar:** más simple de usar, pero guarda los datos en texto plano accesible si el dispositivo es comprometido.

**Trade-off:** `expo-secure-store` agrega una dependencia adicional y una API asíncrona ligeramente más compleja que `AsyncStorage`, pero el beneficio (cifrado nativo de credenciales) supera ese costo dado que T1 (exponer credenciales) es la amenaza de mayor prioridad del equipo.

## Riesgo residual

- La app aún no persiste sesión ni preferencias de forma completa (ver nota `notApplicable` en `negative-tests.json`) — el almacenamiento seguro está implementado a nivel de mecanismo, pero su integración completa con el flujo de sesión queda pendiente para una semana posterior (login/sesión, semana 6 según `docs/CAMPUSOPS.md`).
- La sanitización cubre los campos identificados en `docs/CAMPUSOPS_API.md` y el threat model actual; si se agregan nuevos campos sensibles en el futuro, deberán añadirse explícitamente a la lista de redacción.
