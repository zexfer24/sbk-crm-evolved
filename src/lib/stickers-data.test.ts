import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchStickers } from "@/lib/stickers-data";

interface RawStickerRow {
  id: string;
  storage_path: string;
  name: string | null;
  animated: boolean;
  created_by: string | null;
  created_at: string;
}

function createFakeSupabase(rows: RawStickerRow[]) {
  const calls: { table: string; orderColumn: string; orderAscending: boolean | undefined }[] = [];

  const client = {
    from(table: string) {
      if (table !== "stickers") throw new Error(`Fake Supabase: tabla no soportada en este test: ${table}`);
      return {
        select: () => ({
          order: (orderColumn: string, options?: { ascending?: boolean }) => {
            calls.push({ table, orderColumn, orderAscending: options?.ascending });
            return Promise.resolve({ data: rows, error: null });
          },
        }),
      };
    },
  };

  return { client: client as unknown as SupabaseClient, calls };
}

describe("fetchStickers", () => {
  it("mapea storage_path a la ruta propia del CRM y el resto de los campos", async () => {
    const { client } = createFakeSupabase([
      {
        id: "sticker-1",
        storage_path: "stickers/abc-123.webp",
        name: "Moto contenta",
        animated: false,
        created_by: "agent-1",
        created_at: "2026-09-09T10:00:00.000Z",
      },
    ]);

    const stickers = await fetchStickers(client);

    expect(stickers).toEqual([
      {
        id: "sticker-1",
        url: "/api/media/stickers/abc-123.webp",
        name: "Moto contenta",
        animated: false,
        createdBy: "agent-1",
        createdAt: "2026-09-09T10:00:00.000Z",
      },
    ]);
  });

  it("pide los más recientes primero", async () => {
    const { client, calls } = createFakeSupabase([]);
    await fetchStickers(client);
    expect(calls).toEqual([{ table: "stickers", orderColumn: "created_at", orderAscending: false }]);
  });

  it("un error de la consulta se propaga tal cual", async () => {
    const client = {
      from: () => ({
        select: () => ({
          order: () => Promise.resolve({ data: null, error: new Error("sin permiso") }),
        }),
      }),
    } as unknown as SupabaseClient;

    await expect(fetchStickers(client)).rejects.toThrow("sin permiso");
  });
});
