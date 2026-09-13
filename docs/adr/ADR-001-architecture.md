# ADR-001: Arquitectura en capas para CampusOps

## Contexto

CampusOps maneja tres perfiles de usuario (reportante, técnico, coordinador), y en las próximas semanas incorporará inicio de sesión, persistencia de datos y ubicación. Si el código que obtiene los datos de una incidencia y el código que dibuja la pantalla están mezclados en el mismo archivo, cada vez que cambie el origen de los datos —por ejemplo, al pasar de datos ficticios a un backend real— será necesario modificar directamente los archivos de pantalla, arriesgando romper la parte visual que ya funcionaba solo por cambiar de dónde vienen los datos. El equipo necesita decidir ahora cómo separar "mostrar información" de "obtener información", antes de que el proyecto crezca y ese acoplamiento se vuelva más costoso de corregir.

## Alternativas consideradas

**Alternativa A — Arquitectura en capas (UI / Application / Domain / Infrastructure).** La UI solo se comunica con Application. Application no sabe de dónde vienen los datos: solo conoce un contrato definido en Domain (por ejemplo, "algo que puede darme una lista de incidencias"). Infrastructure es quien cumple ese contrato, por ahora con datos ficticios en memoria, y podría reemplazarse después por una conexión real sin que UI ni Application se enteren del cambio.

**Alternativa B — MVVM (Model-View-ViewModel) con repositorio inyectado.** La View (pantalla) se conecta a un ViewModel que guarda el estado de esa pantalla específica (cargando, con datos, con error) y le avisa a la View cuándo actualizarse. El ViewModel obtiene los datos de un repositorio, similar en función a Infrastructure. A diferencia de la Alternativa A, el ViewModel suele estar atado a una pantalla en particular, y normalmente se apoya en librerías adicionales para que la View "escuche" los cambios del ViewModel automáticamente.

## Decisión

El equipo elige la **Alternativa A: arquitectura en capas (UI / Application / Domain / Infrastructure)**.

## Consecuencias / Trade-off

**Beneficio:** los cuatro nombres de la Alternativa A (UI, Application, Domain, Infrastructure) coinciden directamente con los límites que pide la actividad, sin necesidad de "traducir" conceptos de otro patrón. Además, no requiere instalar ninguna librería adicional de manejo de estado reactivo (como sí suele necesitar MVVM), lo cual mantiene el proyecto simple para el tamaño actual (una lista y un detalle con datos ficticios). También facilita probar `Application` de forma aislada, sin depender de que exista ninguna pantalla real.

**Costo:** al no usar una librería que conecte automáticamente los cambios entre capas, el equipo debe escribir manualmente el "cableado" que conecta cada capa con la siguiente (decidir en qué archivo se construye cada pieza y se la pasa a la que sigue). Esto añade algunos archivos y código de conexión adicional, comparado con un patrón MVVM que automatizaría parte de esa conexión. Para el alcance actual del proyecto, este costo se considera bajo frente al beneficio de mantener las capas desacopladas desde el inicio.
