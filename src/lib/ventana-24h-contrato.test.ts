import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchConversations, fetchInboxCounts } from "@/lib/data";
import { awaitingReply, freeformWindowCutoff, isStalePending, withinFreeformWindow } from "@/lib/dashboard";
import type { BoardConversation } from "@/lib/types";

// ---------------------------------------------------------------------------
// El contrato de la ventana de 24 h de WhatsApp.
//
// Historia: hasta el 28/8/2026 (tarde) el corte de 24 h vivía en DOS sitios
// que tenían que medir con la misma vara — `dashboard.ts` (en memoria) y
// `inbox-sections.ts` (la sección "Esperando +24 h" de la bandeja) — y un
// test de contrato los mantenía de acuerdo. Esa tarde la reforma le quitó a
// `inbox-sections.ts` la píldora "Pendientes" entera, y con ella se fue el
// test: el corte quedó vivo solo en `dashboard.ts` (y el AgentHomePanel) sin
// nada que lo obligara a seguir de acuerdo con nadie más.
//
// El 30/8/2026 la píldora "Pendientes" volvió a la bandeja — pero partida
// por LECTURA (`buildInboxSections`, case "pending": sin-abrir vs.
// leídas-sin-responder), NO por la ventana de 24 h; ese fue el plan
// aprobado, y el comentario de cabecera de `inbox-sections.ts` lo deja
// escrito. `inbox-sections.ts` YA NO TIENE corte de 24 h — confirmado
// leyendo el código: el parámetro `now` de `buildInboxSections` ni siquiera
// se usa (trae `eslint-disable-next-line no-unused-vars`). Así que ya no es
// una pata de este contrato.
//
// Las patas que SÍ existen hoy, y que este archivo amarra entre sí:
//
//   1. EN MEMORIA (`src/lib/dashboard.ts`): `withinFreeformWindow` (corte
//      estricto, `>`) y `isStalePending`, que lo combina con `awaitingReply`.
//   2. EN LA BASE, el contador (`fetchInboxCounts.pendingStale`,
//      `src/lib/data.ts:917-928`): mismo corte con `.lte`/`.is.null`.
//   3. EN LA BASE, la consulta paginada (`fetchConversationRows` /
//      `fetchConversations` con `pendingWindow: "stale"`/`"fresh"`,
//      `src/lib/data.ts:737-745`): el mismo par de términos, empujado al
//      acumulador `orGroups`.
//
// Las tres comparten el mismo `now` fijo y el mismo `freeformWindowCutoff`.
// Si alguien cambia el operador de una sola pata (`>` por `>=` en
// `dashboard.ts`, o `.lte` por `.lt` en `data.ts`, o corre el cutoff una
// hora en cualquiera de los dos lados) sin tocar la otra, el mismo chat
// queda "esperando +24h" en una vista y no en la otra — que es exactamente
// lo que este archivo existe para cazar.
// ---------------------------------------------------------------------------

const HORA = 60 * 60 * 1000;
const AHORA = Date.parse("2026-08-30T12:00:00.000Z");
const CUTOFF = freeformWindowCutoff(AHORA);
const CUTOFF_MS = Date.parse(CUTOFF);

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function fila(over: Partial<BoardConversation> = {}): BoardConversation {
  return {
    id: "conv-x",
    contact: { id: "contact-x", phoneNumber: "+58123456789", displayName: "Cliente", profileName: null },
    status: "open",
    unreadCount: 0,
    manuallyUnread: false,
    assignedAgent: null,
    aiEnabled: true,
    dealStatus: "none",
    dealVerified: false,
    lastCustomerMessageAt: iso(AHORA - HORA),
    lastMessageAt: null,
    hasReply: false,
    createdAt: iso(AHORA - 10 * HORA),
    journeyStage: null,
    intent: null,
    activeTool: null,
    welcomeSentAt: null,
    ...over,
  };
}

// Tabla representativa alrededor del borde. `lastMessageAt: null` en las que
// siguen "esperando" (así `awaitingReply` da `true` sin depender de una
// segunda fecha relativa) y `lastMessageAt` posterior en la que ya se
// contestó.
const ANTES_DEL_CORTE = fila({ id: "antes-del-corte", lastCustomerMessageAt: iso(CUTOFF_MS - 1) });
const EXACTO_EN_EL_CORTE = fila({ id: "exacto-en-el-corte", lastCustomerMessageAt: iso(CUTOFF_MS) });
const JUSTO_DESPUES_DEL_CORTE = fila({
  id: "justo-despues-del-corte",
  lastCustomerMessageAt: iso(CUTOFF_MS + 1),
});
const MUY_VIEJA = fila({ id: "muy-vieja", lastCustomerMessageAt: iso(CUTOFF_MS - 100 * HORA) });
const DENTRO_DE_LA_VENTANA = fila({ id: "dentro-de-la-ventana", lastCustomerMessageAt: iso(AHORA - HORA) });
const SIN_FECHA_DE_CLIENTE = fila({ id: "sin-fecha-de-cliente", lastCustomerMessageAt: null });
const CERRADA_PERO_VIEJA = fila({
  id: "cerrada-pero-vieja",
  status: "closed",
  lastCustomerMessageAt: iso(CUTOFF_MS - 50 * HORA),
});
const YA_CONTESTADA = fila({
  id: "ya-contestada",
  lastCustomerMessageAt: iso(CUTOFF_MS - 50 * HORA),
  lastMessageAt: iso(CUTOFF_MS - 40 * HORA), // posterior al mensaje del cliente: ya se respondió.
});

const TABLA: BoardConversation[] = [
  ANTES_DEL_CORTE,
  EXACTO_EN_EL_CORTE,
  JUSTO_DESPUES_DEL_CORTE,
  MUY_VIEJA,
  DENTRO_DE_LA_VENTANA,
  SIN_FECHA_DE_CLIENTE,
  CERRADA_PERO_VIEJA,
  YA_CONTESTADA,
];

// ---------------------------------------------------------------------------
// Fake 1: la cadena de `.select("id", {count, head:true})` que usa
// `fetchInboxCounts` — adaptado del fake de data-inbox-counts.test.ts (mismo
// patrón: filtros anotados y resueltos como PostgREST resolvería un conteo
// exacto, `.then()` en vez de `.range()`).
// ---------------------------------------------------------------------------

interface FilaConteo {
  id: string;
  awaiting_reply: boolean;
  status: string;
  assigned_agent_id: string | null;
  last_customer_message_at: string | null;
  unread_count: number;
  manually_unread: boolean;
}

function toFilaConteo(c: BoardConversation): FilaConteo {
  return {
    id: c.id,
    awaiting_reply: awaitingReply(c),
    status: c.status,
    assigned_agent_id: c.assignedAgent?.id ?? null,
    last_customer_message_at: c.lastCustomerMessageAt,
    unread_count: c.unreadCount,
    manually_unread: c.manuallyUnread,
  };
}

function createConteoFake(rows: FilaConteo[]) {
  function builder(current: FilaConteo[]) {
    return {
      eq(column: string, value: unknown) {
        return builder(current.filter((r) => (r as unknown as Record<string, unknown>)[column] === value));
      },
      neq(column: string, value: unknown) {
        return builder(current.filter((r) => (r as unknown as Record<string, unknown>)[column] !== value));
      },
      is(column: string, value: unknown) {
        return builder(current.filter((r) => ((r as unknown as Record<string, unknown>)[column] ?? null) === value));
      },
      or(clause: string) {
        const conditions = clause.split(",").map((raw) => {
          const [column, op, ...rest] = raw.split(".");
          return { column, op, value: rest.join(".") };
        });
        return builder(
          current.filter((row) =>
            conditions.some(({ column, op, value }) => {
              const cell = (row as unknown as Record<string, unknown>)[column];
              if (op === "is") {
                if (value === "null") return cell == null;
                if (value === "true") return cell === true;
                return cell === value;
              }
              if (op === "lte") return cell != null && (cell as string) <= value;
              if (op === "gt") return cell != null && (cell as number) > Number(value);
              throw new Error(`operador "${op}" no soportado por el fake de .or()`);
            })
          )
        );
      },
      then(resolve: (value: { count: number; error: null }) => unknown) {
        return resolve({ count: current.length, error: null });
      },
    };
  }

  const client = {
    from() {
      return {
        select() {
          return builder(rows);
        },
      };
    },
  };

  return client as unknown as SupabaseClient;
}

// ---------------------------------------------------------------------------
// Fake 2: la cadena de filas (`.select(cols).order().order()[.gt()|.eq()|
// .neq()|.or()].range()`) que usa `fetchConversationRows`/`fetchConversations`
// — recorte del fake de data-conversations.test.ts a solo los métodos que
// `pendingWindow` usa (no hace falta paginación real: la tabla completa cabe
// en una página de `CONVERSATIONS_PAGE_SIZE` filas). `.order()` no reordena
// de verdad: ninguna aserción de este archivo depende del orden, solo del
// CONJUNTO de ids que vuelve.
// ---------------------------------------------------------------------------

interface RawRow {
  id: string;
  status: string;
  // No viaja en el `select` real (no lo pide ninguna vista): es la columna
  // GENERADA que `awaitingReplyOnly` filtra con `.eq()`. El fake la
  // necesita para poder evaluar ese filtro, igual que Postgres la tiene
  // disponible para el `WHERE` aunque no esté en la lista de columnas
  // pedidas.
  awaiting_reply: boolean;
  unread_count: number;
  manually_unread: boolean;
  ai_enabled: boolean;
  deal_status: string;
  deal_verified: boolean;
  last_customer_message_at: string | null;
  last_message_at: string | null;
  has_reply: boolean;
  created_at: string;
  journey_stage: null;
  intent: null;
  active_tool: null;
  welcome_sent_at: null;
  last_message_preview: null;
  last_message_direction: null;
  last_message_status: null;
  contact: {
    id: string;
    phone_number: string;
    display_name: string | null;
    profile_name: string | null;
    avatar_url: null;
    contact_tags: [];
  };
  assigned_agent: null;
}

function toRawRow(c: BoardConversation): RawRow {
  return {
    id: c.id,
    status: c.status,
    awaiting_reply: awaitingReply(c),
    unread_count: c.unreadCount,
    manually_unread: c.manuallyUnread,
    ai_enabled: c.aiEnabled,
    deal_status: c.dealStatus,
    deal_verified: c.dealVerified,
    last_customer_message_at: c.lastCustomerMessageAt,
    last_message_at: c.lastMessageAt,
    has_reply: c.hasReply,
    created_at: c.createdAt,
    journey_stage: null,
    intent: null,
    active_tool: null,
    welcome_sent_at: null,
    last_message_preview: null,
    last_message_direction: null,
    last_message_status: null,
    contact: {
      id: c.contact.id,
      phone_number: c.contact.phoneNumber,
      display_name: c.contact.displayName,
      profile_name: c.contact.profileName,
      avatar_url: null,
      contact_tags: [],
    },
    assigned_agent: null,
  };
}

/** `columna.operador.valor`, solo primer/segundo punto (igual que data-conversations.test.ts). */
function parseCondition(raw: string): { column: string; op: string; value: string } {
  const firstDot = raw.indexOf(".");
  const column = raw.slice(0, firstDot);
  const rest = raw.slice(firstDot + 1);
  const secondDot = rest.indexOf(".");
  return { column, op: rest.slice(0, secondDot), value: rest.slice(secondDot + 1) };
}

function evalOrClause(row: RawRow, clause: string): boolean {
  return clause.split(",").some((term) => {
    const { column, op, value } = parseCondition(term);
    const cell = (row as unknown as Record<string, unknown>)[column];
    if (op === "is") return value === "null" ? cell == null : cell === value;
    if (op === "lte") return cell != null && (cell as string) <= value;
    if (op === "lt") return cell != null && (cell as string) < value;
    throw new Error(`operador "${op}" no soportado por el fake de .or() de filas`);
  });
}

function createFilasFake(rows: RawRow[]) {
  function builder(preds: Array<(row: RawRow) => boolean>) {
    return {
      order() {
        return builder(preds);
      },
      eq(column: string, value: unknown) {
        return builder([...preds, (row) => (row as unknown as Record<string, unknown>)[column] === value]);
      },
      neq(column: string, value: unknown) {
        return builder([...preds, (row) => (row as unknown as Record<string, unknown>)[column] !== value]);
      },
      gt(column: string, value: unknown) {
        return builder([
          ...preds,
          (row) => {
            const cell = (row as unknown as Record<string, unknown>)[column];
            return cell != null && (cell as string) > (value as string);
          },
        ]);
      },
      or(clause: string) {
        return builder([...preds, (row) => evalOrClause(row, clause)]);
      },
      range(from: number, to: number) {
        const filtered = rows.filter((row) => preds.every((pred) => pred(row)));
        return Promise.resolve({ data: filtered.slice(from, to + 1), error: null });
      },
    };
  }

  const client = {
    from() {
      return {
        select() {
          return builder([]);
        },
      };
    },
  };

  return client as unknown as SupabaseClient;
}

// ---------------------------------------------------------------------------

describe("el borde exacto, en memoria (dashboard.ts)", () => {
  // `CUTOFF_MS` es el instante `now - 24h`. Un mensaje del cliente
  // CRONOLÓGICAMENTE ANTERIOR a ese instante ya lleva más de 24 h esperando
  // — está FUERA de la ventana (stale) — y uno posterior todavía está
  // DENTRO (fresh). El único punto ambiguo es el instante exacto, y ahí
  // `withinFreeformWindow` define el criterio con `>` estricto: el borde
  // mismo cuenta como fuera.
  it("un milisegundo antes del corte ya está fuera de la ventana (más de 24h)", () => {
    expect(withinFreeformWindow(ANTES_DEL_CORTE.lastCustomerMessageAt, AHORA)).toBe(false);
  });

  it("EXACTO en el corte ya no está dentro: `>` es estricto", () => {
    expect(withinFreeformWindow(EXACTO_EN_EL_CORTE.lastCustomerMessageAt, AHORA)).toBe(false);
  });

  it("un milisegundo después del corte sigue dentro de la ventana", () => {
    expect(withinFreeformWindow(JUSTO_DESPUES_DEL_CORTE.lastCustomerMessageAt, AHORA)).toBe(true);
  });

  it("sin fecha del cliente, false: falla cerrado", () => {
    expect(withinFreeformWindow(null, AHORA)).toBe(false);
  });

  it("isStalePending en el borde exacto es true (awaiting + fuera de ventana)", () => {
    expect(isStalePending(EXACTO_EN_EL_CORTE, AHORA)).toBe(true);
  });

  it(
    "isStalePending con lastCustomerMessageAt null da false — no porque " +
      "`withinFreeformWindow` lo rescate, sino porque `awaitingReply` ya " +
      "falló cerrado un paso antes. Es el mismo criterio aplicado dos veces " +
      "por caminos distintos, no dos criterios distintos.",
    () => {
      expect(isStalePending(SIN_FECHA_DE_CLIENTE, AHORA)).toBe(false);
    }
  );
});

describe("leg 1 (memoria) contra leg 2 (fetchInboxCounts.pendingStale)", () => {
  it("el número de pendingStale es exactamente el de isStalePending entre las NO cerradas", async () => {
    // `isStalePending` no mira `status` (lo usan lugares que ya filtraron
    // "abiertas" antes, como `buildTicketStats`); "Pendientes" sí exige
    // `status <> closed`. Por eso el conjunto que se compara acá excluye
    // `cerrada-pero-vieja` a propósito — no es una laguna del contrato, es
    // el alcance documentado de "Pendientes" (awaiting_reply AND no cerrada)
    // aplicado por fuera de `isStalePending`.
    const esperado = TABLA.filter((c) => c.status !== "closed" && isStalePending(c, AHORA));

    const client = createConteoFake(TABLA.map(toFilaConteo));
    const counts = await fetchInboxCounts(client, "viewer-1", AHORA);

    expect(counts.pendingStale).toBe(esperado.length);
  });
});

describe("leg 1 (memoria) contra leg 3 (fetchConversations con pendingWindow), mismo conjunto exacto", () => {
  it('"stale" trae exactamente los ids con isStalePending=true entre las awaiting/no-cerradas', async () => {
    const esperadoIds = TABLA.filter((c) => c.status !== "closed" && isStalePending(c, AHORA))
      .map((c) => c.id)
      .sort();

    const client = createFilasFake(TABLA.map(toRawRow));
    const rows = await fetchConversations(client, {
      awaitingReplyOnly: true,
      activeOnly: true,
      pendingWindow: "stale",
      now: AHORA,
    });

    expect(rows.map((r) => r.id).sort()).toEqual(esperadoIds);
  });

  it('"fresh" es el complemento EXACTO de "stale" dentro del universo awaiting/no-cerradas', async () => {
    const pendientes = TABLA.filter((c) => c.status !== "closed" && awaitingReply(c));
    const esperadoFrescasIds = pendientes
      .filter((c) => !isStalePending(c, AHORA))
      .map((c) => c.id)
      .sort();

    const client = createFilasFake(TABLA.map(toRawRow));
    const [frescas, viejas] = await Promise.all([
      fetchConversations(client, {
        awaitingReplyOnly: true,
        activeOnly: true,
        pendingWindow: "fresh",
        now: AHORA,
      }),
      fetchConversations(client, {
        awaitingReplyOnly: true,
        activeOnly: true,
        pendingWindow: "stale",
        now: AHORA,
      }),
    ]);
    const frescasIds = frescas.map((r) => r.id).sort();
    const viejasIds = viejas.map((r) => r.id);

    expect(frescasIds).toEqual(esperadoFrescasIds);
    // Complemento real dentro del universo "pendiente" — no dos aserciones
    // sueltas que casualmente coincidan: la unión de las dos consultas real
    // (fresh + stale) tiene que ser exactamente `pendientes`, sin solape.
    expect([...frescasIds, ...viejasIds].sort()).toEqual(pendientes.map((c) => c.id).sort());
    for (const id of frescasIds) expect(viejasIds.includes(id)).toBe(false);
  });
});

describe('"fresh" y "stale" particionan TODO el universo, no solo lo pendiente', () => {
  it("cada conversación cae en fresh o en stale, nunca en las dos, nunca en ninguna", async () => {
    const client = createFilasFake(TABLA.map(toRawRow));

    const [frescas, viejas] = await Promise.all([
      fetchConversations(client, { pendingWindow: "fresh", now: AHORA }),
      fetchConversations(client, { pendingWindow: "stale", now: AHORA }),
    ]);

    const frescasIds = new Set(frescas.map((r) => r.id));
    const viejasIds = new Set(viejas.map((r) => r.id));

    // Sin solape.
    for (const id of frescasIds) expect(viejasIds.has(id)).toBe(false);
    // Sin huecos: la unión es la tabla completa.
    expect(frescasIds.size + viejasIds.size).toBe(TABLA.length);

    // Y cada lado coincide, fila por fila, con `withinFreeformWindow` — el
    // mismo criterio de leg 1, ahora sobre el universo sin restringir a
    // "pendiente".
    for (const c of TABLA) {
      const dentro = withinFreeformWindow(c.lastCustomerMessageAt, AHORA);
      expect(frescasIds.has(c.id)).toBe(dentro);
      expect(viejasIds.has(c.id)).toBe(!dentro);
    }
  });
});

describe("el `.is.null` defensivo: mismo cutoff, misma pata de la base en las dos consultas", () => {
  // Estado que hoy no puede darse en producción de verdad: `awaiting_reply`
  // es una columna GENERADA que exige `last_customer_message_at is not
  // null`, así que `awaiting_reply = true` con la fecha en null es
  // contradictorio contra el esquema real. Por eso esta fila se arma A MANO
  // (no con `toFilaConteo`/`toRawRow`, que la derivarían de `awaitingReply()`
  // y darían `false`) y se prueba SOLA, sin compararla contra `isStalePending`
  // — el comentario de `data.ts:921-925` ya avisa que el filtro "no depende"
  // de esa garantía; esto confirma que las DOS patas de la base (el contador
  // y la consulta paginada) cargan igual el término `.is.null` por si esa
  // garantía llegara a fallar, no solo una de las dos.
  const FILA_DEFENSIVA_CONTEO: FilaConteo = {
    id: "defensiva-sin-fecha-pero-marcada-esperando",
    awaiting_reply: true,
    status: "open",
    assigned_agent_id: null,
    last_customer_message_at: null,
    unread_count: 0,
    manually_unread: false,
  };
  const FILA_DEFENSIVA_RAW: RawRow = {
    ...toRawRow(fila({ id: FILA_DEFENSIVA_CONTEO.id, lastCustomerMessageAt: null })),
  };

  it("pendingStale la cuenta", async () => {
    const client = createConteoFake([FILA_DEFENSIVA_CONTEO]);
    const counts = await fetchInboxCounts(client, "viewer-1", AHORA);
    expect(counts.pendingStale).toBe(1);
  });

  it('pendingWindow "stale" también la trae — mismo cutoff, mismo término, otra consulta', async () => {
    const client = createFilasFake([FILA_DEFENSIVA_RAW]);
    const rows = await fetchConversations(client, {
      pendingWindow: "stale",
      now: AHORA,
    });
    expect(rows.map((r) => r.id)).toEqual([FILA_DEFENSIVA_CONTEO.id]);
  });
});
