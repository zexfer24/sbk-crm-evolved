import { describe, expect, it } from "vitest";
import { LECTURA_PENDIENTE_VIGENTE_MS, vistaDeLectura } from "@/lib/media-reading-view";
import type { MessageReading } from "@/lib/types";
import type { ImageFields } from "@/lib/media-reading-fields";

const AHORA = Date.parse("2026-11-16T15:00:00.000Z");

function haceSegundos(segundos: number): string {
  return new Date(AHORA - segundos * 1000).toISOString();
}

function lectura(over: Partial<MessageReading> = {}): MessageReading {
  return {
    kind: "audio",
    status: "ok",
    text: "hola, quiero un casco",
    fields: null,
    createdAt: haceSegundos(5),
    ...over,
  };
}

function campos(over: Partial<ImageFields> = {}): ImageFields {
  return {
    tipo: "repuesto",
    es_comprobante_pago: false,
    texto_visible: "",
    producto_visible: null,
    marca_visible: null,
    modelo_moto_visible: null,
    medida_visible: null,
    comprobante: null,
    orden_cashea: null,
    ...over,
  };
}

function imagen(over: Partial<MessageReading> = {}): MessageReading {
  return lectura({ kind: "image", text: "Un casco integral negro", fields: campos(), ...over });
}

describe("vistaDeLectura · estados sin nada que mostrar", () => {
  it("sin lectura no hay nada", () => {
    expect(vistaDeLectura(null, AHORA)).toEqual({ tipo: "nada" });
    expect(vistaDeLectura(undefined, AHORA)).toEqual({ tipo: "nada" });
  });

  it.each(["vacio", "alucinacion", "fallo"] as const)("%s no muestra nada", (status) => {
    expect(vistaDeLectura(lectura({ status }), AHORA)).toEqual({ tipo: "nada" });
  });

  it("ok sin texto no muestra nada", () => {
    expect(vistaDeLectura(lectura({ text: null }), AHORA)).toEqual({ tipo: "nada" });
    expect(vistaDeLectura(lectura({ text: "   " }), AHORA)).toEqual({ tipo: "nada" });
  });
});

describe("vistaDeLectura · pendiente", () => {
  it("el umbral de vigencia son 120 segundos", () => {
    expect(LECTURA_PENDIENTE_VIGENTE_MS).toBe(120000);
  });

  it("una pendiente de 30 s sigue leyéndose", () => {
    expect(vistaDeLectura(lectura({ status: "pendiente", createdAt: haceSegundos(30) }), AHORA)).toEqual({
      tipo: "leyendo",
    });
  });

  it("una pendiente de 130 s ya no se pinta: un deploy pudo cortar la lectura", () => {
    expect(vistaDeLectura(lectura({ status: "pendiente", createdAt: haceSegundos(130) }), AHORA)).toEqual({
      tipo: "nada",
    });
  });

  it("justo en el umbral ya no es vigente", () => {
    expect(vistaDeLectura(lectura({ status: "pendiente", createdAt: haceSegundos(120) }), AHORA)).toEqual({
      tipo: "nada",
    });
  });

  it("con una fecha ilegible no se pinta", () => {
    expect(vistaDeLectura(lectura({ status: "pendiente", createdAt: "no es fecha" }), AHORA)).toEqual({
      tipo: "nada",
    });
  });
});

describe("vistaDeLectura · audio", () => {
  it("ok con texto devuelve la transcripción", () => {
    expect(vistaDeLectura(lectura(), AHORA)).toEqual({ tipo: "audio", texto: "hola, quiero un casco" });
  });
});

describe("vistaDeLectura · imagen", () => {
  it("devuelve la descripción sin pastilla ni detalle", () => {
    expect(vistaDeLectura(imagen(), AHORA)).toEqual({
      tipo: "imagen",
      descripcion: "Un casco integral negro",
      textoVisible: null,
      pastilla: null,
      detalle: null,
    });
  });

  it("trae el texto visible cuando lo hay y null cuando está vacío", () => {
    const con = vistaDeLectura(imagen({ fields: campos({ texto_visible: "LS2 FF320" }) }), AHORA);
    expect(con).toMatchObject({ tipo: "imagen", textoVisible: "LS2 FF320" });
    const sin = vistaDeLectura(imagen({ fields: campos({ texto_visible: "  " }) }), AHORA);
    expect(sin).toMatchObject({ tipo: "imagen", textoVisible: null });
  });

  it("sin campos igual muestra la descripción", () => {
    expect(vistaDeLectura(imagen({ fields: null }), AHORA)).toMatchObject({
      tipo: "imagen",
      descripcion: "Un casco integral negro",
      pastilla: null,
    });
  });

  it("un comprobante completo: pastilla y detalle con monto, referencia, banco y fecha", () => {
    const vista = vistaDeLectura(
      imagen({
        fields: campos({
          tipo: "comprobante_pago",
          es_comprobante_pago: true,
          comprobante: {
            monto: 1234.5,
            moneda: "VES",
            referencia: "456789",
            banco: "Banesco",
            fecha: "15/11/2026",
          },
        }),
      }),
      AHORA
    );
    expect(vista).toMatchObject({
      pastilla: "Posible comprobante",
      detalle: "Bs 1.234,50 · ref. …456789 · Banesco · 15/11/2026",
    });
  });

  it("un comprobante en dólares usa el signo $ y omite lo que es null", () => {
    const vista = vistaDeLectura(
      imagen({
        fields: campos({
          es_comprobante_pago: true,
          comprobante: { monto: 20, moneda: "USD", referencia: null, banco: null, fecha: null },
        }),
      }),
      AHORA
    );
    expect(vista).toMatchObject({ pastilla: "Posible comprobante", detalle: "$ 20,00" });
  });

  it("un comprobante sin ningún dato legible deja el detalle en null", () => {
    const vista = vistaDeLectura(
      imagen({
        fields: campos({
          tipo: "comprobante_pago",
          comprobante: { monto: null, moneda: null, referencia: null, banco: null, fecha: null },
        }),
      }),
      AHORA
    );
    expect(vista).toMatchObject({ pastilla: "Posible comprobante", detalle: null });
  });

  it("un comprobante sin monto no inventa moneda", () => {
    const vista = vistaDeLectura(
      imagen({
        fields: campos({
          es_comprobante_pago: true,
          comprobante: { monto: null, moneda: "VES", referencia: "123456", banco: null, fecha: null },
        }),
      }),
      AHORA
    );
    expect(vista).toMatchObject({ detalle: "ref. …123456" });
  });

  it("una orden de Cashea con envío y total", () => {
    const vista = vistaDeLectura(
      imagen({
        fields: campos({ tipo: "orden_cashea", orden_cashea: { modalidad: "envio", total_usd: 45 } }),
      }),
      AHORA
    );
    expect(vista).toMatchObject({ pastilla: "Posible orden de Cashea", detalle: "Envío · total $45,00" });
  });

  it("una orden de Cashea con retiro en tienda", () => {
    const vista = vistaDeLectura(
      imagen({
        fields: campos({ tipo: "orden_cashea", orden_cashea: { modalidad: "retiro", total_usd: null } }),
      }),
      AHORA
    );
    expect(vista).toMatchObject({ pastilla: "Posible orden de Cashea", detalle: "Retiro en tienda" });
  });

  it("una orden de Cashea sin datos deja el detalle en null", () => {
    const vista = vistaDeLectura(
      imagen({ fields: campos({ tipo: "orden_cashea", orden_cashea: null }) }),
      AHORA
    );
    expect(vista).toMatchObject({ pastilla: "Posible orden de Cashea", detalle: null });
  });

  it("una foto cualquiera no lleva detalle aunque traiga un comprobante en los campos", () => {
    const vista = vistaDeLectura(
      imagen({
        fields: campos({
          tipo: "repuesto",
          comprobante: { monto: 5, moneda: "USD", referencia: null, banco: null, fecha: null },
        }),
      }),
      AHORA
    );
    expect(vista).toMatchObject({ pastilla: null, detalle: null });
  });
});
