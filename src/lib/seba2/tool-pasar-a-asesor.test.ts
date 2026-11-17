import { describe, expect, it } from "vitest";
import { crearEffectsDeMemoria, type GuionDeMemoria } from "./effects-memoria";
import { areaDeMotivo } from "./motivos";
import { crearSesion } from "./sesion";
import { TEXTO_PASE, TEXTO_SEGUIMOS_POR_AQUI, lineaTiendaCerrada } from "./textos";
import { estadoInicial } from "./tipos";
import {
  NOMBRE_PASAR_A_ASESOR,
  buildPasarAAsesorTool,
  ejecutarPase,
  type DepsDePase,
} from "./tool-pasar-a-asesor";

const AHORA = new Date("2026-11-17T15:00:00Z");

function montar(guion: GuionDeMemoria = {}, sesionParcial: { escaladaAbierta?: boolean } = {}) {
  const effects = crearEffectsDeMemoria(guion);
  const sesion = crearSesion({
    estado: estadoInicial(AHORA),
    escaladaAbierta: sesionParcial.escaladaAbierta ?? false,
    tiendaAbierta: true,
    cuandoAbre: null,
    ahora: AHORA,
  });
  const deps: DepsDePase = { effects, sesion, rafaga: ["quiero comprar las pastillas"], nombresDeAsesores: ["Pedro"] };
  return { effects, sesion, deps };
}

const ENTRADA = {
  motivo: "listo_para_comprar" as const,
  nota: "El cliente quiere comprar 2 pastillas de freno para su SBR.",
  mensajeAlCliente: "Perfecto, ya te pasamos con quien te ayuda a cerrar la compra.",
};

describe("ejecutarPase", () => {
  it("asigna ANTES de enviar y deja el área que sale del motivo, nunca del modelo", async () => {
    const { effects, sesion, deps } = montar();

    const salida = await ejecutarPase(deps, ENTRADA);

    expect(effects.registro.secuencia).toEqual(["pasarAAsesor", "enviarTexto"]);
    expect(effects.registro.pases).toEqual([{ area: "ventas", motivo: "listo_para_comprar", nota: ENTRADA.nota }]);
    expect(effects.registro.mensajes).toHaveLength(1);
    expect(effects.registro.mensajes[0]).toMatchObject({ texto: ENTRADA.mensajeAlCliente, origen: "modelo" });
    expect(salida).toBe("Listo: el caso pasó a ventas. No escribas nada más.");
    expect(sesion.paso).toEqual({ area: "ventas", motivo: "listo_para_comprar" });
    expect(sesion.estado.etapa).toBe("con_asesor");
    expect(sesion.estado.actualizadoEn).toBe(AHORA.toISOString());
    expect(sesion.terminado).toBe(true);
    expect(sesion.herramientas).toEqual([NOMBRE_PASAR_A_ASESOR]);
  });

  it("garantia pasa al área de reclamos", async () => {
    const { effects, deps } = montar();

    await ejecutarPase(deps, { ...ENTRADA, motivo: "garantia", mensajeAlCliente: "Lamentamos lo ocurrido, ya lo revisa el equipo." });

    expect(areaDeMotivo("garantia")).toBe("reclamos");
    expect(effects.registro.pases[0]).toMatchObject({ area: "reclamos", motivo: "garantia" });
  });

  it("si la guarda de salida falla, sale TEXTO_PASE[area] y la guarda queda anotada", async () => {
    const { effects, sesion, deps } = montar();

    await ejecutarPase(deps, { ...ENTRADA, mensajeAlCliente: "Soy un asistente automatizado, ya te paso con un asesor." });

    expect(effects.registro.mensajes).toHaveLength(1);
    expect(effects.registro.mensajes[0]).toMatchObject({ texto: TEXTO_PASE.ventas, origen: "fijo" });
    expect(sesion.guardas).toHaveLength(1);
    expect(sesion.guardas[0].guarda).toBe("identidad");
    // Y aun así el caso se asignó, antes del envío.
    expect(effects.registro.secuencia).toEqual(["pasarAAsesor", "enviarTexto"]);
  });

  it("con la tienda cerrada manda un segundo mensaje con cuándo abre", async () => {
    const { effects, deps } = montar({ pase: { abierta: false, cuandoAbre: "el lunes a las 8:00 am" } });

    await ejecutarPase(deps, ENTRADA);

    expect(effects.registro.mensajes).toHaveLength(2);
    expect(effects.registro.mensajes[0].texto).toBe(ENTRADA.mensajeAlCliente);
    expect(effects.registro.mensajes[1]).toMatchObject({
      texto: lineaTiendaCerrada("el lunes a las 8:00 am"),
      origen: "fijo",
    });
  });

  it("con la tienda abierta no manda el segundo mensaje", async () => {
    const { effects, deps } = montar({ pase: { abierta: true, cuandoAbre: null } });

    await ejecutarPase(deps, ENTRADA);

    expect(effects.registro.mensajes).toHaveLength(1);
  });

  it("si la asignación LANZA, el cliente recibe un texto que no promete asesor y no queda pase registrado", async () => {
    const { effects, sesion, deps } = montar({ paseLanza: new Error("base caída") });

    const salida = await ejecutarPase(deps, ENTRADA);

    expect(effects.registro.pases).toHaveLength(0);
    expect(effects.registro.mensajes).toHaveLength(1);
    expect(effects.registro.mensajes[0]).toMatchObject({ texto: TEXTO_SEGUIMOS_POR_AQUI, origen: "fijo" });
    expect(TEXTO_SEGUIMOS_POR_AQUI.toLowerCase()).not.toContain("asesor");
    expect(salida).toBe("No se pudo asignar el caso; ya se le avisó al cliente. No escribas nada más.");
    expect(sesion.terminado).toBe(true);
    // No se pasó a nadie: el estado y `paso` no dicen lo contrario.
    expect(sesion.paso).toBeNull();
    expect(sesion.estado.etapa).toBe("entender");
  });

  it("una segunda llamada en el mismo turno no envía ni asigna nada", async () => {
    const { effects, deps } = montar();

    await ejecutarPase(deps, ENTRADA);
    const antes = { mensajes: effects.registro.mensajes.length, pases: effects.registro.pases.length };
    const salida = await ejecutarPase(deps, { ...ENTRADA, motivo: "garantia" });

    expect(effects.registro.mensajes).toHaveLength(antes.mensajes);
    expect(effects.registro.pases).toHaveLength(antes.pases);
    expect(salida).toBe("El caso ya está con un asesor: no lo pases de nuevo.");
  });

  it("con una escalada ya abierta al empezar el turno no hace nada", async () => {
    const { effects, sesion, deps } = montar({}, { escaladaAbierta: true });

    const salida = await ejecutarPase(deps, ENTRADA);

    expect(effects.registro.secuencia).toEqual([]);
    expect(salida).toBe("El caso ya está con un asesor: no lo pases de nuevo.");
    expect(sesion.herramientas).toEqual([NOMBRE_PASAR_A_ASESOR]);
  });
});

describe("buildPasarAAsesorTool", () => {
  it("el inputSchema acota motivo, nota (10-600) y mensajeAlCliente (10-300)", () => {
    const { deps } = montar();
    const schema = buildPasarAAsesorTool(deps).inputSchema as unknown as {
      safeParse: (v: unknown) => { success: boolean };
    };

    expect(schema.safeParse(ENTRADA).success).toBe(true);
    expect(schema.safeParse({ ...ENTRADA, motivo: "inventado" }).success).toBe(false);
    expect(schema.safeParse({ ...ENTRADA, nota: "corta" }).success).toBe(false);
    expect(schema.safeParse({ ...ENTRADA, nota: "x".repeat(601) }).success).toBe(false);
    expect(schema.safeParse({ ...ENTRADA, mensajeAlCliente: "corto" }).success).toBe(false);
    expect(schema.safeParse({ ...ENTRADA, mensajeAlCliente: "x".repeat(301) }).success).toBe(false);
    // El modelo no puede elegir el área.
    expect(Object.keys((schema as unknown as { shape: Record<string, unknown> }).shape).sort()).toEqual([
      "mensajeAlCliente",
      "motivo",
      "nota",
    ]);
  });

  it("execute corre el pase", async () => {
    const { effects, deps } = montar();
    const herramienta = buildPasarAAsesorTool(deps);

    const salida = await herramienta.execute!(ENTRADA, { toolCallId: "t1", messages: [], context: {} });

    expect(salida).toContain("Listo: el caso pasó a ventas");
    expect(effects.registro.pases).toHaveLength(1);
  });
});
