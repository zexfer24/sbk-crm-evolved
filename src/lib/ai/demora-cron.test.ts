import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// T10b-4, Entrega B del plan "Seba encuentra y el mostrador no deja esperando"
// (29/9/2026, 3.4 "Nadie sin atender"): la pasada del cron de demora, con una
// base falsa EN MEMORIA que aplica de verdad los filtros que el código le pide
// (eq/is/gt/lte/in/not-in/order/limit) y hace atómicos los `update … where …
// returning` — un fake que se tragara el filtro `responded_at is null` o el
// `reassignments = <leído>` no probaría los candados de idempotencia.
//
// `claimNextAvailableAgent` y `recordHandoff` son los REALES contra ese fake
// (así "nunca el mismo asesor" y el rastro en `conversation_handoffs` se
// prueban de punta a punta); `runDelayTurn` (T10b-3) se mockea con el contrato
// del plan. Todas las fechas son fijas (lunes 28/9/2026, Caracas = UTC-4): NUNCA
// el reloj real — un test de demora que dependa de la hora en que corre la suite
// se pone rojo fuera de horario laboral (lección de `playbooks.test.ts`).
// ---------------------------------------------------------------------------

const { runDelayTurnMock } = vi.hoisted(() => ({
  runDelayTurnMock: vi.fn<(...args: unknown[]) => Promise<{ enviado: boolean; motivo: string }>>(async () => ({
    enviado: true,
    motivo: "enviado",
  })),
}));

vi.mock("@/lib/ai/delay-turn", () => ({ runDelayTurn: runDelayTurnMock }));

import { log } from "@/lib/log";
import { procesarDemoras } from "@/lib/ai/demora-cron";

type Row = Record<string, unknown>;

const en = (dia: number, hora: number, minuto = 0, segundo = 0): Date =>
  new Date(Date.UTC(2026, 8, dia, hora + 4, minuto, segundo));
const lun = (hora: number, minuto = 0, segundo = 0): Date => en(28, hora, minuto, segundo);
const iso = (d: Date): string => d.toISOString();

const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-cccc-cccc-cccccccccccc";

// ---------------------------------------------------------------------------
// Base falsa
// ---------------------------------------------------------------------------

class FakeDb {
  tables: Record<string, Row[]> = {
    agent_settings: [],
    conversations: [],
    conversation_handoffs: [],
    conversation_delay_episodes: [],
    messages: [],
    agents: [],
  };
  /** Reloj con el que la "base" sella `created_at` de lo que se inserta. */
  clock: Date = lun(10, 0);
  /** Cada `update` a una tabla, con su payload (para "ai_enabled no se toca"). */
  updates: { table: string; payload: Row }[] = [];
  /** Cuántas consultas de lectura se hicieron a cada tabla. */
  reads: Record<string, number> = {};
  private seq = 0;

  nextId(): string {
    return `fake-${++this.seq}`;
  }

  client() {
    return {
      from: (table: string) => new Query(this, table),
      rpc: async (fn: string, params: Row) => {
        if (fn !== "record_handoff") throw new Error(`Fake: rpc no soportada: ${fn}`);
        this.tables.conversation_handoffs.push({
          id: this.nextId(),
          conversation_id: params.p_conversation_id,
          to_kind: params.p_to_kind,
          reason: params.p_reason,
          from_kind: params.p_from_kind ?? null,
          from_id: params.p_from_id ?? null,
          to_id: params.p_to_id ?? null,
          created_by: params.p_created_by,
          created_at: iso(this.clock),
        });
        return { data: "handoff", error: null };
      },
    } as never;
  }

  handoffs(reason?: string): Row[] {
    return this.tables.conversation_handoffs.filter((h) => !reason || h.reason === reason);
  }
  conv(id: string): Row {
    return this.tables.conversations.find((c) => c.id === id) as Row;
  }
  episodios(convId?: string): Row[] {
    return this.tables.conversation_delay_episodes.filter((e) => !convId || e.conversation_id === convId);
  }
}

class Query implements PromiseLike<{ data: unknown; error: unknown }> {
  private op: "select" | "insert" | "upsert" | "update" = "select";
  private filters: ((r: Row) => boolean)[] = [];
  private orderBy: { col: string; ascending: boolean; nullsFirst: boolean } | null = null;
  private lim: number | null = null;
  private payload: Row = {};
  private upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {};
  private returning = false;
  private single: "maybe" | null = null;

  constructor(
    private db: FakeDb,
    private table: string
  ) {}

  select() {
    this.returning = true;
    return this;
  }
  insert(p: Row) {
    this.op = "insert";
    this.payload = p;
    return this;
  }
  upsert(p: Row, o: { onConflict?: string; ignoreDuplicates?: boolean } = {}) {
    this.op = "upsert";
    this.payload = p;
    this.upsertOpts = o;
    return this;
  }
  update(p: Row) {
    this.op = "update";
    this.payload = p;
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push((r) => r[col] === val);
    return this;
  }
  neq(col: string, val: unknown) {
    this.filters.push((r) => r[col] != null && r[col] !== val);
    return this;
  }
  is(col: string, val: null | boolean) {
    this.filters.push((r) => (r[col] ?? null) === val);
    return this;
  }
  gt(col: string, val: string) {
    this.filters.push((r) => r[col] != null && (r[col] as string) > val);
    return this;
  }
  gte(col: string, val: string) {
    this.filters.push((r) => r[col] != null && (r[col] as string) >= val);
    return this;
  }
  lt(col: string, val: string) {
    this.filters.push((r) => r[col] != null && (r[col] as string) < val);
    return this;
  }
  lte(col: string, val: string) {
    this.filters.push((r) => r[col] != null && (r[col] as string) <= val);
    return this;
  }
  in(col: string, vals: unknown[]) {
    this.filters.push((r) => vals.includes(r[col]));
    return this;
  }
  not(col: string, op: string, val: string) {
    if (op !== "in") throw new Error(`Fake: operador .not no soportado: ${op}`);
    const excluidos = val.slice(1, -1).split(",");
    this.filters.push((r) => !excluidos.includes(String(r[col])));
    return this;
  }
  order(col: string, o: { ascending?: boolean; nullsFirst?: boolean } = {}) {
    const ascending = o.ascending ?? true;
    this.orderBy = { col, ascending, nullsFirst: o.nullsFirst ?? !ascending };
    return this;
  }
  limit(n: number) {
    this.lim = n;
    return this;
  }
  maybeSingle() {
    this.single = "maybe";
    return this;
  }

  then<T1, T2>(
    onfulfilled?: ((v: { data: unknown; error: unknown }) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((e: unknown) => T2 | PromiseLike<T2>) | null
  ) {
    return this.exec().then(onfulfilled, onrejected);
  }

  private async exec(): Promise<{ data: unknown; error: unknown }> {
    // Un salto de microtarea antes de tocar la "base": dos pasadas lanzadas con
    // Promise.all avanzan en fila y ambas LEEN antes de que ninguna ESCRIBA —
    // sin esto el fake serializaría las pasadas y ningún candado se ejercitaría.
    await Promise.resolve();
    const rows = this.db.tables[this.table];
    if (!rows) throw new Error(`Fake: tabla no soportada: ${this.table}`);
    const clonar = (r: Row): Row => structuredClone(r);

    if (this.op === "insert") {
      const fila = { id: this.db.nextId(), created_at: iso(this.db.clock), ...this.payload };
      rows.push(fila);
      return { data: this.returning ? [clonar(fila)] : null, error: null };
    }

    if (this.op === "upsert") {
      const cols = (this.upsertOpts.onConflict ?? "id").split(",").map((c) => c.trim());
      const existe = rows.some((r) => cols.every((c) => r[c] === this.payload[c]));
      if (existe) return { data: this.returning ? [] : null, error: null };
      const defaults: Row =
        this.table === "conversation_delay_episodes"
          ? {
              responded_at: null,
              reassignments: 0,
              agentes_previos: [],
              ultima_reasignacion_at: null,
              supervisor_notified_at: null,
              created_at: iso(this.db.clock),
            }
          : {};
      const fila = { ...defaults, ...this.payload };
      rows.push(fila);
      return { data: this.returning ? [clonar(fila)] : null, error: null };
    }

    const coinciden = rows.filter((r) => this.filters.every((f) => f(r)));

    if (this.op === "update") {
      this.db.updates.push({ table: this.table, payload: this.payload });
      for (const r of coinciden) Object.assign(r, this.payload);
      return { data: this.returning ? coinciden.map(clonar) : null, error: null };
    }

    this.db.reads[this.table] = (this.db.reads[this.table] ?? 0) + 1;
    let salida = coinciden.map(clonar);
    if (this.orderBy) {
      const { col, ascending, nullsFirst } = this.orderBy;
      salida.sort((x, y) => {
        const a = x[col] as string | number | null;
        const b = y[col] as string | number | null;
        if (a === b) return 0;
        if (a === null) return nullsFirst ? -1 : 1;
        if (b === null) return nullsFirst ? 1 : -1;
        return (a > b ? 1 : -1) * (ascending ? 1 : -1);
      });
    }
    if (this.lim !== null) salida = salida.slice(0, this.lim);
    if (this.single === "maybe") return { data: salida[0] ?? null, error: null };
    return { data: salida, error: null };
  }
}

// ---------------------------------------------------------------------------
// Siembra
// ---------------------------------------------------------------------------

function nuevaBase(parcheAjustes: Row = {}): FakeDb {
  const db = new FakeDb();
  db.tables.agent_settings.push({
    id: true,
    business_hours: null,
    demora_activa: true,
    demora_activa_desde: iso(en(27, 9)),
    ...parcheAjustes,
  });
  return db;
}

function sembrarAgentes(db: FakeDb, agentes: { id: string; nombre: string; last?: string | null; activo?: boolean }[]) {
  for (const a of agentes) {
    db.tables.agents.push({
      id: a.id,
      display_name: a.nombre,
      is_active: a.activo ?? true,
      last_assigned_at: a.last ?? null,
    });
  }
}

function sembrarConv(db: FakeDb, id: string, parche: Row = {}) {
  db.tables.conversations.push({
    id,
    status: "open",
    awaiting_reply: false,
    ai_enabled: true,
    assigned_agent_id: A,
    last_customer_message_at: null,
    ...parche,
  });
}

function msg(
  db: FakeDb,
  convId: string,
  quien: "customer" | "ai" | "agent" | "system",
  cuando: Date,
  extra: Row = {}
) {
  db.tables.messages.push({
    id: db.nextId(),
    conversation_id: convId,
    created_at: iso(cuando),
    direction: quien === "customer" ? "inbound" : "outbound",
    sender_type: quien,
    content: "hola",
    is_internal_note: false,
    message_type: "text",
    whatsapp_status: null,
    whatsapp_error_code: null,
    ...extra,
  });
}

function traspaso(db: FakeDb, convId: string, reason: string, cuando: Date, extra: Row = {}) {
  db.tables.conversation_handoffs.push({
    id: db.nextId(),
    conversation_id: convId,
    reason,
    to_kind: "human",
    to_id: A,
    from_kind: null,
    from_id: null,
    created_by: "system",
    created_at: iso(cuando),
    ...extra,
  });
}

/** Conversación con un mensaje del cliente esperando desde `cuando` (origen "cliente"). */
function clienteEsperando(db: FakeDb, id: string, cuando: Date, parche: Row = {}, texto = "¿tienen pastillas de freno?") {
  sembrarConv(db, id, { awaiting_reply: true, last_customer_message_at: iso(cuando), ...parche });
  msg(db, id, "customer", cuando, { content: texto });
}

/** Escalada de las 10:00 con la despedida de Seba pegada y el cliente callado (origen "escalada"). */
function escaladaDe10(db: FakeDb, id = "conv-1", parche: Row = {}) {
  sembrarConv(db, id, { awaiting_reply: false, last_customer_message_at: iso(lun(9, 58)), ...parche });
  msg(db, id, "customer", lun(9, 58), { content: "¿tienen pastillas de freno?" });
  traspaso(db, id, "escalada", lun(10, 0));
  msg(db, id, "ai", lun(10, 0, 5), { content: "Te paso con un asesor" });
}

async function pasada(db: FakeDb, now: Date, max = 5) {
  db.clock = now;
  return procesarDemoras(db.client(), { now, max });
}

let logInfo: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  runDelayTurnMock.mockReset();
  runDelayTurnMock.mockResolvedValue({ enviado: true, motivo: "enviado" });
  logInfo = vi.spyOn(log, "info").mockImplementation(() => {});
  vi.spyOn(log, "warn").mockImplementation(() => {});
  vi.spyOn(log, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe("procesarDemoras — interruptor", () => {
  it("demora apagada: no lee candidatas ni escribe nada", async () => {
    const db = nuevaBase({ demora_activa: false });
    sembrarAgentes(db, [{ id: A, nombre: "Ana" }, { id: B, nombre: "Beto" }]);
    clienteEsperando(db, "conv-1", lun(10, 0));

    const r = await pasada(db, lun(10, 30));

    expect(r.activa).toBe(false);
    expect(runDelayTurnMock).not.toHaveBeenCalled();
    expect(db.updates).toEqual([]);
    expect(db.episodios()).toEqual([]);
    expect(db.handoffs()).toEqual([]);
    expect(db.reads.conversations ?? 0).toBe(0);
  });

  it("encendida sin fecha de encendido: falla cerrado", async () => {
    const db = nuevaBase({ demora_activa_desde: null });
    clienteEsperando(db, "conv-1", lun(10, 0));

    const r = await pasada(db, lun(10, 30));

    expect(r.activa).toBe(false);
    expect(runDelayTurnMock).not.toHaveBeenCalled();
    expect(db.episodios()).toEqual([]);
  });

  it("el backlog anterior al encendido no dispara nada", async () => {
    const db = nuevaBase({ demora_activa_desde: iso(lun(9, 59)) });
    sembrarAgentes(db, [{ id: A, nombre: "Ana" }, { id: B, nombre: "Beto" }]);
    clienteEsperando(db, "conv-1", lun(9, 50));

    await pasada(db, lun(10, 30));

    expect(runDelayTurnMock).not.toHaveBeenCalled();
    expect(db.handoffs()).toEqual([]);
  });
});

describe("procesarDemoras — responder a los 10 min", () => {
  it("9:59:59 no; 10:10 sí, una vez, con el episodio y los minutos; la IA no se reactiva", async () => {
    const db = nuevaBase();
    sembrarAgentes(db, [{ id: A, nombre: "Ana" }, { id: B, nombre: "Beto" }]);
    // IA PAUSADA y con asesor asignado: la demora responde igual (D2) sin tocar `ai_enabled`.
    clienteEsperando(db, "conv-1", lun(10, 0), { ai_enabled: false });

    await pasada(db, lun(10, 9, 59));
    expect(runDelayTurnMock).not.toHaveBeenCalled();

    const r = await pasada(db, lun(10, 10));
    expect(r.responder).toBe(1);
    expect(runDelayTurnMock).toHaveBeenCalledTimes(1);
    expect(runDelayTurnMock).toHaveBeenCalledWith("conv-1", {
      episodeAt: lun(10, 0),
      esperaMinutos: 10,
      now: lun(10, 10),
    });
    const [fila] = db.episodios("conv-1");
    expect(fila.origen).toBe("cliente");
    expect(fila.responded_at).toBe(iso(lun(10, 10)));

    // La IA no queda reactivada: ninguna escritura a `conversations` toca ai_enabled.
    expect(db.conv("conv-1").ai_enabled).toBe(false);
    expect(db.updates.filter((u) => u.table === "conversations" && "ai_enabled" in u.payload)).toEqual([]);
  });

  it("dos pasadas SECUENCIALES en el mismo minuto dan una sola respuesta", async () => {
    const db = nuevaBase();
    sembrarAgentes(db, [{ id: A, nombre: "Ana" }, { id: B, nombre: "Beto" }]);
    clienteEsperando(db, "conv-1", lun(10, 0));

    await pasada(db, lun(10, 10, 5));
    await pasada(db, lun(10, 10, 40));

    expect(runDelayTurnMock).toHaveBeenCalledTimes(1);
  });

  it("dos pasadas CONCURRENTES (ambas leyeron el estado sin episodio) dan una sola respuesta: el candado responded_at is null", async () => {
    const db = nuevaBase();
    sembrarAgentes(db, [{ id: A, nombre: "Ana" }, { id: B, nombre: "Beto" }]);
    clienteEsperando(db, "conv-1", lun(10, 0));
    db.clock = lun(10, 10);

    await Promise.all([
      procesarDemoras(db.client(), { now: lun(10, 10) }),
      procesarDemoras(db.client(), { now: lun(10, 10) }),
    ]);

    expect(runDelayTurnMock).toHaveBeenCalledTimes(1);
    expect(db.episodios("conv-1")).toHaveLength(1);
  });

  it("si runDelayTurn lanza, libera el candado (se reintenta) y las demás conversaciones siguen", async () => {
    const db = nuevaBase();
    sembrarAgentes(db, [{ id: A, nombre: "Ana" }, { id: B, nombre: "Beto" }]);
    clienteEsperando(db, "conv-1", lun(10, 0));
    clienteEsperando(db, "conv-2", lun(10, 1));
    runDelayTurnMock.mockImplementation(async (id: unknown) => {
      if (id === "conv-1") throw new Error("proveedor caído");
      return { enviado: true, motivo: "enviado" };
    });

    const r = await pasada(db, lun(10, 12));

    expect(runDelayTurnMock).toHaveBeenCalledTimes(2);
    expect(r.errores).toBe(1);
    expect(r.responder).toBe(1);
    expect(db.episodios("conv-1")[0].responded_at).toBeNull();
    expect(db.episodios("conv-2")[0].responded_at).toBe(iso(lun(10, 12)));

    // La siguiente pasada reintenta solo la que falló.
    runDelayTurnMock.mockClear();
    runDelayTurnMock.mockResolvedValue({ enviado: true, motivo: "enviado" });
    await pasada(db, lun(10, 13));
    expect(runDelayTurnMock).toHaveBeenCalledTimes(1);
    expect(runDelayTurnMock.mock.calls[0][0]).toBe("conv-1");
  });

  it("si el turno decide no enviar (enviado: false), el episodio queda reclamado: no se reintenta cada minuto", async () => {
    const db = nuevaBase();
    sembrarAgentes(db, [{ id: A, nombre: "Ana" }, { id: B, nombre: "Beto" }]);
    clienteEsperando(db, "conv-1", lun(10, 0));
    runDelayTurnMock.mockResolvedValue({ enviado: false, motivo: "ia_apagada_global" });

    await pasada(db, lun(10, 10));
    await pasada(db, lun(10, 11));

    expect(runDelayTurnMock).toHaveBeenCalledTimes(1);
  });

  it("un 'gracias' solo NO abre episodio (ráfaga solo cortesía)", async () => {
    const db = nuevaBase();
    sembrarAgentes(db, [{ id: A, nombre: "Ana" }, { id: B, nombre: "Beto" }]);
    clienteEsperando(db, "conv-1", lun(10, 0), {}, "gracias");

    await pasada(db, lun(10, 12));

    expect(runDelayTurnMock).not.toHaveBeenCalled();
    expect(db.episodios()).toEqual([]);
  });

  it("un asesor que escribió después del mensaje del cliente: nada", async () => {
    const db = nuevaBase();
    sembrarAgentes(db, [{ id: A, nombre: "Ana" }, { id: B, nombre: "Beto" }]);
    clienteEsperando(db, "conv-1", lun(10, 0));
    msg(db, "conv-1", "agent", lun(10, 4), { content: "ya lo reviso" });

    await pasada(db, lun(10, 12));

    expect(runDelayTurnMock).not.toHaveBeenCalled();
  });

  it("una nota interna del asesor NO cuenta como haber escrito", async () => {
    const db = nuevaBase();
    sembrarAgentes(db, [{ id: A, nombre: "Ana" }, { id: B, nombre: "Beto" }]);
    clienteEsperando(db, "conv-1", lun(10, 0));
    msg(db, "conv-1", "agent", lun(10, 4), { content: "nota mía", is_internal_note: true });

    await pasada(db, lun(10, 12));

    expect(runDelayTurnMock).toHaveBeenCalledTimes(1);
  });

  it("ventana de 24 h cerrada por Meta (131047): nada", async () => {
    const db = nuevaBase();
    sembrarAgentes(db, [{ id: A, nombre: "Ana" }, { id: B, nombre: "Beto" }]);
    clienteEsperando(db, "conv-1", lun(10, 0));
    msg(db, "conv-1", "ai", lun(10, 2), { whatsapp_status: "failed", whatsapp_error_code: 131047 });

    await pasada(db, lun(10, 12));

    expect(runDelayTurnMock).not.toHaveBeenCalled();
  });

  it("máximo 5 por pasada: de 8 conversaciones, 5 ahora y 3 en la siguiente", async () => {
    const db = nuevaBase();
    sembrarAgentes(db, [{ id: A, nombre: "Ana" }, { id: B, nombre: "Beto" }]);
    for (let i = 1; i <= 8; i++) clienteEsperando(db, `conv-${i}`, lun(10, 0, i));

    const primera = await pasada(db, lun(10, 12));
    expect(primera.responder).toBe(5);
    expect(runDelayTurnMock).toHaveBeenCalledTimes(5);

    const segunda = await pasada(db, lun(10, 13));
    expect(segunda.responder).toBe(3);
    expect(runDelayTurnMock).toHaveBeenCalledTimes(8);
  });
});

describe("procesarDemoras — reasignar a los 15 min", () => {
  it("escalada 10:00, cliente callado: 10:10 nada; 10:15 pasa a OTRO asesor con traspaso, nota y log", async () => {
    const db = nuevaBase();
    sembrarAgentes(db, [
      { id: A, nombre: "Ana", last: iso(en(27, 8)) }, // la más antigua del reparto: sin excluirla, sería la elegida
      { id: B, nombre: "Beto", last: iso(en(27, 12)) },
      { id: C, nombre: "Carla", last: iso(en(27, 13)) },
    ]);
    escaladaDe10(db);

    await pasada(db, lun(10, 10));
    expect(db.conv("conv-1").assigned_agent_id).toBe(A);
    expect(runDelayTurnMock).not.toHaveBeenCalled();

    const r = await pasada(db, lun(10, 15));

    expect(r.reasignar).toBe(1);
    // Nunca el mismo asesor: Ana lo tenía y era la primera del reparto por antigüedad.
    expect(db.conv("conv-1").assigned_agent_id).toBe(B);
    expect(db.conv("conv-1").ai_enabled).toBe(true);
    expect(db.updates.filter((u) => u.table === "conversations" && "ai_enabled" in u.payload)).toEqual([]);
    const [traspasoNuevo] = db.handoffs("reasignada_por_demora");
    expect(traspasoNuevo).toMatchObject({ to_kind: "human", to_id: B, from_kind: "human", from_id: A, created_by: "system" });
    const [fila] = db.episodios("conv-1");
    expect(fila).toMatchObject({
      origen: "escalada",
      reassignments: 1,
      agentes_previos: [A],
      ultima_reasignacion_at: iso(lun(10, 15)),
    });
    expect(fila.episode_at).toBe(iso(lun(10, 0)));
    const notas = db.tables.messages.filter((m) => m.is_internal_note === true);
    expect(notas).toHaveLength(1);
    expect(String(notas[0].content)).toContain("Ana");
    expect(String(notas[0].content)).toContain("Beto");
    expect(logInfo).toHaveBeenCalledWith("reasignada_por_demora", expect.objectContaining({ conversationId: "conv-1" }));
  });

  it("nunca el mismo asesor: si el ÚNICO otro asesor activo no existe, no hay reasignación", async () => {
    const db = nuevaBase();
    // Solo Ana está activa y es la dueña actual: el reparto le devolvería el caso.
    sembrarAgentes(db, [{ id: A, nombre: "Ana" }, { id: B, nombre: "Beto", activo: false }]);
    escaladaDe10(db);

    const r = await pasada(db, lun(10, 15));

    expect(r.reasignar).toBe(0);
    expect(r.sinCandidato).toBe(1);
    expect(db.conv("conv-1").assigned_agent_id).toBe(A);
  });

  it("sin candidato NO escribe nada (ni episodio, ni traspaso, ni nota) y reintenta cuando aparece uno", async () => {
    const db = nuevaBase();
    sembrarAgentes(db, [{ id: A, nombre: "Ana" }]);
    escaladaDe10(db);
    const antes = structuredClone(db.tables);

    await pasada(db, lun(10, 15));

    expect(db.tables.conversation_delay_episodes).toEqual(antes.conversation_delay_episodes);
    expect(db.tables.conversation_handoffs).toEqual(antes.conversation_handoffs);
    expect(db.tables.messages).toEqual(antes.messages);
    expect(db.tables.conversations).toEqual(antes.conversations);

    sembrarAgentes(db, [{ id: B, nombre: "Beto" }]);
    await pasada(db, lun(10, 16));
    expect(db.conv("conv-1").assigned_agent_id).toBe(B);
  });

  it("dos pasadas concurrentes a las 10:15 dejan UNA sola reasignación", async () => {
    const db = nuevaBase();
    sembrarAgentes(db, [
      { id: A, nombre: "Ana", last: iso(en(27, 8)) }, // la más antigua del reparto: sin excluirla, sería la elegida
      { id: B, nombre: "Beto", last: iso(en(27, 12)) },
      { id: C, nombre: "Carla", last: iso(en(27, 13)) },
    ]);
    escaladaDe10(db);
    db.clock = lun(10, 15);

    await Promise.all([
      procesarDemoras(db.client(), { now: lun(10, 15) }),
      procesarDemoras(db.client(), { now: lun(10, 15) }),
    ]);

    expect(db.handoffs("reasignada_por_demora")).toHaveLength(1);
    expect(db.episodios("conv-1")).toHaveLength(1);
    expect(db.episodios("conv-1")[0].reassignments).toBe(1);
  });

  it("fuera de horario no se reasigna", async () => {
    const db = nuevaBase();
    sembrarAgentes(db, [{ id: A, nombre: "Ana" }, { id: B, nombre: "Beto" }]);
    sembrarConv(db, "conv-1", { last_customer_message_at: iso(lun(17, 40)) });
    msg(db, "conv-1", "customer", lun(17, 40));
    traspaso(db, "conv-1", "escalada", lun(17, 50));
    msg(db, "conv-1", "ai", lun(17, 50, 5));

    await pasada(db, lun(18, 30));

    expect(db.handoffs("reasignada_por_demora")).toEqual([]);
    expect(db.conv("conv-1").assigned_agent_id).toBe(A);
  });

  it("un asesor que escribió tras la escalada la atendió: no se reasigna", async () => {
    const db = nuevaBase();
    sembrarAgentes(db, [{ id: A, nombre: "Ana" }, { id: B, nombre: "Beto" }]);
    escaladaDe10(db);
    msg(db, "conv-1", "agent", lun(10, 7), { content: "hola, ya te atiendo" });

    await pasada(db, lun(10, 20));

    expect(db.handoffs("reasignada_por_demora")).toEqual([]);
  });

  it("escalada SIN asesor: se reasigna a alguien (nadie que excluir) y el traspaso sale desde 'unassigned'", async () => {
    const db = nuevaBase();
    sembrarAgentes(db, [{ id: A, nombre: "Ana" }, { id: B, nombre: "Beto" }]);
    escaladaDe10(db, "conv-1", { assigned_agent_id: null });
    db.tables.conversation_handoffs[0] = { ...db.tables.conversation_handoffs[0], reason: "escalada_sin_asesor", to_kind: "unassigned", to_id: null };

    await pasada(db, lun(10, 15));

    expect(db.conv("conv-1").assigned_agent_id).toBe(A);
    expect(db.handoffs("reasignada_por_demora")[0]).toMatchObject({ to_id: A, from_kind: "unassigned", from_id: null });
    expect(db.episodios("conv-1")[0].agentes_previos).toEqual([]);
  });
});

describe("procesarDemoras — el recorrido del plan de punta a punta", () => {
  it("escalada 10:00 → reasigna 10:15 → reasigna 10:30 → avisa al supervisor 10:45 y no rota más (episodio acumulado en UNA fila)", async () => {
    const db = nuevaBase();
    sembrarAgentes(db, [
      { id: A, nombre: "Ana", last: iso(en(27, 8)) }, // la más antigua del reparto: sin excluirla, sería la elegida
      { id: B, nombre: "Beto", last: iso(en(27, 12)) },
      { id: C, nombre: "Carla", last: iso(en(27, 13)) },
    ]);
    escaladaDe10(db);

    // 10:00 - 10:14: nada.
    await pasada(db, lun(10, 1));
    await pasada(db, lun(10, 10));
    await pasada(db, lun(10, 14, 59));
    expect(db.handoffs("reasignada_por_demora")).toEqual([]);

    // 10:15: Ana → Beto.
    await pasada(db, lun(10, 15));
    expect(db.conv("conv-1").assigned_agent_id).toBe(B);
    // Mismo minuto y el minuto siguiente: nada más.
    await pasada(db, lun(10, 15, 30));
    await pasada(db, lun(10, 16));
    expect(db.handoffs("reasignada_por_demora")).toHaveLength(1);

    // 10:29: todavía no (los 15 min se cuentan desde la ÚLTIMA reasignación).
    await pasada(db, lun(10, 29));
    expect(db.handoffs("reasignada_por_demora")).toHaveLength(1);

    // 10:30: Beto → Carla (nunca vuelve a Ana ni a Beto).
    await pasada(db, lun(10, 30));
    expect(db.conv("conv-1").assigned_agent_id).toBe(C);
    expect(db.handoffs("reasignada_por_demora")).toHaveLength(2);

    // 10:45: tope. Aviso al supervisor al MISMO dueño, sin rotar.
    const r = await pasada(db, lun(10, 45));
    expect(r.avisar_supervisor).toBe(1);
    expect(db.conv("conv-1").assigned_agent_id).toBe(C);
    expect(db.handoffs("reasignada_por_demora")).toHaveLength(2);
    const avisos = db.handoffs("demora_sin_asesor");
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatchObject({ to_kind: "human", to_id: C });

    // Después: ni otro aviso ni otra rotación, pase el tiempo que pase.
    await pasada(db, lun(10, 46));
    await pasada(db, lun(11, 0));
    await pasada(db, lun(11, 30));
    expect(db.handoffs("demora_sin_asesor")).toHaveLength(1);
    expect(db.handoffs("reasignada_por_demora")).toHaveLength(2);

    // Un único episodio, con todo acumulado en esa misma fila.
    const filas = db.episodios("conv-1");
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({
      origen: "escalada",
      reassignments: 2,
      agentes_previos: [A, B],
      ultima_reasignacion_at: iso(lun(10, 30)),
      supervisor_notified_at: iso(lun(10, 45)),
    });
    expect(filas[0].episode_at).toBe(iso(lun(10, 0)));

    // La IA nunca se reactivó en todo el recorrido.
    expect(db.updates.filter((u) => u.table === "conversations" && "ai_enabled" in u.payload)).toEqual([]);
  });

  it("dos pasadas concurrentes a las 10:45 dejan UN solo aviso al supervisor", async () => {
    const db = nuevaBase();
    sembrarAgentes(db, [{ id: C, nombre: "Carla" }]);
    escaladaDe10(db, "conv-1", { assigned_agent_id: C });
    db.tables.conversation_delay_episodes.push({
      conversation_id: "conv-1",
      episode_at: iso(lun(10, 0)),
      origen: "escalada",
      responded_at: null,
      reassignments: 2,
      agentes_previos: [A, B],
      ultima_reasignacion_at: iso(lun(10, 30)),
      supervisor_notified_at: null,
    });
    db.clock = lun(10, 45);

    await Promise.all([
      procesarDemoras(db.client(), { now: lun(10, 45) }),
      procesarDemoras(db.client(), { now: lun(10, 45) }),
    ]);

    expect(db.handoffs("demora_sin_asesor")).toHaveLength(1);
  });

  it("si el traspaso del aviso no se pudo escribir, libera el candado y reintenta en la próxima pasada", async () => {
    const db = nuevaBase();
    sembrarAgentes(db, [{ id: C, nombre: "Carla" }]);
    escaladaDe10(db, "conv-1", { assigned_agent_id: C });
    db.tables.conversation_delay_episodes.push({
      conversation_id: "conv-1",
      episode_at: iso(lun(10, 0)),
      origen: "escalada",
      responded_at: null,
      reassignments: 2,
      agentes_previos: [A, B],
      ultima_reasignacion_at: iso(lun(10, 30)),
      supervisor_notified_at: null,
    });
    const cliente = db.client() as unknown as { rpc: (fn: string, p: Row) => Promise<unknown> };
    const rpcOriginal = cliente.rpc;
    let falla = true;
    cliente.rpc = async (fn: string, p: Row) => (falla ? { data: null, error: { message: "corte" } } : rpcOriginal(fn, p));

    db.clock = lun(10, 45);
    await procesarDemoras(cliente as never, { now: lun(10, 45) });
    expect(db.handoffs("demora_sin_asesor")).toEqual([]);
    expect(db.episodios("conv-1")[0].supervisor_notified_at).toBeNull();

    falla = false;
    db.clock = lun(10, 46);
    await procesarDemoras(cliente as never, { now: lun(10, 46) });
    expect(db.handoffs("demora_sin_asesor")).toHaveLength(1);
  });
});
