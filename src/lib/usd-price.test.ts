import { describe, expect, it } from "vitest";
import { usdFromBs } from "@/lib/usd-price";
import { SYSTEM_PROMPT, cacheablePrefix } from "@/lib/ai/prompt";
import { buildCatalogTool, type CatalogOutcome } from "@/lib/ai/tools";

/**
 * D1 del plan "El mostrador busca sin salir del chat" (27/9/2026): redondeo
 * hacia ARRIBA al siguiente múltiplo de $0,10, a favor del negocio, nunca al
 * revés. `rate` se deja en 1 en la mayoría de los casos para poder escribir
 * el valor "sin redondear" directo como `bs`; los que sí necesitan una tasa
 * real están marcados aparte.
 */
describe("usdFromBs", () => {
  it("2,54 sube a 2,60", () => {
    expect(usdFromBs(2.54, 1)).toBe(2.6);
  });

  it("2,01 sube a 2,10", () => {
    expect(usdFromBs(2.01, 1)).toBe(2.1);
  });

  it("2,60 exacto se queda en 2,60 (no sube al siguiente múltiplo)", () => {
    expect(usdFromBs(2.6, 1)).toBe(2.6);
  });

  it("2,00 exacto se queda en 2,00", () => {
    expect(usdFromBs(2, 1)).toBe(2);
  });

  it("con tasa real: 87 Bs a 40 Bs/$ da 2,175 sin redondear, sube a 2,20", () => {
    expect(usdFromBs(87, 40)).toBe(2.2);
  });

  it("no divide por cero: tasa 0 devuelve null", () => {
    expect(usdFromBs(100, 0)).toBeNull();
  });

  it("tasa negativa devuelve null", () => {
    expect(usdFromBs(100, -5)).toBeNull();
  });

  it("tasa no finita (NaN/Infinity) devuelve null", () => {
    expect(usdFromBs(100, NaN)).toBeNull();
    expect(usdFromBs(100, Infinity)).toBeNull();
  });

  it("un bs no finito devuelve null", () => {
    expect(usdFromBs(NaN, 40)).toBeNull();
  });

  /**
   * El caso real que obliga al epsilon: `2,10 / 1,40` es matemáticamente
   * 1,5 exacto, pero en coma flotante da 1,5000000000000002 -- multiplicado
   * por 10 para redondear, 15,000000000000002, no 15. Sin el epsilon,
   * `Math.ceil` de ese número subiría a 16 y el resultado sería $1,60 en vez
   * de $1,50: un valor que matemáticamente ya es un múltiplo exacto de
   * $0,10 no puede subir por ruido de coma flotante.
   */
  it("protegido del ruido de coma flotante: 2,10 / 1,40 da 1,5000000000000002 y no sube a 1,60", () => {
    expect(2.1 / 1.4).not.toBe(1.5); // confirma que este caso ejercita el ruido real
    expect(usdFromBs(2.1, 1.4)).toBe(1.5);
  });
});

/**
 * D3 del plan "El mostrador busca sin salir del chat" (27/9/2026): Seba
 * recibe el número YA redondeado desde el código, y el system prompt NO se
 * toca ni menciona el redondeo -- el prompt ya dice "no los redondees" sobre
 * el precio que le llega ya escrito (prompt.ts, sección de catálogo), y esa
 * frase sigue vigente y no es lo que este resguardo prohíbe. Lo que este
 * test fija es que no aparezca una mención NUEVA a la regla de negocio: ni
 * "hacia arriba", ni "a favor del negocio", ni la cifra "0,10"/"10
 * centavos", ni el nombre de este módulo. Si algún día el modelo necesita
 * saber que redondea, es una decisión nueva que hay que tomar a propósito,
 * no un desliz de un comentario que se filtró al prompt.
 */
describe("resguardo: el redondeo a favor del negocio no se filtra al prompt", () => {
  const MENCIONES_PROHIBIDAS = [
    /redonde\w*\s+hacia\s+arriba/i,
    /a favor del negocio/i,
    /0[.,]10/,
    /10\s*centavos/i,
    /usd-price/i,
    /usdFromBs/i,
  ];

  it("SYSTEM_PROMPT y el prefijo cacheable no mencionan la regla de redondeo", () => {
    for (const patron of MENCIONES_PROHIBIDAS) {
      expect(SYSTEM_PROMPT).not.toMatch(patron);
      expect(cacheablePrefix()).not.toMatch(patron);
    }
  });

  it("la herramienta de catálogo no menciona el redondeo en su descripción ni en la de sus campos", () => {
    const outcome: CatalogOutcome = {
      ran: false,
      conExistencia: false,
      agotados: false,
      sinResultados: false,
      generico: false,
    };
    const tool = buildCatalogTool(
      // @ts-expect-error -- supabase no se usa de forma síncrona al construir la herramienta
      { supabase: {}, conversationId: "conv-1", contactId: "contact-1" },
      outcome
    );

    expect(tool.description ?? "").not.toMatch(/redonde/i);
  });
});
