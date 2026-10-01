# Plan: CLAUDE.md baja de 2.897 a menos de 200 líneas sin perder nada

Fecha: 29/9/2026 · Metodología: liminalwork (regla nueva "CLAUDE.md bajo ~200
líneas; lo retirado va a `CLAUDE.archive.md`") · Solo documentación: sin
código, sin migración, sin tests de la app afectados.

## Por qué

`CLAUDE.md` se carga ENTERO en cada sesión y en cada subagente
(`implementador.md` lo manda a leer antes de escribir). Hoy mide **2.897
líneas**:

| Bloque | Líneas | Qué es |
|---|---|---|
| Encabezado + Comandos | 1–35 | vigente, corto |
| Arquitectura | 36–123 (88) | vigente, pero con historia fechada dentro de cada paso |
| Convenciones | 124–157 (34) | vigente |
| Invariante "ningún lead invisible" | 158–179 (22) | vigente |
| **Trampas conocidas** | **180–2759 (≈2.580, 121 viñetas)** | el 89 % del archivo; muchas con capas "SUPERADO/CORREGIDO/Actualizado" apiladas |
| Bloque RTK | 2760–2897 (138) | copia del `~/.claude/RTK.md` global, que ya se carga por otra vía |

`main` (3d3e9a0, hotfix) suma 22 líneas más en Trampas sobre esta rama.

## Qué se hace

1. **`CLAUDE.archive.md` (nuevo, en la raíz, NO se importa desde CLAUDE.md)**
   recibe **tal cual, sin reescribir una palabra**: las 121 (+ las del hotfix)
   viñetas de Trampas, la versión larga de Arquitectura y el bloque RTK.
   Cada viñeta gana un ancla estable `A-001 … A-12x` en orden de aparición
   (orden actual = cronológico aproximado; no se reordena para que el diff
   sea verificable línea por línea). Encabezado del archivo: qué es, que no
   se carga solo, y cómo buscar ("las citas `ver CLAUDE.md, «…»` de código,
   migraciones y docs se buscan aquí por el título entre comillas").

2. **`CLAUDE.md` nuevo, presupuesto ≈190 líneas:**

   | Sección | Líneas | Contenido |
   |---|---|---|
   | Encabezado + mapas (GLOSARIO, PRODUCCION, **archivo**) | ~18 | igual + un renglón que presenta `CLAUDE.archive.md` |
   | Comandos | ~14 | igual |
   | Arquitectura | ~45 | los 4 pasos del mensaje entrante, frenos, frontend y base, **sin** fechas ni casos — el estado de HOY. El detalle y la historia quedan en el archivo |
   | Convenciones | ~30 | igual + la regla nueva (abajo) |
   | Invariante | ~12 | la regla y su consecuencia práctica; la historia de Etapa 1/2, al archivo |
   | **Índice de trampas** | ~70 | una línea por trampa VIGENTE que evita un bug real, agrupada por tema (IA y turno · Base, RLS y migraciones · Bandeja y UI · Seba/catálogo/ventas · Tests y entorno local · Producción y deploy), cada una termina en `→ A-0xx`. Las superadas del todo no llevan línea; una trampa con capas se resume en su estado FINAL |
   | `@AGENTS.md` | 2 | igual |

   Ejemplo de línea: `- Un fake de Supabase registra operador + columna +
   valor; un tope numérico se fija con su literal → A-098`.

3. **Convención nueva** (en Convenciones): "Una trampa nueva se escribe
   completa en `CLAUDE.archive.md` con el siguiente `A-xxx` y, si cambia cómo
   se trabaja en todo el repo, suma UNA línea al índice de `CLAUDE.md`.
   `CLAUDE.md` no pasa de 200 líneas; si una línea nueva no entra, otra baja
   al archivo."

4. **`.claude/agents/implementador.md`**: "lee `CLAUDE.md`, `docs/GLOSARIO.md`
   **y, en `CLAUDE.archive.md`, las trampas `A-xxx` que el índice asocia a
   los módulos de tu tarea**".

5. **Lo que NO se toca** (decisión): las ~300 citas "ver CLAUDE.md, «título»"
   en 116 archivos (código, migraciones, tests SQL, ci.yml, planes). Se
   resuelven buscando el título en el archivo (punto 1). Reescribirlas sería
   churn en migraciones ya aplicadas y en código de lógica, sin ganancia.

## Verificación (criterio de "terminado")

Script del orquestador en el scratchpad, no test del repo:

1. `wc -l CLAUDE.md` ≤ 200.
2. **Nada se pierde:** toda línea no vacía de las secciones Trampas,
   Arquitectura y RTK del `CLAUDE.md` viejo aparece, idéntica, en
   `CLAUDE.archive.md` (diff por conjunto de líneas → 0 faltantes).
3. Cada `→ A-xxx` del índice existe como ancla en el archivo, y cada ancla
   es única.
4. Cada ruta de archivo y cada identificador entre backticks del CLAUDE.md
   nuevo existe en el repo (`grep`/`ls`): el resumen no inventa nombres.
5. Muestra de 10 citas "ver CLAUDE.md, «…»" tomadas del código: el título
   citado se encuentra en el archivo con `grep -F`.
6. Revisión de lectura del orquestador: ninguna línea del índice contradice
   su viñeta de origen (sobre todo las de capas SUPERADO: la línea dice el
   estado final).

Opcional, a decidir: un test `docs/claude-md-tamano.test.ts` que falle si
`CLAUDE.md` pasa de 200 líneas, para que la regla no se erosione en la
próxima ola.

## Tareas

| # | Tarea | Subagente | Modelo | Depende de |
|---|---|---|---|---|
| T1 | Crear `CLAUDE.archive.md`: copiar verbatim Trampas + Arquitectura larga + RTK, anclas `A-xxx`, encabezado | mecánico | Haiku 4.5 | — |
| T2 | Escribir el `CLAUDE.md` nuevo: arquitectura condensada, invariante, convención nueva, índice por tema con `→ A-xxx` | `implementador` | Sonnet 5.5 | T1 (necesita las anclas) |
| T3 | Actualizar `implementador.md` (una frase) | mecánico | Haiku 4.5 | T2 |
| V | Verificación 1–6 y revisión del índice | orquestador | — | T1–T3 |

Un solo commit narrativo, sin `[migración]`: "CLAUDE.md cabe en doscientas
líneas y todo lo que sabía queda en el archivo".

## Riesgos y decisiones abiertas

- **Base y rama.** Esta rama (`entrega/mostrador-sin-esperas`, d3f4055) está
  por detrás de `main` (3d3e9a0), y el hotfix agregó 22 líneas a Trampas.
  Propuesta: hacerlo en una rama nueva `docs/claude-md-archivo` desde `main`.
  Es solo docs, pero **push a `main` despliega** (rebuild inofensivo);
  alternativa: que viaje dentro de la próxima entrega.
- **Choque con A2.** El worktree `entrega/seba-a2` está trabajando y va a
  sumar trampas al `CLAUDE.md` viejo. Si esto entra primero, su rebase choca
  en Trampas. Propuesta: **hacerlo después de que A2 se fusione**, o que A2
  escriba sus trampas ya en el formato nuevo (archivo + línea de índice).
- **El Claude del VPS** también lee este `CLAUDE.md`: pierde el bloque RTK
  del contexto automático (queda en el archivo). Si allá RTK no está
  instalado, no pierde nada.
- **Fuera de alcance, pero la misma regla lo alcanza:** `docs/GLOSARIO.md`
  pesa 441 KB con renglones de varios miles de caracteres (la skill pide una
  línea por módulo). Sería el plan siguiente.

## Decisiones del operador (30/9/2026) — PLAN APROBADO

- **Momento:** se ejecuta DESPUÉS de que A2 (`entrega/seba-a2`) se fusione a
  `main`. Hasta entonces no se toca `CLAUDE.md` con este plan; al arrancar,
  el archivo recoge también las trampas que traiga A2.
- **Rama:** `docs/claude-md-archivo` desde el `main` de ese momento; el
  fast-forward a `main` lo hace el operador o el VPS (push a `main`
  despliega; solo docs, rebuild inofensivo).
- **Guardia:** SÍ se suma `docs/claude-md-tamano.test.ts` (falla si
  `CLAUDE.md` pasa de 200 líneas) — entra a T2, en el mismo commit.
- Al arrancar, re-medir: las cifras de líneas/viñetas de arriba son del
  29/9 y van a haber crecido con A2.
