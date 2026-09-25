# Auditoría de seguridad — Semana 4

**Autor:** Alberto Herrera
**Rama:** `week4/security-audit-alberto`
**Alcance:** app CampusOps (`src/`, `App.tsx`), script de verificación `scripts/check-auth.mjs`, configuración del repositorio (`.gitignore`, `.env.example`) y backend de práctica `course-backend/`.

> Todos los valores usados en esta auditoría (`demo_token_123`, `admin:demo_pass_123`, `course-valid-token`) son ficticios. No se usaron credenciales reales.

## Hallazgos

| # | Hallazgo | Riesgo | Solución aplicada | Evidencia |
|---|---|---|---|---|
| 1 | Token Bearer escrito directamente en `scripts/check-auth.mjs` | Cualquiera con acceso al repositorio (o a su historial) obtiene el token y puede llamar a los endpoints protegidos | Se lee de la variable de entorno `COURSE_API_TOKEN`; el script falla si no existe. Se agregó la variable a `.env.example` | [token-hardcodeado-corregido.png](evidence/token-hardcodeado-corregido.png) |
| 2 | `.gitignore` solo ignoraba `.env` exacto; `.env.local`, `.env.production`, etc. sí se podían subir | Un `git add .` podía publicar credenciales guardadas en variantes de `.env` (Expo usa `.env.local`) | Se cambió la regla a `.env*` con la excepción `!.env.example` | [gitignore-env-corregido.png](evidence/gitignore-env-corregido.png) |
| 3 | El mensaje de error de `scripts/check-auth.mjs` imprimía la `BASE_URL` completa | Si la URL trae usuario y contraseña (`http://user:pass@host`), quedan expuestos en la terminal y en los logs de CI | El error muestra solo el origen (`protocolo://host:puerto`) mediante `safeOrigin()` | [error-url-sanitizado.png](evidence/error-url-sanitizado.png) |
| 4 | Tokens fijos (`course-valid-token`, `course-refresh-0/1`) en `course-backend/server.mjs` y `course-backend/campusops.mjs` | Si este patrón se copia a un backend real, el token sería público y nunca expiraría | **No corregido** (ver justificación) | [backend-token-fijo.png](evidence/backend-token-fijo.png) |

Se identificaron 4 hallazgos y se corrigieron 3.

---

## Hallazgo 1 — Token escrito directamente en el script de verificación

### Problema encontrado

En `scripts/check-auth.mjs` (línea 3), el token para llamar a los endpoints protegidos estaba escrito en el código (ver "Antes").

### Riesgo

El token queda en el repositorio y en su historial de Git. Cualquiera que clone el proyecto puede usarlo. Además, para cambiarlo había que editar el código y hacer un commit.

### Solución

El token ahora se lee de `COURSE_API_TOKEN`. Si la variable no existe, el script termina con un mensaje claro en vez de usar un valor por defecto. En `.env.example` se agregó el nombre de la variable, sin valor.

No se usó el prefijo `EXPO_PUBLIC_` a propósito: Expo mete esas variables en el bundle de la app, así que cualquiera podría leerlas desde el APK. Este token solo lo usa un script de Node.

### Antes

```js
const VALID = { Authorization: 'Bearer course-valid-token' };
```

### Después

```js
const API_TOKEN = process.env.COURSE_API_TOKEN;

if (!API_TOKEN) {
  console.error('ERROR: falta la variable de entorno COURSE_API_TOKEN (ver .env.example)');
  process.exit(2);
}

const VALID = { Authorization: `Bearer ${API_TOKEN}` };
```

```env
# .env.example
EXPO_PUBLIC_COURSE_BACKEND_URL=http://127.0.0.1:4310
COURSE_API_TOKEN=
```

### Evidencia

- `grep` ya no encuentra el token en el script.
- Sin la variable, el script se detiene (exit 2).
- Con la variable, las 4 verificaciones contra el backend local siguen en `OK` (exit 0), así que el control de la semana 3 sigue funcionando.

![Token corregido](evidence/token-hardcodeado-corregido.png)

---

## Hallazgo 2 — Variantes de `.env` no estaban ignoradas

### Problema encontrado

El `.gitignore` tenía la regla `.env`, que solo cubre ese nombre exacto. Archivos como `.env.local`, `.env.development` o `.env.production.local` (los que Expo carga normalmente) aparecían en `git status` como archivos listos para agregarse.

### Riesgo

Con un `git add .` se podían subir tokens o URLs privadas guardadas en esas variantes. Una vez en GitHub, el secreto queda en el historial aunque luego se borre el archivo.

### Solución

Se reemplazó la regla por un patrón más amplio que conserva la excepción para la plantilla.

### Antes

```gitignore
.env
```

### Después

```gitignore
.env*
!.env.example
```

También se revisó con `git ls-files` que ningún `.env` estuviera ya rastreado. Solo lo está `.env.example`, que no contiene secretos.

### Evidencia

- Antes: se creó un `.env.local` ficticio; `git status` lo mostraba como `??` y `git check-ignore` confirmaba que **no** estaba ignorado.
- Después: `git status` ya no lo muestra y `git check-ignore -v` indica la regla que lo ignora (`.gitignore:8:.env*`). También se ignora `.env.production.local`, mientras que `.env.example` sigue versionándose.

![.gitignore corregido](evidence/gitignore-env-corregido.png)

---

## Hallazgo 3 — Mensaje de error exponía credenciales de la URL

### Problema encontrado

Cuando el script no podía conectarse, imprimía la variable `BASE_URL` tal cual (ver "Antes").

### Riesgo

Es común poner credenciales dentro de una URL (`http://usuario:contraseña@host`). Si el backend no responde, el mensaje las muestra en la terminal y en los logs de GitHub Actions, que cualquier miembro del repositorio puede ver.

### Solución

Se agregó la función `safeOrigin()`, que usa `new URL(...).origin` para quedarse solo con protocolo, host y puerto. Así se descartan usuario, contraseña, ruta y parámetros.

### Antes

```js
console.error(`ERROR: no se pudo conectar a ${BASE_URL} (¿está levantado el backend?)`);
```

### Después

```js
function safeOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '[URL inválida]';
  }
}

console.error(`ERROR: no se pudo conectar a ${safeOrigin(BASE_URL)} (¿está levantado el backend?)`);
```

### Evidencia

Se ejecutó el script con una URL ficticia con credenciales (`http://admin:demo_pass_123@127.0.0.1:9`) y un puerto cerrado:

- Antes el error mostraba `admin:demo_pass_123`.
- Después solo muestra `http://127.0.0.1:9`.

![Error sanitizado](evidence/error-url-sanitizado.png)

---

## Hallazgo 4 — Tokens fijos en el backend de práctica (no corregido)

### Problema encontrado

`course-backend/server.mjs` (líneas 46, 58 y 61) y `course-backend/campusops.mjs` (líneas 30 y 33) comparan y devuelven tokens escritos en el código (`course-valid-token`, `course-refresh-0`, `course-refresh-1`).

### Riesgo

En un sistema real, esto significa que:

- el token es público para quien lea el código;
- el token nunca cambia;
- el token es igual para todos los usuarios.

Con eso cualquiera podría hacerse pasar por cualquier actor.

### Por qué no se corrigió

Es el backend de práctica que entrega el curso: `course-backend/self-test.mjs`, `course-backend/campusops-self-test.mjs` y las pruebas públicas dependen de esos valores exactos. Cambiarlo rompería la evaluación del equipo. Como mitigación, el código propio del proyecto (Hallazgo 1) ya no repite el token y lo recibe por variable de entorno.

### Evidencia

![Tokens fijos en backend](evidence/backend-token-fijo.png)

---

## Comprobación final

- `git status`: no aparece ningún archivo `.env` ni `.env.local` para subir.
- `git ls-files | grep .env`: solo devuelve `.env.example`.
- Este documento y las capturas solo contienen valores ficticios.
- `make verify` (typecheck, lint y test:smoke) pasa sin errores con los cambios.
