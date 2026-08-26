import { beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createPlaybook, updatePlaybook, type PlaybookDraft } from "@/lib/mutations";

// ---------------------------------------------------------------------------
// La sincronización de etiquetas de un escenario, que es donde está el riesgo:
// el atajo de borrar todo y reinsertar deja un hueco en el que el escenario no
// tiene ninguna etiqueta, y si el insert falla ahí se queda para siempre.
// Estas pruebas fijan que solo se toca la diferencia.
// ---------------------------------------------------------------------------

interface Escritura {
  op: "select" | "delete" | "insert";
  payload?: unknown;
  tagIds?: string[];
}

let existentes: string[] = [];
let escrituras: Escritura[] = [];

function createFakeSupabase() {
  const client = {
    from(table: string) {
      if (table === "ai_playbooks") {
        return {
          insert: () => ({
            select: () => ({ single: async () => ({ data: { id: "pb-nuevo" }, error: null }) }),
          }),
          update: () => ({ eq: async () => ({ error: null }) }),
        };
      }

      if (table === "ai_playbook_tags") {
        return {
          select: () => ({
            eq: async () => {
              escrituras.push({ op: "select" });
              return { data: existentes.map((tag_id) => ({ tag_id })), error: null };
            },
          }),
          delete: () => ({
            eq: () => ({
              in: async (_col: string, tagIds: string[]) => {
                escrituras.push({ op: "delete", tagIds });
                return { error: null };
              },
            }),
          }),
          insert: async (payload: { playbook_id: string; tag_id: string }[]) => {
            escrituras.push({ op: "insert", payload, tagIds: payload.map((row) => row.tag_id) });
            return { error: null };
          },
        };
      }

      throw new Error(`Fake Supabase: tabla no soportada en este test: ${table}`);
    },
  };

  return client as unknown as SupabaseClient;
}

function draft(tagIds: string[]): PlaybookDraft {
  return {
    name: "Catálogo general",
    triggerDescription: "el cliente pide el catálogo",
    responseText: "Por acá te dejo el catálogo:",
    attachmentUrl: null,
    attachmentType: null,
    afterSend: "wait",
    tagIds,
  };
}

const soloEscrituras = () => escrituras.filter((e) => e.op !== "select");

beforeEach(() => {
  existentes = [];
  escrituras = [];
});

describe("createPlaybook — etiquetas", () => {
  it("guarda las etiquetas del escenario recién creado, contra el id que devolvió el insert", async () => {
    await createPlaybook(createFakeSupabase(), draft(["tag-envio", "tag-foto"]));

    expect(soloEscrituras()).toEqual([
      {
        op: "insert",
        tagIds: ["tag-envio", "tag-foto"],
        payload: [
          { playbook_id: "pb-nuevo", tag_id: "tag-envio" },
          { playbook_id: "pb-nuevo", tag_id: "tag-foto" },
        ],
      },
    ]);
  });

  it("un escenario sin etiquetas no escribe en la tabla de relación", async () => {
    await createPlaybook(createFakeSupabase(), draft([]));

    expect(soloEscrituras()).toEqual([]);
  });
});

describe("updatePlaybook — etiquetas", () => {
  /**
   * El punto de toda esta función: la etiqueta que ya estaba y sigue estando
   * no se toca. Borrarla y volver a ponerla la dejaría, por un instante, sin
   * existir — y con una escritura fallida, sin existir del todo.
   */
  it("solo toca la diferencia: agrega lo que falta y quita lo que sobra", async () => {
    existentes = ["tag-envio", "tag-viejo"];

    await updatePlaybook(createFakeSupabase(), "pb-1", draft(["tag-envio", "tag-nuevo"]));

    expect(soloEscrituras()).toEqual([
      { op: "delete", tagIds: ["tag-viejo"] },
      { op: "insert", tagIds: ["tag-nuevo"], payload: [{ playbook_id: "pb-1", tag_id: "tag-nuevo" }] },
    ]);
  });

  it("guardar sin cambiar las etiquetas no escribe nada", async () => {
    existentes = ["tag-envio"];

    await updatePlaybook(createFakeSupabase(), "pb-1", draft(["tag-envio"]));

    expect(soloEscrituras()).toEqual([]);
  });

  it("quitarlas todas borra las que había", async () => {
    existentes = ["tag-envio", "tag-foto"];

    await updatePlaybook(createFakeSupabase(), "pb-1", draft([]));

    expect(soloEscrituras()).toEqual([{ op: "delete", tagIds: ["tag-envio", "tag-foto"] }]);
  });

  /** Quitar va antes de agregar: al revés, un cambio grande abulta la tabla de más antes de podarla. */
  it("quita antes de agregar", async () => {
    existentes = ["tag-viejo"];

    await updatePlaybook(createFakeSupabase(), "pb-1", draft(["tag-nuevo"]));

    expect(soloEscrituras().map((e) => e.op)).toEqual(["delete", "insert"]);
  });
});
