import { describe, expect, it } from "vitest";
import type { ImageFields } from "@/lib/media-reading-fields";
import { crearEffectsDeMemoria, type GuionDeMemoria } from "./effects-memoria";
import type { RenglonDeNota } from "./nota-asesor";
import { crearSesion } from "./sesion";
import {
  TEXTO_COMPROBANTE_RECIBIDO,
  TEXTO_SEGUIMOS_POR_AQUI,
  lineaCedulaCashea,
  lineaTiendaCerrada,
} from "./textos";
import { estadoInicial, type EstadoSeba } from "./tipos";
import {
  NOMBRE_RECIBIR_COMPROBANTE,
  buildRecibirComprobanteTool,
  hayComprobanteEnLaRafaga,
  recibirComprobante,
  type DepsDeComprobante,
} from "./tool-recibir-comprobante";

const AHORA = new Date("2026-11-17T15:00:00Z");

function lectura(parcial: Partial<ImageFields>): ImageFields {
  return {
    tipo: "otro",
    es_comprobante_pago: false,
    texto_visible: "",
    producto_visible: null,
    marca_visible: null,
    modelo_moto_visible: null,
    medida_visible: null,
    comprobante: null,
    orden_cashea: null,
    ...parcial,
  };
}

function comprobante(monto: number | null, moneda: "VES" | "USD" | null): ImageFields {
  return lectura({
    tipo: "comprobante_pago",
    es_comprobante_pago: true,
    comprobante: { monto, moneda, referencia: "456789", banco: "Banesco", fecha: "16/11/2026" },
  });
}

const ORDEN_CASHEA = lectura({ tipo: "orden_cashea", orden_cashea: { modalidad: "envio", total_usd: 45 } });
const FOTO_DE_PRODUCTO = lectura({ tipo: "repuesto", producto_visible: "pastillas de freno" });

const PEDIDO: RenglonDeNota[] = [{ cantidad: 2, nombre: "PASTILLAS FRENO BERA SBR", saintCode: "0123", stock: 8 }];
const PEDIDO_CON_CASCO: RenglonDeNota[] = [{ cantidad: 1, nombre: "CASCO INTEGRAL LS2", saintCode: null, stock: 3 }];

function montar(
  opciones: {
    guion?: GuionDeMemoria;
    estado?: Partial<EstadoSeba>;
    escaladaAbierta?: boolean;
    rafaga?: string[];
    lecturas?: ImageFields[];
    pedido?: RenglonDeNota[];
    formaLabel?: string | null;
  } = {},
) {
  const effects = crearEffectsDeMemoria(opciones.guion);
  const sesion = crearSesion({
    estado: { ...estadoInicial(AHORA), ...opciones.estado },
    escaladaAbierta: opciones.escaladaAbierta ?? false,
    tiendaAbierta: true,
    cuandoAbre: null,
    ahora: AHORA,
  });
  const deps: DepsDeComprobante = {
    effects,
    sesion,
    rafaga: opciones.rafaga ?? ["[El cliente envió una foto]"],
    lecturas: opciones.lecturas ?? [comprobante(1234.5, "VES")],
    pedido: opciones.pedido ?? PEDIDO,
    formaLabel: opciones.formaLabel ?? "Pago móvil",
  };
  return { effects, sesion, deps };
}

const textosEnviados = (e: ReturnType<typeof crearEffectsDeMemoria>) => e.registro.mensajes.map((m) => m.texto);

describe("recibirComprobante", () => {
  it("pasa a pagos ANTES de enviar y manda el texto fijo de comprobante recibido", async () => {
    const { effects, sesion, deps } = montar();

    const salida = await recibirComprobante(deps, "pago_movil");

    expect(effects.registro.secuencia).toEqual(["pasarAAsesor", "enviarTexto"]);
    expect(effects.registro.pases).toHaveLength(1);
    expect(effects.registro.pases[0]).toMatchObject({ area: "pagos", motivo: "comprobante_pago" });
    expect(effects.registro.pases[0].nota).toContain("El cliente envió un comprobante de pago.");
    expect(effects.registro.mensajes).toEqual([
      { orden: 1, tipo: "texto", texto: TEXTO_COMPROBANTE_RECIBIDO, origen: "fijo" },
    ]);
    expect(salida).toContain("No escribas nada más");
    expect(sesion.paso).toEqual({ area: "pagos", motivo: "comprobante_pago" });
    expect(sesion.estado.etapa).toBe("comprobante_recibido");
    expect(sesion.estado.actualizadoEn).toBe(AHORA.toISOString());
    expect(sesion.terminado).toBe(true);
    expect(sesion.herramientas).toEqual([NOMBRE_RECIBIR_COMPROBANTE]);
  });

  it("ningún texto enviado confirma, aprueba ni agradece la compra (con Cashea y tienda cerrada: los tres mensajes)", async () => {
    const { effects, deps } = montar({
      guion: { pase: { abierta: false, cuandoAbre: "el lunes a las 8:00 am" } },
      lecturas: [ORDEN_CASHEA],
      pedido: PEDIDO_CON_CASCO,
    });

    await recibirComprobante(deps, "cashea");

    const todo = textosEnviados(effects).join("\n").toLowerCase();
    expect(effects.registro.mensajes).toHaveLength(3);
    for (const prohibida of ["gracias por tu compra", "verificado", "aprobado", "confirmado"]) {
      expect(todo).not.toContain(prohibida);
    }
  });

  it("monto leído distinto del esperado: la nota trae DIFERENCIA y ningún mensaje al cliente lo menciona", async () => {
    const { effects, deps } = montar({
      estado: { totalBs: 1234.5, totalUsd: 45 },
      lecturas: [comprobante(1000, "VES")],
    });

    await recibirComprobante(deps, "transferencia");

    expect(effects.registro.pases[0].nota).toContain("DIFERENCIA: esperado Bs. 1.234,50, leído Bs. 1.000,00");
    const todo = textosEnviados(effects).join("\n");
    expect(todo).not.toContain("1.000,00");
    expect(todo).not.toContain("1000");
    expect(todo).not.toContain("1.234,50");
    expect(todo).not.toContain("DIFERENCIA");
  });

  describe("segundo comprobante", () => {
    it("con etapa comprobante_recibido y la escalada abierta: cero envíos y cero pases", async () => {
      const { effects, sesion, deps } = montar({ estado: { etapa: "comprobante_recibido" }, escaladaAbierta: true });

      const salida = await recibirComprobante(deps, "pago_movil");

      expect(effects.registro.secuencia).toEqual([]);
      expect(salida).toBe("El comprobante ya se recibió y el caso está con pagos. No escribas nada más.");
      expect(sesion.terminado).toBe(true);
      expect(sesion.herramientas).toEqual([NOMBRE_RECIBIR_COMPROBANTE]);
    });

    it("con etapa comprobante_recibido y un pase ya hecho en este turno: tampoco repite", async () => {
      const { effects, sesion, deps } = montar({ estado: { etapa: "comprobante_recibido" } });
      sesion.paso = { area: "pagos", motivo: "comprobante_pago" };

      await recibirComprobante(deps, "pago_movil");

      expect(effects.registro.secuencia).toEqual([]);
    });

    it("con etapa comprobante_recibido pero la escalada ya cerrada, un comprobante NUEVO sí se atiende", async () => {
      const { effects, deps } = montar({ estado: { etapa: "comprobante_recibido" }, escaladaAbierta: false });

      await recibirComprobante(deps, "pago_movil");

      expect(effects.registro.pases).toHaveLength(1);
    });
  });

  describe("pedir la cédula de Cashea", () => {
    it("Cashea sin cédula en la ráfaga: sale la línea de la cédula, sin talla si el pedido no la pide", async () => {
      const { effects, deps } = montar({ lecturas: [ORDEN_CASHEA], rafaga: ["ya hice la orden"] });

      await recibirComprobante(deps, "cashea");

      expect(textosEnviados(effects)).toEqual([TEXTO_COMPROBANTE_RECIBIDO, lineaCedulaCashea(false)]);
    });

    it("con un casco en el pedido y sin talla en la ráfaga: pide también la talla", async () => {
      const { effects, deps } = montar({ lecturas: [ORDEN_CASHEA], pedido: PEDIDO_CON_CASCO, rafaga: ["ya hice la orden"] });

      await recibirComprobante(deps, "cashea");

      expect(textosEnviados(effects)).toEqual([TEXTO_COMPROBANTE_RECIBIDO, lineaCedulaCashea(true)]);
    });

    it("con un casco pero la talla ya dicha en la ráfaga: pide solo la cédula", async () => {
      const { effects, deps } = montar({
        lecturas: [ORDEN_CASHEA],
        pedido: PEDIDO_CON_CASCO,
        rafaga: ["ya hice la orden", "talla M"],
      });

      await recibirComprobante(deps, "cashea");

      expect(textosEnviados(effects)[1]).toBe(lineaCedulaCashea(false));
    });

    it("con la cédula en la ráfaga no sale la línea", async () => {
      const { effects, deps } = montar({
        lecturas: [ORDEN_CASHEA],
        pedido: PEDIDO_CON_CASCO,
        rafaga: ["ya hice la orden", "mi cédula es V-12345678"],
      });

      await recibirComprobante(deps, "cashea");

      expect(textosEnviados(effects)).toEqual([TEXTO_COMPROBANTE_RECIBIDO]);
    });

    it("una orden de Cashea en la ráfaga la pide aunque el medio venga como «desconocido»", async () => {
      const { effects, deps } = montar({ lecturas: [ORDEN_CASHEA], rafaga: ["listo"] });

      await recibirComprobante(deps, "desconocido");

      expect(textosEnviados(effects)).toContain(lineaCedulaCashea(false));
    });

    it("con pago móvil (y sin orden de Cashea) nunca la pide", async () => {
      const { effects, deps } = montar({ lecturas: [comprobante(10, "USD")], pedido: PEDIDO_CON_CASCO });

      await recibirComprobante(deps, "pago_movil");

      expect(textosEnviados(effects)).toEqual([TEXTO_COMPROBANTE_RECIBIDO]);
    });
  });

  it("con la tienda cerrada suma la línea de cuándo abre, y nunca pasa de tres mensajes", async () => {
    const { effects, deps } = montar({
      guion: { pase: { abierta: false, cuandoAbre: "el lunes a las 8:00 am" } },
      lecturas: [ORDEN_CASHEA],
      pedido: PEDIDO_CON_CASCO,
    });

    await recibirComprobante(deps, "cashea");

    expect(textosEnviados(effects)).toEqual([
      TEXTO_COMPROBANTE_RECIBIDO,
      lineaCedulaCashea(true),
      lineaTiendaCerrada("el lunes a las 8:00 am"),
    ]);
    expect(effects.registro.mensajes.length).toBeLessThanOrEqual(3);
  });

  it("si la asignación LANZA: texto que no promete asesor, sin pase, y el estado no dice que el comprobante se recibió", async () => {
    const { effects, sesion, deps } = montar({ guion: { paseLanza: new Error("base caída") } });

    const salida = await recibirComprobante(deps, "pago_movil");

    expect(effects.registro.pases).toHaveLength(0);
    expect(textosEnviados(effects)).toEqual([TEXTO_SEGUIMOS_POR_AQUI]);
    expect(effects.registro.mensajes[0].origen).toBe("fijo");
    expect(salida).toBe("No se pudo asignar el caso; ya se le avisó al cliente. No escribas nada más.");
    expect(sesion.terminado).toBe(true);
    expect(sesion.paso).toBeNull();
    expect(sesion.estado.etapa).toBe("entender");
  });
});

describe("hayComprobanteEnLaRafaga", () => {
  it("es false para una foto de producto (caso E5) y para una ráfaga sin lecturas", () => {
    expect(hayComprobanteEnLaRafaga([FOTO_DE_PRODUCTO])).toBe(false);
    expect(hayComprobanteEnLaRafaga([])).toBe(false);
  });

  it("es true para un comprobante, por la bandera o por el tipo", () => {
    expect(hayComprobanteEnLaRafaga([comprobante(10, "USD")])).toBe(true);
    expect(hayComprobanteEnLaRafaga([lectura({ es_comprobante_pago: true })])).toBe(true);
  });

  it("es true para una orden de Cashea, aunque venga mezclada con otras fotos", () => {
    expect(hayComprobanteEnLaRafaga([FOTO_DE_PRODUCTO, ORDEN_CASHEA])).toBe(true);
  });
});

describe("buildRecibirComprobanteTool", () => {
  it("el inputSchema solo acepta los cinco medios", () => {
    const { deps } = montar();
    const schema = buildRecibirComprobanteTool(deps).inputSchema as unknown as {
      safeParse: (v: unknown) => { success: boolean };
    };

    for (const medio of ["pago_movil", "transferencia", "cashea", "binance", "desconocido"]) {
      expect(schema.safeParse({ medio }).success).toBe(true);
    }
    expect(schema.safeParse({ medio: "efectivo" }).success).toBe(false);
  });

  it("execute corre recibirComprobante", async () => {
    const { effects, deps } = montar();
    const herramienta = buildRecibirComprobanteTool(deps);

    await herramienta.execute!({ medio: "transferencia" }, { toolCallId: "t1", messages: [], context: {} });

    expect(effects.registro.pases).toHaveLength(1);
  });
});
