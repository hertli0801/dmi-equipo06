# Auditoría de seguridad — Semana 4

## Hallazgos

| # | Hallazgo | Riesgo | Solución aplicada | Evidencia |
|---|---|---|---|---|
| 1 | API key ficticia escrita directo en scripts/session-login-demo.mjs | Cualquier persona con acceso al repositorio podría ver la credencial; si fuera real, quedaría expuesta permanentemente en el historial de git | Se movió a process.env.DEMO_API_KEY | evidence/hallazgo-1-antes.txt, evidence/hallazgo-1-despues.txt |
| 2 | console.log imprimía el objeto completo del login, incluyendo accessToken y refreshToken | Filtración de tokens de sesión en logs, correspondiente a la amenaza "Exponer credenciales" (prioridad 1) de docs/threat-model.md | Se reemplazó por un log que solo confirma el estado de autenticación, sin datos sensibles | evidence/hallazgo-2-antes.txt, evidence/hallazgo-2-despues.txt |
| 3 | El error de conexión exponía la IP y el puerto interno del backend en el stack trace | Facilita a un atacante mapear la infraestructura interna del sistema | Se envolvió la petición en try/catch y se generalizó el mensaje de error | evidence/hallazgo-3-antes.txt, evidence/hallazgo-3-despues.txt |

## Hallazgo 1 — API key escrita directo en el código

### Problema encontrado
En `scripts/session-login-demo.mjs`, la constante `API_KEY` tenía el valor `"demo_key_123"` escrito directamente en el código fuente.

### Riesgo
Cualquier persona con acceso al repositorio podría ver el valor. Si en producción se usara una credencial real de esta forma, quedaría expuesta de manera permanente en el historial de Git, incluso si después se elimina del archivo.

### Solución
Se movió el valor a una variable de entorno.

### Antes
```js
const API_KEY = "demo_key_123";
```

### Después
```js
const API_KEY = process.env.DEMO_API_KEY;
```

### Evidencia
Ver `evidence/hallazgo-1-antes.txt` y `evidence/hallazgo-1-despues.txt`.

## Hallazgo 2 — Token completo impreso en consola

### Problema encontrado
Tras el login, `console.log(data)` imprimía el objeto completo devuelto por el backend, incluyendo `accessToken` y `refreshToken`.

### Riesgo
Corresponde a la amenaza #1 de `docs/threat-model.md` ("Exponer credenciales"), identificada como la amenaza raíz del proyecto: comprometer un token habilita el resto de las amenazas del sistema.

### Solución
Se reemplazó el log completo por uno que solo indica el estado de autenticación y el actorId, sin incluir el token.

### Antes
```js
console.log(data);
```

### Después
```js
console.log({ status: "authenticated", actorId: data.actorId });
```

### Evidencia
Ver `evidence/hallazgo-2-antes.txt` y `evidence/hallazgo-2-despues.txt`.

## Hallazgo 3 — Error de conexión exponía IP y puerto internos

### Problema encontrado
Cuando el backend no estaba disponible, el `fetch` fallaba sin manejo de errores, y Node imprimía un stack trace completo con la dirección (`127.0.0.1`) y el puerto (`4310`) del backend.

### Riesgo
Expone detalles de la infraestructura interna que podrían ayudar a un atacante a mapear el sistema.

### Solución
Se envolvió la petición en un bloque `try/catch` que captura cualquier error de conexión y lanza un mensaje genérico hacia quien use la app.

### Antes
```js
throw new Error(`Error conectando con ${baseUrl}/v1/session/login`);
```

### Después
```js
try {
  // ...fetch...
} catch {
  throw new Error("No fue posible iniciar sesion.");
}
```

### Evidencia
Ver `evidence/hallazgo-3-antes.txt` y `evidence/hallazgo-3-despues.txt`.