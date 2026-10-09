import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  downloadMetaMedia,
  getMetaMediaUrl,
  markWhatsappRead,
  MetaApiError,
  metaErrorCode,
  ESPERAS_429_MS,
  rewriteD360MediaUrl,
  sendTypingIndicator,
  sendWhatsappMedia,
  sendWhatsappText,
} from "@/lib/whatsapp/meta-client";
import type { WhatsappCredentials } from "@/lib/whatsapp/provider";
import { log } from "@/lib/log";
import { __reiniciarFilasParaTests } from "@/lib/whatsapp/fila-por-numero";

// Plan "SBK CRM pasa a 360dialog" (8/10/2026), T1: el cliente recibe las
// credenciales ya resueltas (`provider.ts`) en vez de un token suelto.
const META: WhatsappCredentials = { provider: "meta", accessToken: "token-123", graphVersion: "v21.0" };
const D360: WhatsappCredentials = {
  provider: "360dialog",
  apiKey: "key-360",
  baseUrl: "https://waba-v2.360dialog.io",
};

/**
 * T3.1 (4/9/2026): doble check azul y "escribiendo…". A diferencia del resto
 * de meta-client.ts, estas dos funciones nunca lanzan — un check o un typing
 * que no salió no puede tumbar la bandeja ni el turno de la IA. Se prueba el
 * payload exacto (Meta lo exige tal cual) y que ningún fallo —4xx/5xx de
 * Meta, o la red que no respondió— se escape como excepción.
 */

const fetchMock = vi.fn();

beforeEach(() => {
  // Hotfix 2 (9/10/2026): la fila por número vive en memoria del proceso;
  // cada test arranca con las filas y las horas de último 200 vacías.
  __reiniciarFilasParaTests();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ success: true }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("markWhatsappRead", () => {
  it("manda status:read con el wamid del mensaje entrante", async () => {
    await markWhatsappRead("phone-id-1", META, "wamid.ENTRANTE");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://graph.facebook.com/v21.0/phone-id-1/messages");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer token-123");
    expect(JSON.parse(init.body)).toEqual({
      messaging_product: "whatsapp",
      status: "read",
      message_id: "wamid.ENTRANTE",
    });
  });

  it("un rechazo de Meta (4xx) no lanza: solo queda en el registro", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: "Ese mensaje ya no existe." } }),
    });

    await expect(markWhatsappRead("phone-id-1", META, "wamid.VIEJO")).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      "whatsapp_marcar_leido_fallido",
      expect.objectContaining({ status: 400 })
    );
  });

  it("un fallo de red no lanza: solo queda en el registro", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    fetchMock.mockRejectedValue(new TypeError("fetch failed: ETIMEDOUT"));

    await expect(markWhatsappRead("phone-id-1", META, "wamid.X")).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith("whatsapp_marcar_leido_fallido", expect.any(Object));
  });
});

describe("sendTypingIndicator", () => {
  it("manda el mismo cuerpo que marcar leído, más typing_indicator", async () => {
    await sendTypingIndicator("phone-id-1", META, "wamid.ENTRANTE");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://graph.facebook.com/v21.0/phone-id-1/messages");
    expect(JSON.parse(init.body)).toEqual({
      messaging_product: "whatsapp",
      status: "read",
      message_id: "wamid.ENTRANTE",
      typing_indicator: { type: "text" },
    });
  });

  it("un rechazo de Meta no lanza y no interrumpe al que llama", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: "Token vencido." } }),
    });

    await expect(sendTypingIndicator("phone-id-1", META, "wamid.X")).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      "whatsapp_typing_fallido",
      expect.objectContaining({ status: 401 })
    );
  });

  it("un fallo de red tampoco lanza", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));

    await expect(sendTypingIndicator("phone-id-1", META, "wamid.X")).resolves.toBeUndefined();
  });
});

/**
 * T3a ("Seis frentes del buzón", 8/9/2026): un sticker se manda por `link`
 * como cualquier otro adjunto, pero SIN `caption` — Meta lo rechaza si lo
 * lleva. `audio` ya tenía esta misma restricción; `sticker` la suma.
 */
describe("sendWhatsappMedia — sticker", () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: "wamid.STICKER" }] }),
    });
  });

  it("manda {link} sin caption aunque se le pase uno", async () => {
    const result = await sendWhatsappMedia(
      "phone-id-1",
      META,
      "584121234567",
      "sticker",
      "https://signed.example.com/sticker.webp",
      "un pie que Meta va a rechazar"
    );

    expect(result).toEqual({ whatsappMessageId: "wamid.STICKER" });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      messaging_product: "whatsapp",
      to: "584121234567",
      type: "sticker",
      sticker: { link: "https://signed.example.com/sticker.webp" },
    });
  });

  it("sin pie tampoco manda caption (mismo camino)", async () => {
    await sendWhatsappMedia("phone-id-1", META, "584121234567", "sticker", "https://signed.example.com/s.webp");

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body).sticker).toEqual({ link: "https://signed.example.com/s.webp" });
  });
});

// ---------------------------------------------------------------------------
// 360dialog (plan 8/10/2026, T1): mismo cuerpo de la Cloud API, otro host y
// otra autenticación. La llave de 360dialog va en `D360-API-KEY` y NUNCA en
// `Authorization` (y solo viaja a `D360_BASE_URL`, D4).
// ---------------------------------------------------------------------------

describe("envío con Meta (sin regresión)", () => {
  it("sendWhatsappText va a graph.facebook.com con Bearer y sin D360-API-KEY", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ messages: [{ id: "wamid.M" }] }) });

    await sendWhatsappText("phone-id-1", META, "+58 412-123-4567", "hola");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://graph.facebook.com/v21.0/phone-id-1/messages");
    expect(init.headers.Authorization).toBe("Bearer token-123");
    expect(init.headers["D360-API-KEY"]).toBeUndefined();
  });

  it("respeta la versión de la Graph API de las credenciales", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ messages: [{ id: "wamid.M" }] }) });

    await sendWhatsappText("phone-id-1", { ...META, graphVersion: "v23.0" }, "584121234567", "hola");

    expect(fetchMock.mock.calls[0][0]).toBe("https://graph.facebook.com/v23.0/phone-id-1/messages");
  });
});

describe("envío con 360dialog", () => {
  it("sendWhatsappText va a {baseUrl}/messages con D360-API-KEY, sin Authorization y con messaging_product", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ messages: [{ id: "wamid.D" }] }) });

    const result = await sendWhatsappText("phone-id-ignorado", D360, "+58 412-123-4567", "hola");

    expect(result).toEqual({ whatsappMessageId: "wamid.D" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://waba-v2.360dialog.io/messages");
    expect(init.method).toBe("POST");
    expect(init.headers["D360-API-KEY"]).toBe("key-360");
    expect(init.headers.Authorization).toBeUndefined();
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({
      messaging_product: "whatsapp",
      to: "584121234567",
      type: "text",
      text: { body: "hola" },
    });
  });

  it("usa la baseUrl de las credenciales", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ messages: [{ id: "wamid.D" }] }) });

    await sendWhatsappText("p", { ...D360, baseUrl: "https://sandbox.example.io" }, "584121234567", "hola");

    expect(fetchMock.mock.calls[0][0]).toBe("https://sandbox.example.io/messages");
  });

  it("markWhatsappRead va a {baseUrl}/messages con la llave de 360dialog", async () => {
    await markWhatsappRead("p", D360, "wamid.ENTRANTE", "584121234567");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://waba-v2.360dialog.io/messages");
    expect(init.headers["D360-API-KEY"]).toBe("key-360");
    expect(init.headers.Authorization).toBeUndefined();
    expect(JSON.parse(init.body)).toEqual({
      messaging_product: "whatsapp",
      status: "read",
      message_id: "wamid.ENTRANTE",
    });
  });

  it("sendTypingIndicator va a {baseUrl}/messages con la llave de 360dialog", async () => {
    await sendTypingIndicator("p", D360, "wamid.ENTRANTE");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://waba-v2.360dialog.io/messages");
    expect(init.headers["D360-API-KEY"]).toBe("key-360");
    expect(init.headers.Authorization).toBeUndefined();
    expect(JSON.parse(init.body).typing_indicator).toEqual({ type: "text" });
  });

  it("un 401 con cuerpo que no es JSON lanza MetaApiError con status 401 (D8)", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => {
        throw new SyntaxError("Unexpected token U in JSON");
      },
    });

    const err = await sendWhatsappText("p", D360, "584121234567", "hola").catch((e) => e);

    expect(err).toBeInstanceOf(MetaApiError);
    expect(err.status).toBe(401);
    expect(err.message).toBe("360dialog respondió HTTP 401 sin detalle");
    expect(err.details).toBeNull();
  });

  it("un 401 sin JSON con credenciales de Meta nombra a Meta en el mensaje", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => {
        throw new SyntaxError("Unexpected token U in JSON");
      },
    });

    const err = await sendWhatsappText("p", META, "584121234567", "hola").catch((e) => e);

    expect(err).toBeInstanceOf(MetaApiError);
    expect(err.message).toBe("Meta respondió HTTP 401 sin detalle");
  });

  it("metaErrorCode lee error.code de un error 360dialog", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: "Fuera de ventana", code: 131047 } }),
    });

    const err = await sendWhatsappText("p", D360, "584121234567", "hola").catch((e) => e);

    expect(err).toBeInstanceOf(MetaApiError);
    expect(metaErrorCode(err)).toBe(131047);
  });
});

describe("getMetaMediaUrl", () => {
  it("meta: GET a graph con Bearer", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ url: "https://x/y", mime_type: "image/jpeg" }) });

    const r = await getMetaMediaUrl("MEDIA1", META);

    expect(r).toEqual({ url: "https://x/y", mimeType: "image/jpeg" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://graph.facebook.com/v21.0/MEDIA1");
    expect(init.headers.Authorization).toBe("Bearer token-123");
  });

  it("360dialog: GET a {baseUrl}/{mediaId} con D360-API-KEY y sin Authorization", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ url: "https://x/y", mime_type: "image/png" }) });

    const r = await getMetaMediaUrl("MEDIA1", D360);

    expect(r).toEqual({ url: "https://x/y", mimeType: "image/png" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://waba-v2.360dialog.io/MEDIA1");
    expect(init.headers["D360-API-KEY"]).toBe("key-360");
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("un error sin JSON lanza MetaApiError con su status (D8)", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => {
        throw new SyntaxError("no es JSON");
      },
    });

    const err = await getMetaMediaUrl("MEDIA1", D360).catch((e) => e);

    expect(err).toBeInstanceOf(MetaApiError);
    expect(err.status).toBe(401);
  });
});

describe("rewriteD360MediaUrl", () => {
  const BASE = "https://waba-v2.360dialog.io";

  it("reescribe lookaside.fbsbx.com al host de 360dialog y quita las barras escapadas", () => {
    expect(
      rewriteD360MediaUrl(
        "https:\\/\\/lookaside.fbsbx.com\\/whatsapp_business\\/attachments\\/?mid=1&ext=2&hash=3",
        BASE
      )
    ).toBe("https://waba-v2.360dialog.io/whatsapp_business/attachments/?mid=1&ext=2&hash=3");
  });

  it("una URL que ya apunta al host de 360dialog queda igual", () => {
    const url = "https://waba-v2.360dialog.io/whatsapp_business/attachments/?mid=1";
    expect(rewriteD360MediaUrl(url, BASE)).toBe(url);
  });

  it("una URL de otro host lanza (la llave no puede viajar a otro lado)", () => {
    expect(() => rewriteD360MediaUrl("https://evil.example/x", BASE)).toThrow(
      "URL de multimedia fuera del host de 360dialog"
    );
  });

  it("no se deja engañar por un host que solo contiene el de 360dialog", () => {
    expect(() => rewriteD360MediaUrl("https://waba-v2.360dialog.io.evil.example/x", BASE)).toThrow();
  });

  it("una cadena que no es URL lanza", () => {
    expect(() => rewriteD360MediaUrl("esto no es una url", BASE)).toThrow();
  });
});

describe("downloadMetaMedia", () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
  });

  it("meta: descarga la URL tal cual con Bearer", async () => {
    const bytes = await downloadMetaMedia("https://lookaside.fbsbx.com/a?b=1", META);

    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://lookaside.fbsbx.com/a?b=1");
    expect(init.headers.Authorization).toBe("Bearer token-123");
  });

  it("360dialog: reescribe el host y manda D360-API-KEY sin Authorization", async () => {
    await downloadMetaMedia("https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1", D360);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://waba-v2.360dialog.io/whatsapp_business/attachments/?mid=1");
    expect(init.headers["D360-API-KEY"]).toBe("key-360");
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("360dialog: una URL de otro host lanza ANTES de llamar a fetch", async () => {
    await expect(downloadMetaMedia("https://evil.example/x", D360)).rejects.toThrow(
      "URL de multimedia fuera del host de 360dialog"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("una descarga fallida lanza MetaApiError con su status", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });

    const err = await downloadMetaMedia("https://lookaside.fbsbx.com/a", META).catch((e) => e);

    expect(err).toBeInstanceOf(MetaApiError);
    expect(err.status).toBe(404);
  });
});


// ---------------------------------------------------------------------------
// 9/10/2026: 360dialog limita por DESTINATARIO ("Too many requests for one
// number"). El segundo POST al mismo número con menos de ~1-5 s de diferencia
// vuelve 429 y el mensaje NO se acepta, así que repetirlo no duplica nada.
// Con Meta el reintento sigue siendo el de 5799edd (tabla de esperas, sin
// fila); con 360dialog el hotfix 2 lo mueve DENTRO de la fila por número
// (`fila-por-numero.ts`) y la espera mínima es la pausa de 5000 ms.
// ---------------------------------------------------------------------------

const OK = { ok: true, status: 200, json: async () => ({ messages: [{ id: "wamid.X" }] }) };
const LIMITE = {
  ok: false,
  status: 429,
  json: async () => ({ error: "Too many requests for one number" }),
};
const conRetryAfter = (valor: string) => ({
  ...LIMITE,
  headers: { get: (k: string) => (k.toLowerCase() === "retry-after" ? valor : null) },
});

describe("429 de Meta en un envío (sin cambios respecto de 5799edd)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("un 429 seguido de un 200 se reintenta solo con el mismo POST, a los 1500 ms", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(LIMITE).mockResolvedValueOnce(OK);

    const promesa = sendWhatsappText("p", META, "584121234567", "hola");
    await vi.advanceTimersByTimeAsync(1499);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const result = await promesa;

    expect(result).toEqual({ whatsappMessageId: "wamid.X" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url1, init1] = fetchMock.mock.calls[0];
    const [url2, init2] = fetchMock.mock.calls[1];
    expect(url2).toBe(url1);
    expect(init2.body).toBe(init1.body);
    expect(init2.headers).toEqual(init1.headers);
    expect(warn).toHaveBeenCalledWith("whatsapp_429_reintento", { intento: 1, provider: "meta", espera_ms: 1500 });
  });

  it("cuatro 429 seguidos lanzan MetaApiError 429 (4 fetch en total, esperas 1500/3000/5000)", async () => {
    vi.spyOn(log, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValue(LIMITE);

    const promesa = sendWhatsappText("p", META, "584121234567", "hola").catch((e) => e);
    await vi.advanceTimersByTimeAsync(1500 + 3000 + 5000);
    const err = await promesa;

    expect(ESPERAS_429_MS).toEqual([1500, 3000, 5000]);
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err.status).toBe(429);
    expect(err.message).toBe("Too many requests for one number");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("un Retry-After en segundos manda sobre la tabla de esperas", async () => {
    vi.spyOn(log, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(conRetryAfter("2")).mockResolvedValueOnce(OK);

    const promesa = sendWhatsappText("p", META, "584121234567", "hola");
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await promesa;
  });

  it("un Retry-After enorme se topa en 10 s", async () => {
    vi.spyOn(log, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(conRetryAfter("120")).mockResolvedValueOnce(OK);

    const promesa = sendWhatsappText("p", META, "584121234567", "hola");
    await vi.advanceTimersByTimeAsync(9999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await promesa;
  });
});

describe("429 de 360dialog en un envío", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("un 429 seguido de un 200 se reintenta a los 5000 ms y no antes, con el mismo POST", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(LIMITE).mockResolvedValueOnce(OK);

    const promesa = sendWhatsappText("p", D360, "584121234567", "hola");
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const result = await promesa;

    expect(result).toEqual({ whatsappMessageId: "wamid.X" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url1, init1] = fetchMock.mock.calls[0];
    const [url2, init2] = fetchMock.mock.calls[1];
    expect(url2).toBe(url1);
    expect(init2.body).toBe(init1.body);
    expect(init2.headers).toEqual(init1.headers);
    expect(warn).toHaveBeenCalledWith("whatsapp_429_reintento", {
      intento: 1,
      provider: "360dialog",
      espera_ms: 5000,
      en_fila: 0,
    });
  });

  it("siete 429 seguidos (1 + 6 reintentos) lanzan MetaApiError 429 con el texto del proveedor", async () => {
    vi.spyOn(log, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValue(LIMITE);

    const promesa = sendWhatsappText("p", D360, "584121234567", "hola").catch((e) => e);
    await vi.advanceTimersByTimeAsync(6 * 5000);
    const err = await promesa;

    expect(err).toBeInstanceOf(MetaApiError);
    expect(err.status).toBe(429);
    expect(err.message).toBe("Too many requests for one number");
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it("un 400 no se reintenta: un solo fetch y el error tal cual", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: "Fuera de ventana", code: 131047 } }),
    });

    const err = await sendWhatsappText("p", D360, "584121234567", "hola").catch((e) => e);

    expect(err).toBeInstanceOf(MetaApiError);
    expect(err.status).toBe(400);
    expect(err.message).toBe("Fuera de ventana");
    expect(metaErrorCode(err)).toBe(131047);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("un Retry-After menor a la pausa no la acorta: sigue esperando 5000 ms", async () => {
    vi.spyOn(log, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(conRetryAfter("2")).mockResolvedValueOnce(OK);

    const promesa = sendWhatsappText("p", D360, "584121234567", "hola");
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await promesa;
  });

  it("un Retry-After enorme se topa en 10 s", async () => {
    vi.spyOn(log, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(conRetryAfter("120")).mockResolvedValueOnce(OK);

    const promesa = sendWhatsappText("p", D360, "584121234567", "hola");
    await vi.advanceTimersByTimeAsync(9999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await promesa;
  });

  it("el 429 consume su cuerpo (text) antes de reintentar, para liberar la conexión", async () => {
    vi.spyOn(log, "warn").mockImplementation(() => {});
    const text = vi.fn(async () => "Too many requests");
    fetchMock.mockResolvedValueOnce({ ...LIMITE, text }).mockResolvedValueOnce(OK);

    const promesa = sendWhatsappText("p", D360, "584121234567", "hola");
    await vi.advanceTimersByTimeAsync(0);
    expect(text).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    await promesa;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sendTypingIndicator con 429 no reintenta ni lanza: un solo fetch", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValue(LIMITE);

    await expect(sendTypingIndicator("p", D360, "wamid.X")).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "whatsapp_typing_fallido",
      expect.objectContaining({ status: 429, detail: "Too many requests for one number" })
    );
  });
});

// ---------------------------------------------------------------------------
// Hotfix 2 (9/10/2026): "Los mensajes al mismo cliente salen de a uno y en
// orden por 360dialog". Cuatro textos rápidos de un asesor salieron 1.º, 3.º,
// failed, 2.º porque cada envío reintentaba su 429 por su cuenta, en paralelo.
// ---------------------------------------------------------------------------

describe("fila por número con 360dialog", () => {
  /** Registra la hora y el texto de cada POST de envío y responde con la cola dada. */
  function registrarFetch(respuestas: unknown[]) {
    const llamadas: { t: number; texto: string | undefined }[] = [];
    const cola = [...respuestas];
    fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
      const cuerpo = JSON.parse(init.body) as { text?: { body: string } };
      llamadas.push({ t: Date.now(), texto: cuerpo.text?.body });
      return cola.shift() ?? OK;
    });
    return llamadas;
  }

  const conId = (k: string) => ({ ...OK, json: async () => ({ messages: [{ id: `wamid.${k}` }] }) });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(log, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("tres textos al mismo número salen en orden, cada uno ≥ 5000 ms después del anterior", async () => {
    const llamadas = registrarFetch([conId("1"), conId("2"), conId("3")]);

    const p1 = sendWhatsappText("p", D360, "+58 412-123-4567", "uno");
    const p2 = sendWhatsappText("p", D360, "584121234567", "dos");
    const p3 = sendWhatsappText("p", D360, "584121234567", "tres");

    await vi.advanceTimersByTimeAsync(0);
    expect(llamadas.map((l) => l.texto)).toEqual(["uno"]);
    await vi.advanceTimersByTimeAsync(4999);
    expect(llamadas).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(llamadas.map((l) => l.texto)).toEqual(["uno", "dos"]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(llamadas.map((l) => l.texto)).toEqual(["uno", "dos", "tres"]);

    expect(llamadas[1].t - llamadas[0].t).toBeGreaterThanOrEqual(5000);
    expect(llamadas[2].t - llamadas[1].t).toBeGreaterThanOrEqual(5000);
    await expect(Promise.all([p1, p2, p3])).resolves.toEqual([
      { whatsappMessageId: "wamid.1" },
      { whatsappMessageId: "wamid.2" },
      { whatsappMessageId: "wamid.3" },
    ]);
  });

  it("un mensaje no adelanta al que está reintentando un 429", async () => {
    const llamadas = registrarFetch([LIMITE, LIMITE, conId("1"), conId("2")]);

    const p1 = sendWhatsappText("p", D360, "584121234567", "uno");
    const p2 = sendWhatsappText("p", D360, "584121234567", "dos");

    await vi.advanceTimersByTimeAsync(0);
    expect(llamadas.map((l) => l.texto)).toEqual(["uno"]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(llamadas.map((l) => l.texto)).toEqual(["uno", "uno"]);
    await vi.advanceTimersByTimeAsync(5000);
    // El 200 del 1.º llegó a los 10 s; el 2.º espera la pausa desde ahí.
    expect(llamadas.map((l) => l.texto)).toEqual(["uno", "uno", "uno"]);
    const tAceptado = llamadas[2].t;
    await vi.advanceTimersByTimeAsync(4999);
    expect(llamadas).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(llamadas.map((l) => l.texto)).toEqual(["uno", "uno", "uno", "dos"]);
    expect(llamadas[3].t - tAceptado).toBeGreaterThanOrEqual(5000);

    await expect(Promise.all([p1, p2])).resolves.toEqual([
      { whatsappMessageId: "wamid.1" },
      { whatsappMessageId: "wamid.2" },
    ]);
  });

  it("si el 1.º agota sus 7 intentos con 429, falla él y el 2.º sale igual", async () => {
    const llamadas = registrarFetch([LIMITE, LIMITE, LIMITE, LIMITE, LIMITE, LIMITE, LIMITE, conId("2")]);

    const p1 = sendWhatsappText("p", D360, "584121234567", "uno").catch((e) => e);
    const p2 = sendWhatsappText("p", D360, "584121234567", "dos");

    await vi.advanceTimersByTimeAsync(30_000);
    expect(llamadas.filter((l) => l.texto === "uno")).toHaveLength(7);
    const err = await p1;
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err.status).toBe(429);

    await vi.advanceTimersByTimeAsync(0);
    expect(llamadas.map((l) => l.texto).slice(-1)).toEqual(["dos"]);
    await expect(p2).resolves.toEqual({ whatsappMessageId: "wamid.2" });
  });

  it("dos números distintos no se esperan: los dos POST salen en el mismo instante", async () => {
    const llamadas = registrarFetch([conId("a"), conId("b")]);

    const pa = sendWhatsappText("p", D360, "584121111111", "a");
    const pb = sendWhatsappText("p", D360, "584122222222", "b");

    await vi.advanceTimersByTimeAsync(0);
    expect(llamadas.map((l) => l.texto).sort()).toEqual(["a", "b"]);
    expect(llamadas[0].t).toBe(llamadas[1].t);
    await Promise.all([pa, pb]);
  });

  it("con Meta, dos envíos al mismo número salen en paralelo (sin fila)", async () => {
    registrarFetch([conId("1"), conId("2")]);

    const p1 = sendWhatsappText("p", META, "584121234567", "uno");
    const p2 = sendWhatsappText("p", META, "584121234567", "dos");

    // Sin avanzar el reloj ni un ms: ambos fetch ya salieron.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await Promise.all([p1, p2]);
  });

  describe("marcar leído (mínima prioridad)", () => {
    const NUMERO = "584121234567";

    it("con un envío en curso al mismo número no manda nada", async () => {
      let soltar!: (v: unknown) => void;
      const colgado = new Promise((r) => (soltar = r));
      fetchMock.mockImplementationOnce(() => colgado);

      const envio = sendWhatsappText("p", D360, NUMERO, "hola");
      await vi.advanceTimersByTimeAsync(0);
      await markWhatsappRead("p", D360, "wamid.ENTRANTE", NUMERO);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      soltar(conId("1"));
      await envio;
    });

    it("con un 200 aceptado hace menos de 5 s no manda nada", async () => {
      fetchMock.mockResolvedValue(conId("1"));
      await sendWhatsappText("p", D360, NUMERO, "hola");
      await vi.advanceTimersByTimeAsync(4999);

      await markWhatsappRead("p", D360, "wamid.ENTRANTE", NUMERO);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("con la fila libre y la pausa cumplida lo manda, y su 200 cuenta para la pausa del siguiente envío", async () => {
      fetchMock.mockResolvedValue(conId("1"));
      await sendWhatsappText("p", D360, NUMERO, "hola");
      await vi.advanceTimersByTimeAsync(5000);

      await markWhatsappRead("p", D360, "wamid.ENTRANTE", NUMERO);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
        messaging_product: "whatsapp",
        status: "read",
        message_id: "wamid.ENTRANTE",
      });

      const envio = sendWhatsappText("p", D360, NUMERO, "otro");
      await vi.advanceTimersByTimeAsync(4999);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      await envio;
    });

    it("sin historial de envíos al número lo manda de una", async () => {
      await markWhatsappRead("p", D360, "wamid.ENTRANTE", NUMERO);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("sin teléfono no manda nada (360dialog no puede saber de qué fila es)", async () => {
      await markWhatsappRead("p", D360, "wamid.ENTRANTE");
      await markWhatsappRead("p", D360, "wamid.ENTRANTE", null);

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("un 429 del read no se reintenta ni espera: un solo fetch y no lanza", async () => {
      fetchMock.mockResolvedValue(LIMITE);

      await expect(markWhatsappRead("p", D360, "wamid.ENTRANTE", NUMERO)).resolves.toBeUndefined();

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("con Meta se manda siempre, aunque haya un envío en curso al mismo número", async () => {
      let soltar!: (v: unknown) => void;
      const colgado = new Promise((r) => (soltar = r));
      fetchMock.mockImplementationOnce(() => colgado);

      const envio = sendWhatsappText("p", META, NUMERO, "hola");
      await markWhatsappRead("p", META, "wamid.ENTRANTE", NUMERO);
      await markWhatsappRead("p", META, "wamid.ENTRANTE");

      expect(fetchMock).toHaveBeenCalledTimes(3);
      soltar(conId("1"));
      await envio;
    });
  });
});
