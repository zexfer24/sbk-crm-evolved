import { describe, expect, it } from "vitest";
import { ENTREGAS, ETAPAS, ESTADO_VIGENCIA_DIAS, estadoInicial, estadoVigente, parseEstadoSeba } from "./tipos";

// Los topes se fijan con literales (7 días, 1-20 unidades), no con el símbolo
// importado: un tope probado contra su propio símbolo no prueba el número.

const AHORA = new Date("2026-11-17T15:00:00.000Z");

function estadoValido(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    etapa: "cotizado",
    lineas: [{ productId: "p1", cantidad: 2 }],
    forma: "cashea",
    entrega: "envio",
    ciudad: "Barinas",
    totalUsd: 25.5,
    totalBs: 1200,
    priceKind: "estandar",
    complementoSugerido: true,
    ultimaFraseApertura: "Cuéntame, ¿qué andas buscando para tu moto?",
    actualizadoEn: "2026-11-17T14:00:00.000Z",
    ...extra,
  };
}

describe("constantes del estado", () => {
  it("las etapas y entregas son las del contrato, en orden", () => {
    expect([...ETAPAS]).toEqual([
      "entender",
      "cotizado",
      "eligiendo_pago",
      "datos_enviados",
      "comprobante_recibido",
      "con_asesor",
    ]);
    expect([...ENTREGAS]).toEqual(["envio", "retiro", "delivery"]);
  });

  it("el estado vence a los 7 días", () => {
    expect(ESTADO_VIGENCIA_DIAS).toBe(7);
  });
});

describe("estadoInicial", () => {
  it("es un estado vacío en la etapa «entender», fechado con el reloj recibido", () => {
    expect(estadoInicial(AHORA)).toEqual({
      etapa: "entender",
      lineas: [],
      forma: null,
      entrega: null,
      ciudad: null,
      totalUsd: null,
      totalBs: null,
      priceKind: null,
      complementoSugerido: false,
      ultimaFraseApertura: null,
      actualizadoEn: "2026-11-17T15:00:00.000Z",
    });
  });

  it("devuelve un objeto nuevo cada vez (las líneas no se comparten)", () => {
    const a = estadoInicial(AHORA);
    const b = estadoInicial(AHORA);
    a.lineas.push({ productId: "x", cantidad: 1 });
    expect(b.lineas).toEqual([]);
  });
});

describe("parseEstadoSeba", () => {
  it("lee un objeto válido tal cual", () => {
    expect(parseEstadoSeba(estadoValido())).toEqual(estadoValido());
  });

  it("lo que no es un objeto da null", () => {
    expect(parseEstadoSeba(null)).toBeNull();
    expect(parseEstadoSeba(undefined)).toBeNull();
    expect(parseEstadoSeba([])).toBeNull();
    expect(parseEstadoSeba("cotizado")).toBeNull();
    expect(parseEstadoSeba(42)).toBeNull();
  });

  it("una etapa desconocida o ausente invalida el estado entero", () => {
    expect(parseEstadoSeba(estadoValido({ etapa: "volando" }))).toBeNull();
    expect(parseEstadoSeba(estadoValido({ etapa: undefined }))).toBeNull();
    expect(parseEstadoSeba(estadoValido({ etapa: 3 }))).toBeNull();
  });

  it("una entrega desconocida invalida el estado entero; null es válido", () => {
    expect(parseEstadoSeba(estadoValido({ entrega: "dron" }))).toBeNull();
    expect(parseEstadoSeba(estadoValido({ entrega: null }))?.entrega).toBeNull();
  });

  it("descarta las líneas mal formadas y las de cantidad fuera de 1 a 20", () => {
    const parsed = parseEstadoSeba(
      estadoValido({
        lineas: [
          { productId: "ok1", cantidad: 1 },
          { productId: "ok20", cantidad: 20 },
          { productId: "cero", cantidad: 0 },
          { productId: "veintiuno", cantidad: 21 },
          { productId: "decimal", cantidad: 1.5 },
          { productId: "texto", cantidad: "2" },
          { cantidad: 3 },
          { productId: "", cantidad: 3 },
          { productId: 7, cantidad: 3 },
          null,
          "p9",
        ],
      }),
    );
    expect(parsed?.lineas).toEqual([
      { productId: "ok1", cantidad: 1 },
      { productId: "ok20", cantidad: 20 },
    ]);
  });

  it("si `lineas` no es un arreglo, queda vacío", () => {
    expect(parseEstadoSeba(estadoValido({ lineas: "p1" }))?.lineas).toEqual([]);
  });

  it("los campos que faltan toman null, false o una fecha ilegible conservada como vacía", () => {
    const parsed = parseEstadoSeba({ etapa: "entender", actualizadoEn: "2026-11-17T14:00:00.000Z" });
    expect(parsed).toEqual({
      etapa: "entender",
      lineas: [],
      forma: null,
      entrega: null,
      ciudad: null,
      totalUsd: null,
      totalBs: null,
      priceKind: null,
      complementoSugerido: false,
      ultimaFraseApertura: null,
      actualizadoEn: "2026-11-17T14:00:00.000Z",
    });
  });

  it("un priceKind o un total que no son lo que deben pasan a null", () => {
    const parsed = parseEstadoSeba(estadoValido({ priceKind: "regalo", totalUsd: "25", totalBs: Number.NaN }));
    expect(parsed?.priceKind).toBeNull();
    expect(parsed?.totalUsd).toBeNull();
    expect(parsed?.totalBs).toBeNull();
  });

  it("sin `actualizadoEn` legible el estado se conserva pero no vigente (cadena vacía)", () => {
    const parsed = parseEstadoSeba(estadoValido({ actualizadoEn: undefined }));
    expect(parsed).not.toBeNull();
    expect(estadoVigente(parsed, AHORA)).toBeNull();
  });
});

describe("estadoVigente", () => {
  it("null entra y sale null", () => {
    expect(estadoVigente(null, AHORA)).toBeNull();
  });

  it("6 días y 23 horas todavía es vigente", () => {
    const estado = parseEstadoSeba(estadoValido({ actualizadoEn: "2026-11-10T16:00:00.000Z" }));
    expect(estadoVigente(estado, AHORA)).toBe(estado);
  });

  it("7 días y 1 minuto ya no", () => {
    const estado = parseEstadoSeba(estadoValido({ actualizadoEn: "2026-11-10T14:59:00.000Z" }));
    expect(estadoVigente(estado, AHORA)).toBeNull();
  });

  it("una fecha ilegible da null", () => {
    const estado = { ...estadoInicial(AHORA), actualizadoEn: "ayer por la tarde" };
    expect(estadoVigente(estado, AHORA)).toBeNull();
  });
});
