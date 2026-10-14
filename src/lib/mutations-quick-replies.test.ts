import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createQuickReply, deleteQuickReply, updateQuickReply, uploadQuickReplyPhoto } from "@/lib/mutations";
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
      payload: { label: "Buen día", content: "Buen día, soy Ana.", owner_id: "agente-1", media_paths: [] },
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

    const error = await updateQuickReply(client, "qr-1", "Nuevo", "Texto", []).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConfigWriteDeniedError);
    expect((error as Error).message).toBe(MENSAJE_AJENO);
    expect(configErrorMessage(error, "genérico")).toBe(MENSAJE_AJENO);
  });

  it("con 1 fila no lanza, filtra por id y pide el id de vuelta", async () => {
    const { client, llamadas } = fakeSupabase({ rows: [{ id: "qr-1" }] });

    await expect(updateQuickReply(client, "qr-1", "Nuevo", "Texto", [])).resolves.toBeUndefined();

    expect(llamadas[0]).toMatchObject({
      op: "update",
      table: "quick_replies",
      payload: { label: "Nuevo", content: "Texto", media_paths: [] },
      selected: "id",
    });
    expect(llamadas[0].filters).toEqual([{ op: "eq", column: "id", value: "qr-1" }]);
  });

  it("no toca owner_id: editar no cambia el tipo del mensaje", async () => {
    const { client, llamadas } = fakeSupabase({ rows: [{ id: "qr-1" }] });

    await updateQuickReply(client, "qr-1", "Nuevo", "Texto", []);

    expect(Object.keys(llamadas[0].payload as object).sort()).toEqual(["content", "label", "media_paths"]);
  });

  it("un error de la base sigue lanzando el error de la base, no el de permiso", async () => {
    const { client } = fakeSupabase({ error: { code: "57014", message: "timeout" } });

    await expect(updateQuickReply(client, "qr-1", "a", "b", [])).rejects.toMatchObject({ code: "57014" });
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

// ---------------------------------------------------------------------------
// 14/10/2026, rama "Respuestas rápidas con fotos": `media_paths` (hasta 10
// rutas `quick-replies/…` del bucket). Una respuesta puede ser SOLO fotos
// (content vacío); sin fotos el texto sigue siendo obligatorio. Las fotos
// nunca se borran del bucket: un mensaje ya enviado apunta a la misma ruta.
// ---------------------------------------------------------------------------

const RUTA_A = "quick-replies/aaaa.jpg";
const RUTA_B = "quick-replies/bbbb.png";
const SIN_TEXTO_NI_FOTOS = "Escribe el mensaje o agrega al menos una foto.";
const RUTA_INVALIDA = "Una de las fotos tiene una ruta inválida.";
const MAXIMO = "Máximo 10 fotos por respuesta rápida.";
const rutas = (n: number) => Array.from({ length: n }, (_, i) => `quick-replies/${i}.jpg`);

describe("createQuickReply — fotos", () => {
  it("manda media_paths en el payload, en el orden dado", async () => {
    const { client, llamadas } = fakeSupabase();

    await createQuickReply(client, "Cascos", "Mira estos", null, [RUTA_A, RUTA_B]);

    expect((llamadas[0].payload as { media_paths: unknown }).media_paths).toEqual([RUTA_A, RUTA_B]);
  });

  it("sin fotos manda media_paths vacío (llamadores anteriores)", async () => {
    const { client, llamadas } = fakeSupabase();

    await createQuickReply(client, "Horario", "Atendemos de 8 a 18.");

    expect((llamadas[0].payload as { media_paths: unknown }).media_paths).toEqual([]);
  });

  it("permite SOLO fotos: content vacío con al menos una foto", async () => {
    const { client, llamadas } = fakeSupabase();

    await createQuickReply(client, "Solo fotos", "", null, [RUTA_A]);

    expect(llamadas[0].payload).toMatchObject({ content: "", media_paths: [RUTA_A] });
  });

  it("sin texto ni fotos lanza, y no toca la base", async () => {
    const { client, llamadas } = fakeSupabase();

    await expect(createQuickReply(client, "Vacío", "   ", null, [])).rejects.toThrow(SIN_TEXTO_NI_FOTOS);
    expect(llamadas).toHaveLength(0);
  });

  it("más de 10 fotos lanza; diez exactas pasan", async () => {
    const { client, llamadas } = fakeSupabase();

    await expect(createQuickReply(client, "x", "y", null, rutas(11))).rejects.toThrow(MAXIMO);
    expect(llamadas).toHaveLength(0);

    await createQuickReply(client, "x", "y", null, rutas(10));
    expect(llamadas).toHaveLength(1);
  });

  it("una ruta fuera de quick-replies/ o con .. lanza", async () => {
    const { client, llamadas } = fakeSupabase();

    await expect(createQuickReply(client, "x", "y", null, ["outbound/conv-1/a.jpg"])).rejects.toThrow(RUTA_INVALIDA);
    await expect(createQuickReply(client, "x", "y", null, ["quick-replies/../a.jpg"])).rejects.toThrow(RUTA_INVALIDA);
    expect(llamadas).toHaveLength(0);
  });
});

describe("updateQuickReply — fotos", () => {
  it("manda media_paths y conserva el filtro por id y la verificación de filas", async () => {
    const { client, llamadas } = fakeSupabase({ rows: [{ id: "qr-1" }] });

    await updateQuickReply(client, "qr-1", "Nuevo", "Texto", [RUTA_A]);

    expect(llamadas[0].payload).toEqual({ label: "Nuevo", content: "Texto", media_paths: [RUTA_A] });
    expect(llamadas[0].filters).toEqual([{ op: "eq", column: "id", value: "qr-1" }]);
    expect(llamadas[0].selected).toBe("id");
  });

  it("quitar todas las fotos manda un arreglo vacío (no omite la columna)", async () => {
    const { client, llamadas } = fakeSupabase({ rows: [{ id: "qr-1" }] });

    await updateQuickReply(client, "qr-1", "Nuevo", "Texto", []);

    expect((llamadas[0].payload as { media_paths: unknown }).media_paths).toEqual([]);
  });

  it("permite SOLO fotos", async () => {
    const { client, llamadas } = fakeSupabase({ rows: [{ id: "qr-1" }] });

    await updateQuickReply(client, "qr-1", "Solo fotos", "  ", [RUTA_A]);

    expect(llamadas[0].payload).toMatchObject({ content: "", media_paths: [RUTA_A] });
  });

  it("sin texto ni fotos lanza antes de tocar la base", async () => {
    const { client, llamadas } = fakeSupabase({ rows: [{ id: "qr-1" }] });

    await expect(updateQuickReply(client, "qr-1", "x", "", [])).rejects.toThrow(SIN_TEXTO_NI_FOTOS);
    expect(llamadas).toHaveLength(0);
  });

  it("una ruta inválida o más de 10 fotos lanza", async () => {
    const { client, llamadas } = fakeSupabase({ rows: [{ id: "qr-1" }] });

    await expect(updateQuickReply(client, "qr-1", "x", "y", ["otra/ruta.jpg"])).rejects.toThrow(RUTA_INVALIDA);
    await expect(updateQuickReply(client, "qr-1", "x", "y", rutas(11))).rejects.toThrow(MAXIMO);
    expect(llamadas).toHaveLength(0);
  });
});

describe("deleteQuickReply — no borra las fotos del bucket", () => {
  it("solo borra la fila: un mensaje ya enviado apunta a la misma ruta", async () => {
    const storageRemove = vi.fn();
    const { client, llamadas } = fakeSupabase({ rows: [{ id: "qr-1" }] });
    (client as unknown as { storage: unknown }).storage = { from: () => ({ remove: storageRemove }) };

    await deleteQuickReply(client, "qr-1");

    expect(llamadas).toHaveLength(1);
    expect(storageRemove).not.toHaveBeenCalled();
  });
});

describe("uploadQuickReplyPhoto", () => {
  function fakeStorage(uploadError: unknown = null) {
    const upload = vi.fn().mockResolvedValue({ error: uploadError });
    const from = vi.fn(() => ({ upload }));
    const client = { storage: { from } } as unknown as SupabaseClient;
    return { client, upload, from };
  }
  const archivo = (name: string, type: string, size = 100) => {
    const file = new File([new Uint8Array(1)], name, { type });
    Object.defineProperty(file, "size", { value: size });
    return file;
  };

  it("sube a quick-replies/<uuid>.jpg del bucket con su contentType y devuelve la ruta", async () => {
    const { client, upload, from } = fakeStorage();
    const file = archivo("casco.jpg", "image/jpeg");

    const path = await uploadQuickReplyPhoto(client, file);

    expect(path).toMatch(/^quick-replies\/[0-9a-f-]{36}\.jpg$/);
    expect(from).toHaveBeenCalledWith("whatsapp-media");
    expect(upload).toHaveBeenCalledWith(path, file, { contentType: "image/jpeg" });
  });

  it("un PNG termina en .png", async () => {
    const { client } = fakeStorage();
    await expect(uploadQuickReplyPhoto(client, archivo("a.png", "image/png"))).resolves.toMatch(/\.png$/);
  });

  it("rechaza un tipo no admitido o un peso de más SIN subir nada", async () => {
    const { client, upload } = fakeStorage();

    await expect(uploadQuickReplyPhoto(client, archivo("a.webp", "image/webp"))).rejects.toThrow(
      "Solo fotos JPG o PNG."
    );
    await expect(uploadQuickReplyPhoto(client, archivo("b.jpg", "image/jpeg", 5 * 1024 * 1024 + 1))).rejects.toThrow(
      "La foto «b.jpg» pesa más de 5 MB."
    );
    expect(upload).not.toHaveBeenCalled();
  });

  it("si el bucket rechaza la subida, lanza ese error", async () => {
    const { client } = fakeStorage({ message: "bucket caído" });

    await expect(uploadQuickReplyPhoto(client, archivo("a.jpg", "image/jpeg"))).rejects.toMatchObject({
      message: "bucket caído",
    });
  });
});
