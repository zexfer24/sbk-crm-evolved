# Plan "El catálogo configurado sale siempre" (21/9/2026)

Aprobado por el operador el 21/9/2026 ("Aprobado, completo"). Rama
`el-catalogo-configurado-sale-siempre` sobre `9e2cf1a`.

## Contexto

Reporte de solo lectura de producción (VPS, 21/9/2026 00:49 VET, producción en
`3802fad`, base en `20260915010000`):

- "CATALOGO CASCOS" salió 535 veces y "Catálogo general" 161 en 15 días: el
  30 % de todas las respuestas predeterminadas, segundo motivo de contacto.
- En producción (sin H1) el escenario calzado sale siempre. El código
  pendiente de desplegar trae H1 ("el repuesto manda", 18/9/2026,
  `agent.ts`): con intención `consulta_disponibilidad` el escenario se CEDE
  al inventario — y no mira si `buscar_repuesto` está encendido.
- `buscar_repuesto` está APAGADO en producción desde el 25/8. Desplegar tal
  cual dejaría sin PDF a casi todos esos pedidos ("precios de los cascos",
  "me envías el catálogo" → disponibilidad → cedido a un inventario apagado
  → "un asesor te lo confirma" + escalada).
- Sondeo del proveedor: `gpt-5.6-luna` respeta el `toolChoice` de K y elige
  bien los argumentos de K2. Riesgo descartado.
- Decisión del operador: se despliega con `buscar_repuesto` apagado; lo
  enciende él después desde Control IA.

## La regla

Un escenario calzado se cede al inventario SOLO si se cumplen las cuatro:

1. la intención clasificada es `consulta_disponibilidad` (ya existía);
2. la herramienta `buscar_repuesto` está encendida;
3. el mensaje del cliente (la ráfaga) NO pide el catálogo — no nombra
   catálogo / pdf / lista de precios;
4. el escenario tiene `cede_al_inventario = true` (columna nueva, default
   `false`). Solo se marca "Catálogo general".

## Tareas (test primero, rojo, y después el código — regla del operador)

- **T1 `[migración]`** `20260921010000`: `ai_playbooks.cede_al_inventario
  boolean not null default false`, con `lock_timeout` + guarda + `notify
  pgrst` como las cinco pendientes. Test SQL. Más `database.types.ts`, el
  tipo `Playbook`, y las DOS lecturas (la del panel en `data.ts` y la del
  turno en `lib/ai/playbooks.ts`). Commit de migración aparte del código.
- **T2** `src/lib/ai/catalog-request.ts`: `pideCatalogo(lineas: string[])`,
  pura. Tests con frases reales del reporte.
- **T3** `agent.ts`: las cuatro condiciones. Tests por condición + mutación
  de cada término.
- **T4** casilla en el editor de escenarios (`playbooks-panel.tsx`) +
  escritura en `mutations.ts`/`agent-control-view.tsx`. Test del panel.
- **T5** script de catálogos marca "Catálogo general"; `docs/PRODUCCION.md`
  §11 (sexta migración), entrega, CLAUDE.md, GLOSARIO.
- **Cierre**: suite con Redis, 18 SQL tras `db reset`, tsc, lint, build, CI
  real por rama `ci/**`, y escenarios a mano con la herramienta apagada
  (estado de producción) y encendida: "me envías el catálogo de cascos",
  "precios de los cascos", "quisiera ver el catálogo", "¿tienen pastillas de
  freno?". Fusionar a `main` local. Sin push: sigue siendo §11.

## Criterio de terminado

Con `buscar_repuesto` apagado, los cuatro mensajes se comportan EXACTAMENTE
como en producción hoy (sale el escenario calzado). Encendido: los tres
primeros siguen mandando su escenario; solo el cuarto, si calza "Catálogo
general" marcado, va al inventario.
