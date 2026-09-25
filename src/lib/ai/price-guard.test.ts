import { describe, expect, it } from "vitest";
import { findUnsourcedFigure, moneyFigures, numericReadings } from "@/lib/ai/price-guard";

describe("moneyFigures — detecta cada formato de dinero", () => {
  it.each<[string, string[]]>([
    ["108$", ["108"]],
    ["$ 108", ["108"]],
    ["108 $ BCV", ["108"]],
    ["108,00 $", ["108,00"]],
    ["Bs. 88.000,00", ["88.000,00"]],
    ["88000 bs", ["88000"]],
    ["US$ 12.50", ["12.50"]],
  ])("%s -> %j", (texto, esperado) => {
    expect(moneyFigures(texto)).toEqual(esperado);
  });

  // Caso real del 20/9/2026: la moneda queda envuelta en asteriscos de
  // WhatsApp, pero eso no la esconde de la guarda.
  it("tolera los asteriscos de negrita de WhatsApp alrededor", () => {
    expect(moneyFigures("El intercomunicador sale en *108$ BCV*")).toEqual(["108"]);
  });

  it("dos cifras en el mismo texto: '$102,84 BCV (Bs. 88.000,00)'", () => {
    expect(moneyFigures("$102,84 BCV (Bs. 88.000,00)")).toEqual(["102,84", "88.000,00"]);
  });

  it("un porcentaje no es dinero", () => {
    expect(moneyFigures("Llevas 30% de descuento.")).toEqual([]);
  });

  it("números sueltos sin moneda no son dinero (stock, cuotas)", () => {
    expect(moneyFigures("Quedan 5 unidades y son 6 cuotas.")).toEqual([]);
  });

  it("'Bs' no calza dentro de otra palabra ('absorbedor', 'Bsas')", () => {
    expect(moneyFigures("Cambié el absorbedor delantero.")).toEqual([]);
    expect(moneyFigures("Ese repuesto lo traen de Bsas.")).toEqual([]);
  });

  it("texto sin ninguna cifra de dinero -> arreglo vacío", () => {
    expect(moneyFigures("Claro, dame un segundo que reviso.")).toEqual([]);
  });
});

describe("numericReadings — lecturas VE, US y ambiguas", () => {
  it("formato venezolano con miles y decimales: '88.000,00' -> 88000", () => {
    expect(numericReadings("88.000,00")).toEqual([88000]);
  });

  it("formato estadounidense: '12.50' -> 12.5", () => {
    expect(numericReadings("12.50")).toEqual([12.5]);
  });

  it("miles y decimales al revés: '1,234.56' -> 1234.56", () => {
    expect(numericReadings("1,234.56")).toEqual([1234.56]);
  });

  it("coma decimal simple: '36,60' -> 36.6", () => {
    expect(numericReadings("36,60")).toEqual([36.6]);
  });

  it("entero sin separadores: '108' -> 108", () => {
    expect(numericReadings("108")).toEqual([108]);
  });

  it("ambiguo de verdad: '88.000' -> 88000 y 88", () => {
    expect(numericReadings("88.000").slice().sort((a, b) => a - b)).toEqual([88, 88000]);
  });

  it("miles repetidos sin ambigüedad: '1.234.567' -> 1234567", () => {
    expect(numericReadings("1.234.567")).toEqual([1234567]);
  });
});

describe("findUnsourcedFigure — los dos casos reales de producción quedan bloqueados", () => {
  it("caso 20/9/2026: '108$ BCV' copiado del historial, sin ninguna fuente del turno -> bloqueado", () => {
    const texto = "El intercomunicador sale en *108$ BCV*";
    expect(findUnsourcedFigure(texto, [])).toBe("108");
  });

  it("caso 13/9/2026: cuotas de Cashea calculadas de memoria -> bloqueado", () => {
    const texto = "Con Cashea: inicial *$36,60*, saldo *$85,40*, 6 cuotas de *$14,23*.";
    expect(findUnsourcedFigure(texto, [])).not.toBeNull();
  });
});

describe("findUnsourcedFigure — pasa cuando la cifra SÍ tiene fuente en este turno", () => {
  it("la fuente es la salida JSON de la herramienta del catálogo, en este turno", () => {
    const texto = "El repuesto cuesta $102,84 BCV (Bs. 88.000,00).";
    const fuentes = [JSON.stringify({ nombre: "Filtro de aceite", precio: "$102,84 BCV (Bs. 88.000,00)" })];
    expect(findUnsourcedFigure(texto, fuentes)).toBeNull();
  });

  it("la fuente es lo que el cliente escribió en su ráfaga pendiente", () => {
    const texto = "Sí, tenemos los de $44.";
    const fuentes = ["tienen los de 44$?"];
    expect(findUnsourcedFigure(texto, fuentes)).toBeNull();
  });

  it("la fuente es una lección/biblioteca sin símbolo de moneda pegado", () => {
    const texto = "Aplica para compras mayores a $100.";
    const fuentes = ["Cashea: compras mayores a 100 dólares califican para 6 cuotas."];
    expect(findUnsourcedFigure(texto, fuentes)).toBeNull();
  });

  it("un porcentaje solo, sin ninguna fuente, pasa (no es dinero)", () => {
    expect(findUnsourcedFigure("Llevas 30% de descuento.", [])).toBeNull();
  });

  it("la fuente es un monto del historial de compras (salida JSON de buildOrderHistoryTool), repetido en una devolución", () => {
    const texto = "Tu compra fue de $45,50, ¿es correcto?";
    const fuentes = [JSON.stringify({ total: 45.5, moneda: "USD" })];
    expect(findUnsourcedFigure(texto, fuentes)).toBeNull();
  });

  it("texto sin ninguna cifra -> null sin mirar las fuentes", () => {
    expect(findUnsourcedFigure("Claro, dame un segundo que reviso.", [])).toBeNull();
  });
});
