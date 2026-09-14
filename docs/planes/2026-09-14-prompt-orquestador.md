# Prompt orquestador · La voz cercana y la espera visible (14/9/2026)

Acompaña al plan `2026-09-14-la-voz-cercana-y-la-espera-visible.md`, aprobado por el operador el 14/9/2026 con la Decisión 1 tal cual (saludo neutro y único). Es el texto que el operador le da al Claude orquestador.

---

Actúa como ORQUESTADOR bajo la metodología `liminalwork` (léela con la skill
antes de nada, junto con `CLAUDE.md` y `docs/GLOSARIO.md`). El plan ya está
aprobado por el operador y vive en
`docs/planes/2026-09-14-la-voz-cercana-y-la-espera-visible.md`: léelo entero
antes de repartir nada. Tu trabajo es ejecutarlo completo —ocho tareas de
código (T1–T7 más T6b), la documentación T8 y la verificación final— y dejar
el repo con todo hecho, testeado y commiteado, sin hacer `push` ni tocar
producción. Hay UNA migración (T1), que va en su propio commit, primero, con
`[migración]` en el título.

Reglas del orquestador:

1. No implementas. Cada tarea del plan se la asignas a UN subagente propio
   con `subagent_type: "implementador"` (Sonnet, esfuerzo alto), contexto
   limpio. En el prompt del subagente pega literalmente: la sección
   "Decisiones", la sección "Reglas para todos", la sección completa de SU
   tarea (contexto, pasos, tests y mutación), y la instrucción de leer
   `CLAUDE.md`, `docs/GLOSARIO.md` y los archivos que la tarea nombra antes
   de escribir. Nada de resumirle la tarea.

2. Respeta "Orden de ejecución": tanda 1 en paralelo {T1, T2, T5, T6b};
   tanda 2 {T3} sola; tanda 3 {T4, T7} en paralelo; tanda 4 {T6}. Cada
   tanda cierra con `rtk npx tsc --noEmit`, `rtk npm run lint` y `rtk npm
   run test` en verde antes de abrir la siguiente. Al prompt de T5 pégale
   el reporte de T1 (nombres reales de los constraints); al de T4, el de T1
   (la razón nueva ya existe en la base) y el de T3 (dónde quedó
   `despedidaConAsesor`); al de T6, los de T4 y T5 (dónde están la guarda de
   cortesía y la marca `isAutoReply`).

3. Los subagentes NO commitean ni editan `docs/GLOSARIO.md` ni `CLAUDE.md`:
   te entregan la línea de glosario propuesta por archivo y la aplicas tú al
   commitear.

4. Cada subagente termina con el reporte obligatorio. No cierras una tarea
   sin ese reporte Y sin correr tú mismo los tres comandos. Si algo no cuadra
   con el plan, abres otro subagente con la corrección concreta; no parcheas
   a mano.

5. Commits: los haces tú, uno por tarea, con los títulos y el orden de la
   sección "Commits". Mensajes largos con `git commit -F <archivo>` (sin
   rtk). Cada commit lleva sus líneas de `docs/GLOSARIO.md`. `CLAUDE.md` se
   toca en T8, salvo que un reporte cambie doctrina antes.

6. Supuestos que puedes ajustar sin volver al operador: el texto exacto de
   los mensajes fijos mientras digan lo mismo y pasen `revealsIdentity`; los
   nombres de los eventos de log; la lista de palabras de `saludo.ts`; el
   sitio exacto de la sección "CÓMO SUENAS" en la numeración del prompt. Si
   la decisión cambia el plan —otra columna, tocar un trigger, tocar la
   cola, cambiar el comportamiento de `is_auto_reply` en la base—, párate y
   pregúntame.

7. Al cerrar la tanda 4 corre la "Verificación final" completa, incluido el
   escenario a mano de ocho pasos contra el dev local y las seis mutaciones.
   Antes del reporte de entrega pregúntame en qué commit está producción.

8. Entrégame al final: (a) la lista de commits en orden con hash y título;
   (b) el reporte de entrega por commit para el Claude del VPS en el formato
   de `docs/PRODUCCION.md`, con la migración `20260914010000`, el cambio de
   O7 en las variables, y las verificaciones post-deploy de la sección
   "Verificación en producción"; (c) la lista operativa O1–O8 tal cual, para
   el operador; (d) las dudas y la deuda que dejaron los subagentes más la
   que el plan anota a propósito.

Empieza leyendo la skill `liminalwork`, `CLAUDE.md`, `docs/GLOSARIO.md` y
el plan. Luego confirma en una línea que vas a arrancar la tanda 1 con {T1,
T2, T5, T6b} en paralelo y arranca.
