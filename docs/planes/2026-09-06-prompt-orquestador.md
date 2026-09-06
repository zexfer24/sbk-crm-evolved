# Prompt orquestador · El cliente que cambió de número (6/9/2026)

Acompaña al plan `2026-09-06-el-cliente-que-cambio-de-numero.md`. Es el texto
que el operador le dio al Claude orquestador para ejecutar la corrida.

---

Actúa como ORQUESTADOR bajo la metodología `liminalwork` (léela con la skill
antes de nada, junto con `CLAUDE.md` y `docs/GLOSARIO.md`). El plan ya está
aprobado por el operador y vive en
`docs/planes/2026-09-06-el-cliente-que-cambio-de-numero.md`: léelo entero
antes de repartir nada. Tu trabajo es ejecutarlo completo —cuatro tareas
delegadas (S1, S2, S3b, S3a), la documentación S4 y la verificación final— y
dejar el repo con todo hecho, testeado y commiteado, sin hacer `push` ni tocar
producción. No hay migraciones en esta corrida; si un subagente cree
necesitar una, se para y te lo reporta, y tú me preguntas.

Reglas del orquestador:

1. No implementas. Cada tarea del plan se la asignas a UN subagente propio
   con `subagent_type: general-purpose`, `model: sonnet` y razonamiento alto,
   con contexto limpio. En el prompt del subagente pega literalmente: la
   sección "Decisiones del operador", la sección "Reglas para todos", la
   sección completa de SU tarea (con su bloque de contexto, sus pasos y sus
   tests), y la instrucción de leer `CLAUDE.md`, `docs/GLOSARIO.md` y los
   archivos que la tarea nombra antes de escribir. Nada de resumirle la
   tarea: recibe el texto del plan tal cual.

2. Respeta la sección "Orden de ejecución": tanda 1 en paralelo {S1, S2,
   S3b}, que tocan archivos disjuntos; tanda 2 {S3a}, SOLO cuando S1 ya esté
   commiteada, porque S1 y S3a editan `route.ts` y `route.test.ts` y no
   pueden correr juntas sobre el mismo árbol. Al prompt de S3a le pegas
   además el hallazgo del trigger de `messages` que S1 trajo en su reporte
   (migración y líneas), para que no lo vuelva a buscar. Cada tanda cierra
   con la suite completa en verde antes de abrir la siguiente.

3. Los subagentes NO hacen commit y NO editan `docs/GLOSARIO.md` ni
   `CLAUDE.md`: te entregan la línea de glosario propuesta por archivo tocado
   y la aplicas tú al commitear.

4. Cada subagente termina con el reporte obligatorio (qué implementó y
   decidió; archivos y líneas de glosario propuestas; salida de sus tests,
   `tsc` y lint; desvíos o dudas). Para S1 el reporte tiene que traer,
   además, la verificación del trigger de `messages` con la migración citada:
   qué columnas mueve y cuáles no para una fila
   `outbound`/`system`/`system_event`. No cierras una tarea sin ese reporte
   Y sin correr tú mismo `rtk npx tsc --noEmit`, `rtk npm run lint` y `rtk
   npm run test -- --no-file-parallelism`. Si algo no cuadra con el plan,
   abres otro subagente con la corrección concreta; no parcheas a mano.

5. Commits: los haces tú, uno por tarea, narrativos en español (el efecto
   observable, nunca `feat:`), con los títulos de la sección "Commits" del
   plan y en ese orden: S1 (que lleva también el plan y este prompt en
   `docs/planes/`), S2, S3b, S3a. Mensajes largos con `git commit -F
   <archivo>` (sin rtk: `rtk git commit -m` se rompe con comillas simples).
   Cada commit lleva sus líneas de `docs/GLOSARIO.md` actualizadas.
   `CLAUDE.md` solo se toca si un reporte cambia doctrina; no se espera.

6. Supuestos que puedes ajustar sin volver al operador (están en la cabecera
   del plan): el texto exacto de los eventos y del marcador mientras digan lo
   mismo; los nombres de los eventos de log; un `user_changed_number` con
   número inválido se trata como subtipo desconocido. Si un subagente se
   traba en algo que el plan no decide, decide tú por la opción más simple
   que respete `CLAUDE.md` y anótalo en el reporte final. Si la decisión
   cambia el plan —una columna nueva, tocar el trigger, fusionar contactos,
   encolar turno de IA para un `unsupported`—, párate y pregúntame.

7. Al cerrar la tanda 2 corre la "Verificación final" del plan: suite,
   tipos, lint, build con `rtk proxy npm run build` (nunca `rtk next build`;
   verificar el timestamp de `.next/BUILD_ID`), el escenario a mano contra el
   dev local con los tres `POST` al webhook (texto → `system`
   `user_changed_number` → `unsupported` con `type: "poll"`) comprobando en
   la base el contacto movido, el evento, la fila `unsupported` y un solo
   encolado, y las dos mutaciones manuales (quitar la condición de
   multimedia en S3a; quitar el `continue` que evita la reapertura en S1: los
   tests correspondientes deben ponerse rojos; revertir). Antes del reporte
   de entrega me preguntas en qué commit está producción (hoy `8ee97d7`, pero
   confírmalo conmigo).

8. Entrégame al final: (a) la lista de commits en orden con hash y título;
   (b) el reporte de entrega por commit para el Claude del VPS en el formato
   de `docs/PRODUCCION.md`, con el aviso de que NO hay migraciones y de que
   la única verificación post-deploy es el log del contenedor y el paso
   manual del chat de +593987317372 desde el teléfono; (c) el hallazgo del
   trigger de `messages` que trajo S1; (d) la lista de dudas y deuda que
   dejaron los subagentes, más la deuda que el plan deja anotada a propósito
   (`failureAction(131026)`; fusión de historiales en D2; el trigger si trata
   un evento de sistema como respuesta del equipo; etiqueta de reenviado,
   reacciones salientes y BSUID).

Empieza leyendo la skill `liminalwork`, `CLAUDE.md`, `docs/GLOSARIO.md` y
`docs/planes/2026-09-06-el-cliente-que-cambio-de-numero.md`. Luego confirma
en una línea que vas a arrancar la tanda 1 con {S1, S2, S3b} en paralelo y
arranca.
