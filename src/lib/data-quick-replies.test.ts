import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchMensajesRapidosMasUsados, fetchQuickReplies } from "@/lib/data";

// T5b, plan "La ronda del cliente" (30/9/2026): `fetchQuickReplies` pide
// `owner_id` (null = compartido) y lo mapea a `ownerId`. La RLS ya filtra los
// personales ajenos; acá solo se fija la forma de la consulta y del mapeo.

function fakeSupabase(rows: unknown[]) {
  const calls: { table?: string; columns?: string; order?: string } = {};
  const client = {
    from(table: string) {
      calls.table = table;
      return {
        select(columns: string) {
          calls.columns = columns;
          return {
            order(column: string) {
              calls.order = column;
              return Promise.resolve({ data: rows, error: null });
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

describe("fetchQuickReplies", () => {
  it("pide owner_id, ordena por label y mapea ownerId (null = compartido)", async () => {
    const { client, calls } = fakeSupabase([
      { id: "1", label: "Horario", content: "8 a 18", owner_id: null, media_paths: [] },
      { id: "2", label: "Buen día", content: "Buen día, soy Ana", owner_id: "agente-1", media_paths: [] },
    ]);

    const result = await fetchQuickReplies(client);

    expect(calls.table).toBe("quick_replies");
    expect(calls.columns).toMatch(/\bowner_id\b/);
    expect(calls.order).toBe("label");
    expect(result).toEqual([
      { id: "1", label: "Horario", content: "8 a 18", ownerId: null, mediaPaths: [] },
      { id: "2", label: "Buen día", content: "Buen día, soy Ana", ownerId: "agente-1", mediaPaths: [] },
    ]);
  });

  // 14/10/2026, "Respuestas rápidas con fotos": la columna `media_paths` (text[],
  // hasta 10 rutas `quick-replies/…`) se pide y se mapea a `mediaPaths`.
  it("pide media_paths y las mapea a mediaPaths, en orden", async () => {
    const { client, calls } = fakeSupabase([
      { id: "1", label: "Cascos", content: "", owner_id: null, media_paths: ["quick-replies/a.jpg", "quick-replies/b.png"] },
    ]);

    const result = await fetchQuickReplies(client);

    expect(calls.columns).toMatch(/\bmedia_paths\b/);
    expect(result[0].mediaPaths).toEqual(["quick-replies/a.jpg", "quick-replies/b.png"]);
  });

  it("un media_paths null o que no es arreglo se lee como sin fotos (defensivo)", async () => {
    const { client } = fakeSupabase([
      { id: "1", label: "A", content: "x", owner_id: null, media_paths: null },
      { id: "2", label: "B", content: "x", owner_id: null },
      { id: "3", label: "C", content: "x", owner_id: null, media_paths: "quick-replies/a.jpg" },
      { id: "4", label: "D", content: "x", owner_id: null, media_paths: ["quick-replies/a.jpg", null, 5] },
    ]);

    const result = await fetchQuickReplies(client);

    expect(result.map((r) => r.mediaPaths)).toEqual([[], [], [], ["quick-replies/a.jpg"]]);
  });
});

// T8, plan "Presupuestos y mensajes rápidos" (21/10/2026): el ranking «Más
// usados» sale de la RPC `quick_replies_mas_usados`, que corta el conteo en
// `p_hasta` (la medianoche de Caracas que baja de `useInboxDay`). `quick_reply_
// uses` no se lee con select directo: la base no da permiso.
describe("fetchMensajesRapidosMasUsados", () => {
  function fakeRpc(result: { data: unknown; error: unknown }) {
    const calls: { fn?: string; args?: unknown } = {};
    const client = {
      rpc(fn: string, args: unknown) {
        calls.fn = fn;
        calls.args = args;
        return Promise.resolve(result);
      },
    } as unknown as SupabaseClient;
    return { client, calls };
  }

  it("llama a la RPC con p_hasta, 30 días y 5 de límite", async () => {
    const { client, calls } = fakeRpc({ data: [], error: null });

    await fetchMensajesRapidosMasUsados(client, "2026-10-21T04:00:00.000Z");

    expect(calls.fn).toBe("quick_replies_mas_usados");
    expect(calls.args).toEqual({ p_hasta: "2026-10-21T04:00:00.000Z", p_dias: 30, p_limite: 5 });
  });

  it("convierte usos (bigint, llega como texto o número) a número y respeta el orden", async () => {
    const { client } = fakeRpc({
      data: [
        { quick_reply_id: "a", usos: "12" },
        { quick_reply_id: "b", usos: 3 },
      ],
      error: null,
    });

    const result = await fetchMensajesRapidosMasUsados(client, "2026-10-21T04:00:00.000Z");

    expect(result).toEqual([
      { quickReplyId: "a", usos: 12 },
      { quickReplyId: "b", usos: 3 },
    ]);
  });

  it("una respuesta null (quien consulta no es agente) es una lista vacía", async () => {
    const { client } = fakeRpc({ data: null, error: null });

    expect(await fetchMensajesRapidosMasUsados(client, "2026-10-21T04:00:00.000Z")).toEqual([]);
  });

  it("lanza el error de la base", async () => {
    const { client } = fakeRpc({ data: null, error: { code: "57014", message: "timeout" } });

    await expect(fetchMensajesRapidosMasUsados(client, "2026-10-21T04:00:00.000Z")).rejects.toMatchObject({
      code: "57014",
    });
  });
});
