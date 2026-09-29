import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchPlaybooks } from "@/lib/data";

// ---------------------------------------------------------------------------
// T1, plan "El catálogo configurado sale siempre" (21/9/2026). La lectura del
// PANEL (`fetchPlaybooks`) tiene que traer `cede_al_inventario` en el select
// y mapearla a `cedeAlInventario` en el tipo de dominio -- sin esto, T4 (la
// casilla del editor de escenarios, código de una tarea posterior del mismo
// plan) no tendría ningún dato que pintar ni que guardar.
// ---------------------------------------------------------------------------

interface FakeRow {
  id: string;
  name: string;
  trigger_description: string;
  response_text: string;
  attachment_url: string | null;
  attachment_type: string | null;
  after_send: string;
  is_active: boolean;
  cede_al_inventario: boolean;
  disponible_en_espera?: boolean;
  ai_playbook_tags: { tag: { id: string; label: string; color: string } | null }[] | null;
}

function createFakeSupabase(result: { data: FakeRow[] | null; error: unknown }) {
  const calls: { select?: string; order?: string } = {};

  const client = {
    from(table: string) {
      if (table !== "ai_playbooks") throw new Error(`tabla inesperada: ${table}`);
      return {
        select(columns: string) {
          calls.select = columns;
          return {
            order(column: string) {
              calls.order = column;
              return Promise.resolve(result);
            },
          };
        },
      };
    },
  };

  return { client: client as unknown as SupabaseClient, calls };
}

describe("fetchPlaybooks", () => {
  it("pide la columna cede_al_inventario en el select", async () => {
    const { client, calls } = createFakeSupabase({ data: [], error: null });

    await fetchPlaybooks(client);

    expect(calls.select).toContain("cede_al_inventario");
  });

  it("mapea cede_al_inventario a cedeAlInventario, en los dos valores posibles", async () => {
    const rows: FakeRow[] = [
      {
        id: "pb-1",
        name: "Catálogo general",
        trigger_description: "el cliente pide el catálogo",
        response_text: "Acá tienes nuestro catálogo.",
        attachment_url: null,
        attachment_type: null,
        after_send: "wait",
        is_active: true,
        cede_al_inventario: true,
        ai_playbook_tags: null,
      },
      {
        id: "pb-2",
        name: "Ubicación",
        trigger_description: "el cliente pregunta dónde queda la tienda",
        response_text: "Estamos en Barinas.",
        attachment_url: null,
        attachment_type: null,
        after_send: "wait",
        is_active: true,
        cede_al_inventario: false,
        ai_playbook_tags: null,
      },
    ];
    const { client } = createFakeSupabase({ data: rows, error: null });

    const result = await fetchPlaybooks(client);

    expect(result.map((p) => ({ id: p.id, cedeAlInventario: p.cedeAlInventario }))).toEqual([
      { id: "pb-1", cedeAlInventario: true },
      { id: "pb-2", cedeAlInventario: false },
    ]);
  });
});

// T5, plan "Seba encuentra, no insiste, y el mostrador no deja a nadie
// esperando" (28/9/2026, D7): el panel tiene que traer y mapear
// `disponible_en_espera`, o el interruptor del editor no tendría qué pintar.
describe("fetchPlaybooks — disponible_en_espera (T5)", () => {
  it("pide la columna disponible_en_espera en el select", async () => {
    const { client, calls } = createFakeSupabase({ data: [], error: null });

    await fetchPlaybooks(client);

    expect(calls.select).toContain("disponible_en_espera");
  });

  it("mapea disponible_en_espera a disponibleEnEspera, en los dos valores", async () => {
    const base = {
      trigger_description: "cuando aplica",
      response_text: "texto",
      attachment_url: null,
      attachment_type: null,
      after_send: "wait",
      is_active: true,
      cede_al_inventario: false,
      ai_playbook_tags: null,
    };
    const { client } = createFakeSupabase({
      data: [
        { ...base, id: "pb-1", name: "Ubicación", disponible_en_espera: true },
        { ...base, id: "pb-2", name: "REDES", disponible_en_espera: false },
      ],
      error: null,
    });

    const result = await fetchPlaybooks(client);

    expect(result.map((p) => ({ id: p.id, disponibleEnEspera: p.disponibleEnEspera }))).toEqual([
      { id: "pb-1", disponibleEnEspera: true },
      { id: "pb-2", disponibleEnEspera: false },
    ]);
  });
});
