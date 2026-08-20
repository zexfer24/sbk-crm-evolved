# Control del agente de IA — tokens, $USD y sugerencias — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add token-consumption tracking with a chart and $USD cost (by model), a supervisor suggestions panel, and a robot icon to the "Control del agente de IA" page.

**Architecture:** Two new Supabase migrations (token columns + `model_pricing` table, and `agent_suggestions` table) feed a data/mutation layer in `src/lib/`, which a new chart component and two new sections in `agent-control-view.tsx` render. Token usage is captured at the source — `classifyIntent` and `ToolLoopAgent.generate()` — and summed into `agent_turns` on every turn.

**Tech Stack:** Next.js 16 (App Router) + React 19, Supabase (Postgres + RLS + Realtime), Vercel AI SDK (`ai@7`), TypeScript strict mode, plain CSS (no chart library — reuses the existing `.dash-chart-*` SVG pattern from `src/components/dashboard/activity-chart.tsx`).

**Spec:** `docs/superpowers/specs/2026-08-19-agent-control-tokens-suggestions-design.md`

## Global Constraints

- No automated test runner exists in this repo (`package.json` has no `vitest`/`jest`/`playwright`). Do not add one — it's out of scope. Verification is `npx tsc --noEmit` (type check) plus manual verification in `npm run dev`.
- **Baseline TS check:** `npx tsc --noEmit` on this branch is clean today (zero errors) — confirmed 2026-08-20. Every task's "run tsc" step must produce **zero errors** by the time that task is done (some intermediate steps *within* a task legitimately show transient errors from earlier steps in the same task — each such step says so explicitly; if a step's text doesn't say to expect an error, any error is yours to fix).
- **Someone else is editing this repo in parallel, in this same working directory (not a worktree) — not on a branch related to this plan, and it keeps moving while this plan executes.** Their in-progress work is uncommitted and must stay that way. As of this plan's last check it included: a "sales module" (`src/app/ventas/`, `src/components/sales/`, edits to `chat-panel.tsx`, `format.ts`, `message-grouping.ts`, `close-sale-modal.tsx`), a nav icon/link for it in `crm-shell.tsx`/`dashboard-view.tsx`/`agent-control-view.tsx` (a `Receipt` icon), and — inside `agent-control-view.tsx` and `page.tsx` themselves, files this plan also edits — a tabbed "Control de IA" / "Agentes" UI with an `AgentsRosterPanel` component, `fetchAllAgents`, `setAgentActive`, `initialAgents`, and a `Users` icon. **Never remove, rename, or restructure any of that** — only add what a task asks for, alongside it. Never run `git add -A`, `git add .`, `git stash`, `git checkout .`, or any other command that stages, stashes, or discards files this plan didn't touch. Every `git add` in this plan already names exact files — stick to that. If `git status` shows unrelated modified/untracked files before or after your task, that's expected and not yours to explain or fix. If a step's `npx tsc --noEmit` shows errors in files this plan never mentions, they belong to that parallel work — ignore them; judge your own step only by errors in files your task touched.
- **This plan's own quoted line numbers and multi-line "current file" snippets are a snapshot and may already be stale by the time your task runs** — the parallel work above changes these same files while this plan executes. Before editing any file, re-read it fresh. Where a step gives you an exact block of text to find-and-replace, treat that block as the thing to locate by its content (it's chosen to be unique), not by the line number quoted next to it — if you can't find it verbatim, or find something close-but-not-exact, stop and report `NEEDS_CONTEXT` with what you actually see there rather than guessing or forcing it. Where a step says to append at the end of a file, append after whatever the current last line is, not after whatever this plan says the last line used to be.
- Money formatting: always via `formatUsd()` (Task 13), which renders `$X.XX` using `es-VE` locale — don't hand-roll `toFixed`/`$` string concatenation elsewhere.
- Table/column naming: snake_case in SQL and in every `Raw*` interface in `data.ts`; camelCase in every exported TS type in `types.ts` and in component props/state. The `map*` functions in `data.ts` are the only place that crosses that boundary.
- The `model` string that identifies a model everywhere (`agent_turns.model`, `model_pricing.model`, `ModelUsageSummary.model`) is always the `"provider/modelId"` format produced by `currentAgentModelLabel()` in `src/lib/ai/model.ts` (e.g. `"openai/gpt-5.6-luna"`). Never reformat or parse it.
- Follow existing file conventions exactly: mutations throw on `{ error }` (`if (error) throw error`), `data.ts` fetchers take a plain `SupabaseClient` (not the `<Database>`-typed one), CSS lives in the matching `*.css` file next to the component tree it styles (`agent-control.css` for `.ac-*` classes, `dashboard.css` for `.dash-*` classes — already imported into `agent-control-view.tsx`).

---

## File Map

| File | Change |
|---|---|
| `src/components/crm-shell.tsx` | Icon swap only |
| `src/components/dashboard/dashboard-view.tsx` | Icon swap only |
| `src/components/agent-control/agent-control-view.tsx` | Icon swap + two new sections + new state/handlers |
| `supabase/migrations/20260820010000_agent_tokens_pricing.sql` | New — token columns + `model_pricing` table |
| `supabase/migrations/20260820020000_agent_suggestions.sql` | New — `agent_suggestions` table |
| `supabase/seed.sql` | Append `model_pricing` placeholder rows |
| `src/lib/supabase/database.types.ts` | Reflect both migrations |
| `src/lib/types.ts` | Extend `AgentTurn`; add `ModelPricing`, `TokenUsageDay`, `ModelUsageSummary`, `TokenUsageSummary`, `AgentSuggestion(Status)` |
| `src/lib/ai/classify.ts` | Return `{ intent, usage }` instead of bare `Intent` |
| `src/lib/ai/agent.ts` | Capture + sum token usage, write to `agent_turns` |
| `src/lib/data.ts` | Extend `mapAgentTurn`/`fetchAgentTurns`; add `fetchModelPricing`, `fetchTokenUsageSummary`, `fetchAgentSuggestions` |
| `src/lib/mutations.ts` | Add `createAgentSuggestion`, `markSuggestionReviewed`, `updateModelPricing` |
| `src/components/agent-control/token-usage-chart.tsx` | New — SVG bar chart, tokens/day |
| `src/components/agent-control/agent-control.css` | New `.ac-tokens-*`, `.ac-model-*`, `.ac-pricing-*`, `.ac-suggest-*` rules |
| `src/app/agent-control/page.tsx` | Fetch + pass the three new `initial*` props |

---

### Task 1: Ícono — `SlidersHorizontal` → `Bot`

**Files:**
- Modify: `src/components/crm-shell.tsx`
- Modify: `src/components/dashboard/dashboard-view.tsx`
- Modify: `src/components/agent-control/agent-control-view.tsx`

**Interfaces:** None — pure presentational swap, no new props or exports.

Other in-progress work in this repo (see Global Constraints) has already added a `Receipt` icon/nav-link to all three of these files, so don't trust old line numbers — locate everything below by content instead. In each file, there is exactly one `lucide-react` import line and one-or-two JSX usages of `<SlidersHorizontal .../>` — that identifier is unique enough to find both reliably.

- [ ] **Step 1: Swap the import and usage(s) in `crm-shell.tsx`**

In the `lucide-react` import line, remove `SlidersHorizontal` and add `Bot`, keeping every other icon already in that list and keeping the list alphabetically sorted (`Bot` sorts first). Then replace every `<SlidersHorizontal size={N} />` in the file's JSX with `<Bot size={N} />` (same `size` value, nothing else about the surrounding element changes).

- [ ] **Step 2: Swap the import and usage(s) in `dashboard-view.tsx`**

Same transformation as Step 1: `SlidersHorizontal` → `Bot` in the `lucide-react` import (alphabetically sorted, keep every other icon in the list), and every `<SlidersHorizontal size={N} />` → `<Bot size={N} />`.

- [ ] **Step 3: Swap the import and usage(s) in `agent-control-view.tsx`**

Same transformation again. This file has two JSX usages of `SlidersHorizontal` (one in the left nav rail, one in the topbar brand mark) — replace both, preserving each one's own `size` value.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors in `crm-shell.tsx`, `dashboard-view.tsx`, or `agent-control-view.tsx` (ignore any error elsewhere — see Global Constraints on the parallel work in this repo).

- [ ] **Step 5: Manual check**

Run `npm run dev`, open `/agent-control`, `/inbox`, and `/`. Confirm the robot icon shows in the left rail (all three pages) and in the `/agent-control` topbar brand mark, and that `SlidersHorizontal` is gone (no other page used it — confirmed by the earlier repo-wide search).

- [ ] **Step 6: Commit**

```bash
git add src/components/crm-shell.tsx src/components/dashboard/dashboard-view.tsx src/components/agent-control/agent-control-view.tsx
git commit -m "$(cat <<'EOF'
Cambia el ícono de Control de IA a un robot

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Migración — tokens en `agent_turns` + tabla `model_pricing`

**Files:**
- Create: `supabase/migrations/20260820010000_agent_tokens_pricing.sql`

**Interfaces:**
- Produces: columns `agent_turns.input_tokens` / `output_tokens` / `total_tokens` (all `integer`, nullable); table `public.model_pricing(model text pk, input_price_per_million numeric(10,4), output_price_per_million numeric(10,4), updated_at timestamptz, updated_by uuid)`.

- [ ] **Step 1: Write the migration**

```sql
-- ============================================================================
-- Consumo de tokens por turno + tarifas por modelo (Control del agente de IA)
-- ============================================================================

alter table public.agent_turns
  add column input_tokens integer,
  add column output_tokens integer,
  add column total_tokens integer;

comment on column public.agent_turns.total_tokens is 'input_tokens + output_tokens del turno completo (clasificación + respuesta). Null si el turno falló antes de llamar al modelo.';

-- ---------------------------------------------------------------------------
-- MODEL_PRICING
-- Tarifa en USD por millón de tokens, por modelo. `model` usa el mismo
-- formato "proveedor/modelo" que ya escribe currentAgentModelLabel() en
-- agent_turns.model, así que el cruce es por igualdad directa de texto.
-- Editable desde el panel de Control de IA sin necesidad de redeploy.
-- ---------------------------------------------------------------------------
create table public.model_pricing (
  model text primary key,
  input_price_per_million numeric(10, 4) not null,
  output_price_per_million numeric(10, 4) not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.agents (id) on delete set null
);

alter table public.model_pricing enable row level security;

create policy "model_pricing_all" on public.model_pricing for all
  using (public.is_agent()) with check (public.is_agent());

grant select, insert, update, delete on public.model_pricing to authenticated, service_role;
```

- [ ] **Step 2: Apply it locally and verify the columns/table exist**

The local Supabase stack is already running (`supabase_db_Liminal_CRM`, up for a while) with live data from the parallel work described in Global Constraints — **never run `npx supabase db reset`**, it wipes that data. Run: `npx supabase migration up --local` (applies only this new, pending migration).
Expected: migration runs without error. Verify with: `npx supabase db query --local "select column_name from information_schema.columns where table_name = 'agent_turns' and column_name like '%tokens'; select model from public.model_pricing;"` — should list the three token columns and return zero rows for `model_pricing` (empty table, expected — Task 4 seeds it).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260820010000_agent_tokens_pricing.sql
git commit -m "$(cat <<'EOF'
Añade columnas de tokens a agent_turns y tabla model_pricing

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Migración — tabla `agent_suggestions`

**Files:**
- Create: `supabase/migrations/20260820020000_agent_suggestions.sql`

**Interfaces:**
- Produces: table `public.agent_suggestions(id uuid pk, agent_id uuid, content text, status text 'pending'|'reviewed', created_at timestamptz, reviewed_at timestamptz, reviewed_by uuid)`, published on `supabase_realtime`.

- [ ] **Step 1: Write the migration**

```sql
-- ============================================================================
-- Sugerencias de los asesores hacia el supervisor sobre mejoras del bot
-- ============================================================================

create table public.agent_suggestions (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents (id) on delete cascade,
  content text not null,
  status text not null default 'pending' check (status in ('pending', 'reviewed')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.agents (id) on delete set null
);

comment on table public.agent_suggestions is 'Sugerencias de mejora del bot que los asesores dejan para el supervisor. status pasa a reviewed cuando un supervisor/admin la marca.';

create index agent_suggestions_created_at_idx on public.agent_suggestions (created_at desc);

alter table public.agent_suggestions enable row level security;

create policy "agent_suggestions_all" on public.agent_suggestions for all
  using (public.is_agent()) with check (public.is_agent());

grant select, insert, update, delete on public.agent_suggestions to authenticated, service_role;

alter publication supabase_realtime add table public.agent_suggestions;
```

- [ ] **Step 2: Apply and verify**

**Never run `npx supabase db reset`** (see Task 2, Step 2 — it would wipe the parallel work's live local data). Run: `npx supabase migration up --local`.
Expected: no errors. Verify with: `npx supabase db query --local "select * from public.agent_suggestions limit 1;"` — returns an empty result with the right columns (no error about the table not existing).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260820020000_agent_suggestions.sql
git commit -m "$(cat <<'EOF'
Añade tabla agent_suggestions para el panel de sugerencias al supervisor

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Seed — tarifas placeholder por modelo

**Files:**
- Modify: `supabase/seed.sql` (append at the current end of the file — see Global Constraints on stale line numbers)

**Interfaces:**
- Consumes: `model_pricing` table from Task 2.

- [ ] **Step 1: Append the seed rows**

Add to the end of `supabase/seed.sql`:

```sql

-- ============================================================================
-- TARIFAS de modelo (placeholder — ajustar desde el panel de Control de IA
-- antes de confiar en el $USD que muestra; estos valores son de ejemplo)
-- ============================================================================
insert into public.model_pricing (model, input_price_per_million, output_price_per_million) values
  ('openai/gpt-5.6-luna', 1.2500, 10.0000),
  ('google/gemini-3.1-flash-lite', 0.1000, 0.4000)
on conflict (model) do nothing;
```

- [ ] **Step 2: Apply and verify**

**Never run `npx supabase db reset`** (see Task 2, Step 2), and do **not** re-run the whole `seed.sql` file against the live local DB either — most of its other inserts (contacts, conversations, messages, products, etc.) have no `on conflict` clause and will fail with duplicate-key errors against data that's already there. Instead, run only the two new rows directly: `npx supabase db query --local "insert into public.model_pricing (model, input_price_per_million, output_price_per_million) values ('openai/gpt-5.6-luna', 1.2500, 10.0000), ('google/gemini-3.1-flash-lite', 0.1000, 0.4000) on conflict (model) do nothing;"`
Expected: no errors. Verify with: `npx supabase db query --local "select * from public.model_pricing;"` — returns the two seeded rows (plus any others already present).

- [ ] **Step 3: Commit**

```bash
git add supabase/seed.sql
git commit -m "$(cat <<'EOF'
Siembra tarifas placeholder de modelo en model_pricing

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `database.types.ts` — reflejar ambas migraciones

**Files:**
- Modify: `src/lib/supabase/database.types.ts:66-103` (agent_turns block) and two new table blocks

**Interfaces:**
- Consumes: schema from Tasks 2 and 3.
- Produces: `Database["public"]["Tables"]["agent_turns"]` with token columns; `Database["public"]["Tables"]["agent_suggestions"]`; `Database["public"]["Tables"]["model_pricing"]`.

- [ ] **Step 1: Add the token columns to `agent_turns`**

Replace the `agent_turns` block (lines 66-103):
```ts
      agent_turns: {
        Row: {
          action: string
          conversation_id: string
          created_at: string
          id: string
          intent: string | null
          model: string | null
          summary: string | null
        }
        Insert: {
          action: string
          conversation_id: string
          created_at?: string
          id?: string
          intent?: string | null
          model?: string | null
          summary?: string | null
        }
        Update: {
          action?: string
          conversation_id?: string
          created_at?: string
          id?: string
          intent?: string | null
          model?: string | null
          summary?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_turns_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
```
with:
```ts
      agent_turns: {
        Row: {
          action: string
          conversation_id: string
          created_at: string
          id: string
          input_tokens: number | null
          intent: string | null
          model: string | null
          output_tokens: number | null
          summary: string | null
          total_tokens: number | null
        }
        Insert: {
          action: string
          conversation_id: string
          created_at?: string
          id?: string
          input_tokens?: number | null
          intent?: string | null
          model?: string | null
          output_tokens?: number | null
          summary?: string | null
          total_tokens?: number | null
        }
        Update: {
          action?: string
          conversation_id?: string
          created_at?: string
          id?: string
          input_tokens?: number | null
          intent?: string | null
          model?: string | null
          output_tokens?: number | null
          summary?: string | null
          total_tokens?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_turns_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
```

- [ ] **Step 2: Insert `agent_suggestions` right before the `agent_turns` block**

Line numbers in this file may have shifted from other in-progress work elsewhere in the repo (not yours to touch — see Global Constraints) — locate this anchor by its text, not by a line number. Find this exact, unique block (the end of `agent_settings`, right before `agent_turns: {` begins):
```ts
        Relationships: [
          {
            foreignKeyName: "agent_settings_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_turns: {
```
Insert the new `agent_suggestions` block right after that closing `}` and right before `agent_turns: {`, so the result reads:
```ts
        Relationships: [
          {
            foreignKeyName: "agent_settings_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_suggestions: {
        Row: {
          agent_id: string
          content: string
          created_at: string
          id: string
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
        }
        Insert: {
          agent_id: string
          content: string
          created_at?: string
          id?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
        }
        Update: {
          agent_id?: string
          content?: string
          created_at?: string
          id?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_suggestions_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_suggestions_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
        ]
      }
```

- [ ] **Step 3: Insert `model_pricing` between `messages` and `notes`**

Again, locate this anchor by text, not by line number. Find this exact, unique block (the end of `messages`, right before `notes: {` begins):
```ts
          {
            foreignKeyName: "messages_sender_agent_id_fkey"
            columns: ["sender_agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
        ]
      }
      notes: {
```
Insert the new `model_pricing` block right after that closing `}` and right before `notes: {`, so the result reads:
```ts
          {
            foreignKeyName: "messages_sender_agent_id_fkey"
            columns: ["sender_agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
        ]
      }
      model_pricing: {
        Row: {
          input_price_per_million: number
          model: string
          output_price_per_million: number
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          input_price_per_million: number
          model: string
          output_price_per_million: number
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          input_price_per_million?: number
          model?: string
          output_price_per_million?: number
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "model_pricing_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
        ]
      }
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors in `src/lib/supabase/database.types.ts` (ignore any error elsewhere — see Global Constraints on the parallel work in this repo).

- [ ] **Step 5: Commit**

```bash
git add src/lib/supabase/database.types.ts
git commit -m "$(cat <<'EOF'
Actualiza database.types.ts con agent_suggestions, model_pricing y tokens

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `types.ts` — nuevos tipos

**Files:**
- Modify: `src/lib/types.ts:152-166`

**Interfaces:**
- Produces: `AgentTurn` (extended), `ModelPricing`, `TokenUsageDay`, `ModelUsageSummary`, `TokenUsageSummary`, `AgentSuggestionStatus`, `AgentSuggestion`. Every later task that imports from `types.ts` uses exactly these names and shapes.

- [ ] **Step 1: Extend `AgentTurn` and append the new types**

Replace (lines 152-166):
```ts
/** Una fila de la bitácora de turnos del agente — alimenta el feed en vivo del panel de control. */
export interface AgentTurn {
  id: string;
  conversationId: string;
  intent: AgentIntent | null;
  action: AgentTurnAction;
  summary: string | null;
  model: string | null;
  createdAt: string;
}

/** Interruptor global de la IA en todo el CRM. */
export interface AgentSettings {
  aiGloballyEnabled: boolean;
}
```
with:
```ts
/** Una fila de la bitácora de turnos del agente — alimenta el feed en vivo del panel de control. */
export interface AgentTurn {
  id: string;
  conversationId: string;
  intent: AgentIntent | null;
  action: AgentTurnAction;
  summary: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  createdAt: string;
}

/** Interruptor global de la IA en todo el CRM. */
export interface AgentSettings {
  aiGloballyEnabled: boolean;
}

/** Tarifa en USD por millón de tokens para un modelo — usada para calcular el costo del consumo de la IA. */
export interface ModelPricing {
  model: string;
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  updatedAt: string;
}

/** Tokens consumidos en un día — un punto del gráfico de consumo. */
export interface TokenUsageDay {
  date: string;
  tokens: number;
}

/** Consumo acumulado de un modelo, con su costo en USD si hay tarifa cargada. */
export interface ModelUsageSummary {
  model: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  usdCost: number | null;
}

/** Resumen de consumo de tokens para el panel de Control de IA. */
export interface TokenUsageSummary {
  totalTokens: number;
  totalUsd: number;
  byDay: TokenUsageDay[];
  byModel: ModelUsageSummary[];
}

/** Sugerencia de un asesor humano al supervisor sobre cómo mejorar el bot. */
export type AgentSuggestionStatus = "pending" | "reviewed";

export interface AgentSuggestion {
  id: string;
  agentId: string;
  agentName: string | null;
  content: string;
  status: AgentSuggestionStatus;
  createdAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: new errors in `src/lib/data.ts` (its `mapAgentTurn`/`fetchAgentTurns` don't populate the new required `AgentTurn` fields yet) — that's expected, Task 9 fixes it. Confirm no *other* file this plan has already touched (`crm-shell.tsx`, `dashboard-view.tsx`, `agent-control-view.tsx`, `database.types.ts`) shows a new error.

- [ ] **Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "$(cat <<'EOF'
Añade tipos de consumo de tokens, tarifas y sugerencias

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `classify.ts` — devolver también el uso de tokens

**Files:**
- Modify: `src/lib/ai/classify.ts` (whole file, 23 lines)

**Interfaces:**
- Consumes: `generateObject` from `ai` (already imported).
- Produces: `ClassifyResult { intent: Intent; usage: LanguageModelUsage }`; `classifyIntent(messages): Promise<ClassifyResult>` (signature change — only caller is `runAgentTurn` in `agent.ts`, updated in Task 8).

- [ ] **Step 1: Rewrite the file**

```ts
import "server-only";
import { generateObject, type LanguageModelUsage, type ModelMessage } from "ai";
import { getAgentModel } from "@/lib/ai/model";
import { CLASSIFY_PROMPT } from "@/lib/ai/prompt";

export const INTENT_VALUES = ["consulta_disponibilidad", "devolucion", "queja", "otro"] as const;
export type Intent = (typeof INTENT_VALUES)[number];

export interface ClassifyResult {
  intent: Intent;
  usage: LanguageModelUsage;
}

/** Fase A del turno: clasificación obligatoria, barata y rápida — separada del agente que actúa. */
export async function classifyIntent(messages: ModelMessage[]): Promise<ClassifyResult> {
  const { model } = getAgentModel("low");

  const { object, usage } = await generateObject({
    model,
    output: "enum",
    enum: INTENT_VALUES as unknown as string[],
    system: CLASSIFY_PROMPT,
    messages,
  });

  return { intent: object as Intent, usage };
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: a new error in `src/lib/ai/agent.ts` (`classifyIntent(history)` is used as if it returns `Intent`, not `ClassifyResult` — Task 8 fixes it), plus the `data.ts` ones from Task 6 (still unfixed until Task 9). No other new errors in files this plan has touched.

- [ ] **Step 3: Commit**

```bash
git add src/lib/ai/classify.ts
git commit -m "$(cat <<'EOF'
classifyIntent devuelve también el uso de tokens del paso de clasificación

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `agent.ts` — capturar y sumar tokens, escribirlos en `agent_turns`

**Files:**
- Modify: `src/lib/ai/agent.ts`

**Interfaces:**
- Consumes: `ClassifyResult` from Task 7 (`classifyIntent` now returns `{ intent, usage }`); `agent_turns.input_tokens/output_tokens/total_tokens` columns from Task 2.
- Produces: every `agent_turns` insert now carries real token counts (or `null` for the early-classify-failure case).

- [ ] **Step 1: Add the `LanguageModelUsage` import and a tiny tokens helper**

Change the import line (currently):
```ts
import { ToolLoopAgent, isStepCount, type ModelMessage, type ToolSet } from "ai";
```
to:
```ts
import { ToolLoopAgent, isStepCount, type LanguageModelUsage, type ModelMessage, type ToolSet } from "ai";
```

Add this helper right after `function errorMessage(...)` (after line 37):
```ts
interface TurnTokens {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

function tokensFromUsage(usage: LanguageModelUsage): TurnTokens {
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    totalTokens: usage.totalTokens ?? 0,
  };
}

function addTokens(a: TurnTokens, b: TurnTokens): TurnTokens {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}
```

- [ ] **Step 2: Update `logTurn` to accept and store tokens**

Replace:
```ts
async function logTurn(
  supabase: SupabaseClient<Database>,
  conversationId: string,
  intent: Intent | null,
  action: "answered" | "escalated" | "error",
  summary: string
) {
  await supabase.from("agent_turns").insert({
    conversation_id: conversationId,
    intent,
    action,
    summary: summary.slice(0, 500),
    model: currentAgentModelLabel(),
  });
}
```
with:
```ts
async function logTurn(
  supabase: SupabaseClient<Database>,
  conversationId: string,
  intent: Intent | null,
  action: "answered" | "escalated" | "error",
  summary: string,
  tokens: TurnTokens | null
) {
  await supabase.from("agent_turns").insert({
    conversation_id: conversationId,
    intent,
    action,
    summary: summary.slice(0, 500),
    model: currentAgentModelLabel(),
    input_tokens: tokens?.inputTokens ?? null,
    output_tokens: tokens?.outputTokens ?? null,
    total_tokens: tokens?.totalTokens ?? null,
  });
}
```

- [ ] **Step 3: Update the classify call site and its error branch**

Replace:
```ts
  let intent: Intent;
  try {
    intent = await classifyIntent(history);
  } catch (err) {
    await logTurn(supabase, conversationId, null, "error", `Fallo al clasificar intención: ${errorMessage(err)}`);
    return;
  }
```
with:
```ts
  let intent: Intent;
  let classifyTokens: TurnTokens;
  try {
    const classified = await classifyIntent(history);
    intent = classified.intent;
    classifyTokens = tokensFromUsage(classified.usage);
  } catch (err) {
    await logTurn(supabase, conversationId, null, "error", `Fallo al clasificar intención: ${errorMessage(err)}`, null);
    return;
  }
```

- [ ] **Step 4: Update the `agent.generate()` call site and its error branch**

Replace:
```ts
  let text = "";
  try {
    const result = await agent.generate({ messages: history });
    text = result.text ?? "";
  } catch (err) {
    await logTurn(supabase, conversationId, intent, "error", errorMessage(err));
    await supabase.from("conversations").update({ active_tool: null }).eq("id", conversationId);
    return;
  }
```
with:
```ts
  let text = "";
  let turnTokens = classifyTokens;
  try {
    const result = await agent.generate({ messages: history });
    text = result.text ?? "";
    turnTokens = addTokens(classifyTokens, tokensFromUsage(result.usage));
  } catch (err) {
    await logTurn(supabase, conversationId, intent, "error", errorMessage(err), classifyTokens);
    await supabase.from("conversations").update({ active_tool: null }).eq("id", conversationId);
    return;
  }
```

- [ ] **Step 5: Pass `turnTokens` into the final `logTurn` call**

Replace:
```ts
  await logTurn(
    supabase,
    conversationId,
    intent,
    outcome.escalated ? "escalated" : "answered",
    outcome.escalated ? `Escalado a ${outcome.assignedAgentName ?? "(sin asesor disponible)"}. Motivo: ${outcome.motivo}.` : text
  );
```
with:
```ts
  await logTurn(
    supabase,
    conversationId,
    intent,
    outcome.escalated ? "escalated" : "answered",
    outcome.escalated ? `Escalado a ${outcome.assignedAgentName ?? "(sin asesor disponible)"}. Motivo: ${outcome.motivo}.` : text,
    turnTokens
  );
```

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: the `agent.ts` error from Task 7 is gone. Remaining: only the `data.ts` ones from Task 6 (still unfixed until Task 9) — no other new errors in files this plan has touched.

- [ ] **Step 7: Manual verification**

Run `npm run dev`, open `/agent-control`, use the "Probar el agente" simulator to send a test message (e.g. "¿Tienes carburador para una Bera SBR 200?"), then check in Supabase Studio (or `npx supabase db psql` → `select action, input_tokens, output_tokens, total_tokens from agent_turns order by created_at desc limit 1;`) that the new row has non-null, non-zero token counts.

- [ ] **Step 8: Commit**

```bash
git add src/lib/ai/agent.ts
git commit -m "$(cat <<'EOF'
Captura y guarda el consumo de tokens de cada turno del agente

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: `data.ts` — fetchers de tokens, tarifas y sugerencias

**Files:**
- Modify: `src/lib/data.ts`

**Interfaces:**
- Consumes: `AgentTurn`, `ModelPricing`, `TokenUsageDay`, `ModelUsageSummary`, `TokenUsageSummary`, `AgentSuggestion` from Task 6; `agent_turns`/`model_pricing`/`agent_suggestions` tables from Tasks 2-3.
- Produces:
  - `fetchAgentTurns(supabase, limit?): Promise<AgentTurn[]>` (unchanged signature, now includes tokens).
  - `fetchModelPricing(supabase): Promise<ModelPricing[]>`
  - `fetchTokenUsageSummary(supabase, days?): Promise<TokenUsageSummary>` (default `days = 30`; `byDay` always has exactly 14 entries, oldest first, zero-filled).
  - `fetchAgentSuggestions(supabase, limit?): Promise<AgentSuggestion[]>` (default `limit = 50`, newest first).

- [ ] **Step 1: Extend `RawAgentTurn`/`mapAgentTurn`/`fetchAgentTurns` with tokens**

Replace (around lines 381-413):
```ts
interface RawAgentTurn {
  id: string;
  conversation_id: string;
  intent: AgentTurn["intent"];
  action: AgentTurn["action"];
  summary: string | null;
  model: string | null;
  created_at: string;
}

function mapAgentTurn(row: RawAgentTurn): AgentTurn {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    intent: row.intent,
    action: row.action,
    summary: row.summary,
    model: row.model,
    createdAt: row.created_at,
  };
}

/** Últimos turnos del agente de IA en todo el CRM, para el feed en vivo del panel de control. */
export async function fetchAgentTurns(supabase: SupabaseClient, limit = 30): Promise<AgentTurn[]> {
  const { data, error } = await supabase
    .from("agent_turns")
    .select("id, conversation_id, intent, action, summary, model, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data as RawAgentTurn[]).map(mapAgentTurn);
}
```
with:
```ts
interface RawAgentTurn {
  id: string;
  conversation_id: string;
  intent: AgentTurn["intent"];
  action: AgentTurn["action"];
  summary: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  created_at: string;
}

function mapAgentTurn(row: RawAgentTurn): AgentTurn {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    intent: row.intent,
    action: row.action,
    summary: row.summary,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    createdAt: row.created_at,
  };
}

/** Últimos turnos del agente de IA en todo el CRM, para el feed en vivo del panel de control. */
export async function fetchAgentTurns(supabase: SupabaseClient, limit = 30): Promise<AgentTurn[]> {
  const { data, error } = await supabase
    .from("agent_turns")
    .select("id, conversation_id, intent, action, summary, model, input_tokens, output_tokens, total_tokens, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data as RawAgentTurn[]).map(mapAgentTurn);
}

interface RawModelPricing {
  model: string;
  input_price_per_million: number;
  output_price_per_million: number;
  updated_at: string;
}

function mapModelPricing(row: RawModelPricing): ModelPricing {
  return {
    model: row.model,
    inputPricePerMillion: row.input_price_per_million,
    outputPricePerMillion: row.output_price_per_million,
    updatedAt: row.updated_at,
  };
}

/** Tarifa por millón de tokens de cada modelo visto, para calcular costo en $USD. */
export async function fetchModelPricing(supabase: SupabaseClient): Promise<ModelPricing[]> {
  const { data, error } = await supabase
    .from("model_pricing")
    .select("model, input_price_per_million, output_price_per_million, updated_at")
    .order("model");

  if (error) throw error;
  return (data as RawModelPricing[]).map(mapModelPricing);
}

interface RawTokenUsageRow {
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  created_at: string;
}

/**
 * Consumo de tokens de los últimos `days` días: total, costo en $USD según
 * model_pricing, serie diaria (últimos 14 días, zero-filled) y desglose por
 * modelo. Se agrega en JS sobre las filas crudas, igual que el resto de
 * data.ts — sin vistas SQL nuevas.
 */
export async function fetchTokenUsageSummary(supabase: SupabaseClient, days = 30): Promise<TokenUsageSummary> {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const [{ data: turnsData, error: turnsError }, pricing] = await Promise.all([
    supabase
      .from("agent_turns")
      .select("model, input_tokens, output_tokens, total_tokens, created_at")
      .gte("created_at", since.toISOString()),
    fetchModelPricing(supabase),
  ]);

  if (turnsError) throw turnsError;

  const priceByModel = new Map(pricing.map((p) => [p.model, p]));
  const rows = (turnsData as RawTokenUsageRow[]).filter((row) => row.total_tokens !== null);

  const byDayMap = new Map<string, number>();
  const byModelMap = new Map<string, { inputTokens: number; outputTokens: number; totalTokens: number }>();

  for (const row of rows) {
    const day = row.created_at.slice(0, 10);
    byDayMap.set(day, (byDayMap.get(day) ?? 0) + (row.total_tokens ?? 0));

    const modelKey = row.model ?? "desconocido";
    const current = byModelMap.get(modelKey) ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    current.inputTokens += row.input_tokens ?? 0;
    current.outputTokens += row.output_tokens ?? 0;
    current.totalTokens += row.total_tokens ?? 0;
    byModelMap.set(modelKey, current);
  }

  const byDay: TokenUsageDay[] = [];
  for (let i = 13; i >= 0; i -= 1) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const key = date.toISOString().slice(0, 10);
    byDay.push({ date: key, tokens: byDayMap.get(key) ?? 0 });
  }

  function usdCost(model: string, inputTokens: number, outputTokens: number): number | null {
    const price = priceByModel.get(model);
    if (!price) return null;
    return (inputTokens / 1_000_000) * price.inputPricePerMillion + (outputTokens / 1_000_000) * price.outputPricePerMillion;
  }

  const byModel: ModelUsageSummary[] = Array.from(byModelMap.entries())
    .map(([model, usage]) => ({
      model,
      totalTokens: usage.totalTokens,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      usdCost: usdCost(model, usage.inputTokens, usage.outputTokens),
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const totalTokens = byModel.reduce((sum, m) => sum + m.totalTokens, 0);
  const totalUsd = byModel.reduce((sum, m) => sum + (m.usdCost ?? 0), 0);

  return { totalTokens, totalUsd, byDay, byModel };
}

interface RawAgentSuggestion {
  id: string;
  agent_id: string;
  content: string;
  status: AgentSuggestion["status"];
  created_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  agent: RawAgent | null;
}

function mapAgentSuggestion(row: RawAgentSuggestion): AgentSuggestion {
  return {
    id: row.id,
    agentId: row.agent_id,
    agentName: row.agent?.display_name ?? null,
    content: row.content,
    status: row.status,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
  };
}

/** Sugerencias de mejora del bot dejadas por asesores para el supervisor, más recientes primero. */
export async function fetchAgentSuggestions(supabase: SupabaseClient, limit = 50): Promise<AgentSuggestion[]> {
  const { data, error } = await supabase
    .from("agent_suggestions")
    .select(
      `id, agent_id, content, status, created_at, reviewed_at, reviewed_by,
       agent:agents(id, display_name, full_name, avatar_url, role, is_active)`
    )
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data as unknown as RawAgentSuggestion[]).map(mapAgentSuggestion);
}
```

- [ ] **Step 2: Add the new types to the top-level type import**

Change the `import type { ... } from "@/lib/types";` block (lines 3-16) from:
```ts
import type {
  Agent,
  AgentSettings,
  AgentTurn,
  Contact,
  Conversation,
  HourlyActivity,
  Message,
  Note,
  QuickReply,
  Tag,
  WhatsappChannel,
  WhatsappTemplate,
} from "@/lib/types";
```
to:
```ts
import type {
  Agent,
  AgentSettings,
  AgentSuggestion,
  AgentTurn,
  Contact,
  Conversation,
  HourlyActivity,
  Message,
  ModelPricing,
  ModelUsageSummary,
  Note,
  QuickReply,
  Tag,
  TokenUsageDay,
  TokenUsageSummary,
  WhatsappChannel,
  WhatsappTemplate,
} from "@/lib/types";
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: the `data.ts` errors from Task 6 are gone. No errors remain in any file this plan has touched.

- [ ] **Step 4: Manual verification**

In a scratch file or the Node REPL isn't practical here (no test runner) — instead, verify through the running app once Task 13 wires the UI. For now, confirm the file compiles clean per Step 3; that's the checkpoint for this task.

- [ ] **Step 5: Commit**

```bash
git add src/lib/data.ts
git commit -m "$(cat <<'EOF'
Añade fetchTokenUsageSummary, fetchModelPricing y fetchAgentSuggestions

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: `mutations.ts` — sugerencias y tarifas

**Files:**
- Modify: `src/lib/mutations.ts`

**Interfaces:**
- Consumes: `Agent` (existing import), `agent_suggestions`/`model_pricing` tables.
- Produces:
  - `createAgentSuggestion(supabase, agent: Agent, content: string): Promise<void>`
  - `markSuggestionReviewed(supabase, suggestionId: string, reviewer: Agent): Promise<void>`
  - `updateModelPricing(supabase, model: string, inputPricePerMillion: number, outputPricePerMillion: number, agent: Agent): Promise<void>`

- [ ] **Step 1: Append the three mutations at the end of the file**

Append at the very end of the file, after whatever its current last function is:
```ts

export async function createAgentSuggestion(supabase: SupabaseClient, agent: Agent, content: string) {
  const { error } = await supabase.from("agent_suggestions").insert({ agent_id: agent.id, content });
  if (error) throw error;
}

export async function markSuggestionReviewed(supabase: SupabaseClient, suggestionId: string, reviewer: Agent) {
  const { error } = await supabase
    .from("agent_suggestions")
    .update({ status: "reviewed", reviewed_at: new Date().toISOString(), reviewed_by: reviewer.id })
    .eq("id", suggestionId);
  if (error) throw error;
}

export async function updateModelPricing(
  supabase: SupabaseClient,
  model: string,
  inputPricePerMillion: number,
  outputPricePerMillion: number,
  agent: Agent
) {
  const { error } = await supabase.from("model_pricing").upsert({
    model,
    input_price_per_million: inputPricePerMillion,
    output_price_per_million: outputPricePerMillion,
    updated_at: new Date().toISOString(),
    updated_by: agent.id,
  });
  if (error) throw error;
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors in `src/lib/mutations.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/mutations.ts
git commit -m "$(cat <<'EOF'
Añade mutaciones para sugerencias al supervisor y tarifas de modelo

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: `token-usage-chart.tsx` — gráfico SVG de tokens por día

**Files:**
- Create: `src/components/agent-control/token-usage-chart.tsx`

**Interfaces:**
- Consumes: `TokenUsageDay[]` from Task 6; CSS classes `.dash-chart`, `.dash-chart-svg`, `.dash-chart-grid`, `.dash-chart-axis`, `.dash-chart-tick`, `.dash-chart-bar`, `.dash-num` (already defined in `src/components/dashboard/dashboard.css`, already imported by `agent-control-view.tsx`).
- Produces: `TokenUsageChart({ data: TokenUsageDay[] })` — a `<div className="dash-chart">` fragment (no `<section>` wrapper — it's embedded inside the "Consumo de tokens" panel built in Task 13, not a standalone panel like `ActivityChart`).

This mirrors the existing bar-chart half of `src/components/dashboard/activity-chart.tsx` (same CSS classes, same SVG structure), simplified to one series instead of a stacked bar + line combo.

- [ ] **Step 1: Write the component**

```tsx
import type { TokenUsageDay } from "@/lib/types";

const W = 640;
const H = 160;
const PAD = { top: 12, right: 10, bottom: 24, left: 44 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

interface TokenUsageChartProps {
  data: TokenUsageDay[];
}

export function TokenUsageChart({ data }: TokenUsageChartProps) {
  const step = PLOT_W / data.length;
  const peak = Math.max(1, ...data.map((d) => d.tokens));
  const scaleY = (value: number) => PAD.top + PLOT_H - (value / peak) * PLOT_H;
  const centerX = (index: number) => PAD.left + step * index + step / 2;
  const barWidth = Math.min(step * 0.55, 22);
  const gridValues = [0, peak / 2, peak];
  const total = data.reduce((sum, d) => sum + d.tokens, 0);

  return (
    <div className="dash-chart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="dash-chart-svg"
        role="img"
        aria-label={`Tokens consumidos por día, últimos ${data.length} días. Total: ${total}.`}
      >
        {gridValues.map((value) => (
          <g key={value}>
            <line
              className="dash-chart-grid"
              x1={PAD.left}
              x2={W - PAD.right}
              y1={scaleY(value)}
              y2={scaleY(value)}
            />
            <text className="dash-chart-tick dash-num" x={PAD.left - 8} y={scaleY(value) + 3.5} textAnchor="end">
              {formatCompact(value)}
            </text>
          </g>
        ))}

        {data.map((day, index) => {
          if (day.tokens === 0) return null;
          const height = (day.tokens / peak) * PLOT_H;
          return (
            <g key={day.date}>
              <title>{`${dayLabel(day.date)} · ${day.tokens.toLocaleString("es-VE")} tokens`}</title>
              <rect
                className="dash-chart-bar"
                x={centerX(index) - barWidth / 2}
                y={PAD.top + PLOT_H - height}
                width={barWidth}
                height={height}
                fill="var(--lm-link)"
              />
            </g>
          );
        })}

        <line
          className="dash-chart-axis"
          x1={PAD.left}
          x2={W - PAD.right}
          y1={PAD.top + PLOT_H}
          y2={PAD.top + PLOT_H}
        />

        {data.map((day, index) =>
          index % 2 === 0 ? (
            <text key={day.date} className="dash-chart-tick dash-num" x={centerX(index)} y={H - 7} textAnchor="middle">
              {dayLabel(day.date)}
            </text>
          ) : null
        )}
      </svg>
    </div>
  );
}

/** "2026-08-19" -> "19/08" */
function dayLabel(isoDate: string): string {
  const [, month, day] = isoDate.split("-");
  return `${day}/${month}`;
}

function formatCompact(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors in `src/components/agent-control/token-usage-chart.tsx`.

- [ ] **Step 3: Commit**

```bash
git add src/components/agent-control/token-usage-chart.tsx
git commit -m "$(cat <<'EOF'
Añade el gráfico de tokens consumidos por día

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: `agent-control.css` — estilos nuevos

**Files:**
- Modify: `src/components/agent-control/agent-control.css` (append at the current end of the file — see Global Constraints on stale line numbers)

**Interfaces:**
- Produces: `.ac-tokens-stats`, `.ac-tokens-stat`, `.ac-tokens-stat-value`, `.ac-tokens-stat-label`, `.ac-model-list`, `.ac-model-row`, `.ac-model-row-head`, `.ac-model-name`, `.ac-model-tokens`, `.ac-model-usd`, `.ac-model-pricing`, `.ac-pricing-field`, `.ac-pricing-input`, `.ac-suggest`, `.ac-suggest-row`, `.ac-suggest-list` — all consumed by Task 13's JSX. (The suggestions feed rows reuse the existing `.ac-feed-*` and `.ac-badge` classes already in this file — no duplication.)

- [ ] **Step 1: Append the new rules**

```css

/* --------------------------------------------------------------------------
   Consumo de tokens
   -------------------------------------------------------------------------- */

.ac-tokens-stats {
  display: flex;
  gap: 24px;
  padding: 18px 26px 4px;
  flex-wrap: wrap;
}

.ac-tokens-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.ac-tokens-stat-value {
  font-size: 22px;
  font-weight: 600;
}

.ac-tokens-stat-label {
  font-size: 12px;
  color: var(--lm-muted);
}

.ac-model-list {
  display: flex;
  flex-direction: column;
}

.ac-model-row {
  padding: 12px 26px;
  border-top: 1px solid var(--lm-line);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ac-model-row-head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.ac-model-name {
  font-family: var(--font-mono), ui-monospace, monospace;
  font-size: 12.5px;
  font-weight: 600;
}

.ac-model-tokens {
  font-size: 12px;
  color: var(--lm-ink-soft);
}

.ac-model-usd {
  margin-left: auto;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--lm-ink);
}

.ac-model-pricing {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  flex-wrap: wrap;
}

.ac-pricing-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 11px;
  color: var(--lm-muted);
}

.ac-pricing-input {
  width: 96px;
  border: 1px solid var(--lm-line);
  border-radius: 8px;
  padding: 5px 8px;
  font-size: 12.5px;
  font-family: var(--font-mono), ui-monospace, monospace;
  background: var(--lm-surface);
  color: var(--lm-ink);
}

.ac-pricing-input:focus {
  outline: 2px solid var(--lm-link);
  outline-offset: 1px;
}

/* --------------------------------------------------------------------------
   Sugerencias al supervisor
   -------------------------------------------------------------------------- */

.ac-suggest {
  padding: 20px 26px 4px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.ac-suggest-row {
  display: flex;
  gap: 10px;
  align-items: flex-end;
}

.ac-suggest-list {
  display: flex;
  flex-direction: column;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/agent-control/agent-control.css
git commit -m "$(cat <<'EOF'
Añade estilos para el panel de tokens y el panel de sugerencias

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: `agent-control-view.tsx` + `page.tsx` — conectar todo

**Files:**
- Modify: `src/components/agent-control/agent-control-view.tsx`
- Modify: `src/app/agent-control/page.tsx`

**Interfaces:**
- Consumes: everything from Tasks 6, 9, 10, 11 (`TokenUsageSummary`, `ModelPricing`, `AgentSuggestion` types; `fetchTokenUsageSummary`, `fetchModelPricing`, `fetchAgentSuggestions`; `createAgentSuggestion`, `markSuggestionReviewed`, `updateModelPricing`; `TokenUsageChart`).
- Produces: `AgentControlViewProps` gains `initialTokenUsage: TokenUsageSummary`, `initialPricing: ModelPricing[]`, `initialSuggestions: AgentSuggestion[]` — `page.tsx` is the only caller, updated in this same task.

**Both files already carry unrelated, in-progress functionality from the parallel work described in Global Constraints: a tabbed "Control de IA" / "Agentes" UI, `AgentsRosterPanel`, `fetchAllAgents`, `setAgentActive`, `initialAgents`. Every instruction below is additive — read each anchor fresh in the live file first (per Global Constraints, this plan's snapshot may already be stale), and never remove or restructure anything you didn't add.** Task 1 already replaced `SlidersHorizontal` with `Bot` in this file — don't redo that.

- [ ] **Step 1: Update `page.tsx` to also fetch and pass the three new props**

Read the current file first — it already fetches `agents`/`fetchAllAgents` and passes `initialAgents`; keep all of that. Add three more entries to the `Promise.all` array and three more fetch imports, then pass three more props. The result should read like this (adjust only if the live file's roster-panel wiring differs from what's shown here — preserve that wiring, just add the token/pricing/suggestions pieces alongside it):

```tsx
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  fetchAgentSettings,
  fetchAgentSuggestions,
  fetchAgentTurns,
  fetchAllAgents,
  fetchConversations,
  fetchCurrentAgent,
  fetchModelPricing,
  fetchTokenUsageSummary,
} from "@/lib/data";
import { currentAgentModelLabel } from "@/lib/ai/model";
import { AgentControlView } from "@/components/agent-control/agent-control-view";

export default async function AgentControlPage() {
  const supabase = await createClient();

  const [currentAgent, conversations, turns, settings, agents, tokenUsage, pricing, suggestions] =
    await Promise.all([
      fetchCurrentAgent(supabase),
      fetchConversations(supabase),
      fetchAgentTurns(supabase),
      fetchAgentSettings(supabase),
      fetchAllAgents(supabase),
      fetchTokenUsageSummary(supabase),
      fetchModelPricing(supabase),
      fetchAgentSuggestions(supabase),
    ]);

  if (!currentAgent) {
    redirect("/login");
  }

  return (
    <AgentControlView
      currentAgent={currentAgent}
      initialConversations={conversations}
      initialTurns={turns}
      initialSettings={settings}
      initialAgents={agents}
      initialTokenUsage={tokenUsage}
      initialPricing={pricing}
      initialSuggestions={suggestions}
      modelLabel={currentAgentModelLabel()}
    />
  );
}
```

- [ ] **Step 2: Extend the type import in `agent-control-view.tsx`**

Find the `import type { ... } from "@/lib/types";` line (currently a single line, something like `import type { Agent, AgentIntent, AgentSettings, AgentTurn, AgentTurnAction, Conversation } from "@/lib/types";`). Add `AgentSuggestion`, `ModelPricing`, `ModelUsageSummary`, and `TokenUsageSummary` to that list, keeping every name already there and keeping the whole list alphabetically sorted.

- [ ] **Step 3: Extend the `@/lib/data` import**

Find the `import { ... } from "@/lib/data";` line (currently includes at least `fetchAgentSettings`, `fetchAgentTurns`, `fetchAllAgents`, `fetchConversations`). Add `fetchAgentSuggestions`, `fetchModelPricing`, and `fetchTokenUsageSummary` to that list, keeping every name already there and keeping the whole list alphabetically sorted.

- [ ] **Step 4: Extend the `@/lib/mutations` import**

Find the `import { ... } from "@/lib/mutations";` line (currently includes at least `setAgentActive`, `setAiEnabled`, `setAiGloballyEnabled`, `intervene`). Add `createAgentSuggestion`, `markSuggestionReviewed`, and `updateModelPricing` to that list, keeping every name already there and keeping the whole list alphabetically sorted.

- [ ] **Step 5: Add the `TokenUsageChart` import**

Find this exact, unique line:
```tsx
import { AgentsRosterPanel } from "@/components/agent-control/agent-roster-panel";
```
Add a new import line right after it:
```tsx
import { AgentsRosterPanel } from "@/components/agent-control/agent-roster-panel";
import { TokenUsageChart } from "@/components/agent-control/token-usage-chart";
```

- [ ] **Step 6: Extend `AgentControlViewProps`**

Find this exact, unique block (part of the props interface):
```tsx
  initialAgents: Agent[];
  modelLabel: string;
}
```
Replace it with:
```tsx
  initialAgents: Agent[];
  initialTokenUsage: TokenUsageSummary;
  initialPricing: ModelPricing[];
  initialSuggestions: AgentSuggestion[];
  modelLabel: string;
}
```

- [ ] **Step 7: Extend the component's destructured props**

Find this exact, unique block (the function signature):
```tsx
  initialAgents,
  modelLabel,
}: AgentControlViewProps) {
```
Replace it with:
```tsx
  initialAgents,
  initialTokenUsage,
  initialPricing,
  initialSuggestions,
  modelLabel,
}: AgentControlViewProps) {
```

- [ ] **Step 8: Add state for tokens, pricing, and suggestions**

Find this exact, unique block:
```tsx
  const [agents, setAgents] = useState(initialAgents);
  const [togglingKillSwitch, setTogglingKillSwitch] = useState(false);
```
Replace it with:
```tsx
  const [agents, setAgents] = useState(initialAgents);
  const [tokenUsage, setTokenUsage] = useState(initialTokenUsage);
  const [pricing, setPricing] = useState(initialPricing);
  const [suggestions, setSuggestions] = useState(initialSuggestions);
  const [togglingKillSwitch, setTogglingKillSwitch] = useState(false);
```

Then find this exact, unique block (the end of the existing simulator state, right before `refresh`):
```tsx
  const [simOk, setSimOk] = useState<string | null>(null);

  const refresh = useCallback(async () => {
```
Replace it with:
```tsx
  const [simOk, setSimOk] = useState<string | null>(null);

  const [suggestionText, setSuggestionText] = useState("");
  const [sendingSuggestion, setSendingSuggestion] = useState(false);
  const [resolvingSuggestionId, setResolvingSuggestionId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
```

- [ ] **Step 9: Extend `refresh()` and the realtime subscription**

Find this exact, unique block:
```tsx
  const refresh = useCallback(async () => {
    try {
      const [nextConversations, nextTurns, nextSettings, nextAgents] = await Promise.all([
        fetchConversations(supabase),
        fetchAgentTurns(supabase),
        fetchAgentSettings(supabase),
        fetchAllAgents(supabase),
      ]);
      setConversations(nextConversations);
      setTurns(nextTurns);
      setSettings(nextSettings);
      setAgents(nextAgents);
    } catch {
      // El siguiente cambio en tiempo real reintentará la sincronización.
    }
  }, [supabase]);

  useEffect(() => {
    const channel = supabase
      .channel("agent-control-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "conversations" }, () => refresh())
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "agent_turns" }, () => refresh())
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "agent_settings" }, () => refresh())
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "agents" }, () => refresh())
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, refresh]);
```
Replace it with:
```tsx
  const refresh = useCallback(async () => {
    try {
      const [nextConversations, nextTurns, nextSettings, nextAgents, nextTokenUsage, nextPricing, nextSuggestions] =
        await Promise.all([
          fetchConversations(supabase),
          fetchAgentTurns(supabase),
          fetchAgentSettings(supabase),
          fetchAllAgents(supabase),
          fetchTokenUsageSummary(supabase),
          fetchModelPricing(supabase),
          fetchAgentSuggestions(supabase),
        ]);
      setConversations(nextConversations);
      setTurns(nextTurns);
      setSettings(nextSettings);
      setAgents(nextAgents);
      setTokenUsage(nextTokenUsage);
      setPricing(nextPricing);
      setSuggestions(nextSuggestions);
    } catch {
      // El siguiente cambio en tiempo real reintentará la sincronización.
    }
  }, [supabase]);

  useEffect(() => {
    const channel = supabase
      .channel("agent-control-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "conversations" }, () => refresh())
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "agent_turns" }, () => refresh())
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "agent_settings" }, () => refresh())
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "agents" }, () => refresh())
      .on("postgres_changes", { event: "*", schema: "public", table: "agent_suggestions" }, () => refresh())
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, refresh]);
```

- [ ] **Step 10: Add the `pricingByModel` memo**

Find this exact, unique line:
```tsx
  const conversationsById = useMemo(() => new Map(conversations.map((c) => [c.id, c])), [conversations]);
```
Add a new line right after it:
```tsx
  const conversationsById = useMemo(() => new Map(conversations.map((c) => [c.id, c])), [conversations]);

  const pricingByModel = useMemo(() => new Map(pricing.map((p) => [p.model, p])), [pricing]);
```

- [ ] **Step 11: Add the three new handlers**

Find this exact, unique block (the end of `signOut`, right before the component's `return`):
```tsx
  async function signOut() {
    await supabase.auth.signOut();
    router.push("/login");
  }

  return (
```
Replace it with:
```tsx
  async function signOut() {
    await supabase.auth.signOut();
    router.push("/login");
  }

  async function savePricing(model: string, inputPricePerMillion: number, outputPricePerMillion: number) {
    await updateModelPricing(supabase, model, inputPricePerMillion, outputPricePerMillion, currentAgent);
    await refresh();
  }

  async function sendSuggestion() {
    if (!suggestionText.trim()) return;
    setSendingSuggestion(true);
    try {
      await createAgentSuggestion(supabase, currentAgent, suggestionText.trim());
      setSuggestionText("");
      await refresh();
    } finally {
      setSendingSuggestion(false);
    }
  }

  async function resolveSuggestion(id: string) {
    setResolvingSuggestionId(id);
    try {
      await markSuggestionReviewed(supabase, id, currentAgent);
      await refresh();
    } finally {
      setResolvingSuggestionId(null);
    }
  }

  return (
```

- [ ] **Step 12: Insert the two new sections between "Actividad en vivo" and "Probar el agente"**

Find this exact, unique block (the JSX title of the "Probar el agente" panel and the `</div>` that closes the two-column row right above it):
```tsx
            </div>

            <section className="dash-panel">
              <div className="dash-panel-head">
                <h2 className="dash-panel-title">Probar el agente</h2>
```
Replace it with (this keeps the same `</div>` and adds two full new `<section>` panels before the existing "Probar el agente" one, which is untouched below):
```tsx
            </div>

            <section className="dash-panel">
              <div className="dash-panel-head">
                <h2 className="dash-panel-title">Consumo de tokens</h2>
                <span className="dash-panel-spacer" />
                <span className="dash-panel-note">últimos 30 días</span>
              </div>

              <div className="ac-tokens-stats">
                <div className="ac-tokens-stat">
                  <span className="ac-tokens-stat-value dash-num">{tokenUsage.totalTokens.toLocaleString("es-VE")}</span>
                  <span className="ac-tokens-stat-label">tokens totales</span>
                </div>
                <div className="ac-tokens-stat">
                  <span className="ac-tokens-stat-value dash-num">{formatUsd(tokenUsage.totalUsd)}</span>
                  <span className="ac-tokens-stat-label">equivalente en USD</span>
                </div>
              </div>

              <TokenUsageChart data={tokenUsage.byDay} />

              <div className="ac-model-list">
                {tokenUsage.byModel.length === 0 ? (
                  <p className="ac-live-empty">Todavía no hay consumo registrado.</p>
                ) : (
                  tokenUsage.byModel.map((usage) => (
                    <ModelPricingRow
                      key={usage.model}
                      usage={usage}
                      pricing={pricingByModel.get(usage.model)}
                      onSave={savePricing}
                    />
                  ))
                )}
              </div>
            </section>

            <section className="dash-panel">
              <div className="dash-panel-head">
                <h2 className="dash-panel-title">Sugerencias al supervisor</h2>
                <span className="dash-panel-spacer" />
                <span className="dash-panel-note">
                  {suggestions.filter((s) => s.status === "pending").length} pendientes
                </span>
              </div>

              <div className="ac-suggest">
                <div className="ac-suggest-row">
                  <textarea
                    className="ac-sim-textarea"
                    placeholder="Ej: los clientes preguntan mucho por envíos a Maracaibo y el bot no sabe responder eso todavía."
                    value={suggestionText}
                    onChange={(e) => setSuggestionText(e.target.value)}
                    disabled={sendingSuggestion}
                  />
                  <button
                    className="crm-pill"
                    data-variant="solid"
                    type="button"
                    onClick={sendSuggestion}
                    disabled={sendingSuggestion || !suggestionText.trim()}
                  >
                    {sendingSuggestion ? "Enviando…" : "Enviar"}
                  </button>
                </div>

                <div className="ac-suggest-list">
                  {suggestions.length === 0 ? (
                    <p className="ac-feed-empty">Todavía no hay sugerencias registradas.</p>
                  ) : (
                    suggestions.map((s) => (
                      <div className="ac-feed-row" key={s.id}>
                        <div className="ac-feed-head">
                          <span className="ac-feed-name">{s.agentName ?? "Asesor"}</span>
                          <span className="ac-badge" data-tone={s.status === "pending" ? "wait" : "good"}>
                            {s.status === "pending" ? "Pendiente" : "Revisada"}
                          </span>
                          <span className="ac-feed-time">{timeLabel(s.createdAt)}</span>
                          {s.status === "pending" && currentAgent.role !== "agent" && (
                            <button
                              className="crm-pill"
                              type="button"
                              onClick={() => resolveSuggestion(s.id)}
                              disabled={resolvingSuggestionId === s.id}
                            >
                              Marcar revisada
                            </button>
                          )}
                        </div>
                        <p className="ac-feed-summary">{s.content}</p>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </section>

            <section className="dash-panel">
              <div className="dash-panel-head">
                <h2 className="dash-panel-title">Probar el agente</h2>
```

If the live file's "Probar el agente" section sits inside a `{tab === "ia" && (<>...</>)}` block (as it does in the version this plan was last checked against), that's correct — these two new sections belong inside that same block, so the anchor above (which is entirely inside it) is the right insertion point. Do not move the new sections outside that block.

- [ ] **Step 13: Add `ModelPricingRow` and `formatUsd` after the component**

Find the end of the file — the component's closing `return ( ... );\n}` followed by nothing else (or by whatever the current last lines are). Append these two functions after the component's closing `}`:

```tsx

function ModelPricingRow({
  usage,
  pricing,
  onSave,
}: {
  usage: ModelUsageSummary;
  pricing: ModelPricing | undefined;
  onSave: (model: string, inputPricePerMillion: number, outputPricePerMillion: number) => Promise<void>;
}) {
  const [inputPrice, setInputPrice] = useState(String(pricing?.inputPricePerMillion ?? ""));
  const [outputPrice, setOutputPrice] = useState(String(pricing?.outputPricePerMillion ?? ""));
  const [saving, setSaving] = useState(false);

  async function save() {
    const input = Number(inputPrice);
    const output = Number(outputPrice);
    if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return;
    setSaving(true);
    try {
      await onSave(usage.model, input, output);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="ac-model-row">
      <div className="ac-model-row-head">
        <span className="ac-model-name">{usage.model}</span>
        <span className="ac-model-tokens dash-num">{usage.totalTokens.toLocaleString("es-VE")} tokens</span>
        <span className="ac-model-usd dash-num">{usage.usdCost !== null ? formatUsd(usage.usdCost) : "sin tarifa"}</span>
      </div>
      <div className="ac-model-pricing">
        <label className="ac-pricing-field">
          $/1M input
          <input
            type="number"
            step="0.0001"
            min="0"
            className="ac-pricing-input"
            value={inputPrice}
            onChange={(e) => setInputPrice(e.target.value)}
            disabled={saving}
          />
        </label>
        <label className="ac-pricing-field">
          $/1M output
          <input
            type="number"
            step="0.0001"
            min="0"
            className="ac-pricing-input"
            value={outputPrice}
            onChange={(e) => setOutputPrice(e.target.value)}
            disabled={saving}
          />
        </label>
        <button className="crm-pill" type="button" onClick={save} disabled={saving}>
          {saving ? "Guardando…" : "Guardar"}
        </button>
      </div>
    </div>
  );
}

function formatUsd(value: number): string {
  return `$${value.toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
```

- [ ] **Step 14: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors in `src/components/agent-control/agent-control-view.tsx` or `src/app/agent-control/page.tsx`.

- [ ] **Step 15: Manual verification (this is the real test cycle — no unit tests exist for this UI)**

Run `npm run dev`, sign in, open `/agent-control`, and check:
1. The "Control de IA" tab (default tab) still shows the kill switch, live conversations, and activity feed exactly as before, plus the two new sections.
2. The "Agentes" tab (the roster panel from the parallel work) still works exactly as before — this task must not have touched it.
3. "Consumo de tokens" shows two stat tiles (tokens totales, equivalente en USD), a bar chart (may be all zeros / flat if no turns ran recently), and one row per model seen in `agent_turns` with editable `$/1M input`/`$/1M output` fields.
4. Use the simulator ("Probar el agente") to send a message; after it completes, confirm the token stats and chart update (they refresh automatically via the `agent_turns` INSERT realtime subscription).
5. Edit a model's `$/1M input` field, click Guardar, reload the page, and confirm the value persisted (it re-reads from `model_pricing` on load).
6. In "Sugerencias al supervisor", type a suggestion and click Enviar — it should appear at the top of the list tagged "Pendiente".
7. If `currentAgent.role` is `"agent"`, confirm there is **no** "Marcar revisada" button on any suggestion. If it's `"supervisor"` or `"admin"`, confirm the button appears on pending suggestions, and clicking it flips the badge to "Revisada" and hides the button.

- [ ] **Step 16: Commit**

```bash
git add src/app/agent-control/page.tsx src/components/agent-control/agent-control-view.tsx
git commit -m "$(cat <<'EOF'
Conecta el panel de tokens/$USD y el de sugerencias en Control de IA

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Post-implementation checklist

- [ ] `npx tsc --noEmit` shows no errors in any file this plan touched (errors in files belonging to the parallel sales-module work in progress are not this plan's concern).
- [ ] `npm run lint` has no new violations in the files this plan touched.
- [ ] All 13 tasks' manual verification steps passed in `npm run dev`.
- [ ] Update the spec's "Riesgos / decisiones abiertas" note (or tell the user directly) that the seeded `model_pricing` rates are placeholders to be corrected from the panel.

## Hallazgos diferidos de la revisión final (no bloquean el merge)

La revisión final de toda la rama (commits `b43bdbf..7702d1f`, + un fix wave `7702d1f..43de6cc` para el Crítico y los 4 Importantes) quedó **limpia** — 0 errores de `tsc`, 0 violaciones de `lint`, re-revisión confirmó los 5 arreglos sin romper nada. Estos 9 hallazgos Menores y un aviso quedaron documentados como seguimiento, no como bloqueo:

1. **`tokensFromUsage` (`src/lib/ai/agent.ts`)** usa `usage.totalTokens ?? 0`. Si un proveedor devuelve `inputTokens`/`outputTokens` pero omite `totalTokens`, la fila queda con partes reales y un total en 0 — inconsistente consigo misma. Más robusto: `usage.totalTokens ?? (inputTokens + outputTokens)`.
2. **El bucketing por día en `fetchTokenUsageSummary`/la función SQL `agent_token_usage`** es en UTC, mientras el resto del CRM usa `CRM_TIME_ZONE` (Caracas, `src/lib/time-zone.ts`). A UTC-4, los turnos entre 8pm y medianoche caen en la barra del día siguiente. No es un bug de cálculo (es internamente consistente), pero desalinea el gráfico del horario real de los supervisores.
3. **Las mutaciones de sugerencias/tarifas fallan en silencio** — `sendSuggestion`, `resolveSuggestion`, `savePricing` en `agent-control-view.tsx` no tienen `catch`: si la mutación falla (RLS, red, offline), el spinner para y no pasa nada más, sin mensaje. El simulador ya tiene el patrón correcto (`simError`) un poco más abajo en el mismo archivo — reusar ese patrón, al menos para `sendSuggestion`.
4. **`ModelPricingRow` no resincroniza sus inputs tras el montaje** — el `useState` inicial solo lee `pricing` una vez y el `key={usage.model}` es estable, así que el componente nunca remonta. Si un supervisor corrige una tarifa mientras otro tiene el panel abierto, el segundo ve el `$` actualizado pero sus inputs siguen con el valor viejo, y guardar revertiría el cambio del primero. Fix sugerido: usar `key={`${usage.model}:${pricing?.updatedAt ?? ""}`}` para que remonte cuando la tarifa subyacente cambie.
5. **El panel dice "últimos 30 días" pero el gráfico muestra 14** — la ventana de 14 días es intencional (más ventana de fetch para el total/costo que para el gráfico), pero solo se explica en el `aria-label` del SVG, invisible para usuarios videntes. Falta un rótulo visible tipo "por día · últimos 14".
6. **`formatUsd` siempre muestra 2 decimales** — los costos reales por turno son del orden de $0.004, así que hasta acumular volumen todo se lee "$0.00", que parece roto en vez de pequeño. Considerar `maximumFractionDigits: value < 1 ? 4 : 2`.
7. **El control de "Marcar revisada" es solo de UI** — `currentAgent.role !== "agent"` en el cliente, pero la policy RLS `agent_suggestions_all` deja que cualquier agente activo actualice `status` directo con la anon key, y `createAgentSuggestion` no valida que `agent_id` sea `auth.uid()` (autoría falsificable). Aceptado como proporcionado para una bandera interna de bajo riesgo — si esto gana peso, el hardening de una línea es `with check (agent_id = auth.uid())` en el INSERT.
8. **`"desconocido"` (turnos con `model` null) recibe una fila de tarifa editable** en el desglose por modelo — inofensivo y hoy inalcanzable (`logTurn` siempre escribe `currentAgentModelLabel()`), pero el formulario de precio debería suprimirse para esa clave sintética.
9. **El textarea de sugerencias reusa la clase `.ac-sim-textarea`** (del simulador) en vez de tener su propia clase — funciona, pero acopla dos secciones sin relación; un futuro restyle del simulador lo movería sin querer.

**Aviso (no es un bug de este plan):** `src/components/sales/sales-view.tsx` (archivo sin trackear, del trabajo en paralelo, fuera de este diff) todavía renderiza el ícono viejo `SlidersHorizontal` para su propio link de nav a `/agent-control` — un cuarto lugar donde aparece ese ícono, además de los tres que la Tarea 1 de este plan corrigió. Es de quien sea dueño de ese archivo, no de esta rama.
