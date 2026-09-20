# Modelo de amenazas — CampusOps

## Activos

Informacion y recursos que, de ser vistos o modificados sin autorizacion, representarian un problema para CampusOps:

1. **Credenciales de los usuarios** (login, tokens de sesion de los tres perfiles).
2. **Registros tecnicos (logs)** del sistema.
3. **Datos de las incidencias** (descripcion, categoria, estado, quien la reporto, historial de cambios).
4. **Fotografias y ubicacion** adjuntas a una incidencia.

## Fronteras de confianza

Puntos donde los datos pasan entre componentes o personas con distinto nivel de confianza:

- **Frontera 1 — App del reportante -> Backend de CampusOps.** Cualquier dato que envie el reportante (descripcion, foto, ubicacion) llega desde un dispositivo que la app no controla; el backend no debe confiar en que esos datos esten bien formados o sean honestos sin validarlos primero.
- **Frontera 2 — Datos del reportante -> Decision del coordinador.** El coordinador prioriza y asigna incidencias basandose en la descripcion y evidencia que envio el reportante. Si esos datos no fueron validados antes, el coordinador podria tomar decisiones sobre informacion falsa o manipulada.
- **Frontera 3 — Sistema en ejecucion -> Registros tecnicos (logs).** Cuando el sistema registra un evento (asignacion, error, cambio de estado), esa informacion pasa de ser temporal en memoria a quedar escrita permanentemente en un archivo de logs, potencialmente accesible a personal con menos necesidad de conocer los detalles personales.

## Amenazas priorizadas

| Prioridad | Amenaza | Por que esta prioridad |
|---:|---|---|
| 1 | Exponer credenciales | Comprometer una cuenta habilita todas las demas amenazas de esta lista; es especialmente grave si la cuenta comprometida es la de un coordinador, que tiene visibilidad sobre todo el conjunto de incidencias y tecnicos. |
| 2 | Filtrar datos en registros (logs) | Los logs conservan un historial de cambios; si exponen datos personales o de asignacion que deberian ocultarse (segun docs/CAMPUSOPS.md), se filtra informacion sensible de forma pasiva y dificil de detectar. |
| 3 | Alterar asignaciones | Modificar a que tecnico se asigna una incidencia, o su prioridad/urgencia, causa un dano operativo directo: una incidencia sencilla podria marcarse como urgente (desperdiciando tiempo del equipo), o una realmente urgente podria quedar sin atencion prioritaria. |
| 4 | Consultar incidencias ajenas | Viola la privacidad de quien reporto o fue asignado a una incidencia, pero no causa por si sola un dano operativo inmediato como si lo hace alterar una asignacion. |

## Riesgo que atenderiamos primero

Atenderiamos primero la exposicion de credenciales, porque es la amenaza raiz: si se compromete una cuenta (especialmente de coordinador), un atacante puede ejecutar cualquiera de las otras tres amenazas desde adentro del sistema, con permisos legitimos.

## Controles y verificación (borrador inicial)

| Amenaza | Control propuesto | Como se verificaria |
|---|---|---|
| Exponer credenciales | Validar tokens de sesion en cada peticion al backend; no almacenar contrasenas en texto plano. | Prueba que intente acceder a un endpoint protegido sin token valido y confirme que se rechaza (401). |
| Filtrar datos en registros (logs) | Sanitizar los logs para que nunca incluyan nombre, correo, ubicacion exacta ni historial de asignaciones (segun docs/CAMPUSOPS.md). | Busqueda automatizada (grep/regex) sobre los logs generados que confirme la ausencia de esos campos. |
| Alterar asignaciones | Verificar el rol del usuario antes de permitir reasignar una incidencia (solo coordinador). | Prueba que intente reasignar una incidencia como reportante o tecnico y confirme que se rechaza. |
| Consultar incidencias ajenas | Filtrar las incidencias que ve cada usuario segun su perfil y relacion con el caso. | Prueba que consulte incidencias con un usuario reportante y confirme que solo ve las suyas. |
