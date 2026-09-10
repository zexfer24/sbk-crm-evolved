import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchInboxCounts } from "@/lib/data";
import { freeformWindowCutoff } from "@/lib/dashboard";
import { orExpression, pgrstLiteral } from "@/lib/ai/pgrst";

// ---------------------------------------------------------------------------
// Los conteos de las píldoras de la bandeja: "Pendientes" (con o sin asesor
// — a propósito, ver la migración 20260828020000) y su subconjunto fuera de
// la ventana de 24 h ("Esperando +24 h"), de la reforma del 28/8/2026;
// "Lo mío" y "No leídas" de las reformas siguientes; "Escaladas" (T1.5, plan
// "La bandeja que no pierde", 5/9/2026). "Sin dueño" no entra acá — no es un
// conteo de Postgres, es el largo de una lista, y su fake vive en
// `data-unassigned-conversations.test.ts`. El fake reproduce
// `.from("conversations").select("id", {count, head})` encadenado con
// `.eq()/.neq()/.is()/.or()`, resolviendo como PostgREST resolvería un
// `count: "exact", head: true`: sin filas, solo el número.
// ---------------------------------------------------------------------------

interface Filtro {
  op: string;
  column: string;
  value: unknown;
}

interface Consulta {
  filtros: Filtro[];
  opciones: unknown;
}

interface FilaConteo {
  id: string;
  awaiting_reply: boolean;
  status: string;
  assigned_agent_id: string | null;
  last_customer_message_at: string | null;
  unread_count: number;
  manually_unread: boolean;
  /** T1.5 (5/9/2026): las tres columnas que mira el conteo de "Escaladas". */
  journey_stage: string | null;
  ai_enabled: boolean;
  last_reply_sender: string | null;
  /**
   * T1 (8/9/2026): lo que mira el corte "habló hoy" (`since`). Opcionales —
   * `undefined` en las filas de este archivo que no ejercitan `since`, así
   * que las siete filas de `filas()` no tuvieron que tocarse.
   */
  last_message_at?: string | null;
  created_at?: string;
}

/**
 * Divide una expresión de `.or()` por sus comas de nivel superior, sin
 * partir las que quedan dentro de un `and(...)` anidado — mismo recorte que
 * `data-conversations.test.ts` (T1, 8/9/2026: `since` combinado con el `.or()`
 * propio de "pendingStale"/"unread"/"escalated" produce `and(a,b)` de dos
 * términos, algo que este fake no tenía que entender antes de esta tarea).
 */
function splitTopLevel(clause: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of clause) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) parts.push(current);
  return parts;
}

function createFakeSupabase(rows: FilaConteo[]) {
  const consultas: Consulta[] = [];

  function builder(consulta: Consulta, current: FilaConteo[]) {
    const api = {
      eq(column: string, value: unknown) {
        consulta.filtros.push({ op: "eq", column, value });
        return builder(
          consulta,
          current.filter((row) => (row as unknown as Record<string, unknown>)[column] === value)
        );
      },
      neq(column: string, value: unknown) {
        consulta.filtros.push({ op: "neq", column, value });
        return builder(
          consulta,
          current.filter((row) => (row as unknown as Record<string, unknown>)[column] !== value)
        );
      },
      is(column: string, value: unknown) {
        consulta.filtros.push({ op: "is", column, value });
        return builder(
          consulta,
          current.filter(
            (row) => ((row as unknown as Record<string, unknown>)[column] ?? null) === value
          )
        );
      },
      // Fake mínimo: entiende las cláusulas que emite fetchInboxCounts para
      // `pendingStale` (`columna.lte.valor` y `columna.is.null`), `unread`
      // (`columna.gt.valor` y `columna.is.true`) y, desde T1 (8/9/2026),
      // `since` combinado con cualquiera de los anteriores en un solo
      // `and(...)` por `orExpression` — de ahí el término RECURSIVO: un
      // `and(...)` de nivel superior puede traer, a su vez, otro término
      // suelto o `and(...)` adentro.
      or(clause: string) {
        consulta.filtros.push({ op: "or", column: "", value: clause });
        function evalTerm(row: FilaConteo, term: string): boolean {
          if (term.startsWith("and(") && term.endsWith(")")) {
            const inner = term.slice(4, -1);
            return splitTopLevel(inner).every((raw) => evalTerm(row, raw));
          }
          const [column, op, ...rest] = term.split(".");
          let value = rest.join(".");
          // `since` viaja entrecomillado (`pgrstLiteral`, igual que el resto
          // de los valores libres de esta base): sin desentrecomillar, el
          // caracter `"` (0x22) ordena ANTES que cualquier dígito y el `gte`
          // de acá abajo daría siempre verdadero, sin importar la fecha real.
          if (value.startsWith('"') && value.endsWith('"')) {
            value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
          }
          const cell = (row as unknown as Record<string, unknown>)[column];
          if (op === "is") {
            if (value === "null") return cell == null;
            if (value === "true") return cell === true;
            return cell === value;
          }
          if (op === "lte") return cell != null && (cell as string) <= value;
          if (op === "gt") return cell != null && (cell as number) > Number(value);
          // T1 (8/9/2026): el corte "habló hoy" (`since`) es el primer
          // consumidor de `gte` en este fake.
          if (op === "gte") return cell != null && (cell as string) >= value;
          // T1.5 (5/9/2026): el conteo de "Escaladas" arma
          // `last_reply_sender.neq.agent` dentro del `.or()` (junto con
          // `.is.null` y `.is.true`) para expresar "is distinct from
          // 'agent'" — ver el comentario de `escalated` en data.ts.
          if (op === "neq") return cell !== value;
          throw new Error(`operador "${op}" no soportado por el fake de .or()`);
        }
        const terms = splitTopLevel(clause);
        return builder(
          consulta,
          current.filter((row) => terms.some((term) => evalTerm(row, term)))
        );
      },
      // La consulta de "Sin dueño" (`fetchUnassignedConversationIds`) no es un
      // conteo: pide filas con la bitácora embebida y ordena/limita esa
      // relación. Acá esos tres solo tienen que no romper la cadena — lo que
      // el corte decide se prueba en `data-unassigned-conversations.test.ts`,
      // contra un doble que sí modela la bitácora.
      order() {
        return builder(consulta, current);
      },
      range(desde: number, hasta: number) {
        return builder(consulta, current.slice(desde, hasta + 1));
      },
      limit() {
        return builder(consulta, current);
      },
      in(column: string, values: unknown[]) {
        consulta.filtros.push({ op: "in", column, value: values });
        return builder(
          consulta,
          current.filter((row) =>
            values.includes((row as unknown as Record<string, unknown>)[column])
          )
        );
      },
      // Se resuelve como promesa. Para los cuatro conteos, `count: "exact",
      // head: true` no trae filas; para la consulta de "Sin dueño" se
      // devuelven las filas con la bitácora vacía, que es lo que hace que
      // ninguna califique y el contador dé 0 en este archivo.
      then(
        resolve: (value: {
          count: number;
          data: Record<string, unknown>[];
          error: null;
        }) => unknown
      ) {
        return resolve({
          count: current.length,
          data: current.map((row) => ({ ...row, conversation_handoffs: [] })),
          error: null,
        });
      },
    };
    return api;
  }

  const client = {
    from() {
      return {
        select(_columns: string, opciones?: unknown) {
          const consulta: Consulta = { filtros: [], opciones };
          consultas.push(consulta);
          return builder(consulta, rows);
        },
      };
    },
  };

  return { client: client as unknown as SupabaseClient, consultas };
}

const AHORA = Date.parse("2026-08-28T12:00:00.000Z");
const CUTOFF = freeformWindowCutoff(AHORA);
const DESPUES_DEL_CORTE = new Date(Date.parse(CUTOFF) + 1000).toISOString();
const ANTES_DEL_CORTE = new Date(Date.parse(CUTOFF) - 1000).toISOString();

/**
 * Campos por defecto de "Escaladas" (T1.5, 5/9/2026) para las filas que no
 * tienen nada que ver con esa píldora: `journey_stage: null` ya excluye por
 * sí solo (no es `'assigned'`), así que estas cinco filas no cuentan para
 * "escalated" pase lo que pase con el resto de sus campos.
 */
const SIN_ESCALAR = { journey_stage: null, ai_enabled: true, last_reply_sender: null };

function filas(): FilaConteo[] {
  return [
    // Pendiente, dentro de la ventana, sin asesor.
    {
      id: "conv-0",
      awaiting_reply: true,
      status: "open",
      assigned_agent_id: null,
      last_customer_message_at: DESPUES_DEL_CORTE,
      unread_count: 0,
      manually_unread: false,
      ...SIN_ESCALAR,
    },
    // Pendiente, fuera de la ventana, CON asesor — cuenta igual: "Pendientes"
    // no exige "sin asesor" (migración 20260828020000).
    {
      id: "conv-1",
      awaiting_reply: true,
      status: "open",
      assigned_agent_id: "ana",
      last_customer_message_at: ANTES_DEL_CORTE,
      unread_count: 0,
      manually_unread: false,
      ...SIN_ESCALAR,
    },
    // awaiting_reply, pero cerrada: no es "Pendientes". Sí trae mensajes sin
    // leer: cuenta para "unread" (decisión de diseño — ver el test de abajo).
    {
      id: "conv-2",
      awaiting_reply: true,
      status: "closed",
      assigned_agent_id: null,
      last_customer_message_at: ANTES_DEL_CORTE,
      unread_count: 4,
      manually_unread: false,
      ...SIN_ESCALAR,
    },
    // No está esperando respuesta, pero es del viewer: cuenta para "mine".
    {
      id: "conv-3",
      awaiting_reply: false,
      status: "open",
      assigned_agent_id: "viewer-1",
      last_customer_message_at: null,
      unread_count: 0,
      manually_unread: false,
      ...SIN_ESCALAR,
    },
    // Pendiente, del viewer, sin fecha de cliente: cae en "stale" (falla
    // cerrado) y también en "mine". Apartada a mano: cuenta también para
    // "unread", aunque el contador esté en cero.
    {
      id: "conv-4",
      awaiting_reply: true,
      status: "open",
      assigned_agent_id: "viewer-1",
      last_customer_message_at: null,
      unread_count: 0,
      manually_unread: true,
      ...SIN_ESCALAR,
    },
    // Escalada sin asesor: la IA se despidió con el mensaje de cortesía
    // (`last_reply_sender: 'ai'`) y ya no espera — cuenta igual, por el `or`
    // con `awaiting_reply` que el conteo comparte con `matchesFilter`.
    {
      id: "conv-5",
      awaiting_reply: false,
      status: "open",
      assigned_agent_id: null,
      last_customer_message_at: DESPUES_DEL_CORTE,
      unread_count: 0,
      manually_unread: false,
      journey_stage: "assigned",
      ai_enabled: false,
      last_reply_sender: "ai",
    },
    // Escalada CON asesor que ya respondió de verdad y el cliente no volvió:
    // no cuenta — es el caso que prueba que el `neq`/`is.null` no se traga
    // de más.
    {
      id: "conv-6",
      awaiting_reply: false,
      status: "open",
      assigned_agent_id: "beto",
      last_customer_message_at: ANTES_DEL_CORTE,
      unread_count: 0,
      manually_unread: false,
      journey_stage: "assigned",
      ai_enabled: false,
      last_reply_sender: "agent",
    },
  ];
}

describe("fetchInboxCounts", () => {
  it('"pending" pregunta por awaiting_reply y status <> closed, sin condición de asesor', async () => {
    const { client, consultas } = createFakeSupabase(filas());

    await fetchInboxCounts(client, "viewer-1", AHORA);

    expect(consultas[0].filtros).toEqual([
      { op: "eq", column: "awaiting_reply", value: true },
      { op: "neq", column: "status", value: "closed" },
    ]);
    expect(consultas[0].opciones).toEqual({ count: "exact", head: true });
  });

  it('"pendingStale" repite el predicado de "pending" y le agrega el corte de ventana invertido con .or(), incluido lo sin fecha', async () => {
    const { client, consultas } = createFakeSupabase(filas());

    await fetchInboxCounts(client, "viewer-1", AHORA);

    expect(consultas[1].filtros).toEqual([
      { op: "eq", column: "awaiting_reply", value: true },
      { op: "neq", column: "status", value: "closed" },
      {
        op: "or",
        column: "",
        value: `last_customer_message_at.lte.${CUTOFF},last_customer_message_at.is.null`,
      },
    ]);
    expect(consultas[1].opciones).toEqual({ count: "exact", head: true });
  });

  it('"mine" pregunta por assigned_agent_id igual al viewer, igual que antes de la reforma', async () => {
    const { client, consultas } = createFakeSupabase(filas());

    await fetchInboxCounts(client, "viewer-1", AHORA);

    expect(consultas[2].filtros).toEqual([
      { op: "eq", column: "assigned_agent_id", value: "viewer-1" },
    ]);
    expect(consultas[2].opciones).toEqual({ count: "exact", head: true });
  });

  /**
   * `unread` va cerca del final del `Promise.all` para no correr los índices
   * que los tres tests de arriba ya afirman por posición (`consultas[0..2]`).
   * Sin condición de estado, a propósito: una conversación CERRADA con
   * mensajes sin leer (conv-2) sigue contando — es la misma decisión que
   * `unreadOnly` de `fetchConversations` (ver data-conversations.test.ts).
   *
   * Son SIETE consultas desde el 10/9/2026 (T3, "Los números del día"), no
   * seis: "Tuyas sin leer" (consultas[4], ver el test de abajo) se suma justo
   * al lado de "unread"; "Escaladas" pasa de consultas[4] a consultas[5]; "Sin
   * dueño" sigue última porque no es un conteo —pide filas con la bitácora
   * embebida— y porque es la única que toca otra tabla.
   */
  it('"unread" pregunta por el OR de unread_count/manually_unread, sin condición de estado', async () => {
    const { client, consultas } = createFakeSupabase(filas());

    await fetchInboxCounts(client, "viewer-1", AHORA);

    expect(consultas).toHaveLength(7);
    expect(consultas[3].filtros).toEqual([
      {
        op: "or",
        column: "",
        value: "unread_count.gt.0,manually_unread.is.true",
      },
    ]);
    expect(consultas[3].opciones).toEqual({ count: "exact", head: true });
  });

  /**
   * "Tuyas sin leer" (T3, "Los números del día", 10/9/2026): mismo OR que
   * "unread" arriba, más `assigned_agent_id` por `.eq()` — la tarjeta "Tuyas
   * sin leer" del panel de inicio.
   */
  it('"mineUnread" pregunta por assigned_agent_id y el mismo OR que "unread"', async () => {
    const { client, consultas } = createFakeSupabase(filas());

    await fetchInboxCounts(client, "viewer-1", AHORA);

    expect(consultas[4].filtros).toEqual([
      { op: "eq", column: "assigned_agent_id", value: "viewer-1" },
      {
        op: "or",
        column: "",
        value: "unread_count.gt.0,manually_unread.is.true",
      },
    ]);
    expect(consultas[4].opciones).toEqual({ count: "exact", head: true });
  });

  /**
   * "Escaladas" (T1.5, 5/9/2026): las primeras tres condiciones son `.eq()`/
   * `.neq()` normales —mismo predicado que usa `conversations_escalated_idx`
   * (migración 20260905010000)—, y la cuarta ("is distinct from 'agent' or
   * awaiting_reply") viaja en un solo `.or()`, igual que "unread" arriba.
   */
  it('"escalated" pregunta por journey_stage/ai_enabled/status y el OR final', async () => {
    const { client, consultas } = createFakeSupabase(filas());

    await fetchInboxCounts(client, "viewer-1", AHORA);

    expect(consultas[5].filtros).toEqual([
      { op: "eq", column: "journey_stage", value: "assigned" },
      { op: "eq", column: "ai_enabled", value: false },
      { op: "neq", column: "status", value: "closed" },
      {
        op: "or",
        column: "",
        value: "last_reply_sender.neq.agent,last_reply_sender.is.null,awaiting_reply.is.true",
      },
    ]);
    expect(consultas[5].opciones).toEqual({ count: "exact", head: true });
  });

  it("devuelve los siete números, cada uno contra su propio subconjunto", async () => {
    const { client } = createFakeSupabase(filas());

    const result = await fetchInboxCounts(client, "viewer-1", AHORA);

    // pending: conv-0, conv-1, conv-4 (awaiting_reply y no cerrada).
    // pendingStale: de esos, conv-1 (fuera de ventana) y conv-4 (sin fecha).
    // mine: conv-3 y conv-4 (assigned_agent_id === "viewer-1").
    // unread: conv-2 (cerrada, pero con unread_count > 0 — a propósito, no
    // exige status abierto) y conv-4 (manually_unread).
    // mineUnread: solo conv-4 (mine Y unread a la vez) — conv-3 es mine pero
    // leída, conv-2 no leída pero no es del viewer.
    // escalated: conv-5 (escalada sin asesor, la IA se despidió con la
    // cortesía) — NO conv-6 (con asesor que ya respondió de verdad y el
    // cliente no volvió).
    expect(result).toEqual({
      pending: 3,
      pendingStale: 2,
      mine: 2,
      unread: 2,
      mineUnread: 1,
      escalated: 1,
      unassigned: 0,
    });
  });
});

/**
 * T1 del plan "Seis frentes del buzón" (8/9/2026): "habló hoy" en los seis
 * contadores originales (el séptimo, `mineUnread`, se suma el 10/9/2026 con
 * T3, "Los números del día", y hereda el mismo mecanismo). `since` se
 * combina en el MISMO `.or()` que cada conteo ya
 * arma (`orExpression`, `src/lib/ai/pgrst.ts`) — nunca como un segundo
 * `.or()` encadenado (ver el comentario de `since` en
 * `FetchConversationsOptions`, data.ts). Los strings esperados se calculan
 * con la misma `orExpression` que usa la implementación, igual que
 * `data-conversations.test.ts` ya hace para el cursor combinado con
 * `unreadOnly` — así el test valida la COMBINACIÓN, no una copia a mano del
 * algoritmo que podría desincronizarse en silencio.
 */
describe('fetchInboxCounts — since ("habló hoy")', () => {
  const SINCE = "2026-09-08T04:00:00.000Z";
  const sinceGroup = [
    `last_message_at.gte.${pgrstLiteral(SINCE)}`,
    `and(last_message_at.is.null,created_at.gte.${pgrstLiteral(SINCE)})`,
  ];

  function fila(id: string, over: Partial<FilaConteo> = {}): FilaConteo {
    return {
      id,
      awaiting_reply: true,
      status: "open",
      assigned_agent_id: null,
      last_customer_message_at: null,
      unread_count: 0,
      manually_unread: false,
      journey_stage: null,
      ai_enabled: true,
      last_reply_sender: null,
      last_message_at: "2026-09-08T10:00:00.000Z",
      created_at: "2026-09-08T10:00:00.000Z",
      ...over,
    };
  }

  it('"pending" (sin OR propio) agrega el .or() de since solo', async () => {
    const { client, consultas } = createFakeSupabase([fila("conv-0")]);

    await fetchInboxCounts(client, "viewer-1", AHORA, { since: SINCE });

    expect(consultas[0].filtros).toContainEqual({
      op: "or",
      column: "",
      value: orExpression([sinceGroup]),
    });
  });

  it('"mine" (sin OR propio) agrega el .or() de since solo', async () => {
    const { client, consultas } = createFakeSupabase([fila("conv-0")]);

    await fetchInboxCounts(client, "viewer-1", AHORA, { since: SINCE });

    expect(consultas[2].filtros).toContainEqual({
      op: "or",
      column: "",
      value: orExpression([sinceGroup]),
    });
  });

  it('"pendingStale" cruza su OR propio con el de since en una sola disyunción', async () => {
    const { client, consultas } = createFakeSupabase([fila("conv-0")]);

    await fetchInboxCounts(client, "viewer-1", AHORA, { since: SINCE });

    const propio = [`last_customer_message_at.lte.${CUTOFF}`, "last_customer_message_at.is.null"];
    expect(consultas[1].filtros).toContainEqual({
      op: "or",
      column: "",
      value: orExpression([propio, sinceGroup]),
    });
  });

  it('"unread" cruza su OR propio con el de since en una sola disyunción', async () => {
    const { client, consultas } = createFakeSupabase([fila("conv-0")]);

    await fetchInboxCounts(client, "viewer-1", AHORA, { since: SINCE });

    const propio = ["unread_count.gt.0", "manually_unread.is.true"];
    expect(consultas[3].filtros).toContainEqual({
      op: "or",
      column: "",
      value: orExpression([propio, sinceGroup]),
    });
  });

  it('"mineUnread" cruza su OR propio (el mismo de "unread") con el de since en una sola disyunción', async () => {
    const { client, consultas } = createFakeSupabase([fila("conv-0")]);

    await fetchInboxCounts(client, "viewer-1", AHORA, { since: SINCE });

    const propio = ["unread_count.gt.0", "manually_unread.is.true"];
    expect(consultas[4].filtros).toContainEqual({
      op: "eq",
      column: "assigned_agent_id",
      value: "viewer-1",
    });
    expect(consultas[4].filtros).toContainEqual({
      op: "or",
      column: "",
      value: orExpression([propio, sinceGroup]),
    });
  });

  it('"escalated" cruza su OR propio con el de since en una sola disyunción', async () => {
    const { client, consultas } = createFakeSupabase([fila("conv-0")]);

    await fetchInboxCounts(client, "viewer-1", AHORA, { since: SINCE });

    const propio = [
      "last_reply_sender.neq.agent",
      "last_reply_sender.is.null",
      "awaiting_reply.is.true",
    ];
    expect(consultas[5].filtros).toContainEqual({
      op: "or",
      column: "",
      value: orExpression([propio, sinceGroup]),
    });
  });

  it('"unassigned" (fetchUnassignedConversationIds) también recibe since', async () => {
    const { client, consultas } = createFakeSupabase([fila("conv-0")]);

    await fetchInboxCounts(client, "viewer-1", AHORA, { since: SINCE });

    expect(consultas[6].filtros).toContainEqual({
      op: "or",
      column: "",
      value: orExpression([sinceGroup]),
    });
  });

  it("sin since (interruptor \"Ver todo\"), ninguno de los seis agrega el .or() de since", async () => {
    const { client, consultas } = createFakeSupabase([fila("conv-0")]);

    await fetchInboxCounts(client, "viewer-1", AHORA);

    // "pending"/"mine" no llevan ningún .or() sin since (ya cubierto arriba
    // por los tests que abren este archivo); acá se confirma que ninguna de
    // las seis consultas menciona `last_message_at.gte` — ni siquiera las
    // que ya tenían su propio `.or()`.
    for (const consulta of consultas) {
      for (const filtro of consulta.filtros) {
        if (filtro.op === "or") {
          expect(String(filtro.value)).not.toContain("last_message_at.gte");
        }
      }
    }
  });

  it("con datos reales de hoy y de ayer, since deja solo lo de hoy en los conteos que lo cruzan", async () => {
    const rows = [
      // Hoy, pendiente sin asesor: cuenta en pending/pendingStale.
      fila("conv-hoy", { last_customer_message_at: ANTES_DEL_CORTE }),
      // Ayer, pendiente sin asesor: pending/pendingStale la ven, since la saca.
      fila("conv-ayer", {
        last_message_at: "2026-09-07T10:00:00.000Z",
        created_at: "2026-09-07T10:00:00.000Z",
        last_customer_message_at: ANTES_DEL_CORTE,
      }),
      // Recién creada hoy desde la bandeja (T6): sin last_message_at
      // todavía, pero created_at de hoy — since la deja pasar igual.
      fila("conv-recien-creada", {
        last_message_at: null,
        created_at: "2026-09-08T11:00:00.000Z",
        last_customer_message_at: ANTES_DEL_CORTE,
      }),
    ];
    const { client } = createFakeSupabase(rows);

    const result = await fetchInboxCounts(client, "viewer-1", AHORA, { since: SINCE });

    expect(result.pending).toBe(2); // conv-hoy, conv-recien-creada
    expect(result.pendingStale).toBe(2); // las dos están fuera de la ventana de 24h
  });
});
