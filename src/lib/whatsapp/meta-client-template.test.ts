import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { sendWhatsappTemplate } from "@/lib/whatsapp/meta-client";

/**
 * T3.3 (5/9/2026): `sendWhatsappTemplate` con `components` (variables del
 * cuerpo). Archivo aparte de `meta-client.test.ts` (T3.1, corre en paralelo)
 * para no pisar el mismo archivo desde dos tareas a la vez.
 */

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ messages: [{ id: "wamid.NUEVO" }] }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendWhatsappTemplate", () => {
  it("sin components, el payload no lleva la clave (plantilla sin variables)", async () => {
    await sendWhatsappTemplate("phone-id-1", "token-123", "+58123456789", "bienvenida", "es");

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      messaging_product: "whatsapp",
      to: "58123456789",
      type: "template",
      template: { name: "bienvenida", language: { code: "es" } },
    });
    expect(body.template.components).toBeUndefined();
  });

  it("con components, arma el body parameter posicional exacto que exige Meta", async () => {
    await sendWhatsappTemplate("phone-id-1", "token-123", "+58123456789", "pedido_listo", "es", [
      {
        type: "body",
        parameters: [
          { type: "text", text: "Pedro" },
          { type: "text", text: "el carburador PZ27" },
        ],
      },
    ]);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.template).toEqual({
      name: "pedido_listo",
      language: { code: "es" },
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: "Pedro" },
            { type: "text", text: "el carburador PZ27" },
          ],
        },
      ],
    });
  });

  it("un arreglo vacío de components se trata igual que no mandar ninguno", async () => {
    await sendWhatsappTemplate("phone-id-1", "token-123", "+58123456789", "bienvenida", "es", []);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.template.components).toBeUndefined();
  });

  it("devuelve el wamid del mensaje enviado", async () => {
    const result = await sendWhatsappTemplate("phone-id-1", "token-123", "+58123456789", "bienvenida", "es");
    expect(result).toEqual({ whatsappMessageId: "wamid.NUEVO" });
  });
});
