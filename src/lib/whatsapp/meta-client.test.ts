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
    await markWhatsappRead("p", D360, "wamid.ENTRANTE");

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
// number"). El segundo POST al mismo número con menos de ~1-3 s de diferencia
// vuelve 429 y el mensaje NO se acepta, así que repetirlo no duplica nada.
// ---------------------------------------------------------------------------

describe("429 de 360dialog en un envío", () => {
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

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("un 429 seguido de un 200 se reintenta solo con el mismo POST", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(LIMITE).mockResolvedValueOnce(OK);

    const promesa = sendWhatsappText("p", D360, "584121234567", "hola");
    await vi.advanceTimersByTimeAsync(ESPERAS_429_MS[0]);
    const result = await promesa;

    expect(result).toEqual({ whatsappMessageId: "wamid.X" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url1, init1] = fetchMock.mock.calls[0];
    const [url2, init2] = fetchMock.mock.calls[1];
    expect(url2).toBe(url1);
    expect(init2.body).toBe(init1.body);
    expect(init2.headers).toEqual(init1.headers);
    expect(warn).toHaveBeenCalledWith("whatsapp_429_reintento", { intento: 1, provider: "360dialog" });
  });

  it("cuatro 429 seguidos lanzan MetaApiError 429 con el texto del proveedor (4 fetch en total)", async () => {
    vi.spyOn(log, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValue(LIMITE);

    const promesa = sendWhatsappText("p", D360, "584121234567", "hola").catch((e) => e);
    await vi.advanceTimersByTimeAsync(ESPERAS_429_MS.reduce((a, b) => a + b, 0));
    const err = await promesa;

    expect(err).toBeInstanceOf(MetaApiError);
    expect(err.status).toBe(429);
    expect(err.message).toBe("Too many requests for one number");
    expect(fetchMock).toHaveBeenCalledTimes(4);
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

  it("un Retry-After en segundos manda sobre la tabla de esperas", async () => {
    vi.spyOn(log, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(conRetryAfter("2")).mockResolvedValueOnce(OK);

    const promesa = sendWhatsappText("p", D360, "584121234567", "hola");
    await vi.advanceTimersByTimeAsync(1999);
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
