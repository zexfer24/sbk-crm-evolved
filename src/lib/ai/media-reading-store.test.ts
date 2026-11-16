import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// El módulo real de lectura arrastra el SDK de IA; acá solo importa qué
// recibe y qué devuelve. `transcribirAudio`/`leerImagen` nunca lanzan en
// producción, pero un test fuerza el rechazo para probar la red del catch.
const transcribirAudioMock = vi.fn();
const leerImagenMock = vi.fn();
vi.mock("@/lib/ai/media-reading", () => ({
  transcribirAudio: (...args: unknown[]) => transcribirAudioMock(...args),
  leerImagen: (...args: unknown[]) => leerImagenMock(...args),
}));

vi.mock("@/lib/ai/model", () => ({
  visionModelId: () => "openai/gpt-5.4",
}));

import { kindDeLectura, registrarFalloDeDescarga, registrarLectura } from "./media-reading-store";

interface Filtro {
  op: "eq";
  column: string;
  value: unknown;
}

interface Llamada {
  table: string;
  op: "upsert" | "update" | "select";
  payload?: Record<string, unknown>;
  options?: Record<string, unknown>;
  filtros: Filtro[];
}

/**
 * Fake de Supabase que registra tabla, operación, payload, opciones del
 * upsert y operador + columna + VALOR de cada filtro (un fake que se traga el
 * argumento de un `.eq()` no prueba nada: regla del repo, 20/9/2026).
 */
function crearAdminFalso(config: {
  upsertError?: { message: string } | null;
  settings?: { data: { daily_spend_cap_usd: number | null } | null; error: { message: string } | null };
  gasto?: { data: number | null; error: { message: string } | null };
  precios?: { data: { input_price_per_million: number; output_price_per_million: number } | null; error?: { message: string } | null };
  updateResult?: { data: { message_id: string }[] | null; error: { message: string } | null };
}) {
  const llamadas: Llamada[] = [];
  const rpcs: string[] = [];

  const admin = {
    from(table: string) {
      return {
        upsert(payload: Record<string, unknown>, options?: Record<string, unknown>) {
          llamadas.push({ table, op: "upsert", payload, options, filtros: [] });
          return Promise.resolve({ error: config.upsertError ?? null });
        },
        update(payload: Record<string, unknown>) {
          const llamada: Llamada = { table, op: "update", payload, filtros: [] };
          llamadas.push(llamada);
          const builder = {
            eq(column: string, value: unknown) {
              llamada.filtros.push({ op: "eq", column, value });
              return builder;
            },
            select() {
              return Promise.resolve(
                config.updateResult ?? { data: [{ message_id: String(llamada.filtros[0]?.value) }], error: null },
              );
            },
          };
          return builder;
        },
        select(columns: string) {
          const llamada: Llamada = { table, op: "select", payload: { columns }, filtros: [] };
          llamadas.push(llamada);
          const builder = {
            eq(column: string, value: unknown) {
              llamada.filtros.push({ op: "eq", column, value });
              return builder;
            },
            maybeSingle() {
              if (table === "agent_settings") {
                return Promise.resolve(config.settings ?? { data: { daily_spend_cap_usd: null }, error: null });
              }
              if (table === "model_pricing") {
                return Promise.resolve({ data: null, error: null, ...(config.precios ?? {}) });
              }
              return Promise.resolve({ data: null, error: null });
            },
          };
          return builder;
        },
      };
    },
    rpc(name: string) {
      rpcs.push(name);
      return Promise.resolve(config.gasto ?? { data: 0, error: null });
    },
  };

  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    admin: admin as any,
    llamadas,
    rpcs,
    upserts: () => llamadas.filter((l) => l.op === "upsert"),
    updates: () => llamadas.filter((l) => l.op === "update"),
  };
}

const MSG = "11111111-1111-1111-1111-111111111111";
const CONV = "22222222-2222-2222-2222-222222222222";
const bytes = new Uint8Array([1, 2, 3]);

const lecturaAudio = {
  status: "ok",
  text: "hola quiero un casco",
  model: "openai/whisper-1",
  audioSeconds: 7.5,
  costUsd: 0.00075,
  durationMs: 1800,
};

const lecturaImagen = {
  status: "ok",
  text: "Casco negro integral",
  fields: { tipo: "producto" },
  model: "openai/gpt-5.4",
  inputTokens: 900,
  outputTokens: 80,
  costUsd: 0.0031,
  durationMs: 2500,
};

const PRECIOS = { data: { input_price_per_million: 2.5, output_price_per_million: 15 }, error: null };

beforeEach(() => {
  delete process.env.AI_MEDIA_READING;
  transcribirAudioMock.mockReset().mockResolvedValue(lecturaAudio);
  leerImagenMock.mockReset().mockResolvedValue(lecturaImagen);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AI_MEDIA_READING;
});

describe("kindDeLectura", () => {
  it("audio e imagen se leen; el resto no", () => {
    expect(kindDeLectura("audio")).toBe("audio");
    expect(kindDeLectura("image")).toBe("image");
    for (const otro of ["sticker", "video", "document", "text", null, undefined]) {
      expect(kindDeLectura(otro)).toBeNull();
    }
  });
});

describe("registrarLectura", () => {
  it("audio: primero la fila pendiente, después el update con la transcripción", async () => {
    const fake = crearAdminFalso({});
    await registrarLectura(fake.admin, { messageId: MSG, conversationId: CONV, kind: "audio", bytes, mime: "audio/ogg" });

    const [pendiente] = fake.upserts();
    expect(pendiente.table).toBe("message_readings");
    expect(pendiente.payload).toEqual({
      message_id: MSG,
      conversation_id: CONV,
      kind: "audio",
      status: "pendiente",
    });
    expect(pendiente.options).toEqual({ onConflict: "message_id", ignoreDuplicates: true });

    expect(transcribirAudioMock).toHaveBeenCalledWith(bytes, "audio/ogg");
    expect(leerImagenMock).not.toHaveBeenCalled();

    const [actualizar] = fake.updates();
    expect(actualizar.table).toBe("message_readings");
    expect(actualizar.payload).toMatchObject({
      status: "ok",
      model: "openai/whisper-1",
      text: "hola quiero un casco",
      fields: null,
      error: null,
      duration_ms: 1800,
      audio_seconds: 7.5,
      input_tokens: null,
      output_tokens: null,
      cost_usd: 0.00075,
    });
    expect(typeof actualizar.payload?.updated_at).toBe("string");
    expect(actualizar.filtros).toEqual([{ op: "eq", column: "message_id", value: MSG }]);

    // El orden importa: la fila pendiente se escribe ANTES de llamar al modelo.
    expect(fake.llamadas.indexOf(pendiente)).toBeLessThan(fake.llamadas.indexOf(actualizar));
  });

  it("imagen: lee la tarifa de model_pricing con el id del modelo de visión y guarda campos y tokens", async () => {
    const fake = crearAdminFalso({ precios: PRECIOS });
    await registrarLectura(fake.admin, { messageId: MSG, conversationId: CONV, kind: "image", bytes, mime: "image/jpeg" });

    const consultaPrecios = fake.llamadas.find((l) => l.table === "model_pricing");
    expect(consultaPrecios?.payload).toEqual({ columns: "input_price_per_million, output_price_per_million" });
    expect(consultaPrecios?.filtros).toEqual([{ op: "eq", column: "model", value: "openai/gpt-5.4" }]);

    expect(leerImagenMock).toHaveBeenCalledWith(bytes, "image/jpeg", { input: 2.5, output: 15 });
    expect(transcribirAudioMock).not.toHaveBeenCalled();

    expect(fake.updates()[0].payload).toMatchObject({
      status: "ok",
      model: "openai/gpt-5.4",
      text: "Casco negro integral",
      fields: { tipo: "producto" },
      input_tokens: 900,
      output_tokens: 80,
      cost_usd: 0.0031,
      duration_ms: 2500,
      audio_seconds: null,
    });
  });

  it("imagen sin fila de tarifa: lee igual, sin precios", async () => {
    const fake = crearAdminFalso({ precios: { data: null, error: null } });
    await registrarLectura(fake.admin, { messageId: MSG, conversationId: CONV, kind: "image", bytes, mime: "image/png" });
    expect(leerImagenMock).toHaveBeenCalledWith(bytes, "image/png", undefined);
  });

  it("imagen con error al leer la tarifa: lee igual, sin precios", async () => {
    const fake = crearAdminFalso({ precios: { data: null, error: { message: "boom" } } });
    await registrarLectura(fake.admin, { messageId: MSG, conversationId: CONV, kind: "image", bytes, mime: "image/png" });
    expect(leerImagenMock).toHaveBeenCalledWith(bytes, "image/png", undefined);
  });

  it("AI_MEDIA_READING=off: no toca la base ni el modelo", async () => {
    process.env.AI_MEDIA_READING = "off";
    const fake = crearAdminFalso({});
    await registrarLectura(fake.admin, { messageId: MSG, conversationId: CONV, kind: "audio", bytes, mime: "audio/ogg" });
    await registrarFalloDeDescarga(fake.admin, { messageId: MSG, conversationId: CONV, kind: "audio" });
    expect(fake.llamadas).toEqual([]);
    expect(fake.rpcs).toEqual([]);
    expect(transcribirAudioMock).not.toHaveBeenCalled();
    expect(leerImagenMock).not.toHaveBeenCalled();
  });

  describe("tope de gasto diario", () => {
    it("gasto igual al tope: fallo/tope_de_gasto y no llama al modelo", async () => {
      const fake = crearAdminFalso({
        settings: { data: { daily_spend_cap_usd: 5 }, error: null },
        gasto: { data: 5, error: null },
      });
      await registrarLectura(fake.admin, { messageId: MSG, conversationId: CONV, kind: "audio", bytes, mime: "audio/ogg" });

      expect(transcribirAudioMock).not.toHaveBeenCalled();
      expect(fake.rpcs).toEqual(["agent_spend_today"]);
      const consulta = fake.llamadas.find((l) => l.table === "agent_settings");
      expect(consulta?.filtros).toEqual([{ op: "eq", column: "id", value: true }]);
      expect(fake.updates()).toHaveLength(1);
      expect(fake.updates()[0].payload).toMatchObject({ status: "fallo", error: "tope_de_gasto" });
      expect(fake.updates()[0].filtros).toEqual([{ op: "eq", column: "message_id", value: MSG }]);
    });

    it("gasto como texto numérico (numeric de Postgres) también compara", async () => {
      const fake = crearAdminFalso({
        settings: { data: { daily_spend_cap_usd: 5 }, error: null },
        gasto: { data: "7.25" as unknown as number, error: null },
      });
      await registrarLectura(fake.admin, { messageId: MSG, conversationId: CONV, kind: "audio", bytes, mime: "audio/ogg" });
      expect(transcribirAudioMock).not.toHaveBeenCalled();
      expect(fake.updates()[0].payload).toMatchObject({ error: "tope_de_gasto" });
    });

    it("tope null: sin tope, lee", async () => {
      const fake = crearAdminFalso({
        settings: { data: { daily_spend_cap_usd: null }, error: null },
        gasto: { data: 999, error: null },
      });
      await registrarLectura(fake.admin, { messageId: MSG, conversationId: CONV, kind: "audio", bytes, mime: "audio/ogg" });
      expect(transcribirAudioMock).toHaveBeenCalledTimes(1);
    });

    it("gasto menor que el tope: lee", async () => {
      const fake = crearAdminFalso({
        settings: { data: { daily_spend_cap_usd: 5 }, error: null },
        gasto: { data: 4.99, error: null },
      });
      await registrarLectura(fake.admin, { messageId: MSG, conversationId: CONV, kind: "audio", bytes, mime: "audio/ogg" });
      expect(transcribirAudioMock).toHaveBeenCalledTimes(1);
    });

    it("error en la RPC del gasto: fallo/tope_no_consultable, sin modelo", async () => {
      const fake = crearAdminFalso({
        settings: { data: { daily_spend_cap_usd: 5 }, error: null },
        gasto: { data: null, error: { message: "rpc caída" } },
      });
      await registrarLectura(fake.admin, { messageId: MSG, conversationId: CONV, kind: "image", bytes, mime: "image/jpeg" });
      expect(leerImagenMock).not.toHaveBeenCalled();
      expect(fake.updates()[0].payload).toMatchObject({ status: "fallo", error: "tope_no_consultable" });
    });

    it("error al leer agent_settings: fallo/tope_no_consultable, sin modelo", async () => {
      const fake = crearAdminFalso({
        settings: { data: null, error: { message: "tabla caída" } },
      });
      await registrarLectura(fake.admin, { messageId: MSG, conversationId: CONV, kind: "audio", bytes, mime: "audio/ogg" });
      expect(transcribirAudioMock).not.toHaveBeenCalled();
      expect(fake.updates()[0].payload).toMatchObject({ status: "fallo", error: "tope_no_consultable" });
    });
  });

  it("si el upsert de pendiente falla: no llama al modelo, no lanza y avisa", async () => {
    const fake = crearAdminFalso({ upsertError: { message: 'relation "message_readings" does not exist' } });
    await expect(
      registrarLectura(fake.admin, { messageId: MSG, conversationId: CONV, kind: "audio", bytes, mime: "audio/ogg" }),
    ).resolves.toBeUndefined();
    expect(transcribirAudioMock).not.toHaveBeenCalled();
    expect(fake.rpcs).toEqual([]);
    const lineas = (console.error as unknown as { mock: { calls: string[][] } }).mock.calls.map((c) => c[0]);
    expect(lineas.some((l) => l.includes("lectura_no_registrada"))).toBe(true);
  });

  it("si transcribirAudio lanza: no lanza hacia afuera y deja fallo/excepcion", async () => {
    transcribirAudioMock.mockRejectedValue(new Error("explotó"));
    const fake = crearAdminFalso({});
    await expect(
      registrarLectura(fake.admin, { messageId: MSG, conversationId: CONV, kind: "audio", bytes, mime: "audio/ogg" }),
    ).resolves.toBeUndefined();
    const ultimo = fake.updates().at(-1);
    expect(ultimo?.payload).toMatchObject({ status: "fallo", error: "excepcion" });
    expect(ultimo?.filtros).toEqual([{ op: "eq", column: "message_id", value: MSG }]);
  });

  it("si el update final da 0 filas: no lanza y deja el aviso", async () => {
    const fake = crearAdminFalso({ updateResult: { data: [], error: null } });
    await expect(
      registrarLectura(fake.admin, { messageId: MSG, conversationId: CONV, kind: "audio", bytes, mime: "audio/ogg" }),
    ).resolves.toBeUndefined();
    const lineas = (console.error as unknown as { mock: { calls: string[][] } }).mock.calls.map((c) => c[0]);
    expect(lineas.some((l) => l.includes("lectura_no_guardada"))).toBe(true);
  });

  it("si el update final da error: no lanza y deja el aviso", async () => {
    const fake = crearAdminFalso({ updateResult: { data: null, error: { message: "boom" } } });
    await expect(
      registrarLectura(fake.admin, { messageId: MSG, conversationId: CONV, kind: "image", bytes, mime: "image/jpeg" }),
    ).resolves.toBeUndefined();
    const lineas = (console.error as unknown as { mock: { calls: string[][] } }).mock.calls.map((c) => c[0]);
    expect(lineas.some((l) => l.includes("lectura_no_guardada"))).toBe(true);
  });

  it("nunca loguea el texto leído ni los campos", async () => {
    const fake = crearAdminFalso({ updateResult: { data: [], error: null } });
    await registrarLectura(fake.admin, { messageId: MSG, conversationId: CONV, kind: "audio", bytes, mime: "audio/ogg" });
    const todo = [
      ...(console.error as unknown as { mock: { calls: string[][] } }).mock.calls,
      ...(console.log as unknown as { mock: { calls: string[][] } }).mock.calls,
    ]
      .map((c) => c[0])
      .join("\n");
    expect(todo).not.toContain("hola quiero un casco");
  });
});

describe("registrarFalloDeDescarga", () => {
  it("escribe fallo/descarga sobrescribiendo la fila", async () => {
    const fake = crearAdminFalso({});
    await registrarFalloDeDescarga(fake.admin, { messageId: MSG, conversationId: CONV, kind: "image" });

    expect(fake.upserts()).toHaveLength(1);
    const [fallo] = fake.upserts();
    expect(fallo.table).toBe("message_readings");
    expect(fallo.payload).toMatchObject({
      message_id: MSG,
      conversation_id: CONV,
      kind: "image",
      status: "fallo",
      error: "descarga",
    });
    expect(typeof fallo.payload?.updated_at).toBe("string");
    // Sin ignoreDuplicates: debe sobrescribir una fila previa.
    expect(fallo.options).toEqual({ onConflict: "message_id" });
    expect(transcribirAudioMock).not.toHaveBeenCalled();
  });

  it("no lanza aunque el upsert falle", async () => {
    const fake = crearAdminFalso({ upsertError: { message: "boom" } });
    await expect(
      registrarFalloDeDescarga(fake.admin, { messageId: MSG, conversationId: CONV, kind: "audio" }),
    ).resolves.toBeUndefined();
  });

  it("no lanza aunque el cliente de base lance", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const roto: any = {
      from() {
        throw new Error("sin conexión");
      },
    };
    await expect(
      registrarFalloDeDescarga(roto, { messageId: MSG, conversationId: CONV, kind: "audio" }),
    ).resolves.toBeUndefined();
  });
});
