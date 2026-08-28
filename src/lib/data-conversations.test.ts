import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CONVERSATIONS_PAGE_SIZE, fetchBoardConversations, fetchConversations } from "@/lib/data";
import { freeformWindowCutoff } from "@/lib/dashboard";

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
    last_message_at: new Date(2024, 0, 1, 0, 0, index).toISOString(),
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

function createFakeSupabase(rows: ReturnType<typeof makeRow>[]) {
  const calls: RangeCall[] = [];
  const filters: { op: string; column: string; value: unknown }[] = [];

  // Builder encadenable como el de PostgREST: los filtros se anotan y el
  // range final resuelve sobre las filas que quedaron.
  function builder(current: ReturnType<typeof makeRow>[]) {
    return {
      neq(column: string, value: unknown) {
        filters.push({ op: "neq", column, value });
        return builder(current.filter((row) => (row as Record<string, unknown>)[column] !== value));
      },
      eq(column: string, value: unknown) {
        filters.push({ op: "eq", column, value });
        return builder(current.filter((row) => (row as Record<string, unknown>)[column] === value));
      },
      is(column: string, value: unknown) {
        filters.push({ op: "is", column, value });
        return builder(
          current.filter((row) => ((row as Record<string, unknown>)[column] ?? null) === value)
        );
      },
      in(column: string, values: unknown[]) {
        filters.push({ op: "in", column, value: values });
        return builder(
          current.filter((row) => values.includes((row as Record<string, unknown>)[column]))
        );
      },
      gt(column: string, value: unknown) {
        filters.push({ op: "gt", column, value });
        return builder(
          current.filter((row) => {
            const cell = (row as Record<string, unknown>)[column];
            return cell != null && cell > (value as string);
          })
        );
      },
      lte(column: string, value: unknown) {
        filters.push({ op: "lte", column, value });
        return builder(
          current.filter((row) => {
            const cell = (row as Record<string, unknown>)[column];
            return cell != null && cell <= (value as string);
          })
        );
      },
      // Fake mínimo de `.or()`: entiende las cláusulas que emite data.ts para
      // `pendingWindow: "stale"` (`columna.lte.valor` y `columna.is.null`) y
      // para `unreadOnly` (`columna.gt.valor` y `columna.is.true`), separadas
      // por coma. Alcanza para lo que se prueba acá, no para PostgREST en
      // general.
      or(clause: string) {
        filters.push({ op: "or", column: "", value: clause });
        const conditions = clause.split(",").map((raw) => {
          const [column, op, ...rest] = raw.split(".");
          return { column, op, value: rest.join(".") };
        });
        return builder(
          current.filter((row) =>
            conditions.some(({ column, op, value }) => {
              const cell = (row as Record<string, unknown>)[column];
              if (op === "is") {
                if (value === "null") return cell == null;
                if (value === "true") return cell === true;
                return cell === value;
              }
              if (op === "lte") return cell != null && cell <= value;
              if (op === "gt") return cell != null && (cell as number) > Number(value);
              throw new Error(`operador "${op}" no soportado por el fake de .or()`);
            })
          )
        );
      },
      range(from: number, to: number) {
        calls.push({ from, to });
        return Promise.resolve({ data: current.slice(from, to + 1), error: null });
      },
    };
  }

  const selects: string[] = [];

  const client = {
    from() {
      return {
        select(query: string) {
          selects.push(query);
          return {
            order() {
              return builder(rows);
            },
          };
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
   * Sin `offset`, «traer 30 más» se pedía como `limit` creciente desde la
   * fila 0: la sexta bajada volvía a bajar 180 filas —135 KB, 1,2 s medidos
   * en producción— para mostrar 30 nuevas.
   */
  it("con offset pide solo la página siguiente", async () => {
    const { client, calls } = createFakeSupabase(
      Array.from({ length: 200 }, (_, i) => makeRow(i))
    );

    const result = await fetchConversations(client, { offset: 30, limit: 30 });

    expect(calls).toEqual([{ from: 30, to: 59 }]);
    expect(result).toHaveLength(30);
    expect(result[0].id).toBe("conv-30");
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
     * La sección "Esperando +24 h" pide `PENDING_STALE_LIMIT` filas
     * (inbox-sections.ts): `pendingWindow` tiene que poder combinarse con
     * `limit` como cualquier otro filtro.
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
