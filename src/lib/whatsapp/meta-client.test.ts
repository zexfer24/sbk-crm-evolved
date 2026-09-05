import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { markWhatsappRead, sendTypingIndicator } from "@/lib/whatsapp/meta-client";
import { log } from "@/lib/log";

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
    await markWhatsappRead("phone-id-1", "token-123", "wamid.ENTRANTE");

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

    await expect(markWhatsappRead("phone-id-1", "token-123", "wamid.VIEJO")).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      "whatsapp_marcar_leido_fallido",
      expect.objectContaining({ status: 400 })
    );
  });

  it("un fallo de red no lanza: solo queda en el registro", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    fetchMock.mockRejectedValue(new TypeError("fetch failed: ETIMEDOUT"));

    await expect(markWhatsappRead("phone-id-1", "token-123", "wamid.X")).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith("whatsapp_marcar_leido_fallido", expect.any(Object));
  });
});

describe("sendTypingIndicator", () => {
  it("manda el mismo cuerpo que marcar leído, más typing_indicator", async () => {
    await sendTypingIndicator("phone-id-1", "token-123", "wamid.ENTRANTE");

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

    await expect(sendTypingIndicator("phone-id-1", "token-123", "wamid.X")).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      "whatsapp_typing_fallido",
      expect.objectContaining({ status: 401 })
    );
  });

  it("un fallo de red tampoco lanza", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));

    await expect(sendTypingIndicator("phone-id-1", "token-123", "wamid.X")).resolves.toBeUndefined();
  });
});
