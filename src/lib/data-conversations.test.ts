import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CONVERSATIONS_PAGE_SIZE, fetchBoardConversations, fetchConversations } from "@/lib/data";
import { freeformWindowCutoff } from "@/lib/dashboard";
import { cursorAfterPage } from "@/lib/inbox-paging";

// ---------------------------------------------------------------------------
// Fake de SupabaseClient para la cadena de fetchConversations
// (`.from().select().order().range()`), que devuelve rebanadas reales del
// arreglo según el rango pedido. Reproduce el tope de filas de PostgREST:
// sin `.range()`, una respuesta se corta en silencio y las conversaciones
// más viejas desaparecen de la bandeja sin ningún error.
// ---------------------------------------------------------------------------

interface RangeCall {
  from: number;
  to: number;
}

function makeRow(index: number) {
  return {
    id: `conv-${index}`,
    status: "open" as const,
    assigned_agent_id: null as string | null,
    // Columna generada: la calcula Postgres a partir de los dos timestamps.
    awaiting_reply: false,
    // Real, no generada: vive en `messages`. La mantiene el trigger de
    // inserción y dice si de acá salió alguna respuesta alguna vez.
    has_reply: false,
    unread_count: 0,
    manually_unread: false,
    ai_enabled: true,
    deal_status: null,
    deal_closed_at: null,
    deal_payment_proof_url: null,
    order: null,
    deal_verified: false,
    deal_verified_at: null,
    deal_verified_by: null,
    deal_payment_method: null,
    deal_closed_by: null,
    last_customer_message_at: null as string | null,
    last_message_at: new Date(2024, 0, 1, 0, 0, index).toISOString() as string | null,
    last_message_preview: `preview ${index}`,
    last_message_direction: null,
    last_message_status: null,
    created_at: new Date(2024, 0, 1, 0, 0, index).toISOString(),
    journey_stage: null,
    intent: null,
    active_tool: null,
    welcome_sent_at: null,
    contact: {
      id: `contact-${index}`,
      phone_number: `5840000${index}`,
      display_name: `Cliente ${index}`,
      profile_name: null,
      avatar_url: null,
      cedula_type: null,
      cedula_number: null,
      state: null,
      city: null,
      address: null,
      contact_tags: [],
    },
    channel: {
      id: "canal-1",
      label: "Principal",
      phone_number: "584120000000",
      phone_number_id: "pnid",
      status: "connected" as const,
    },
    assigned_agent: null,
  };
}

type Row = ReturnType<typeof makeRow>;

interface SortSpec {
  column: string;
  ascending: boolean;
  nullsFirst: boolean;
}

/**
 * Divide una expresión de `.or()` por sus comas de nivel superior, sin
 * partir las que quedan dentro de un `and(...)` anidado ni las que vinieran
 * dentro de un literal entrecomillado (los timestamps con cursor no traen
 * comas, pero sí `+` y `:` — la comilla es lo único que hay que respetar acá).
 */
function splitTopLevel(clause: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inQuotes = false;
  let current = "";
  for (let i = 0; i < clause.length; i++) {
    const ch = clause[i];
    if (ch === '"' && clause[i - 1] !== "\\") inQuotes = !inQuotes;
    if (!inQuotes) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) {
        parts.push(current);
        current = "";
        continue;
      }
    }
    current += ch;
  }
  if (current) parts.push(current);
  return parts;
}

interface Cond {
  column: string;
  op: string;
  value: string;
}

/** `columna.operador.valor`, con el valor opcionalmente entrecomillado (`pgrstLiteral`). */
function parseCondition(raw: string): Cond {
  const firstDot = raw.indexOf(".");
  const column = raw.slice(0, firstDot);
  const rest = raw.slice(firstDot + 1);
  const secondDot = rest.indexOf(".");
  const op = rest.slice(0, secondDot);
  let value = rest.slice(secondDot + 1);
  if (value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return { column, op, value };
}

function compareCell(cell: unknown, value: string): number {
  if (typeof cell === "number") {
    const num = Number(value);
    return cell < num ? -1 : cell > num ? 1 : 0;
  }
  const str = String(cell);
  return str < value ? -1 : str > value ? 1 : 0;
}

function evalCond(row: Row, cond: Cond): boolean {
  const cell = (row as Record<string, unknown>)[cond.column];
  switch (cond.op) {
    case "is":
      if (cond.value === "null") return cell == null;
      if (cond.value === "true") return cell === true;
      return cell === cond.value;
    case "eq":
      return cell != null && compareCell(cell, cond.value) === 0;
    case "lt":
      return cell != null && compareCell(cell, cond.value) < 0;
    case "lte":
      return cell != null && compareCell(cell, cond.value) <= 0;
    case "gt":
      return cell != null && compareCell(cell, cond.value) > 0;
    default:
      throw new Error(`operador "${cond.op}" no soportado por el fake de .or()`);
  }
}

/** Un término de nivel superior: una condición sola, o `and(...)` de varias. */
function evalTerm(row: Row, term: string): boolean {
  if (term.startsWith("and(") && term.endsWith(")")) {
    const inner = term.slice(4, -1);
    return splitTopLevel(inner).every((raw) => evalCond(row, parseCondition(raw)));
  }
  return evalCond(row, parseCondition(term));
}

function compareRows(a: Row, b: Row, sorts: SortSpec[]): number {
  for (const { column, ascending, nullsFirst } of sorts) {
    const av = (a as Record<string, unknown>)[column];
    const bv = (b as Record<string, unknown>)[column];
    const aNull = av == null;
    const bNull = bv == null;
    if (aNull && bNull) continue;
    if (aNull) return nullsFirst ? -1 : 1;
    if (bNull) return nullsFirst ? 1 : -1;
    if (av === bv) continue;
    const lt = (av as string) < (bv as string);
    if (ascending) return lt ? -1 : 1;
    return lt ? 1 : -1;
  }
  return 0;
}

function createFakeSupabase(rows: Row[]) {
  const calls: RangeCall[] = [];
  const filters: { op: string; column: string; value: unknown }[] = [];

  // Builder encadenable como el de PostgREST: los filtros y los `.order()`
  // se anotan, y el `.range()` final ordena de verdad y resuelve sobre las
  // filas que quedaron — reproduce el reordenamiento real que sufre la
  // bandeja cuando una fila sube al tope mientras se pagina.
  function builder(current: Row[], sorts: SortSpec[]) {
    return {
      order(column: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) {
        const ascending = opts?.ascending ?? true;
        const nullsFirst = opts?.nullsFirst ?? ascending;
        return builder(current, [...sorts, { column, ascending, nullsFirst }]);
      },
      neq(column: string, value: unknown) {
        filters.push({ op: "neq", column, value });
        return builder(
          current.filter((row) => (row as Record<string, unknown>)[column] !== value),
          sorts
        );
      },
      eq(column: string, value: unknown) {
        filters.push({ op: "eq", column, value });
        return builder(
          current.filter((row) => (row as Record<string, unknown>)[column] === value),
          sorts
        );
      },
      is(column: string, value: unknown) {
        filters.push({ op: "is", column, value });
        return builder(
          current.filter((row) => ((row as Record<string, unknown>)[column] ?? null) === value),
          sorts
        );
      },
      in(column: string, values: unknown[]) {
        filters.push({ op: "in", column, value: values });
        return builder(
          current.filter((row) => values.includes((row as Record<string, unknown>)[column])),
          sorts
        );
      },
      gt(column: string, value: unknown) {
        filters.push({ op: "gt", column, value });
        return builder(
          current.filter((row) => {
            const cell = (row as Record<string, unknown>)[column];
            return cell != null && cell > (value as string);
          }),
          sorts
        );
      },
      lte(column: string, value: unknown) {
        filters.push({ op: "lte", column, value });
        return builder(
          current.filter((row) => {
            const cell = (row as Record<string, unknown>)[column];
            return cell != null && cell <= (value as string);
          }),
          sorts
        );
      },
      // Fake mínimo de `.or()`: entiende las cláusulas que emite `orExpression`
      // (src/lib/ai/pgrst.ts) — condiciones sueltas `columna.operador.valor`
      // y `and(...)` anidado, valores opcionalmente entrecomillados con
      // `pgrstLiteral` — para lo que se prueba acá, no PostgREST en general.
      or(clause: string) {
        filters.push({ op: "or", column: "", value: clause });
        const terms = splitTopLevel(clause);
        return builder(
          current.filter((row) => terms.some((term) => evalTerm(row, term))),
          sorts
        );
      },
      range(from: number, to: number) {
        calls.push({ from, to });
        const sorted = [...current].sort((a, b) => compareRows(a, b, sorts));
        return Promise.resolve({ data: sorted.slice(from, to + 1), error: null });
      },
    };
  }

  const selects: string[] = [];

  const client = {
    from() {
      return {
        select(query: string) {
          selects.push(query);
          return builder(rows, []);
        },
      };
    },
  };

  return { client: client as unknown as SupabaseClient, calls, filters, selects };
}

describe("fetchConversations", () => {
  /**
   * Este es el fallo que no avisa: PostgREST corta la respuesta en su tope de
   * filas y devuelve `error: null`. La bandeja se ve normal, solo que sin las
   * conversaciones más viejas. `fetchMessages` ya se defendía de esto; la
   * lista de conversaciones no.
   */
  it("pagina hasta traerlas todas cuando hay más filas que el tope de una página", async () => {
    const total = CONVERSATIONS_PAGE_SIZE + 250;
    const { client, calls } = createFakeSupabase(
      Array.from({ length: total }, (_, i) => makeRow(i))
    );

    const result = await fetchConversations(client);

    expect(result).toHaveLength(total);
    expect(calls.length).toBeGreaterThan(1);
  });

  /**
   * La bandeja no necesita el histórico completo para pintar la lista: pide
   * las más recientes y con eso arma la pantalla. Traer de más cuesta una
   * consulta con siete joins por fila y un payload que viaja entero al
   * navegador en cada carga.
   */
  it("respeta el tope pedido y resuelve con una sola consulta", async () => {
    const { client, calls } = createFakeSupabase(
      Array.from({ length: 5000 }, (_, i) => makeRow(i))
    );

    const result = await fetchConversations(client, { limit: 200 });

    expect(result).toHaveLength(200);
    expect(calls).toEqual([{ from: 0, to: 199 }]);
  });

  /** Un tope mayor que lo que existe no debe inventar páginas vacías de más. */
  it("se detiene cuando la página vuelve incompleta", async () => {
    const { client, calls } = createFakeSupabase(
      Array.from({ length: 10 }, (_, i) => makeRow(i))
    );

    const result = await fetchConversations(client);

    expect(result).toHaveLength(10);
    expect(calls).toHaveLength(1);
  });

  /**
   * Bajar por la bandeja tiene que costar una página.
   *
   * El cursor (última fila de la página anterior) reemplazó al `offset` de
   * posición el 29/8/2026: pide "lo que sigue después de esta fila" en vez
   * de "la fila número N", así que un reordenamiento en el medio no le
   * afecta (ver el bloque "reordenamiento durante la paginación" más abajo).
   */
  it("con cursor pide solo la página siguiente, filtrando por el valor de la última fila recibida", async () => {
    const rows = Array.from({ length: 200 }, (_, i) => makeRow(i));
    const { client, calls, filters } = createFakeSupabase(rows);

    // La página anterior terminó en conv-170 (índice 170 de 0..199, la fila
    // número 30 en el orden descendente): ese es el cursor con el que se
    // pide la siguiente.
    const cursor = { lastMessageAt: rows[170].last_message_at, id: "conv-170" };

    const result = await fetchConversations(client, { cursor, limit: 30 });

    expect(filters).toContainEqual({
      op: "or",
      column: "",
      value:
        `last_message_at.lt."${cursor.lastMessageAt}",` +
        `and(last_message_at.eq."${cursor.lastMessageAt}",id.lt."conv-170"),` +
        `last_message_at.is.null`,
    });
    expect(calls).toEqual([{ from: 0, to: 29 }]);
    expect(result).toHaveLength(30);
    // Todo lo que sigue al cursor en el orden descendente: conv-169..conv-140.
    expect(result[0].id).toBe("conv-169");
    expect(result[29].id).toBe("conv-140");
  });

  /**
   * El tablero y el roster piden solo el trabajo vivo: su costo depende de la
   * carga del día, no de cuántos meses de histórico acumule el CRM.
   */
  it("con activeOnly deja lo cerrado en la base, no lo filtra el navegador", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => makeRow(i));
    rows[3] = { ...rows[3], status: "closed" as never };
    const { client, filters } = createFakeSupabase(rows);

    const result = await fetchConversations(client, { activeOnly: true });

    expect(filters).toContainEqual({ op: "neq", column: "status", value: "closed" });
    expect(result).toHaveLength(9);
  });

  /**
   * El tablero y Control de IA piden TODO el trabajo abierto de una vez para
   * contar por etapa y por asesor: cientos de filas, y cada campo se paga en
   * cada una. Medido: 320,9 KB por petición. Lo que no cuentan ni pintan no
   * puede viajar — sobre todo `contact_tags(tag:tags(...))`, que PostgREST
   * resuelve con un lateral por fila.
   */
  it("la fila del tablero no arrastra ni la vista previa ni las etiquetas", async () => {
    const { client, selects } = createFakeSupabase([makeRow(0)]);

    await fetchBoardConversations(client, { activeOnly: true });

    const select = selects[0];
    expect(select).not.toContain("contact_tags");
    expect(select).not.toContain("last_message_preview");
    expect(select).not.toContain("last_message_status");
    expect(select).not.toContain("avatar_url");
    // Pero sí lo que el recorrido necesita para ubicar la conversación.
    expect(select).toContain("journey_stage");
    expect(select).toContain("assigned_agent");
  });

  it("la fila de la bandeja sí las lleva: pinta una línea de chat", async () => {
    const { client, selects } = createFakeSupabase([makeRow(0)]);

    await fetchConversations(client, { limit: 30 });

    expect(selects[0]).toContain("contact_tags");
    expect(selects[0]).toContain("last_message_preview");
  });

  /**
   * `neverRepliedOnly` sigue existiendo en esta capa como herramienta
   * disponible, aunque ningún filtro de la bandeja la use hoy: la
   * segmentación real de la píldora "Pendientes" es por ventana de 24 h
   * (`pendingWindow`, ver los tests de abajo y `inbox-sections.ts`), no por
   * `has_reply` — ese campo es vitalicio y probarlo como corte de "sin
   * atender" vació la píldora en producción el 28/8/2026. Acá solo se
   * confirma que la opción sigue traduciéndose al filtro correcto en
   * PostgREST.
   */
  it("con neverRepliedOnly, pregunta a la base también por has_reply", async () => {
    const rows = Array.from({ length: 6 }, (_, i) => makeRow(i));
    rows[0] = { ...rows[0], awaiting_reply: true };
    rows[1] = { ...rows[1], awaiting_reply: true, assigned_agent_id: "ana" };
    rows[2] = { ...rows[2], awaiting_reply: true, status: "closed" as never };
    rows[3] = { ...rows[3], awaiting_reply: true, has_reply: true };
    const { client, filters } = createFakeSupabase(rows);

    const result = await fetchConversations(client, {
      activeOnly: true,
      unassignedOnly: true,
      awaitingReplyOnly: true,
      neverRepliedOnly: true,
    });

    expect(filters).toContainEqual({ op: "eq", column: "awaiting_reply", value: true });
    expect(filters).toContainEqual({ op: "eq", column: "has_reply", value: false });
    expect(filters).toContainEqual({ op: "is", column: "assigned_agent_id", value: null });
    expect(filters).toContainEqual({ op: "neq", column: "status", value: "closed" });
    expect(result.map((c) => c.id)).toEqual(["conv-0"]);
  });

  /**
   * `.in()` con lista vacía no es una consulta válida en PostgREST, y acá
   * además significa «nada que buscar»: se resuelve sin ir a la red.
   */
  it("con una lista vacía de ids o contactos responde vacío sin consultar", async () => {
    const { client, calls } = createFakeSupabase(
      Array.from({ length: 10 }, (_, i) => makeRow(i))
    );

    expect(await fetchConversations(client, { contactIds: [] })).toEqual([]);
    expect(await fetchConversations(client, { ids: [] })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  /**
   * "No leídas": el mismo predicado que `isUnread` (inbox-sections.ts) y que
   * el índice parcial de la migración 20260828030000, sin condición de
   * estado a propósito — una conversación cerrada con mensajes sin leer
   * sigue sin leer.
   */
  it("con unreadOnly emite el OR de unread_count/manually_unread y deja lo cerrado con algo sin leer", async () => {
    const rows = [
      { ...makeRow(0), unread_count: 3 }, // sin leer por contador
      { ...makeRow(1), unread_count: 0, manually_unread: true }, // sin leer a mano
      { ...makeRow(2), unread_count: 0, manually_unread: false }, // leído
      {
        ...makeRow(3),
        unread_count: 2,
        status: "closed" as never,
      }, // cerrada con mensajes sin leer: sigue contando
    ];
    const { client, filters } = createFakeSupabase(rows);

    const result = await fetchConversations(client, { unreadOnly: true });

    expect(filters).toContainEqual({
      op: "or",
      column: "",
      value: "unread_count.gt.0,manually_unread.is.true",
    });
    expect(result.map((c) => c.id).sort()).toEqual(["conv-0", "conv-1", "conv-3"]);
  });

  /**
   * "Mías": sin condición de estado, a propósito — es cola y archivo
   * personal a la vez (paridad con `InboxCounts.mine`).
   */
  it("con assignedTo emite eq(assigned_agent_id, id) y deja lo cerrado asignado a ese perfil", async () => {
    const rows = [
      { ...makeRow(0), assigned_agent_id: "ana" },
      { ...makeRow(1), assigned_agent_id: "beto" },
      { ...makeRow(2), assigned_agent_id: "ana", status: "closed" as never },
    ];
    const { client, filters } = createFakeSupabase(rows);

    const result = await fetchConversations(client, { assignedTo: "ana" });

    expect(filters).toContainEqual({ op: "eq", column: "assigned_agent_id", value: "ana" });
    expect(result.map((c) => c.id).sort()).toEqual(["conv-0", "conv-2"]);
  });

  describe("reordenamiento durante la paginación (bug de producción, 29/8/2026)", () => {
    /**
     * Reproduce el bug confirmado en producción: la píldora "Todos" pagina
     * con `offset`. Si una conversación fuera de las dos primeras páginas
     * recibe un mensaje y sube al tope mientras el asesor sigue bajando la
     * lista, todas las de abajo se corren una posición — la página
     * siguiente, pedida por `offset`, salta justo la fila que cruzó el borde
     * y esa fila no vuelve nunca (`mergeById` deduplica lo que llega, no
     * recupera lo que jamás se pidió). Producción reordenaba ~3 veces/minuto.
     *
     * ROJO confirmado antes de esta prueba (con `{ offset: 30, limit: 30 }`
     * en vez de `{ cursor, limit: 30 }` para la página 2, el camino que
     * usaba `crm-shell.tsx:184-187`):
     *
     *   AssertionError: expected [ 'conv-40' ] to deeply equal []
     *
     * `conv-40` es la fila en la posición 59 original: al subir `conv-29` al
     * tope, todo lo de encima de su posición vieja se corre una fila hacia
     * abajo, y `offset: 30` —que cuenta posiciones, no valores— deja de
     * llegar hasta ella.
     */
    it("con cursor, una fila que sube al tope no hace perder ninguna fila de la ventana ya recorrida", async () => {
      const total = 100;
      const initialRows = Array.from({ length: total }, (_, i) => makeRow(i));
      const { client } = createFakeSupabase(initialRows);

      // Página 1: las 30 más recientes (índices 99..70) — la carga inicial
      // de la bandeja.
      const page1 = await fetchConversations(client, { limit: 30 });

      // Las posiciones 0-59 originales, antes de que nada se mueva: índices
      // 99..40, 60 filas.
      const originalTop60Ids = Array.from({ length: 60 }, (_, i) => `conv-${99 - i}`);

      // Mientras el asesor sigue bajando, la fila de la posición ~70 (índice
      // 29, en la página 3) recibe un mensaje: sube al tope.
      const rowThatJumps = initialRows.find((r) => r.id === "conv-29")!;
      rowThatJumps.last_message_at = new Date(2030, 0, 1).toISOString();

      // Página 2 por cursor: la última fila que se vio, no una posición.
      const cursor = cursorAfterPage(page1)!;
      const page2 = await fetchConversations(client, { cursor, limit: 30 });

      const seen = new Set(page1.map((c) => c.id));
      const union = [...page1, ...page2.filter((c) => !seen.has(c.id))];
      const unionIds = new Set(union.map((c) => c.id));

      const faltantes = originalTop60Ids.filter((id) => !unionIds.has(id));
      expect(faltantes).toEqual([]);
    });

    /**
     * 3 empates reales de `last_message_at` conviven en 1.851 filas de
     * producción (29/8/2026): el cursor NECESITA desempatar por `id`, o dos
     * filas con la misma fecha en el borde de página pueden repetirse o
     * perderse entre una página y la siguiente.
     */
    it("con empates de last_message_at en el borde de página, el desempate por id no pierde ni repite filas", async () => {
      const rows = Array.from({ length: 40 }, (_, i) => makeRow(i));
      // Posiciones 29/30/31 (índices 10/9/8, ya que el orden descendente
      // hace pos = 39 - índice) comparten la misma fecha: cruzan justo el
      // borde de una página de 30.
      const fechaEmpate = rows[10].last_message_at;
      rows[9] = { ...rows[9], last_message_at: fechaEmpate };
      rows[8] = { ...rows[8], last_message_at: fechaEmpate };
      const { client } = createFakeSupabase(rows);

      const page1 = await fetchConversations(client, { limit: 30 });
      const cursor = cursorAfterPage(page1)!;
      const page2 = await fetchConversations(client, { cursor, limit: 30 });

      const page1Ids = page1.map((c) => c.id);
      const page2Ids = page2.map((c) => c.id);

      // Ninguna repetida entre página 1 y 2.
      expect(page1Ids.filter((id) => page2Ids.includes(id))).toEqual([]);
      // Ninguna perdida: las 40 filas están, entre las dos páginas.
      expect(new Set([...page1Ids, ...page2Ids]).size).toBe(40);
      expect(page1Ids).toHaveLength(30);
      expect(page2Ids).toHaveLength(10);
    });

    /**
     * Las filas sin `last_message_at` ordenan al final (`nulls last`). El
     * cursor tiene que poder cruzar de la zona con fecha a la zona nula:
     * sin el tercer término del predicado (`last_message_at.is.null`), esas
     * filas quedarían inalcanzables desde cualquier página con cursor
     * no-nulo.
     */
    it("el cursor cruza de la zona con fecha a la zona nula y trae todas las filas sin fecha", async () => {
      const conFecha = Array.from({ length: 20 }, (_, i) => makeRow(i));
      const sinFecha = Array.from({ length: 15 }, (_, i) => ({
        ...makeRow(1000 + i),
        id: `conv-null-${i}`,
        last_message_at: null,
      }));
      const rows = [...conFecha, ...sinFecha];
      const { client } = createFakeSupabase(rows);

      const page1 = await fetchConversations(client, { limit: 20 });
      // La página 1 agota la zona con fecha: sus 20 filas son exactamente
      // `conFecha`, en orden descendente.
      expect(page1.map((c) => c.id).sort()).toEqual(
        conFecha.map((r) => r.id).sort()
      );

      const cursor = cursorAfterPage(page1)!;
      const page2 = await fetchConversations(client, { cursor, limit: 20 });

      expect(page2.map((c) => c.id).sort()).toEqual(sinFecha.map((r) => r.id).sort());
      expect(page2.every((c) => c.lastMessageAt === null)).toBe(true);
    });
  });

  describe("pendingWindow", () => {
    const AHORA = Date.parse("2026-08-28T12:00:00.000Z");
    const CUTOFF = freeformWindowCutoff(AHORA);

    function conFecha(index: number, lastCustomerMessageAt: string | null) {
      return { ...makeRow(index), last_customer_message_at: lastCustomerMessageAt };
    }

    const DESPUES_DEL_CORTE = new Date(Date.parse(CUTOFF) + 1000).toISOString();
    const ANTES_DEL_CORTE = new Date(Date.parse(CUTOFF) - 1000).toISOString();

    /**
     * `"fresh"` es lo que sigue dentro de la ventana de 24 h: se le puede
     * escribir texto libre ahora mismo. El operador es `gt`, no `gte` —igual
     * que `withinFreeformWindow` (src/lib/dashboard.ts) y que
     * `fetchBacklogCounts` más abajo en este mismo archivo—, así que el
     * instante exacto del corte NO cuenta como "fresh".
     */
    it('con pendingWindow "fresh" emite gt(last_customer_message_at, cutoff) y deja solo lo que sigue dentro de la ventana', async () => {
      const rows = [
        conFecha(0, DESPUES_DEL_CORTE), // dentro de la ventana
        conFecha(1, CUTOFF), // exactamente el corte: no es "mayor que"
        conFecha(2, ANTES_DEL_CORTE), // fuera de la ventana
        conFecha(3, null), // sin fecha de cliente
      ];
      const { client, filters } = createFakeSupabase(rows);

      const result = await fetchConversations(client, { pendingWindow: "fresh", now: AHORA });

      expect(filters).toContainEqual({ op: "gt", column: "last_customer_message_at", value: CUTOFF });
      expect(result.map((c) => c.id)).toEqual(["conv-0"]);
    });

    /**
     * `"stale"` es el complemento exacto de `"fresh"`: todo lo que no siga
     * dentro de la ventana, incluido lo que no tiene fecha de cliente — falla
     * cerrado, mismo criterio que `withinFreeformWindow` y que la partición
     * de `buildInboxSections` (src/lib/inbox-sections.ts). Va por `.or()`
     * porque PostgREST no tiene un "not gt" directo con soporte de null.
     */
    it('con pendingWindow "stale" emite el corte invertido con .or() e incluye lo sin fecha de cliente', async () => {
      const rows = [
        conFecha(0, DESPUES_DEL_CORTE), // dentro de la ventana: queda fuera de "stale"
        conFecha(1, CUTOFF), // exactamente el corte: stale
        conFecha(2, ANTES_DEL_CORTE), // fuera de la ventana: stale
        conFecha(3, null), // sin fecha de cliente: stale (falla cerrado)
      ];
      const { client, filters } = createFakeSupabase(rows);

      const result = await fetchConversations(client, { pendingWindow: "stale", now: AHORA });

      expect(filters).toContainEqual({
        op: "or",
        column: "",
        value: `last_customer_message_at.lte.${CUTOFF},last_customer_message_at.is.null`,
      });
      expect(result.map((c) => c.id).sort()).toEqual(["conv-1", "conv-2", "conv-3"]);
    });

    /**
     * `pendingWindow` ya no tiene consumidor en la bandeja (la píldora
     * "Pendientes" salió en la reforma del 28/8/2026; queda disponible como
     * `neverRepliedOnly`), pero mientras exista tiene que poder combinarse
     * con `limit` como cualquier otro filtro.
     */
    it('pendingWindow "stale" respeta el limit explícito', async () => {
      const rows = Array.from({ length: 10 }, (_, i) => conFecha(i, ANTES_DEL_CORTE));
      const { client, calls } = createFakeSupabase(rows);

      const result = await fetchConversations(client, {
        pendingWindow: "stale",
        now: AHORA,
        limit: 3,
      });

      expect(result).toHaveLength(3);
      expect(calls).toEqual([{ from: 0, to: 2 }]);
    });
  });
});
