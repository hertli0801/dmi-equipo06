# Definición del problema — CampusOps

> Sustituyan todas las indicaciones entre corchetes por el trabajo del equipo.

## Problema

Imagina que eres un profesor y llegas a tu salón, pero el proyector no enciende; o eres un alumno y ves una fuga de agua en los baños. Hoy en día, en nuestro campus, reportar esto es un caos: la gente manda un WhatsApp, le avisa al conserje si se lo topa en el pasillo, o manda correos que se pierden en la bandeja de entrada. 

El resultado es que los problemas tardan días en resolverse, la comunidad siente que los ignoran, y el equipo de mantenimiento vive estresado "apagando incendios" sin saber qué urge más. CampusOps importa porque elimina estos "reportes de pasillo" y crea un canal único, claro y transparente. Garantiza que cualquier falla se registre, se asigne a la persona correcta y se le dé seguimiento hasta que el problema esté solucionado, mejorando la vida de todos en el campus.

## Alcance


### Incluye

- Registro de incidencias (tickets) donde los usuarios pueden describir el problema y subir fotografías de evidencia.
- Un panel para que el coordinador asigne tareas a técnicos específicos y priorice las urgencias.
- Seguimiento en tiempo real de los estados del reporte (ej. Nuevo, Asignado, En Progreso, Resuelto).

### No incluye

-Gestión de inventarios, cotizaciones o compras de piezas de repuesto (refacciones).
- Sistemas de nómina, control de asistencia o pago a los empleados de mantenimiento y proveedores externos.

## Actores y responsabilidades

- **Reportante:** Cualquier miembro de la comunidad (alumno, profesor o administrativo). Su responsabilidad es avisar que algo falló dando los detalles precisos y estar al tanto de si su problema ya fue solucionado.
- **Técnico:** El personal de mantenimiento. Su responsabilidad es revisar su lista de tareas asignadas, ir físicamente a reparar la falla y actualizar el sistema cuando el trabajo esté terminado.
- **Coordinador:** El líder del equipo de mantenimiento. Su responsabilidad es revisar todos los reportes que llegan, decidir qué es más urgente y repartir el trabajo equitativamente entre los técnicos.

## Flujo principal

1. **Reportar:** El Reportante detecta una falla, entra al sistema, sube una foto, describe qué pasa y envía el reporte (el sistema lo marca como "Nuevo").
2. **Asignar:** El Coordinador lee el reporte recién llegado, evalúa la urgencia y se lo asigna al Técnico más adecuado para el trabajo.
3. **Atender:** El Técnico revisa su lista, va al lugar de la falla, comienza a trabajar y, al terminar, documenta lo que hizo.
4. **Cerrar:** El Técnico cambia el estado a "Resuelto", y el sistema le permite al Reportante ver que su problema ya quedó solucionado.

## Criterios de aceptación verificables

1. **Dado** que un Reportante está en el sistema, **cuando** llena el formulario de falla y lo envía, **entonces** el sistema crea un ticket con el estado "Nuevo" y lo muestra en su historial.
2. **Dado** que el Coordinador está en su panel, **cuando** selecciona un ticket "Nuevo" y elige a un Técnico de la lista, **entonces** el estado del ticket cambia a "Asignado" y le aparece al Técnico en su bandeja de tareas.
3. **Dado** que un Técnico terminó de reparar una falla, **cuando** cambia el estado de su ticket a "Resuelto", **entonces** el sistema se actualiza y el Reportante puede ver ese nuevo estado al consultar su reporte.
