import { describe, expect, it } from "vitest";
import {
  buildTemplateBodyComponents,
  substituteTemplateVariables,
  templateVariableCount,
} from "@/lib/whatsapp/template-variables";

describe("templateVariableCount", () => {
  it("sin {{n}} devuelve 0", () => {
    expect(templateVariableCount("Gracias por tu compra.")).toBe(0);
  });

  it("cuenta la variable más alta, no cuántas apariciones hay", () => {
    expect(templateVariableCount("Hola {{1}}, tu pedido {{1}} está listo.")).toBe(1);
    expect(templateVariableCount("Hola {{1}}, tu repuesto {{2}} llega el {{3}}.")).toBe(3);
  });
});

describe("substituteTemplateVariables", () => {
  it("reemplaza cada {{n}} por su valor", () => {
    expect(substituteTemplateVariables("Hola {{1}}, tu repuesto {{2}} ya llegó.", ["Pedro", "el carburador PZ27"])).toBe(
      "Hola Pedro, tu repuesto el carburador PZ27 ya llegó."
    );
  });

  it("un hueco sin valor se deja tal cual: la vista previa distingue lo lleno de lo vacío", () => {
    expect(substituteTemplateVariables("Hola {{1}}, tu pedido {{2}} está listo.", ["Pedro", ""])).toBe(
      "Hola Pedro, tu pedido {{2}} está listo."
    );
  });

  it("sin variables en el cuerpo, lo devuelve intacto", () => {
    expect(substituteTemplateVariables("Gracias por tu compra.", [])).toBe("Gracias por tu compra.");
  });
});

describe("buildTemplateBodyComponents", () => {
  it("sin variables no arma componentes: la plantilla no lleva `components`", () => {
    expect(buildTemplateBodyComponents([])).toBeUndefined();
  });

  it("arma un solo componente body con un parámetro de texto por variable, en orden", () => {
    expect(buildTemplateBodyComponents(["Pedro", "el carburador PZ27"])).toEqual([
      {
        type: "body",
        parameters: [
          { type: "text", text: "Pedro" },
          { type: "text", text: "el carburador PZ27" },
        ],
      },
    ]);
  });
});
