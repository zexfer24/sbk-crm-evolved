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
  markSuggestionReviewed,
  setAgentActive,
  setAgentToolEnabled,
  setAiGloballyEnabled,
  setCatalogLinkActive,
  setDailySpendCap,
  setKnowledgeEntryActive,
  setLessonActive,
  setPlaybookActive,
  updateBusinessHours,
  updateCatalogLink,
  updateKnowledgeEntry,
  updateModelPricing,
  updateNote,
  updatePlaybook,
  type PlaybookDraft,
} from "@/lib/mutations";
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
