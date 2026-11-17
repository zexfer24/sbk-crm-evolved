import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Agent, Sticker } from "@/lib/types";
import {
  ConfigWriteDeniedError,
  CONFIG_WRITE_DENIED_MESSAGE,
  assertRowsAffected,
  deleteKnowledgeCategory,
  deleteKnowledgeEntry,
  deleteLesson,
  deleteNote,
  deletePlaybook,
  deleteSticker,
  deleteCatalogLink,
  createPaymentMethod,
  deletePaymentMethod,
  guardarMetaVenta,
  markSuggestionReviewed,
  resolveSuggestion,
  saveShadowReview,
  setAgentActive,
  setAgentAreas,
  setAgentToolEnabled,
  setAiGloballyEnabled,
  setCatalogLinkActive,
  setDailySpendCap,
  setDemoraActiva,
  setKnowledgeEntryActive,
  setLessonActive,
  setPaymentMethodActive,
  setPlaybookActive,
  setSebaV2Mode,
  updateBusinessHours,
  updateCasheaSettings,
  updateCatalogLink,
  updateKnowledgeEntry,
  updateModelPricing,
  updateNote,
  updatePaymentMethod,
  updatePlaybook,
  updateShadowLimits,
  updateWelcomeTexts,
  type PlaybookDraft,
} from "@/lib/mutations";
import type { PaymentMethodDraft } from "@/lib/payment-methods";
import type { BusinessHours } from "@/lib/business-hours";

/**
 * T7, plan "Seba encuentra, no insiste, y el mostrador no deja a nadie
 * esperando" (28/9/2026). Bajo RLS, un UPDATE/DELETE que la política no deja
 * pasar NO da error: afecta 0 filas y PostgREST responde 200/204 (probado
 * contra la base local en `supabase/tests/config_solo_supervisor.sql`). Sin
 * `.select()` el cliente no puede distinguir "guardé" de "la RLS me ignoró",
 * así que cada mutación de configuración pide las filas afectadas y lanza si
 * volvieron vacías.
 *
 * El fake imita a PostgREST en lo que importa: SIN `.select()` después del
 * update/delete/upsert, `data` es `null` (no hay cuerpo de respuesta); CON
 * `.select()`, devuelve lo que el caso configure. Por eso quitar el
 * `.select()` de una mutación pone rojo su test: recibe `null` y lanza
 * incluso cuando la base sí guardó.
 */

interface WriteCall {
  table: string;
  op: "update" | "delete" | "upsert";
  payload?: unknown;
  filters: [string, unknown][];
  selected: string | null;
}

function fakeSupabase(options: {
  /** Filas que devuelve la escritura cuando pide `.select()` (por defecto, ninguna: la RLS la ignoró). */
  rows?: unknown[] | null;
  error?: unknown;
  /** Filas que devuelve una LECTURA (`.select()` antes de escribir), por tabla. */
  reads?: Record<string, unknown[]>;
  /** Filas de una escritura con `.select()`, por tabla (pisa a `rows` para esa tabla). */
  rowsByTable?: Record<string, unknown[]>;
  storageRemove?: ReturnType<typeof vi.fn>;
}) {
  const writes: WriteCall[] = [];
  const rows = options.rows === undefined ? [] : options.rows;

  function builder(table: string) {
    let call: WriteCall | null = null;
    let readColumns: string | null = null;
    const b: Record<string, unknown> = {
      update(payload: unknown) {
        call = { table, op: "update", payload, filters: [], selected: null };
        writes.push(call);
        return b;
      },
      delete() {
        call = { table, op: "delete", filters: [], selected: null };
        writes.push(call);
        return b;
      },
      upsert(payload: unknown) {
        call = { table, op: "upsert", payload, filters: [], selected: null };
        writes.push(call);
        return b;
      },
      insert(payload: unknown) {
        call = null;
        writes.push({ table, op: "update", payload, filters: [], selected: "insert" });
        return Promise.resolve({ data: null, error: options.error ?? null });
      },
      select(columns: string) {
        if (call) call.selected = columns;
        else readColumns = columns;
        return b;
      },
      eq(column: string, value: unknown) {
        call?.filters.push([column, value]);
        return b;
      },
      in(column: string, value: unknown) {
        call?.filters.push([column, value]);
        return b;
      },
      then(resolve: (value: { data: unknown; error: unknown }) => unknown) {
        if (call) {
          const data = call.selected ? (options.rowsByTable?.[table] ?? rows) : null;
          return Promise.resolve({ data, error: options.error ?? null }).then(resolve);
        }
        return Promise.resolve({ data: options.reads?.[table] ?? [], error: null, readColumns }).then(resolve);
      },
    };
    return b;
  }

  const client = {
    from: (table: string) => builder(table),
    storage: { from: () => ({ remove: options.storageRemove ?? vi.fn(async () => ({ error: null })) }) },
  } as unknown as SupabaseClient;

  return { client, writes };
}

const SUPERVISOR: Agent = {
  id: "sup-1",
  displayName: "Rosa",
  fullName: "Rosa Pérez",
  avatarUrl: null,
  role: "supervisor",
  isActive: true,
};

const HOURS: BusinessHours = {
  mon: [["08:00", "18:00"]],
  tue: [["08:00", "18:00"]],
  wed: [["08:00", "18:00"]],
  thu: [["08:00", "18:00"]],
  fri: [["08:00", "18:00"]],
  sat: [],
  sun: [],
};

const STICKER: Sticker = {
  id: "sticker-1",
  url: "/api/media/stickers/sticker-1.webp",
  name: null,
  animated: false,
  createdBy: "agent-42",
  createdAt: "2026-09-09T12:00:00.000Z",
};

const DRAFT_PLAYBOOK = {
  name: "Ubicación",
  triggerDescription: "pregunta dónde queda la tienda",
  responseText: "Estamos en Barinas.",
  attachmentUrl: null,
  attachmentType: null,
  afterSend: "wait",
  cedeAlInventario: false,
  disponibleEnEspera: false,
  tagIds: [],
} as unknown as PlaybookDraft;

const ENTRY_DRAFT = { categoryId: "cat-1", title: "Garantía", content: "Texto", sourceFilename: null };

const CATALOG_DRAFT = { key: "cascos", label: "Cascos", url: "https://drive.google.com/file/d/1abc" };

const PAYMENT_DRAFT: PaymentMethodDraft = {
  key: "pago_movil",
  label: "Pago móvil",
  currency: "VES",
  instructions: "Banco X, cédula Y, teléfono Z.",
  sebaEntrega: true,
};
const PAYMENT_EDIT = {
  label: PAYMENT_DRAFT.label,
  currency: PAYMENT_DRAFT.currency,
  instructions: PAYMENT_DRAFT.instructions,
  sebaEntrega: PAYMENT_DRAFT.sebaEntrega,
};

const WELCOME_DRAFT = { welcomeText: "Hola, buen día", followups: ["Una frase", "Otra frase"] };
const CASHEA_SETTINGS = { datosText: "Dame tu cédula", minimoUsd: 25, seisCuotasDesdeUsd: 100 };

/** Una fila por mutación de configuración que escribe con UPDATE/DELETE/UPSERT. */
const CASES: {
  name: string;
  table: string;
  op: WriteCall["op"];
  /** Mensaje esperado cuando la RLS ignora la escritura. */
  denied: RegExp;
  run: (client: SupabaseClient) => Promise<unknown>;
}[] = [
  { name: "setAiGloballyEnabled", table: "agent_settings", op: "update", denied: /supervisor o administrador/, run: (c) => setAiGloballyEnabled(c, SUPERVISOR, false) },
  { name: "setDailySpendCap", table: "agent_settings", op: "update", denied: /supervisor o administrador/, run: (c) => setDailySpendCap(c, SUPERVISOR, 5) },
  { name: "setDemoraActiva (encender)", table: "agent_settings", op: "update", denied: /supervisor o administrador/, run: (c) => setDemoraActiva(c, SUPERVISOR, true) },
  { name: "setDemoraActiva (apagar)", table: "agent_settings", op: "update", denied: /supervisor o administrador/, run: (c) => setDemoraActiva(c, SUPERVISOR, false) },
  { name: "updateBusinessHours", table: "agent_settings", op: "update", denied: /supervisor o administrador/, run: (c) => updateBusinessHours(c, SUPERVISOR, HOURS) },
  { name: "updatePlaybook", table: "ai_playbooks", op: "update", denied: /supervisor o administrador/, run: (c) => updatePlaybook(c, "pb-1", DRAFT_PLAYBOOK) },
  { name: "deletePlaybook", table: "ai_playbooks", op: "delete", denied: /supervisor o administrador/, run: (c) => deletePlaybook(c, "pb-1") },
  { name: "setPlaybookActive", table: "ai_playbooks", op: "update", denied: /supervisor o administrador/, run: (c) => setPlaybookActive(c, "pb-1", false) },
  { name: "setLessonActive", table: "ai_lessons", op: "update", denied: /autor de la lección o un supervisor/, run: (c) => setLessonActive(c, "l-1", false) },
  { name: "deleteLesson", table: "ai_lessons", op: "delete", denied: /autor de la lección o un supervisor/, run: (c) => deleteLesson(c, "l-1") },
  { name: "setAgentToolEnabled", table: "agent_tools", op: "update", denied: /supervisor o administrador/, run: (c) => setAgentToolEnabled(c, SUPERVISOR, "buscar_repuesto", false) },
  { name: "deleteKnowledgeCategory", table: "knowledge_categories", op: "delete", denied: /supervisor o administrador/, run: (c) => deleteKnowledgeCategory(c, "cat-1") },
  { name: "updateKnowledgeEntry", table: "knowledge_entries", op: "update", denied: /supervisor o administrador/, run: (c) => updateKnowledgeEntry(c, SUPERVISOR, "e-1", ENTRY_DRAFT) },
  { name: "setKnowledgeEntryActive", table: "knowledge_entries", op: "update", denied: /supervisor o administrador/, run: (c) => setKnowledgeEntryActive(c, "e-1", false) },
  { name: "deleteKnowledgeEntry", table: "knowledge_entries", op: "delete", denied: /supervisor o administrador/, run: (c) => deleteKnowledgeEntry(c, "e-1") },
  { name: "setAgentActive", table: "agents", op: "update", denied: /supervisor o administrador/, run: (c) => setAgentActive(c, "agent-2", false) },
  { name: "markSuggestionReviewed", table: "agent_suggestions", op: "update", denied: /supervisor o administrador/, run: (c) => markSuggestionReviewed(c, "s-1", SUPERVISOR) },
  { name: "updateModelPricing", table: "model_pricing", op: "upsert", denied: /supervisor o administrador/, run: (c) => updateModelPricing(c, "openai/x", 1, 2, SUPERVISOR) },
  { name: "updateCatalogLink", table: "catalog_links", op: "update", denied: /supervisor o administrador/, run: (c) => updateCatalogLink(c, SUPERVISOR, "link-1", CATALOG_DRAFT) },
  { name: "deleteCatalogLink", table: "catalog_links", op: "delete", denied: /supervisor o administrador/, run: (c) => deleteCatalogLink(c, "link-1") },
  { name: "setCatalogLinkActive", table: "catalog_links", op: "update", denied: /supervisor o administrador/, run: (c) => setCatalogLinkActive(c, SUPERVISOR, "link-1", false) },
  // Entrega 2 de Seba v2 (16/11/2026): formas de pago, bienvenida, modo, límites, Cashea y áreas.
  { name: "updatePaymentMethod", table: "payment_methods", op: "update", denied: /supervisor o administrador/, run: (c) => updatePaymentMethod(c, SUPERVISOR, "pago_movil", PAYMENT_EDIT) },
  { name: "setPaymentMethodActive", table: "payment_methods", op: "update", denied: /supervisor o administrador/, run: (c) => setPaymentMethodActive(c, SUPERVISOR, "pago_movil", false) },
  { name: "deletePaymentMethod", table: "payment_methods", op: "delete", denied: /supervisor o administrador/, run: (c) => deletePaymentMethod(c, "pago_movil") },
  { name: "updateWelcomeTexts", table: "agent_settings", op: "update", denied: /supervisor o administrador/, run: (c) => updateWelcomeTexts(c, SUPERVISOR, WELCOME_DRAFT) },
  { name: "setSebaV2Mode", table: "agent_settings", op: "update", denied: /supervisor o administrador/, run: (c) => setSebaV2Mode(c, SUPERVISOR, "sombra") },
  { name: "updateShadowLimits", table: "agent_settings", op: "update", denied: /supervisor o administrador/, run: (c) => updateShadowLimits(c, SUPERVISOR, { capUsd: 5, samplePct: 40 }) },
  { name: "updateCasheaSettings", table: "agent_settings", op: "update", denied: /supervisor o administrador/, run: (c) => updateCasheaSettings(c, SUPERVISOR, CASHEA_SETTINGS) },
  { name: "setAgentAreas", table: "agents", op: "update", denied: /supervisor o administrador/, run: (c) => setAgentAreas(c, "agent-2", ["pagos", "ventas"]) },
  // Plan "Paneles" (13/11/2026): la meta diaria de un canal. Un `agent` no puede ni insertar ni
  // actualizar `metas_venta` (RLS de supervisor/admin): el upsert que no devuelve fila no es un guardado.
  { name: "guardarMetaVenta", table: "metas_venta", op: "upsert", denied: /supervisor o administrador/, run: (c) => guardarMetaVenta(c, "online", 2600, "2026-11-13") },
  // Entrega 3 de Seba v2 (17/11/2026): la revisión de un borrador de sombra es solo de supervisor/admin.
  { name: "saveShadowReview", table: "shadow_reviews", op: "upsert", denied: /supervisor o administrador/, run: (c) => saveShadowReview(c, SUPERVISOR, "d-1", { veredicto: "no", errorTipo: "precio", correccion: "Era $12", destino: "leccion" }) },
  { name: "deleteSticker", table: "stickers", op: "delete", denied: /subió el sticker o un supervisor/, run: (c) => deleteSticker(c, STICKER) },
  // Fuera de la lista original del plan, mismo defecto: `notes_update`/`notes_delete` exigen ser el autor o supervisor.
  { name: "updateNote", table: "notes", op: "update", denied: /autor de la nota o un supervisor/, run: (c) => updateNote(c, "n-1", "texto") },
  { name: "deleteNote", table: "notes", op: "delete", denied: /autor de la nota o un supervisor/, run: (c) => deleteNote(c, "n-1") },
];

describe("assertRowsAffected", () => {
  it("lanza con el mensaje pedido cuando no volvió ninguna fila", () => {
    expect(() => assertRowsAffected([])).toThrow(CONFIG_WRITE_DENIED_MESSAGE);
    expect(() => assertRowsAffected(null)).toThrow(CONFIG_WRITE_DENIED_MESSAGE);
    expect(() => assertRowsAffected(undefined)).toThrow(CONFIG_WRITE_DENIED_MESSAGE);
  });

  it("el mensaje por defecto es literal", () => {
    expect(CONFIG_WRITE_DENIED_MESSAGE).toBe("Solo un supervisor o administrador puede cambiar esto.");
  });

  it("deja pasar cuando volvió al menos una fila", () => {
    expect(() => assertRowsAffected([{ id: "x" }])).not.toThrow();
  });

  it("lanza un ConfigWriteDeniedError con el mensaje que se le pase", () => {
    try {
      assertRowsAffected([], "Solo el autor puede.");
      throw new Error("no lanzó");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigWriteDeniedError);
      expect((error as Error).message).toBe("Solo el autor puede.");
    }
  });
});

describe.each(CASES)("$name — el guardado que la RLS ignora ya no pasa por bueno", ({ table, op, denied, run }) => {
  it("lanza cuando la escritura afectó 0 filas (la RLS la ignoró sin error)", async () => {
    const { client } = fakeSupabase({ rows: [] });

    await expect(run(client)).rejects.toThrow(denied);
  });

  it("no lanza cuando la escritura devolvió la fila afectada", async () => {
    const { client, writes } = fakeSupabase({ rows: [{ id: "x" }] });

    await expect(run(client)).resolves.not.toThrow();

    const write = writes.find((w) => w.table === table && w.op === op);
    expect(write, `debía escribir en ${table} con ${op}`).toBeDefined();
    expect(write?.selected, `${op} sobre ${table} tiene que pedir las filas afectadas con .select()`).toBeTruthy();
  });

  it("un error real de la base sube tal cual, sin disfrazarse de permiso", async () => {
    const { client } = fakeSupabase({ rows: null, error: new Error("connection reset") });

    await expect(run(client)).rejects.toThrow(/connection reset/);
  });
});

describe("guardarMetaVenta — plan Paneles, 13/11/2026", () => {
  it("escribe (canal, vigente_desde, monto_usd) con upsert sobre la clave (canal, vigente_desde)", async () => {
    const { client, writes } = fakeSupabase({ rows: [{ canal: "tienda" }] });

    await guardarMetaVenta(client, "tienda", 1800.5, "2026-11-13");

    const w = writes.find((x) => x.table === "metas_venta");
    expect(w?.op).toBe("upsert");
    expect(w?.payload).toEqual({ canal: "tienda", vigente_desde: "2026-11-13", monto_usd: 1800.5 });
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])("monto %s: error en español y NO llama a Supabase", async (monto) => {
    const { client, writes } = fakeSupabase({ rows: [{ canal: "online" }] });

    await expect(guardarMetaVenta(client, "online", monto, "2026-11-13")).rejects.toThrow(/meta.*mayor que cero/i);

    expect(writes).toHaveLength(0);
  });

  it("un día que no es YYYY-MM-DD tampoco escribe", async () => {
    const { client, writes } = fakeSupabase({ rows: [{ canal: "online" }] });

    await expect(guardarMetaVenta(client, "online", 100, "13/11/2026")).rejects.toThrow(/día/i);

    expect(writes).toHaveLength(0);
  });
});

describe("setDemoraActiva — T10b-5, 29/9/2026", () => {
  it("al ENCENDER escribe demora_activa = true Y demora_activa_desde = ahora (el corte del backlog)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-29T15:30:00.000Z"));
    try {
      const { client, writes } = fakeSupabase({ rows: [{ id: true }] });

      await setDemoraActiva(client, SUPERVISOR, true);

      const write = writes.find((w) => w.table === "agent_settings" && w.op === "update");
      expect(write?.payload).toMatchObject({
        demora_activa: true,
        demora_activa_desde: "2026-09-29T15:30:00.000Z",
        updated_by: "sup-1",
      });
      expect(write?.filters).toContainEqual(["id", true]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("al APAGAR escribe solo demora_activa = false: no toca demora_activa_desde", async () => {
    const { client, writes } = fakeSupabase({ rows: [{ id: true }] });

    await setDemoraActiva(client, SUPERVISOR, false);

    const write = writes.find((w) => w.table === "agent_settings" && w.op === "update");
    expect(write?.payload).toMatchObject({ demora_activa: false, updated_by: "sup-1" });
    expect(write?.payload).not.toHaveProperty("demora_activa_desde");
  });
});

describe("deleteSticker — sin fila borrada no toca el archivo", () => {
  it("con 0 filas afectadas lanza y NO quita el objeto del bucket", async () => {
    const storageRemove = vi.fn(async () => ({ error: null }));
    const { client } = fakeSupabase({ rows: [], storageRemove });

    await expect(deleteSticker(client, STICKER)).rejects.toThrow(/subió el sticker o un supervisor/);
    expect(storageRemove).not.toHaveBeenCalled();
  });

  it("con la fila borrada quita el objeto del bucket", async () => {
    const storageRemove = vi.fn(async () => ({ error: null }));
    const { client } = fakeSupabase({ rows: [{ id: "sticker-1" }], storageRemove });

    await deleteSticker(client, STICKER);

    expect(storageRemove).toHaveBeenCalledWith(["stickers/sticker-1.webp"]);
  });
});

describe("updatePlaybook — las etiquetas también", () => {
  it("si el borrado de etiquetas sobrantes afecta 0 filas, lanza", async () => {
    const { client, writes } = fakeSupabase({
      rows: [{ id: "pb-1" }],
      reads: { ai_playbook_tags: [{ tag_id: "vieja" }] },
      rowsByTable: { ai_playbook_tags: [] },
    });

    await expect(updatePlaybook(client, "pb-1", { ...DRAFT_PLAYBOOK, tagIds: [] })).rejects.toThrow(
      /supervisor o administrador/
    );
    expect(writes.some((w) => w.table === "ai_playbook_tags" && w.op === "delete" && w.selected)).toBe(true);
  });

  it("si el borrado de etiquetas sobrantes devuelve filas, sigue y guarda", async () => {
    const { client } = fakeSupabase({
      rows: [{ id: "pb-1" }],
      reads: { ai_playbook_tags: [{ tag_id: "vieja" }] },
    });

    await expect(updatePlaybook(client, "pb-1", { ...DRAFT_PLAYBOOK, tagIds: [] })).resolves.toBeUndefined();
  });
});

describe("Seba v2 (16/11/2026)", () => {
  describe("createPaymentMethod", () => {
    it("escribe con insert, con la etiqueta y las instrucciones recortadas y quién la creó", async () => {
      const { client, writes } = fakeSupabase({ rows: [] });

      await createPaymentMethod(
        client,
        SUPERVISOR,
        { ...PAYMENT_DRAFT, label: "  Pago móvil ", instructions: " Banco X \n" },
        30
      );

      expect(writes).toHaveLength(1);
      expect(writes[0].table).toBe("payment_methods");
      expect(writes[0].selected).toBe("insert");
      expect(writes[0].payload).toEqual({
        key: "pago_movil",
        label: "Pago móvil",
        currency: "VES",
        instructions: "Banco X",
        seba_entrega: true,
        sort_order: 30,
        updated_by: "sup-1",
      });
    });

    it("un 23505 (clave repetida) se traduce al mensaje del panel", async () => {
      const { client } = fakeSupabase({ error: { code: "23505", message: "duplicate key" } });

      await expect(createPaymentMethod(client, SUPERVISOR, PAYMENT_DRAFT, 10)).rejects.toThrow(
        "Ya existe una forma de pago con esa clave."
      );
    });

    it("un 42501 (RLS: no es supervisor) se traduce a ConfigWriteDeniedError", async () => {
      const { client } = fakeSupabase({ error: { code: "42501", message: "new row violates row-level security" } });

      const error = await createPaymentMethod(client, SUPERVISOR, PAYMENT_DRAFT, 10).catch((e) => e);

      expect(error).toBeInstanceOf(ConfigWriteDeniedError);
      expect(error.message).toBe(CONFIG_WRITE_DENIED_MESSAGE);
    });

    it("cualquier otro error sube tal cual", async () => {
      const original = { code: "57014", message: "statement timeout" };
      const { client } = fakeSupabase({ error: original });

      await expect(createPaymentMethod(client, SUPERVISOR, PAYMENT_DRAFT, 10)).rejects.toBe(original);
    });

    it.each([
      ["clave inválida", { key: "Pago Movil" }, /clave usa solo minúsculas/],
      ["clave reservada", { key: "cashea" }, /se configura aparte/],
      ["etiqueta vacía", { label: "  " }, /nombre de la forma de pago/],
      ["instrucciones vacías", { instructions: "" }, /datos que recibe el cliente/],
    ])("%s: la segunda barrera lanza y NO llama a Supabase", async (_nombre, cambio, mensaje) => {
      const { client, writes } = fakeSupabase({ rows: [] });

      await expect(createPaymentMethod(client, SUPERVISOR, { ...PAYMENT_DRAFT, ...cambio }, 10)).rejects.toThrow(mensaje);

      expect(writes).toHaveLength(0);
    });
  });

  describe("payload y filtro de cada guardado", () => {
    it("updatePaymentMethod: no toca la clave, filtra por ella y deja quién lo cambió", async () => {
      const { client, writes } = fakeSupabase({ rows: [{ key: "pago_movil" }] });

      await updatePaymentMethod(client, SUPERVISOR, "pago_movil", {
        ...PAYMENT_EDIT,
        label: " Pago móvil nuevo ",
        currency: "USD",
        sebaEntrega: false,
      });

      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({ table: "payment_methods", op: "update", selected: "key" });
      expect(writes[0].payload).toEqual({
        label: "Pago móvil nuevo",
        currency: "USD",
        instructions: "Banco X, cédula Y, teléfono Z.",
        seba_entrega: false,
        updated_by: "sup-1",
      });
      expect(writes[0].payload).not.toHaveProperty("key");
      expect(writes[0].filters).toEqual([["key", "pago_movil"]]);
    });

    it("updatePaymentMethod con un borrador inválido: lanza y NO escribe", async () => {
      const { client, writes } = fakeSupabase({ rows: [{ key: "x" }] });

      await expect(
        updatePaymentMethod(client, SUPERVISOR, "pago_movil", { ...PAYMENT_EDIT, instructions: "   " })
      ).rejects.toThrow(/datos que recibe el cliente/);
      await expect(updatePaymentMethod(client, SUPERVISOR, "cashea", PAYMENT_EDIT)).rejects.toThrow(
        /se configura aparte/
      );

      expect(writes).toHaveLength(0);
    });

    it("setPaymentMethodActive", async () => {
      const { client, writes } = fakeSupabase({ rows: [{ key: "zelle" }] });

      await setPaymentMethodActive(client, SUPERVISOR, "zelle", false);

      expect(writes[0]).toMatchObject({ table: "payment_methods", op: "update", selected: "key" });
      expect(writes[0].payload).toEqual({ is_active: false, updated_by: "sup-1" });
      expect(writes[0].filters).toEqual([["key", "zelle"]]);
    });

    it("deletePaymentMethod borra por clave", async () => {
      const { client, writes } = fakeSupabase({ rows: [{ key: "zelle" }] });

      await deletePaymentMethod(client, "zelle");

      expect(writes[0]).toMatchObject({ table: "payment_methods", op: "delete", selected: "key" });
      expect(writes[0].filters).toEqual([["key", "zelle"]]);
    });

    it("updateWelcomeTexts guarda el borrador NORMALIZADO sobre la fila única", async () => {
      const { client, writes } = fakeSupabase({ rows: [{ id: true }] });

      await updateWelcomeTexts(client, SUPERVISOR, { welcomeText: "  Hola\nbuen día ", followups: [" Uno ", "Dos  "] });

      expect(writes[0]).toMatchObject({ table: "agent_settings", op: "update", selected: "id" });
      expect(writes[0].payload).toEqual({
        welcome_text: "Hola\nbuen día",
        welcome_followups: ["Uno", "Dos"],
        updated_by: "sup-1",
        updated_at: expect.any(String),
      });
      expect(writes[0].filters).toEqual([["id", true]]);
    });

    it("setSebaV2Mode", async () => {
      const { client, writes } = fakeSupabase({ rows: [{ id: true }] });

      await setSebaV2Mode(client, SUPERVISOR, "copiloto");

      expect(writes[0].payload).toEqual({ seba_v2_modo: "copiloto", updated_by: "sup-1", updated_at: expect.any(String) });
      expect(writes[0].filters).toEqual([["id", true]]);
    });

    it("updateShadowLimits", async () => {
      const { client, writes } = fakeSupabase({ rows: [{ id: true }] });

      await updateShadowLimits(client, SUPERVISOR, { capUsd: 12.5, samplePct: 30 });

      expect(writes[0].payload).toEqual({
        shadow_daily_cap_usd: 12.5,
        shadow_sample_pct: 30,
        updated_by: "sup-1",
        updated_at: expect.any(String),
      });
      expect(writes[0].filters).toEqual([["id", true]]);
    });

    it("updateCasheaSettings", async () => {
      const { client, writes } = fakeSupabase({ rows: [{ id: true }] });

      await updateCasheaSettings(client, SUPERVISOR, CASHEA_SETTINGS);

      expect(writes[0].payload).toEqual({
        cashea_datos_text: "Dame tu cédula",
        cashea_minimo_usd: 25,
        cashea_seis_cuotas_desde_usd: 100,
        updated_by: "sup-1",
        updated_at: expect.any(String),
      });
      expect(writes[0].filters).toEqual([["id", true]]);
    });
  });

  describe("setAgentAreas", () => {
    it("normaliza con parseAreas: un valor ajeno no viaja, y filtra por el asesor", async () => {
      const { client, writes } = fakeSupabase({ rows: [{ id: "agent-2" }] });

      await setAgentAreas(client, "agent-2", ["reclamos", "cobranza", "pagos", "pagos"] as never);

      expect(writes[0]).toMatchObject({ table: "agents", op: "update", selected: "id" });
      expect(writes[0].payload).toEqual({ areas: ["pagos", "reclamos"] });
      expect(writes[0].filters).toEqual([["id", "agent-2"]]);
    });

    it("sin ningún área escribe un arreglo vacío (un asesor puede quedar sin áreas)", async () => {
      const { client, writes } = fakeSupabase({ rows: [{ id: "agent-2" }] });

      await setAgentAreas(client, "agent-2", []);

      expect(writes[0].payload).toEqual({ areas: [] });
    });

    it("un 42501 (el trigger: un asesor cambiando SUS áreas) se traduce a ConfigWriteDeniedError", async () => {
      const { client } = fakeSupabase({ error: { code: "42501", message: "solo un supervisor" } });

      const error = await setAgentAreas(client, "agent-1", ["pagos"]).catch((e) => e);

      expect(error).toBeInstanceOf(ConfigWriteDeniedError);
      expect(error.message).toBe(CONFIG_WRITE_DENIED_MESSAGE);
    });
  });

  describe("segundas barreras: lanzan y NO escriben", () => {
    it("updateWelcomeTexts con errores de validateWelcomeDraft", async () => {
      const { client, writes } = fakeSupabase({ rows: [{ id: true }] });

      await expect(updateWelcomeTexts(client, SUPERVISOR, { welcomeText: "", followups: ["a", "b"] })).rejects.toThrow(
        "Escribe el mensaje de bienvenida."
      );
      await expect(updateWelcomeTexts(client, SUPERVISOR, { welcomeText: "Hola", followups: ["solo una"] })).rejects.toThrow(
        /al menos 2 frases/
      );
      await expect(
        updateWelcomeTexts(client, SUPERVISOR, { welcomeText: "Hola", followups: ["a", "x".repeat(161)] })
      ).rejects.toThrow("La frase no puede pasar de 160 caracteres.");

      expect(writes).toHaveLength(0);
    });

    it("setSebaV2Mode con un modo desconocido", async () => {
      const { client, writes } = fakeSupabase({ rows: [{ id: true }] });

      await expect(setSebaV2Mode(client, SUPERVISOR, "turbo" as never)).rejects.toThrow("Modo de Seba v2 desconocido.");

      expect(writes).toHaveLength(0);
    });

    it.each([
      [{ capUsd: -1, samplePct: 10 }],
      [{ capUsd: Number.NaN, samplePct: 10 }],
      [{ capUsd: Number.POSITIVE_INFINITY, samplePct: 10 }],
      [{ capUsd: 5, samplePct: 101 }],
      [{ capUsd: 5, samplePct: -1 }],
      [{ capUsd: 5, samplePct: 50.5 }],
      [{ capUsd: 5, samplePct: Number.NaN }],
    ])("updateShadowLimits %j", async (limits) => {
      const { client, writes } = fakeSupabase({ rows: [{ id: true }] });

      await expect(updateShadowLimits(client, SUPERVISOR, limits)).rejects.toThrow(
        "Los límites de la sombra no son válidos."
      );

      expect(writes).toHaveLength(0);
    });

    it("updateShadowLimits acepta los bordes 0 y 100", async () => {
      const { client, writes } = fakeSupabase({ rows: [{ id: true }] });

      await updateShadowLimits(client, SUPERVISOR, { capUsd: 0, samplePct: 0 });
      await updateShadowLimits(client, SUPERVISOR, { capUsd: 5, samplePct: 100 });

      expect(writes).toHaveLength(2);
    });

    it.each([
      [{ ...CASHEA_SETTINGS, datosText: "   " }],
      [{ ...CASHEA_SETTINGS, datosText: "a".repeat(1001) }],
      [{ ...CASHEA_SETTINGS, minimoUsd: -1 }],
      [{ ...CASHEA_SETTINGS, minimoUsd: Number.NaN }],
      [{ ...CASHEA_SETTINGS, seisCuotasDesdeUsd: Number.POSITIVE_INFINITY }],
    ])("updateCasheaSettings %#", async (settings) => {
      const { client, writes } = fakeSupabase({ rows: [{ id: true }] });

      await expect(updateCasheaSettings(client, SUPERVISOR, settings)).rejects.toThrow(
        "Los datos de Cashea no son válidos."
      );

      expect(writes).toHaveLength(0);
    });
  });
});

describe("Sombra y copiloto de Seba v2 (17/11/2026)", () => {
  const ASESOR: Agent = { ...SUPERVISOR, id: "ase-1", role: "agent" };

  describe("saveShadowReview", () => {
    it("hace upsert por draft_id con el agente actual como revisor y pide la fila afectada", async () => {
      const { client, writes } = fakeSupabase({ rows: [{ draft_id: "d-1" }] });

      await saveShadowReview(client, SUPERVISOR, "d-1", {
        veredicto: "cambio_menor",
        errorTipo: "tono",
        correccion: "  Más cercano  ",
        destino: "prompt",
      });

      const write = writes.find((w) => w.table === "shadow_reviews");
      expect(write?.op).toBe("upsert");
      expect(write?.selected).toBeTruthy();
      expect(write?.payload).toMatchObject({
        draft_id: "d-1",
        veredicto: "cambio_menor",
        error_tipo: "tono",
        correccion: "Más cercano",
        destino: "prompt",
        reviewed_by: "sup-1",
      });
    });

    it("«igual» guarda sin tipo de error ni corrección (null, no texto vacío)", async () => {
      const { client, writes } = fakeSupabase({ rows: [{ draft_id: "d-1" }] });

      await saveShadowReview(client, SUPERVISOR, "d-1", { veredicto: "igual", errorTipo: null, correccion: null, destino: null });

      expect(writes[0].payload).toMatchObject({ veredicto: "igual", error_tipo: null, correccion: null, destino: null });
    });

    it("segunda barrera: «no» sin corrección lanza y NO escribe", async () => {
      const { client, writes } = fakeSupabase({ rows: [{ draft_id: "d-1" }] });

      await expect(
        saveShadowReview(client, SUPERVISOR, "d-1", { veredicto: "no", errorTipo: "precio", correccion: "  ", destino: null })
      ).rejects.toThrow("Escribe cómo debió responder Seba.");
      await expect(
        saveShadowReview(client, SUPERVISOR, "d-1", { veredicto: "no", errorTipo: "inventado", correccion: "x", destino: null })
      ).rejects.toThrow(/tipo de error/);
      expect(writes).toHaveLength(0);
    });
  });

  describe("resolveSuggestion", () => {
    it("actualiza SOLO las tres columnas de la sugerencia y SOLO si sigue pendiente", async () => {
      const { client, writes } = fakeSupabase({ rows: [{ id: "d-1" }] });

      const resuelta = await resolveSuggestion(client, ASESOR, "d-1", "enviada");

      expect(resuelta).toBe(true);
      const write = writes.find((w) => w.table === "agent_shadow_drafts");
      expect(write?.op).toBe("update");
      expect(write?.selected).toBeTruthy();
      expect(Object.keys(write?.payload as object).sort()).toEqual([
        "sugerencia_estado",
        "sugerencia_resuelta_at",
        "sugerencia_resuelta_por",
      ]);
      expect(write?.payload).toMatchObject({ sugerencia_estado: "enviada", sugerencia_resuelta_por: "ase-1" });
      expect(write?.filters).toContainEqual(["id", "d-1"]);
      expect(write?.filters).toContainEqual(["sugerencia_estado", "pendiente"]);
    });

    it("con 0 filas devuelve false (otro asesor ya la resolvió) y NO lanza", async () => {
      const { client } = fakeSupabase({ rows: [] });

      await expect(resolveSuggestion(client, ASESOR, "d-1", "descartada")).resolves.toBe(false);
    });

    it("un error real de la base sí lanza", async () => {
      const { client } = fakeSupabase({ rows: null, error: new Error("connection reset") });

      await expect(resolveSuggestion(client, ASESOR, "d-1", "vencida")).rejects.toThrow(/connection reset/);
    });

    it("un estado que no es de resolución (pendiente) no escribe", async () => {
      const { client, writes } = fakeSupabase({ rows: [{ id: "d-1" }] });

      await expect(resolveSuggestion(client, ASESOR, "d-1", "pendiente" as never)).rejects.toThrow(/Estado de sugerencia/);
      expect(writes).toHaveLength(0);
    });
  });
});
