# Control del agente de IA — consumo de tokens, sugerencias y costo en $USD

Fecha: 2026-08-19
Rama: `feat/dashboard-recorrido-cliente`
Área: `/agent-control` (panel "Control del agente de IA")

## Contexto

El panel de control del agente de IA (`src/components/agent-control/agent-control-view.tsx`)
ya muestra: interruptor global, conversaciones en vivo con la IA, un feed de
turnos (`agent_turns`) y un simulador de mensajes. No captura tokens, no
tiene forma de calcular costo en $USD, y no existe ningún mecanismo para
que los asesores dejen sugerencias de mejora del bot al supervisor.

## Alcance

1. Mostrar el consumo de tokens del agente de IA y un gráfico de cómo se
   consume en el tiempo.
2. Mostrar el equivalente en $USD del consumo, calculado según el modelo
   usado en cada turno (tarifas editables sin redeploy).
3. Panel donde los asesores humanos dejan sugerencias de mejora del bot
   para el supervisor, con estado pendiente/revisada.
4. Cambiar el ícono de la categoría "Control de IA" de `SlidersHorizontal`
   a `Bot` (lucide-react) en los tres lugares donde aparece.

Fuera de alcance (decidido explícitamente con el usuario): la IA no genera
sugerencias por sí misma; solo los asesores humanos las escriben.

## Esquema de base de datos

### Migración 1 — `agent_turns` + `model_pricing`

```sql
alter table public.agent_turns
  add column input_tokens integer,
  add column output_tokens integer,
  add column total_tokens integer;
```

Nullable: un turno que falla antes de llamar al modelo (p. ej. error de
clasificación temprano) no tiene uso que registrar.

```sql
create table public.model_pricing (
  model text primary key,
  input_price_per_million numeric(10,4) not null,
  output_price_per_million numeric(10,4) not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.agents (id) on delete set null
);
```

`model` usa el mismo formato `"proveedor/modelo"` que ya escribe
`currentAgentModelLabel()` en `agent_turns.model` (ej.
`"openai/gpt-5.6-luna"`), así que un turno se cruza con su tarifa por
igualdad directa de texto, sin tabla de mapeo adicional.

Semilla (`supabase/seed.sql`): una fila placeholder por cada modelo que el
`.env` puede seleccionar hoy (`openai/gpt-5.6-luna`,
`google/gemini-3.1-flash-lite`), con precios de ejemplo marcados para que
el usuario los ajuste — desde el propio panel, no hace falta migrar de
nuevo.

RLS: mismo criterio que el resto del backend del agente — cualquier agente
autenticado puede leer/escribir (`agent_turns_all`, política nueva
`model_pricing_all`).

### Migración 2 — `agent_suggestions`

```sql
create table public.agent_suggestions (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents (id) on delete cascade,
  content text not null,
  status text not null default 'pending' check (status in ('pending', 'reviewed')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.agents (id) on delete set null
);

create index agent_suggestions_created_at_idx on public.agent_suggestions (created_at desc);
```

RLS: cualquier agente autenticado puede leer/insertar; marcar `reviewed`
también queda abierto a nivel de RLS (igual que el resto del CRM), pero la
UI solo expone el botón "Marcar revisada" a `role !== "agent"`
(supervisor/admin) — el control de quién puede resolver una sugerencia es
de producto, no de base de datos, siguiendo el patrón ya usado en el resto
del panel (ej. kill switch visible a todos, sin restricción de rol en
RLS).

Realtime: se añade `agent_suggestions` a `supabase_realtime` para que el
panel se actualice en vivo entre supervisores, igual que `agent_turns` y
`agent_settings`.

`database.types.ts` se actualiza a mano para reflejar ambas migraciones
(es como ya está mantenido en este repo, no autogenerado en este flujo).

## Captura de tokens

`classifyIntent` (`src/lib/ai/classify.ts`) y `ToolLoopAgent.generate()`
(`src/lib/ai/agent.ts`) ya devuelven `result.usage: LanguageModelUsage`
(AI SDK `ai@7`), con `inputTokens` / `outputTokens` / `totalTokens`
(`number | undefined`).

- `classifyIntent` cambia su firma de `Promise<Intent>` a
  `Promise<{ intent: Intent; usage: LanguageModelUsage }>`. Único caller:
  `runAgentTurn` en `agent.ts`.
- En `runAgentTurn`, se suman `usage` de la clasificación + `usage` del
  `agent.generate()` final (tratando `undefined` como 0) y se pasa el
  total a `logTurn`, que inserta `input_tokens` / `output_tokens` /
  `total_tokens` junto al resto de la fila.
- Si `classifyIntent` lanza error antes de tener `usage` (fallo temprano),
  el turno de error se registra sin tokens (`null`), como ya ocurre hoy
  con el resto de columnas nullable.

## Datos y agregación (`src/lib/data.ts`)

Sin vistas SQL nuevas — mismo patrón que el resto de `data.ts`: se trae la
fila cruda y se agrega en JS.

```ts
export interface TokenUsageDay { date: string; tokens: number }
export interface ModelUsageSummary {
  model: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  usdCost: number | null; // null si no hay fila de precio para ese modelo
}
export interface TokenUsageSummary {
  totalTokens: number;
  totalUsd: number;
  byDay: TokenUsageDay[];   // últimos 14 días, orden ascendente, días sin datos en 0
  byModel: ModelUsageSummary[];
}

export async function fetchTokenUsageSummary(supabase, days = 30): Promise<TokenUsageSummary>
export async function fetchModelPricing(supabase): Promise<ModelPricing[]>
export async function fetchAgentSuggestions(supabase, limit = 50): Promise<AgentSuggestion[]>
```

`fetchTokenUsageSummary` trae `agent_turns` (solo `model`, `input_tokens`,
`output_tokens`, `total_tokens`, `created_at`) de los últimos `days` días,
más `model_pricing` completo, y calcula:
- `byDay`: suma de `total_tokens` agrupada por fecha (14 días visibles en
  el gráfico, aunque la ventana de fetch sea de 30 para el total/costo).
- `byModel`: suma de tokens por modelo + costo si hay tarifa.
- `totalTokens` / `totalUsd`: suma total de la ventana de 30 días.

## Tipos (`src/lib/types.ts`)

- `AgentTurn` gana `inputTokens: number | null`, `outputTokens: number | null`,
  `totalTokens: number | null`.
- Nuevo `ModelPricing { model: string; inputPricePerMillion: number; outputPricePerMillion: number; updatedAt: string }`.
- Nuevo `AgentSuggestionStatus = "pending" | "reviewed"`.
- Nuevo `AgentSuggestion { id: string; agentId: string; agentName: string | null; content: string; status: AgentSuggestionStatus; createdAt: string; reviewedAt: string | null; reviewedBy: string | null }`
  (`agentName` viene de un join con `agents` en el fetch, igual que otros
  fetch de `data.ts` que resuelven nombres).

## Mutaciones (`src/lib/mutations.ts`)

- `createAgentSuggestion(supabase, agent, content)` — inserta en
  `agent_suggestions`.
- `markSuggestionReviewed(supabase, suggestionId, reviewerAgent)` —
  actualiza `status`, `reviewed_at`, `reviewed_by`.
- `updateModelPricing(supabase, model, inputPricePerMillion, outputPricePerMillion, agent)` —
  upsert en `model_pricing`.

Mismo patrón que las mutaciones existentes: `supabase.from(...).insert/update`,
`if (error) throw error`.

## UI (`src/components/agent-control/agent-control-view.tsx`)

Dos secciones nuevas (`<section className="dash-panel">`), insertadas
después de `Actividad en vivo` y antes de `Probar el agente`:

**"Consumo de tokens"**
- Fila de stats: tokens totales (30 días) + $USD totales.
- Gráfico de barras SVG hecho a mano (`token-usage-chart.tsx`, sin
  dependencia nueva) — tokens por día, últimos 14 días. Se construye
  siguiendo el skill `dataviz` para paleta/estilo consistente con el
  resto del CRM.
- Lista compacta por modelo: nombre, tokens, $USD (o "sin tarifa" si no
  hay fila en `model_pricing`).
- Mini formulario de tarifas: por cada modelo visto en `byModel`, dos
  inputs (precio input / output por millón) + botón guardar, usando
  `updateModelPricing`. Reusa `crm-pill` para el botón.

**"Sugerencias al supervisor"**
- Textarea + botón enviar (`createAgentSuggestion`), visible para
  cualquier agente.
- Lista cronológica (más reciente primero): autor, hora, contenido,
  badge de estado (`ac-badge` con tono `wait` para pendiente, `good` para
  revisada).
- Botón "Marcar revisada" solo si `currentAgent.role !== "agent"` y el
  estado es `pending`.

Ambas secciones se suscriben al mismo patrón de `refresh()` +
`postgres_changes` que ya usa el componente (se añaden `agent_suggestions`
y — opcionalmente — no hace falta realtime en `model_pricing`, cambia
poco).

## Ícono

`SlidersHorizontal` → `Bot` (lucide-react) en:
- `src/components/crm-shell.tsx`
- `src/components/dashboard/dashboard-view.tsx`
- `src/components/agent-control/agent-control-view.tsx` (botón del rail +
  marca del topbar)

## Testing

- Sin framework de test automatizado detectado en el repo (no hay
  `vitest`/`jest` en `package.json`). Verificación manual: `npm run dev`,
  abrir `/agent-control`, correr el simulador para generar un turno real y
  confirmar que aparecen tokens en el feed / gráfico / desglose por
  modelo, enviar una sugerencia y marcarla revisada con un agente
  supervisor.
- `npx tsc --noEmit` para chequeo de tipos antes de dar por terminado.

## Riesgos / decisiones abiertas

- Las tarifas sembradas en `seed.sql` son placeholders — el usuario debe
  ajustarlas desde el panel antes de que el $USD mostrado sea real. Se
  deja explícito en el propio dato sembrado (comentario SQL) y en la UI
  (si no hay tarifa, se muestra "sin tarifa" en vez de $0).
