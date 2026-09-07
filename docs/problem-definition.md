# Definición del problema — CampusOps

## Problema

En la universidad ficticia, estudiantes y personal reportan de forma dispersa fallas eléctricas, daños en laboratorios, fugas de agua, problemas de conectividad, equipos descompuestos, riesgos de seguridad y necesidades de mantenimiento. Sin un sistema centralizado, los reportes se pierden, se duplican o tardan en atenderse porque no hay un mecanismo claro para priorizar, asignar y dar seguimiento. CampusOps busca centralizar el reporte y atención de incidencias del campus, dando trazabilidad desde que se reporta hasta que se cierra.

## Alcance

### Incluye

- Definición de los tres actores (reportante, técnico, coordinador) y sus responsabilidades.
- Documentación del flujo de una incidencia: reportar → asignar → atender → cerrar.
- Identificación y priorización de tres riesgos del proyecto.
- Un proyecto inicial (starter) instalable y verificable por cualquier integrante del equipo.

### No incluye

- Implementación de pantallas, inicio de sesión o persistencia real de datos.
- Integración con servicios de mapas o geocodificación.
- Manejo de sincronización, trabajo sin conexión o resolución de conflictos (se abordan en semanas posteriores).

## Actores y responsabilidades

- **Reportante:** crea una incidencia, elige categoría, la describe, adjunta fotografías, indica ubicación y consulta el estado de sus propios reportes.
- **Técnico:** consulta las incidencias que le fueron asignadas, inicia su atención, registra diagnóstico y notas, y marca la incidencia como resuelta.
- **Coordinador:** revisa el conjunto de incidencias, las prioriza, asigna o reasigna técnicos, y decide cuándo cerrar o reabrir un caso.

## Flujo principal

1. Reportar: el reportante crea la incidencia con categoría, descripción y ubicación; la incidencia inicia en estado `open`.
2. Asignar: el coordinador revisa y prioriza la incidencia, y la asigna a un técnico; pasa a estado `assigned`.
3. Atender: el técnico inicia la atención, registra diagnóstico y evidencia; la incidencia pasa a `in_progress` y luego a `resolved` cuando el técnico concluye.
4. Cerrar: el coordinador revisa la resolución y cierra la incidencia (`closed`), o la reabre hacia `assigned` si detecta que el problema persiste.

## Criterios de aceptación verificables

1. Dado el proyecto inicial instalado con `make setup`, cuando se ejecuta `make feedback`, entonces el typecheck, el lint y la prueba básica (`smoke test`) terminan sin errores.
2. Dado el flujo documentado, cuando una incidencia cambia de estado, entonces solo puede avanzar en la secuencia `open → assigned → in_progress → resolved → closed` (o regresar de `resolved`/`closed` a `assigned` si el coordinador reabre), sin saltos arbitrarios entre estados no adyacentes.
3. Dado un riesgo registrado en `risk-register.md`, cuando se evalúa su prioridad, entonces incluye una justificación de probabilidad e impacto (no basta con la palabra "alto", "medio" o "bajo" sin explicación).
