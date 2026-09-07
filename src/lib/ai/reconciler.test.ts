import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// El reconciliador se prueba con dobles propios, no contra Redis/Postgres de
// verdad: lo que importa acá es la LÓGICA de qué se reencola y qué no, no la
// atomicidad de Redis (eso ya lo cubren redis-queue.test.ts y queue.test.ts
// contra un Redis real). `enqueueAgentTurns` SÍ es la implementación real
// (se importa de @/lib/ai/queue sin mockear): así el test verifica que el
// reconciliador de verdad reencola en la cola, con el mismo camino que usa
// el resto del sistema, y no solo que "llamó a la función correcta".
// ---------------------------------------------------------------------------

/**
 * Redis en memoria, solo lo que hace falta acá: `zmscore` (que usa el
 * reconciliador para preguntar "¿ya está en cola?"), `zadd` (que usa
 * `AgentQueue.enqueue`, dentro de `enqueueAgentTurns` real, vía
 * `redis-queue.ts` real) y `zcard` (que usa `pendingAgentTurns` para que
 * los tests puedan comprobar qué quedó encolado de verdad).
 */
class FakeRedis {
  private zsets = new Map<string, Map<string, number>>();

  private set(key: string): Map<string, number> {
    let z = this.zsets.get(key);
    if (!z) {
      z = new Map();
      this.zsets.set(key, z);
    }
    return z;
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    const existia = this.set(key).has(member);
    this.set(key).set(member, score);
    return existia ? 0 : 1;
  }

  async zmscore(key: string, ...members: string[]): Promise<(string | null)[]> {
    const z = this.set(key);
    return members.map((m) => (z.has(m) ? String(z.get(m)) : null));
  }

  async zcard(key: string): Promise<number> {
    return this.set(key).size;
  }

  /** Solo para las aserciones de los tests: score crudo o null si no está. */
  scoreOf(key: string, member: string): number | null {
    return this.set(key).get(member) ?? null;
  }

  /** Solo para los tests: vacía todo entre casos, sin exponer el Map privado. */
  reset(): void {
    this.zsets = new Map();
  }
}

const redis = new FakeRedis();
vi.mock("@/lib/redis", () => ({ getRedis: () => redis }));

import { reconcileOrphanTurns, RECONCILE_BATCH_LIMIT, RECONCILE_QUEUE_KEY } from "@/lib/ai/reconciler";
import { pendingAgentTurns } from "@/lib/ai/queue";

interface FakeRow {
  id: string;
  awaiting_reply: boolean;
  assigned_agent_id: string | null;
  status: string;
  ai_enabled: boolean;
  last_customer_message_at: string | null;
  last_message_at: string | null;
  ai_turn_lock_until: string | null;
}

function baseRow(id: string, overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id,
    awaiting_reply: true,
    assigned_agent_id: null,
    status: "open",
    ai_enabled: true,
    last_customer_message_at: new Date().toISOString(),
    last_message_at: new Date().toISOString(),
    ai_turn_lock_until: null,
    ...overrides,
  };
}

/**
 * Doble de Supabase que sí EVALÚA los filtros contra las filas, a diferencia
 * del patrón de "grabar qué filtros se pidieron" que usa data-backlog.test.ts:
 * acá interesa el comportamiento (qué queda adentro), no solo la forma de la
 * consulta, porque un mismo dataset tiene que cubrir varios escenarios
 * (lock vigente, fuera de ventana, etc.) en un solo lugar.
 */
/**
 * Un mensaje, con lo justo para el filtro de "ya escribió una persona".
 *
 * `created_at` (T7, 8/9/2026): la guarda dejó de preguntar "¿alguna vez
 * escribió un asesor?" y pasó a comparar fechas contra
 * `last_customer_message_at` y una ventana de gracia — ver human-handled.ts.
 */
interface FakeMensaje {
  conversation_id: string;
  sender_type: string;
  created_at: string;
}

function createFakeSupabase(rows: FakeRow[], mensajes: FakeMensaje[] = []) {
  const handoffCalls: Record<string, unknown>[] = [];

  function builder() {
    const predicates: ((r: FakeRow) => boolean)[] = [];
    let orderCol: keyof FakeRow | null = null;
    let orderAscending = true;
    let limit: number | null = null;

    const api = {
      eq(col: keyof FakeRow, val: unknown) {
        predicates.push((r) => r[col] === val);
        return api;
      },
      is(col: keyof FakeRow, val: unknown) {
        predicates.push((r) => r[col] === val);
        return api;
      },
      neq(col: keyof FakeRow, val: unknown) {
        predicates.push((r) => r[col] !== val);
        return api;
      },
      gt(col: keyof FakeRow, val: string) {
        predicates.push((r) => typeof r[col] === "string" && (r[col] as string) > val);
        return api;
      },
      order(col: keyof FakeRow, opciones: { ascending: boolean }) {
        orderCol = col;
        orderAscending = opciones.ascending;
        return api;
      },
      limit(n: number) {
        limit = n;
        return api;
      },
      then(resolve: (v: { data: FakeRow[]; error: null }) => unknown) {
        let resultado = rows.filter((r) => predicates.every((p) => p(r)));
        if (orderCol) {
          const col = orderCol;
          resultado = [...resultado].sort((a, b) => {
            const av = a[col];
            const bv = b[col];
            if (av == null && bv == null) return 0;
            if (av == null) return 1; // nullsFirst: false
            if (bv == null) return -1;
            if (av === bv) return 0;
            const mayor = av > bv ? 1 : -1;
            return orderAscending ? mayor : -mayor;
          });
        }
        if (limit != null) resultado = resultado.slice(0, limit);
        return resolve({ data: resultado, error: null });
      },
    };
    return api;
  }

  function mensajesBuilder() {
    const predicados: ((m: FakeMensaje) => boolean)[] = [];
    const api = {
      eq(col: keyof FakeMensaje, val: unknown) {
        predicados.push((m) => m[col] === val);
        return api;
      },
      in(col: keyof FakeMensaje, vals: unknown[]) {
        predicados.push((m) => vals.includes(m[col]));
        return api;
      },
      // T7 (8/9/2026): conversationsWrittenByHumans acota el lote con
      // `.gt("created_at", umbral)` antes de decidir en memoria.
      gt(col: keyof FakeMensaje, val: string) {
        predicados.push((m) => m[col] > val);
        return api;
      },
      then(resolve: (v: { data: FakeMensaje[]; error: null }) => unknown) {
        return resolve({ data: mensajes.filter((m) => predicados.every((p) => p(m))), error: null });
      },
    };
    return api;
  }

  return {
    handoffCalls,
    client: {
      from(tabla: string) {
        if (tabla === "conversations") return { select: () => builder() };
        // `conversationsWrittenByHumans` (human-handled.ts) pregunta acá si
        // algún asesor escribió en el chat. Sin este caso el fake lanzaba, el
        // filtro fallaba cerrado y el reconciliador no encolaba nada.
        if (tabla === "messages") return { select: () => mensajesBuilder() };
        throw new Error(`Fake Supabase: tabla no soportada: ${tabla}`);
      },
      rpc(fn: string, params?: Record<string, unknown>) {
        if (fn !== "record_handoff") throw new Error(`Fake Supabase: rpc no soportada: ${fn}`);
        handoffCalls.push(params ?? {});
        return Promise.resolve({ data: "handoff-1", error: null });
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

const AHORA = Date.parse("2026-08-30T15:00:00.000Z");
const DENTRO_DE_VENTANA = "2026-08-30T10:00:00.000Z"; // hace 5h
const FUERA_DE_VENTANA = "2026-08-29T10:00:00.000Z"; // hace 29h

beforeEach(() => {
  redis.reset();
});

describe("reconcileOrphanTurns — el predicado y la ventana", () => {
  it("con la cola vacía y 3 conversaciones que cumplen el predicado, encola las 3 y registra 3 traspasos 'reabierto'", async () => {
    const rows = [baseRow("conv-1"), baseRow("conv-2"), baseRow("conv-3")];
    const { client, handoffCalls } = createFakeSupabase(rows);

    const resultado = await reconcileOrphanTurns(client, AHORA);

    expect(resultado).toEqual({ revisadas: 3, yaEnCola: 0, bloqueadasPorLock: 0, atendidasPorHumanos: 0, encoladas: 3 });
    expect(await pendingAgentTurns()).toBe(3);
    expect(handoffCalls).toHaveLength(3);
    for (const call of handoffCalls) {
      expect(call).toMatchObject({ p_to_kind: "ai", p_reason: "reabierto", p_created_by: "system" });
    }
    expect(handoffCalls.map((c) => c.p_conversation_id).sort()).toEqual(["conv-1", "conv-2", "conv-3"]);
  });

  it("una conversación fuera de la ventana de 24h no se encola", async () => {
    const rows = [
      baseRow("conv-dentro", { last_customer_message_at: DENTRO_DE_VENTANA }),
      baseRow("conv-fuera", { last_customer_message_at: FUERA_DE_VENTANA }),
    ];
    const { client, handoffCalls } = createFakeSupabase(rows);

    const resultado = await reconcileOrphanTurns(client, AHORA);

    expect(resultado.encoladas).toBe(1);
    expect(resultado.revisadas).toBe(1);
    expect(await pendingAgentTurns()).toBe(1);
    expect(handoffCalls.map((c) => c.p_conversation_id)).toEqual(["conv-dentro"]);
  });

  it("una conversación asignada, cerrada, con la IA apagada o sin last_customer_message_at no entra", async () => {
    const rows = [
      baseRow("conv-asignada", { assigned_agent_id: "asesor-1" }),
      baseRow("conv-cerrada", { status: "closed" }),
      baseRow("conv-ia-apagada", { ai_enabled: false }),
      baseRow("conv-sin-fecha", { last_customer_message_at: null }),
      baseRow("conv-buena"),
    ];
    const { client } = createFakeSupabase(rows);

    const resultado = await reconcileOrphanTurns(client, AHORA);

    expect(resultado).toEqual({ revisadas: 1, yaEnCola: 0, bloqueadasPorLock: 0, atendidasPorHumanos: 0, encoladas: 1 });
  });
});

describe("reconcileOrphanTurns — no duplicar lo que ya está en curso", () => {
  it("una conversación que YA está en la cola de Redis no se encola de nuevo", async () => {
    await redis.zadd(RECONCILE_QUEUE_KEY, AHORA + 5_000, "conv-ya-en-cola");
    const rows = [baseRow("conv-ya-en-cola"), baseRow("conv-nueva")];
    const { client, handoffCalls } = createFakeSupabase(rows);

    const resultado = await reconcileOrphanTurns(client, AHORA);

    expect(resultado).toEqual({ revisadas: 2, yaEnCola: 1, bloqueadasPorLock: 0, atendidasPorHumanos: 0, encoladas: 1 });
    // El score original no se tocó: el reconciliador no volvió a escribirla.
    expect(redis.scoreOf(RECONCILE_QUEUE_KEY, "conv-ya-en-cola")).toBe(AHORA + 5_000);
    expect(handoffCalls.map((c) => c.p_conversation_id)).toEqual(["conv-nueva"]);
  });

  /**
   * El bucle que este filtro corta, y por qué no basta con `assigned_agent_id
   * is null`: el asesor que contesta sin asignarse el chat lo deja libre a
   * los ojos de la consulta. El turno igual lo descarta —`humanHasWritten` es
   * su propia guarda, el cliente nunca recibe nada indebido—, pero la
   * conversación sigue con `awaiting_reply` y cinco minutos después el cron
   * la vuelve a encolar. Sin este filtro eso se repite para siempre, gastando
   * un cupo y escribiendo una fila de bitácora en cada vuelta.
   */
  it("una conversación donde un asesor ya escribió no se encola, aunque no esté asignada", async () => {
    const rows = [
      baseRow("conv-la-atiende-alguien", { last_customer_message_at: DENTRO_DE_VENTANA }),
      baseRow("conv-sola", { last_customer_message_at: DENTRO_DE_VENTANA }),
    ];
    const mensajes = [
      // El asesor escribió hace 5 min (dentro de la gracia de 30 min por
      // default): está conversando AHORA, no es una nota vieja. Ver el
      // describe de más abajo para el caso contrario (humano viejo).
      {
        conversation_id: "conv-la-atiende-alguien",
        sender_type: "agent",
        created_at: new Date(AHORA - 5 * 60_000).toISOString(),
      },
      // Un mensaje del cliente en la otra conversación no la descalifica: lo
      // que importa es si escribió una PERSONA del equipo.
      { conversation_id: "conv-sola", sender_type: "customer", created_at: DENTRO_DE_VENTANA },
    ];
    const { client, handoffCalls } = createFakeSupabase(rows, mensajes);

    const resultado = await reconcileOrphanTurns(client, AHORA);

    expect(resultado).toEqual({
      revisadas: 2,
      yaEnCola: 0,
      bloqueadasPorLock: 0,
      atendidasPorHumanos: 1,
      encoladas: 1,
    });
    expect(handoffCalls.map((c) => c.p_conversation_id)).toEqual(["conv-sola"]);
    expect(await pendingAgentTurns()).toBe(1);
  });

  it("una conversación con lock de turno vigente no se toca", async () => {
    const rows = [
      baseRow("conv-con-lock", { ai_turn_lock_until: new Date(AHORA + 60_000).toISOString() }),
      baseRow("conv-lock-vencido", { ai_turn_lock_until: new Date(AHORA - 60_000).toISOString() }),
      baseRow("conv-sin-lock"),
    ];
    const { client, handoffCalls } = createFakeSupabase(rows);

    const resultado = await reconcileOrphanTurns(client, AHORA);

    expect(resultado).toEqual({ revisadas: 3, yaEnCola: 0, bloqueadasPorLock: 1, atendidasPorHumanos: 0, encoladas: 2 });
    expect(handoffCalls.map((c) => c.p_conversation_id).sort()).toEqual(["conv-lock-vencido", "conv-sin-lock"]);
    expect(redis.scoreOf(RECONCILE_QUEUE_KEY, "conv-con-lock")).toBeNull();
  });
});

/**
 * T7 (8/9/2026): "ya escribió un asesor" dejó de ser vitalicio. Hasta esta
 * corrida, un mensaje de asesor de hace semanas dejaba la conversación fuera
 * del reconciliador para siempre, aunque el cliente hubiera vuelto a escribir
 * hoy y nadie del equipo estuviera mirando el chat — el caso real
 * `3b654d2c-3cf8-4eef-8638-bc75e45cb10a` (un "a" del 28/8, cliente nuevo el
 * 7/9). Ahora `conversationsWrittenByHumans` compara fechas: bloquea solo si
 * el asesor se adelantó al último mensaje del cliente o si escribió hace
 * menos de `AI_HUMAN_GRACE_MINUTES` (G=30 por default). Ver human-handled.ts.
 */
describe("reconcileOrphanTurns — la guarda de humanos ya no es vitalicia (T7)", () => {
  it("una conversación con humano viejo y cliente nuevo ahora SÍ se reencola", async () => {
    const rows = [
      baseRow("conv-humano-viejo", { last_customer_message_at: DENTRO_DE_VENTANA }),
    ];
    const mensajes = [
      // El "a" del 28/8, muy anterior a DENTRO_DE_VENTANA y a años luz de
      // los 30 minutos de gracia por default.
      { conversation_id: "conv-humano-viejo", sender_type: "agent", created_at: "2026-08-28T00:00:00.000Z" },
    ];
    const { client, handoffCalls } = createFakeSupabase(rows, mensajes);

    const resultado = await reconcileOrphanTurns(client, AHORA);

    expect(resultado).toEqual({ revisadas: 1, yaEnCola: 0, bloqueadasPorLock: 0, atendidasPorHumanos: 0, encoladas: 1 });
    expect(handoffCalls.map((c) => c.p_conversation_id)).toEqual(["conv-humano-viejo"]);
    expect(await pendingAgentTurns()).toBe(1);
  });

  it("con humano hace menos de G sigue fuera (atendidasPorHumanos)", async () => {
    const rows = [
      // Cliente MUY reciente (hace 2 min): el humano de abajo escribió ANTES
      // que él, así que la cláusula de "se adelantó" no aplica acá — la que
      // bloquea es la de gracia.
      baseRow("conv-humano-reciente", { last_customer_message_at: new Date(AHORA - 2 * 60_000).toISOString() }),
    ];
    const mensajes = [
      // El asesor escribió hace 5 min, ANTES que el cliente, pero dentro de
      // la gracia de 30 min por default: está conversando AHORA.
      {
        conversation_id: "conv-humano-reciente",
        sender_type: "agent",
        created_at: new Date(AHORA - 5 * 60_000).toISOString(),
      },
    ];
    const { client, handoffCalls } = createFakeSupabase(rows, mensajes);

    const resultado = await reconcileOrphanTurns(client, AHORA);

    expect(resultado).toEqual({ revisadas: 1, yaEnCola: 0, bloqueadasPorLock: 0, atendidasPorHumanos: 1, encoladas: 0 });
    expect(handoffCalls).toHaveLength(0);
    expect(await pendingAgentTurns()).toBe(0);
  });
});

describe("reconcileOrphanTurns — el tope de la pasada", () => {
  it("con 60 candidatas, respeta el tope de 50 por pasada", async () => {
    const rows = Array.from({ length: 60 }, (_, i) =>
      baseRow(`conv-${String(i).padStart(2, "0")}`, {
        // Se separan en el tiempo para que el orden "más reciente primero"
        // sea determinístico: conv-00 es la más vieja, conv-59 la más nueva.
        last_message_at: new Date(AHORA - (60 - i) * 1000).toISOString(),
      })
    );
    const { client, handoffCalls } = createFakeSupabase(rows);

    const resultado = await reconcileOrphanTurns(client, AHORA);

    expect(resultado.revisadas).toBe(RECONCILE_BATCH_LIMIT);
    expect(resultado.encoladas).toBe(RECONCILE_BATCH_LIMIT);
    expect(await pendingAgentTurns()).toBe(RECONCILE_BATCH_LIMIT);
    expect(handoffCalls).toHaveLength(RECONCILE_BATCH_LIMIT);
    // Se quedó con las 50 más recientes (conv-10 .. conv-59), no las 50 primeras.
    expect(handoffCalls.map((c) => c.p_conversation_id)).not.toContain("conv-00");
    expect(handoffCalls.map((c) => c.p_conversation_id)).toContain("conv-59");
  });
});

describe("reconcileOrphanTurns — el predicado no mira conversation_handoffs (T0.3)", () => {
  /**
   * T0.3 amplió el CHECK de `conversation_handoffs.reason` con `escalada`,
   * `escalada_sin_asesor` y `rechazado_por_meta`. El fake de este archivo ni
   * siquiera modela esa tabla para lectura (`createFakeSupabase` solo la
   * usa como destino de `record_handoff`, nunca como fuente de un `select`):
   * si el reconciliador alguna vez empezara a filtrar por `reason` o
   * `to_kind`, este test seguiría en verde por accidente y el fake tendría
   * que fallar en cambio. Lo que sí prueba de verdad es que una conversación
   * en el mismo estado de siempre (awaiting_reply, sin asesor, IA
   * encendida) se rescata igual sin que importe CUÁL fue el traspaso que la
   * dejó huérfana — el reconciliador nunca pregunta eso.
   */
  it("una huérfana por 'rechazado_por_meta' se rescata igual que cualquier otra: el motivo anterior no entra en el predicado", async () => {
    const rows = [baseRow("conv-rechazada-por-meta")];
    const { client, handoffCalls } = createFakeSupabase(rows);

    const resultado = await reconcileOrphanTurns(client, AHORA);

    expect(resultado.encoladas).toBe(1);
    expect(await pendingAgentTurns()).toBe(1);
    expect(handoffCalls).toHaveLength(1);
    expect(handoffCalls[0]).toMatchObject({
      p_conversation_id: "conv-rechazada-por-meta",
      p_to_kind: "ai",
      p_reason: "reabierto",
    });
  });
});

describe("reconcileOrphanTurns — sin candidatas", () => {
  it("sin nada que cumpla el predicado, no toca la cola ni escribe traspasos", async () => {
    const { client, handoffCalls } = createFakeSupabase([]);

    const resultado = await reconcileOrphanTurns(client, AHORA);

    expect(resultado).toEqual({ revisadas: 0, yaEnCola: 0, bloqueadasPorLock: 0, atendidasPorHumanos: 0, encoladas: 0 });
    expect(await pendingAgentTurns()).toBe(0);
    expect(handoffCalls).toHaveLength(0);
  });
});
