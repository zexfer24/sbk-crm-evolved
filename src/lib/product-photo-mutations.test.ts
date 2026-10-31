import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProductPhoto } from "@/lib/types";
import { ConfigWriteDeniedError } from "@/lib/config-write";

vi.mock("@/lib/product-photo-image", () => ({
  renderProductPhotoJpeg: vi.fn(),
}));

import { renderProductPhotoJpeg } from "@/lib/product-photo-image";
import {
  deleteProductPhoto,
  replaceProductPhoto,
  setPrimaryProductPhoto,
  uploadProductPhoto,
} from "@/lib/product-photo-mutations";

/**
 * T3, plan «Cada repuesto con su foto» (30/10/2026). El fake registra, EN
 * ORDEN, cada llamada con tabla, operación, columnas y VALORES (trampa del
 * 20/9/2026: un fake que se traga el operador o el argumento no atrapa una
 * inversión). `calls` mezcla storage y tabla para poder verificar el orden
 * "subir, actualizar la fila".
 */

const PRODUCT = "11111111-1111-1111-1111-111111111111";
const COMPRESSED = { blob: { size: 234_567, type: "image/jpeg" } as unknown as Blob, width: 1600, height: 1200 };
const FILE = { type: "image/png", size: 5000 } as unknown as Blob;

type Call =
  | { kind: "upload"; bucket: string; path: string; file: unknown; options: unknown }
  | { kind: "remove"; bucket: string }
  | { kind: "count"; table: string; columns: string; options: unknown; filters: [string, unknown][] }
  | { kind: "insert"; table: string; payload: Record<string, unknown>; selected: string | null }
  | { kind: "update" | "delete"; table: string; payload?: unknown; filters: [string, unknown][]; selected: string | null };

interface Options {
  count?: number | null;
  countError?: unknown;
  uploadError?: unknown;
  insertError?: unknown;
  updateError?: unknown;
  /** Filas devueltas por update/delete con `.select()`. */
  rows?: unknown[];
  /** Lo que la fila insertada tiene como `is_primary` cuando el payload no lo dice (la primera nace principal por trigger). */
  defaultPrimary?: boolean;
}

function fakeSupabase(options: Options = {}) {
  const calls: Call[] = [];

  function builder(table: string) {
    let current: Call | null = null;
    const b: Record<string, unknown> = {
      select(columns: string, opts?: unknown) {
        if (current) {
          (current as { selected: string | null }).selected = columns;
        } else {
          current = { kind: "count", table, columns, options: opts, filters: [] };
          calls.push(current);
        }
        return b;
      },
      insert(payload: Record<string, unknown>) {
        current = { kind: "insert", table, payload, selected: null };
        calls.push(current);
        return b;
      },
      update(payload: unknown) {
        current = { kind: "update", table, payload, filters: [], selected: null };
        calls.push(current);
        return b;
      },
      delete() {
        current = { kind: "delete", table, filters: [], selected: null };
        calls.push(current);
        return b;
      },
      eq(column: string, value: unknown) {
        (current as { filters: [string, unknown][] }).filters.push([column, value]);
        return b;
      },
      single() {
        const payload = (current as { payload: Record<string, unknown> }).payload;
        if (options.insertError) return Promise.resolve({ data: null, error: options.insertError });
        return Promise.resolve({
          data: {
            id: "new-photo",
            storage_path: payload.storage_path,
            is_primary: payload.is_primary ?? options.defaultPrimary ?? false,
            position: payload.position,
          },
          error: null,
        });
      },
      then(resolve: (value: unknown) => unknown) {
        if (current?.kind === "count") {
          return Promise.resolve({
            count: options.count === undefined ? 0 : options.count,
            error: options.countError ?? null,
          }).then(resolve);
        }
        const error = current?.kind === "update" ? (options.updateError ?? null) : null;
        return Promise.resolve({ data: error ? null : (options.rows ?? []), error }).then(resolve);
      },
    };
    return b;
  }

  const client = {
    from: (table: string) => builder(table),
    storage: {
      from: (bucket: string) => ({
        upload: (path: string, file: unknown, uploadOptions: unknown) => {
          calls.push({ kind: "upload", bucket, path, file, options: uploadOptions });
          return Promise.resolve({ data: options.uploadError ? null : { path }, error: options.uploadError ?? null });
        },
        remove: () => {
          calls.push({ kind: "remove", bucket });
          return Promise.resolve({ data: [], error: null });
        },
        getPublicUrl: (path: string) => ({ data: { publicUrl: `https://storage.test/product-photos/${path}` } }),
      }),
    },
  } as unknown as SupabaseClient;

  return { client, calls };
}

beforeEach(() => {
  vi.mocked(renderProductPhotoJpeg).mockReset();
  vi.mocked(renderProductPhotoJpeg).mockResolvedValue(COMPRESSED);
});

describe("uploadProductPhoto", () => {
  it("sube el JPEG comprimido al bucket público, en una ruta del producto, sin pisar nada", async () => {
    const { client, calls } = fakeSupabase();
    await uploadProductPhoto(client, PRODUCT, FILE);

    expect(renderProductPhotoJpeg).toHaveBeenCalledWith(FILE);
    const upload = calls.find((c) => c.kind === "upload");
    expect(upload).toMatchObject({
      kind: "upload",
      bucket: "product-photos",
      file: COMPRESSED.blob,
      options: { contentType: "image/jpeg", upsert: false },
    });
    expect((upload as { path: string }).path).toMatch(
      /^11111111-1111-1111-1111-111111111111\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/
    );
  });

  it("inserta la fila con producto, ruta, medidas, peso y position = fotos que ya tenía", async () => {
    const { client, calls } = fakeSupabase({ count: 3 });
    await uploadProductPhoto(client, PRODUCT, FILE);

    const count = calls.find((c) => c.kind === "count");
    expect(count).toMatchObject({
      table: "product_photos",
      columns: "id",
      options: { count: "exact", head: true },
      filters: [["product_id", PRODUCT]],
    });
    const upload = calls.find((c) => c.kind === "upload") as { path: string };
    const insert = calls.find((c) => c.kind === "insert");
    expect(insert).toMatchObject({
      table: "product_photos",
      payload: {
        product_id: PRODUCT,
        storage_path: upload.path,
        width: 1600,
        height: 1200,
        bytes: 234_567,
        position: 3,
      },
      selected: "id, storage_path, is_primary, position",
    });
    // Nunca manda is_primary en una subida común: lo decide el trigger.
    expect((insert as { payload: Record<string, unknown> }).payload).not.toHaveProperty("is_primary");
  });

  it("lee el conteo antes de subir y sube antes de insertar", async () => {
    const { client, calls } = fakeSupabase();
    await uploadProductPhoto(client, PRODUCT, FILE);
    expect(calls.map((c) => c.kind)).toEqual(["count", "upload", "insert"]);
  });

  it("un conteo nulo cuenta como cero", async () => {
    const { client, calls } = fakeSupabase({ count: null });
    await uploadProductPhoto(client, PRODUCT, FILE);
    const insert = calls.find((c) => c.kind === "insert") as unknown as { payload: { position: number } };
    expect(insert.payload.position).toBe(0);
  });

  it("devuelve la foto con su URL pública", async () => {
    const { client, calls } = fakeSupabase({ count: 1, defaultPrimary: false });
    const photo = await uploadProductPhoto(client, PRODUCT, FILE);
    const upload = calls.find((c) => c.kind === "upload") as { path: string };
    expect(photo).toEqual({
      id: "new-photo",
      storagePath: upload.path,
      url: `https://storage.test/product-photos/${upload.path}`,
      isPrimary: false,
      position: 1,
    });
  });

  it("falla con un mensaje claro si no hay manera de bajarla a 1 MB, sin subir nada", async () => {
    vi.mocked(renderProductPhotoJpeg).mockResolvedValue(null);
    const { client, calls } = fakeSupabase();
    await expect(uploadProductPhoto(client, PRODUCT, FILE)).rejects.toThrow(
      "No se pudo reducir la foto a menos de 1 MB."
    );
    expect(calls.some((c) => c.kind === "upload" || c.kind === "insert")).toBe(false);
  });

  it("deja pasar el error de formato que lanza la compresión", async () => {
    vi.mocked(renderProductPhotoJpeg).mockRejectedValue(new Error("Formato no admitido: usa JPG, PNG o WebP."));
    const { client } = fakeSupabase();
    await expect(uploadProductPhoto(client, PRODUCT, FILE)).rejects.toThrow("Formato no admitido");
  });

  it("un rechazo de permisos del bucket se vuelve ConfigWriteDeniedError con el mensaje exacto", async () => {
    const { client, calls } = fakeSupabase({
      uploadError: { message: "new row violates row-level security policy", statusCode: "403" },
    });
    const error = await uploadProductPhoto(client, PRODUCT, FILE).catch((e) => e);
    expect(error).toBeInstanceOf(ConfigWriteDeniedError);
    expect(error.message).toBe("Solo un supervisor o administrador puede cambiar las fotos.");
    expect(calls.some((c) => c.kind === "insert")).toBe(false);
  });

  it("otro error del bucket se lanza con un mensaje que lo nombra", async () => {
    const { client } = fakeSupabase({ uploadError: { message: "Payload too large", statusCode: "413" } });
    const error = await uploadProductPhoto(client, PRODUCT, FILE).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ConfigWriteDeniedError);
    expect(error.message).toContain("Payload too large");
  });

  it("el tope de 6 fotos se relanza con el texto del trigger, tal cual", async () => {
    const { client } = fakeSupabase({
      insertError: { code: "23514", message: "Este repuesto ya tiene 6 fotos." },
    });
    await expect(uploadProductPhoto(client, PRODUCT, FILE)).rejects.toThrow(
      new Error("Este repuesto ya tiene 6 fotos.")
    );
  });

  it("un 42501 al insertar se vuelve ConfigWriteDeniedError con el mensaje exacto", async () => {
    const { client } = fakeSupabase({
      insertError: { code: "42501", message: 'new row violates row-level security policy for table "product_photos"' },
    });
    const error = await uploadProductPhoto(client, PRODUCT, FILE).catch((e) => e);
    expect(error).toBeInstanceOf(ConfigWriteDeniedError);
    expect(error.message).toBe("Solo un supervisor o administrador puede cambiar las fotos.");
  });

  it("si el insert falla NO intenta borrar el objeto (el bucket no tiene política de borrado)", async () => {
    const { client, calls } = fakeSupabase({ insertError: { code: "XX000", message: "boom" } });
    await expect(uploadProductPhoto(client, PRODUCT, FILE)).rejects.toBeDefined();
    expect(calls.some((c) => c.kind === "remove")).toBe(false);
  });

  it("un error al contar las fotos se lanza y no sube nada", async () => {
    const { client, calls } = fakeSupabase({ countError: { code: "XX000", message: "sin red" } });
    await expect(uploadProductPhoto(client, PRODUCT, FILE)).rejects.toBeDefined();
    expect(calls.some((c) => c.kind === "upload")).toBe(false);
  });
});

describe("deleteProductPhoto", () => {
  it("borra la fila por id pidiendo las filas afectadas", async () => {
    const { client, calls } = fakeSupabase({ rows: [{ id: "p-1" }] });
    await deleteProductPhoto(client, "p-1");
    expect(calls).toEqual([
      { kind: "delete", table: "product_photos", filters: [["id", "p-1"]], selected: "id" },
    ]);
  });

  it("con 0 filas afectadas (la RLS lo ignoró) lanza ConfigWriteDeniedError", async () => {
    const { client } = fakeSupabase({ rows: [] });
    const error = await deleteProductPhoto(client, "p-1").catch((e) => e);
    expect(error).toBeInstanceOf(ConfigWriteDeniedError);
    expect(error.message).toBe("Solo un supervisor o administrador puede cambiar las fotos.");
  });

  it("NO toca el storage: los mensajes ya enviados referencian el objeto", async () => {
    const { client, calls } = fakeSupabase({ rows: [{ id: "p-1" }] });
    await deleteProductPhoto(client, "p-1");
    expect(calls.some((c) => c.kind === "remove")).toBe(false);
  });
});

describe("setPrimaryProductPhoto", () => {
  it("marca la foto como principal por id pidiendo las filas afectadas", async () => {
    const { client, calls } = fakeSupabase({ rows: [{ id: "p-2" }] });
    await setPrimaryProductPhoto(client, "p-2");
    expect(calls).toEqual([
      {
        kind: "update",
        table: "product_photos",
        payload: { is_primary: true },
        filters: [["id", "p-2"]],
        selected: "id",
      },
    ]);
  });

  it("con 0 filas afectadas lanza ConfigWriteDeniedError", async () => {
    const { client } = fakeSupabase({ rows: [] });
    await expect(setPrimaryProductPhoto(client, "p-2")).rejects.toBeInstanceOf(ConfigWriteDeniedError);
  });
});

describe("replaceProductPhoto", () => {
  const OLD_PRIMARY: ProductPhoto = {
    id: "old-1",
    storagePath: `${PRODUCT}/old.jpg`,
    url: "https://storage.test/old",
    isPrimary: true,
    position: 2,
  };

  it("ACTUALIZA la misma fila con la ruta nueva y las medidas, por id, pidiendo las filas afectadas", async () => {
    const { client, calls } = fakeSupabase({ rows: [{ id: "old-1" }] });
    await replaceProductPhoto(client, OLD_PRIMARY, PRODUCT, FILE);

    expect(calls.map((c) => c.kind)).toEqual(["upload", "update"]);
    const upload = calls[0] as { bucket: string; path: string; options: unknown };
    expect(upload.bucket).toBe("product-photos");
    expect(upload.path).toMatch(/^11111111-1111-1111-1111-111111111111\/[0-9a-f-]{36}\.jpg$/);
    expect(upload.options).toEqual({ contentType: "image/jpeg", upsert: false });
    expect(calls[1]).toEqual({
      kind: "update",
      table: "product_photos",
      payload: { storage_path: upload.path, width: 1600, height: 1200, bytes: 234_567 },
      filters: [["id", "old-1"]],
      selected: "id, storage_path, is_primary, position",
    });
  });

  it("no inserta ni borra filas: el tope de 6 fotos no se toca", async () => {
    const { client, calls } = fakeSupabase({ rows: [{ id: "old-1" }] });
    await replaceProductPhoto(client, OLD_PRIMARY, PRODUCT, FILE);
    expect(calls.some((c) => c.kind === "insert" || c.kind === "delete" || c.kind === "count")).toBe(false);
  });

  it("conserva id, position e isPrimary y devuelve la URL de la ruta nueva", async () => {
    const { client, calls } = fakeSupabase({ rows: [{ id: "old-1" }] });
    const photo = await replaceProductPhoto(client, { ...OLD_PRIMARY, isPrimary: false, position: 5 }, PRODUCT, FILE);
    const upload = calls[0] as { path: string };
    expect(photo).toEqual({
      id: "old-1",
      storagePath: upload.path,
      url: `https://storage.test/product-photos/${upload.path}`,
      isPrimary: false,
      position: 5,
    });
    // El update jamás manda is_primary ni position: no hay nada que reasignar.
    const update = calls[1] as { payload: Record<string, unknown> };
    expect(update.payload).not.toHaveProperty("is_primary");
    expect(update.payload).not.toHaveProperty("position");
  });

  it("con 0 filas afectadas (la RLS lo ignoró) lanza ConfigWriteDeniedError con el mensaje exacto", async () => {
    const { client } = fakeSupabase({ rows: [] });
    const error = await replaceProductPhoto(client, OLD_PRIMARY, PRODUCT, FILE).catch((e) => e);
    expect(error).toBeInstanceOf(ConfigWriteDeniedError);
    expect(error.message).toBe("Solo un supervisor o administrador puede cambiar las fotos.");
  });

  it("si el update da error lo lanza, y no toca la fila vieja ni el storage", async () => {
    const { client, calls } = fakeSupabase({ updateError: { code: "XX000", message: "boom" } });
    await expect(replaceProductPhoto(client, OLD_PRIMARY, PRODUCT, FILE)).rejects.toMatchObject({ message: "boom" });
    expect(calls.some((c) => c.kind === "delete" || c.kind === "remove")).toBe(false);
  });

  it("si no se puede comprimir o el bucket rechaza, no toca la tabla", async () => {
    vi.mocked(renderProductPhotoJpeg).mockResolvedValueOnce(null);
    const sinComprimir = fakeSupabase();
    await expect(replaceProductPhoto(sinComprimir.client, OLD_PRIMARY, PRODUCT, FILE)).rejects.toThrow(
      "No se pudo reducir la foto a menos de 1 MB."
    );
    expect(sinComprimir.calls).toEqual([]);

    const rechazado = fakeSupabase({ uploadError: { message: "new row violates row-level security policy", statusCode: "403" } });
    await expect(replaceProductPhoto(rechazado.client, OLD_PRIMARY, PRODUCT, FILE)).rejects.toBeInstanceOf(
      ConfigWriteDeniedError
    );
    expect(rechazado.calls.map((c) => c.kind)).toEqual(["upload"]);
  });

  it("nunca borra objetos del storage", async () => {
    const { client, calls } = fakeSupabase({ rows: [{ id: "old-1" }] });
    await replaceProductPhoto(client, OLD_PRIMARY, PRODUCT, FILE);
    expect(calls.some((c) => c.kind === "remove")).toBe(false);
  });
});
