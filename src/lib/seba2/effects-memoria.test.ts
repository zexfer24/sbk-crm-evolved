import { describe, expect, it } from "vitest";
import { crearEffectsDeMemoria } from "./effects-memoria";
import { estadoInicial, type ResumenDeTurno } from "./tipos";

const AHORA = new Date("2026-11-17T15:00:00.000Z");

function resumen(extra: Partial<ResumenDeTurno> = {}): ResumenDeTurno {
  return {
    accion: "answered",
    resumen: "Cotizó un casco.",
    rafaga: ["precio del casco"],
    triggerMessageId: "m1",
    estadoAntes: null,
    estadoDespues: null,
    herramientas: [],
    productos: [],
    guardas: [],
    contexto: { iaGlobal: true, asesorAsignado: false, asesorEscribioHaceMin: null },
    tokens: null,
    modelo: null,
    duracionMs: 10,
    ...extra,
  };
}

describe("efectos de memoria: registro", () => {
  it("el modo por defecto es «memoria» y el guion puede pedir sombra o copiloto", () => {
    expect(crearEffectsDeMemoria().modo).toBe("memoria");
    expect(crearEffectsDeMemoria({ modo: "sombra" }).modo).toBe("sombra");
    expect(crearEffectsDeMemoria({ modo: "copiloto" }).modo).toBe("copiloto");
  });

  it("registra cada efecto en el orden en que ocurrió", async () => {
    const fx = crearEffectsDeMemoria();
    fx.escribiendo();
    await fx.enviarTexto("Hola", "fijo");
    await fx.enviarImagen("https://x.test/a.jpg", "Pie");
    await fx.enviarImagen("https://x.test/b.jpg", null);
    await fx.pasarAAsesor({ area: "pagos", motivo: "comprobante_pago", nota: "Comprobante recibido" });
    await fx.guardarCarrito([{ productId: "p1", cantidad: 2, priceKind: "estandar" }]);
    await fx.marcarVisto({ hasta: "2026-11-17T14:00:00Z", ids: ["m1"] });
    await fx.cerrar(resumen());

    expect(fx.registro.secuencia).toEqual([
      "escribiendo",
      "enviarTexto",
      "enviarImagen",
      "enviarImagen",
      "pasarAAsesor",
      "guardarCarrito",
      "marcarVisto",
      "cerrar",
    ]);
    expect(fx.registro.escribiendo).toBe(1);
    expect(fx.registro.mensajes).toEqual([
      { orden: 1, tipo: "texto", texto: "Hola", origen: "fijo" },
      { orden: 2, tipo: "imagen", texto: "Pie", origen: "herramienta", mediaUrl: "https://x.test/a.jpg" },
      { orden: 3, tipo: "imagen", texto: "", origen: "herramienta", mediaUrl: "https://x.test/b.jpg" },
    ]);
    expect(fx.registro.pases).toEqual([
      { area: "pagos", motivo: "comprobante_pago", nota: "Comprobante recibido" },
    ]);
    expect(fx.registro.carrito).toEqual([{ productId: "p1", cantidad: 2, priceKind: "estandar" }]);
    expect(fx.registro.vistos).toEqual([{ hasta: "2026-11-17T14:00:00Z", ids: ["m1"] }]);
    expect(fx.registro.cierre?.resumen).toBe("Cotizó un casco.");
  });

  it("los envíos devuelven ok: true por defecto", async () => {
    const fx = crearEffectsDeMemoria();
    expect(await fx.enviarTexto("a", "modelo")).toEqual({ ok: true });
    expect(await fx.enviarImagen("u", null)).toEqual({ ok: true });
  });
});

describe("efectos de memoria: fallas guionadas", () => {
  it("envioFalla devuelve ok: false y no registra el mensaje (pero sí el intento en la secuencia)", async () => {
    const fx = crearEffectsDeMemoria({ envioFalla: true });
    expect(await fx.enviarTexto("a", "modelo")).toEqual({ ok: false });
    expect(await fx.enviarImagen("u", "pie")).toEqual({ ok: false });
    expect(fx.registro.mensajes).toEqual([]);
    expect(fx.registro.secuencia).toEqual(["enviarTexto", "enviarImagen"]);
  });

  it("paseLanza hace rechazar a pasarAAsesor con ese error y no registra el pase", async () => {
    const error = new Error("sin asesores");
    const fx = crearEffectsDeMemoria({ paseLanza: error });
    await expect(fx.pasarAAsesor({ area: "ventas", motivo: "otro", nota: "n" })).rejects.toBe(error);
    expect(fx.registro.pases).toEqual([]);
  });

  it("el pase devuelve por defecto «asignado, abierta, sin asesor previo» y acepta parches", async () => {
    const porDefecto = crearEffectsDeMemoria();
    expect(await porDefecto.pasarAAsesor({ area: "ventas", motivo: "otro", nota: "n" })).toEqual({
      asignado: true,
      abierta: true,
      cuandoAbre: null,
      yaTeniaAsesor: false,
    });
    const cerrada = crearEffectsDeMemoria({ pase: { abierta: false, cuandoAbre: "el lunes a las 8:00 am" } });
    expect(await cerrada.pasarAAsesor({ area: "ventas", motivo: "otro", nota: "n" })).toEqual({
      asignado: true,
      abierta: false,
      cuandoAbre: "el lunes a las 8:00 am",
      yaTeniaAsesor: false,
    });
  });
});

describe("efectos de memoria: mensaje nuevo del cliente", () => {
  it("mensajeNuevoTrasEnvios = 1 da false antes del primer envío y true después", async () => {
    const fx = crearEffectsDeMemoria({ mensajeNuevoTrasEnvios: 1 });
    expect(await fx.hayMensajeNuevoDelCliente()).toBe(false);
    await fx.enviarTexto("uno", "modelo");
    expect(await fx.hayMensajeNuevoDelCliente()).toBe(true);
  });

  it("un envío que falla no cuenta", async () => {
    const fx = crearEffectsDeMemoria({ mensajeNuevoTrasEnvios: 1, envioFalla: true });
    await fx.enviarTexto("uno", "modelo");
    expect(await fx.hayMensajeNuevoDelCliente()).toBe(false);
  });

  it("null (o sin definir) nunca da true", async () => {
    const fx = crearEffectsDeMemoria({ mensajeNuevoTrasEnvios: null });
    await fx.enviarTexto("uno", "modelo");
    await fx.enviarTexto("dos", "modelo");
    expect(await fx.hayMensajeNuevoDelCliente()).toBe(false);
    expect(await crearEffectsDeMemoria().hayMensajeNuevoDelCliente()).toBe(false);
  });
});

describe("efectos de memoria: bienvenida y productos ya cotizados", () => {
  it("la bienvenida se reclama una sola vez por turno", async () => {
    const fx = crearEffectsDeMemoria();
    expect(await fx.reclamarBienvenida()).toBe(true);
    expect(await fx.reclamarBienvenida()).toBe(false);
    // Cuenta las concedidas, no los intentos: es lo que un test quiere afirmar.
    expect(fx.registro.bienvenidasReclamadas).toBe(1);
  });

  it("con bienvenidaDisponible: false nunca se concede", async () => {
    const fx = crearEffectsDeMemoria({ bienvenidaDisponible: false });
    expect(await fx.reclamarBienvenida()).toBe(false);
  });

  it("productosYaCotizados devuelve un Set nuevo cada vez", async () => {
    const fx = crearEffectsDeMemoria({ yaCotizados: ["p1", "p2"] });
    const a = await fx.productosYaCotizados();
    a.add("p3");
    const b = await fx.productosYaCotizados();
    expect([...b]).toEqual(["p1", "p2"]);
    expect(b).not.toBe(a);
  });
});

describe("efectos de memoria: estado y cierre", () => {
  it("leerEstado devuelve el del guion y, tras guardar, lo último guardado", async () => {
    const inicial = estadoInicial(AHORA);
    const fx = crearEffectsDeMemoria({ estado: inicial });
    expect(await fx.leerEstado()).toBe(inicial);
    expect(fx.registro.estado).toBe(inicial);

    const nuevo = { ...inicial, etapa: "cotizado" as const };
    await fx.guardarEstado(nuevo);
    expect(await fx.leerEstado()).toBe(nuevo);
    expect(fx.registro.estado).toBe(nuevo);
  });

  it("sin guion no hay estado", async () => {
    const fx = crearEffectsDeMemoria();
    expect(await fx.leerEstado()).toBeNull();
    expect(fx.registro.estado).toBeNull();
  });

  it("cerrar dos veces lanza", async () => {
    const fx = crearEffectsDeMemoria();
    await fx.cerrar(resumen());
    await expect(fx.cerrar(resumen())).rejects.toThrow("cerrar se llamó dos veces");
  });
});

describe("efectos de memoria: silencios y notas para el asesor", () => {
  it("registra cada silencio y cada nota, en orden y en la secuencia", async () => {
    const fx = crearEffectsDeMemoria();

    await fx.registrarSilencio("cortesia_tras_escalada");
    await fx.anotarParaAsesor("Mientras espera al asesor, el cliente agregó: «es para una SBR»");
    await fx.registrarSilencio("sin_mensaje_nuevo");

    expect(fx.registro.silencios).toEqual(["cortesia_tras_escalada", "sin_mensaje_nuevo"]);
    expect(fx.registro.notas).toEqual(["Mientras espera al asesor, el cliente agregó: «es para una SBR»"]);
    expect(fx.registro.secuencia).toEqual(["registrarSilencio", "anotarParaAsesor", "registrarSilencio"]);
  });

  it("sin llamadas, ambos registros arrancan vacíos", () => {
    const fx = crearEffectsDeMemoria();
    expect(fx.registro.silencios).toEqual([]);
    expect(fx.registro.notas).toEqual([]);
  });

  it("notaLanza hace rechazar a anotarParaAsesor y no registra la nota (el intento sí queda en la secuencia)", async () => {
    const error = new Error("no se pudo escribir");
    const fx = crearEffectsDeMemoria({ notaLanza: error });
    await expect(fx.anotarParaAsesor("algo")).rejects.toBe(error);
    expect(fx.registro.notas).toEqual([]);
    expect(fx.registro.secuencia).toEqual(["anotarParaAsesor"]);
  });
});
