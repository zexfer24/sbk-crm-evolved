import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createQuickReply, deleteQuickReply, updateQuickReply } from "@/lib/mutations";
import { ConfigWriteDeniedError, configErrorMessage } from "@/lib/config-write";

// ---------------------------------------------------------------------------
// T5b, plan "La ronda del cliente" (30/9/2026): mensajes rápidos PERSONALES.
// La migración 20261001010000 le puso `owner_id` a `quick_replies` y cuatro
// políticas con `owner_id is null or owner_id = auth.uid()`. Un UPDATE/DELETE
// sobre un mensaje ajeno (o ya borrado) afecta 0 filas SIN error, así que las
// dos mutaciones piden `.select("id")` y lanzan si vuelve vacío; un INSERT con
// `owner_id` ajeno sí da 42501 por sí solo.
//
// El fake registra operador + columna + valor de cada filtro y las columnas del
// `.select()` (CLAUDE.md, "un fake de Supabase puede tragarse el operador o el
// argumento de un filtro"). Sin `.select()` tras update/delete, `data` es
// `null`, como PostgREST: quitar la verificación pone rojo el test.
// ---------------------------------------------------------------------------

interface Llamada {
  op: "insert" | "update" | "delete";
  table: string;
  payload?: unknown;
  filters: { op: string; column: string; value: unknown }[];
  selected: string | null;
}

function fakeSupabase(options: { rows?: unknown[]; error?: unknown } = {}) {
  const llamadas: Llamada[] = [];

  function builder(table: string, op: Llamada["op"], payload?: unknown) {
    const llamada: Llamada = { op, table, payload, filters: [], selected: null };
    llamadas.push(llamada);
    const b = {
      eq(column: string, value: unknown) {
        llamada.filters.push({ op: "eq", column, value });
        return b;
      },
      select(columns: string) {
        llamada.selected = columns;
        return b;
      },
      then(resolve: (value: { data: unknown; error: unknown }) => unknown) {
        const data = llamada.selected ? (options.rows ?? []) : null;
        return Promise.resolve({ data, error: options.error ?? null }).then(resolve);
      },
    };
    return b;
  }

  const client = {
    from: (table: string) => ({
      insert: (payload: unknown) => builder(table, "insert", payload),
      update: (payload: unknown) => builder(table, "update", payload),
      delete: () => builder(table, "delete"),
    }),
  } as unknown as SupabaseClient;

  return { client, llamadas };
}

const MENSAJE_AJENO = "Este mensaje rápido ya no existe o no es tuyo.";

describe("createQuickReply — dueño del mensaje", () => {
  it("un mensaje personal manda owner_id con el id del asesor", async () => {
    const { client, llamadas } = fakeSupabase();

    await createQuickReply(client, "Buen día", "Buen día, soy Ana.", "agente-1");

    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]).toMatchObject({
      op: "insert",
      table: "quick_replies",
      payload: { label: "Buen día", content: "Buen día, soy Ana.", owner_id: "agente-1" },
    });
  });

  it("un mensaje compartido manda owner_id null", async () => {
    const { client, llamadas } = fakeSupabase();

    await createQuickReply(client, "Horario", "Atendemos de 8 a 18.", null);

    expect((llamadas[0].payload as { owner_id: unknown }).owner_id).toBeNull();
  });

  it("sin ownerId es compartido (llamadores anteriores a T5b)", async () => {
    const { client, llamadas } = fakeSupabase();

    await createQuickReply(client, "Horario", "Atendemos de 8 a 18.");

    expect((llamadas[0].payload as { owner_id: unknown }).owner_id).toBeNull();
  });

  it("lanza el error de la base (p. ej. 42501 por un owner_id ajeno)", async () => {
    const { client } = fakeSupabase({ error: { code: "42501", message: "rls" } });

    await expect(createQuickReply(client, "x", "y", "otro")).rejects.toMatchObject({ code: "42501" });
  });
});

describe("updateQuickReply — filas afectadas", () => {
  it("con 0 filas (ajeno o borrado) lanza el error de permiso con su mensaje", async () => {
    const { client } = fakeSupabase({ rows: [] });

    const error = await updateQuickReply(client, "qr-1", "Nuevo", "Texto").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConfigWriteDeniedError);
    expect((error as Error).message).toBe(MENSAJE_AJENO);
    expect(configErrorMessage(error, "genérico")).toBe(MENSAJE_AJENO);
  });

  it("con 1 fila no lanza, filtra por id y pide el id de vuelta", async () => {
    const { client, llamadas } = fakeSupabase({ rows: [{ id: "qr-1" }] });

    await expect(updateQuickReply(client, "qr-1", "Nuevo", "Texto")).resolves.toBeUndefined();

    expect(llamadas[0]).toMatchObject({
      op: "update",
      table: "quick_replies",
      payload: { label: "Nuevo", content: "Texto" },
      selected: "id",
    });
    expect(llamadas[0].filters).toEqual([{ op: "eq", column: "id", value: "qr-1" }]);
  });

  it("no toca owner_id: editar no cambia el tipo del mensaje", async () => {
    const { client, llamadas } = fakeSupabase({ rows: [{ id: "qr-1" }] });

    await updateQuickReply(client, "qr-1", "Nuevo", "Texto");

    expect(Object.keys(llamadas[0].payload as object).sort()).toEqual(["content", "label"]);
  });

  it("un error de la base sigue lanzando el error de la base, no el de permiso", async () => {
    const { client } = fakeSupabase({ error: { code: "57014", message: "timeout" } });

    await expect(updateQuickReply(client, "qr-1", "a", "b")).rejects.toMatchObject({ code: "57014" });
  });
});

describe("deleteQuickReply — filas afectadas", () => {
  it("con 0 filas lanza el error de permiso con su mensaje", async () => {
    const { client } = fakeSupabase({ rows: [] });

    const error = await deleteQuickReply(client, "qr-1").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConfigWriteDeniedError);
    expect((error as Error).message).toBe(MENSAJE_AJENO);
  });

  it("con 1 fila no lanza, filtra por id y pide el id de vuelta", async () => {
    const { client, llamadas } = fakeSupabase({ rows: [{ id: "qr-1" }] });

    await expect(deleteQuickReply(client, "qr-1")).resolves.toBeUndefined();

    expect(llamadas[0]).toMatchObject({ op: "delete", table: "quick_replies", selected: "id" });
    expect(llamadas[0].filters).toEqual([{ op: "eq", column: "id", value: "qr-1" }]);
  });
});
