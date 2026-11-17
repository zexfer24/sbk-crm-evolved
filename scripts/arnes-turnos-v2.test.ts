// ---------------------------------------------------------------------------
// ARNÉS DE TURNOS de Seba v2 (17/11/2026, entrega 3 del rework). FUERA de la suite
// normal: `vitest.config.ts` lo excluye y se corre aparte,
//
//   npm run test:arnes-turnos
//
// Qué hace: corre el turno REAL de Seba v2 (`runSeba2Turn`, con el modelo real y el
// catálogo de la base a la que apunte) sobre los casos de `privado/seba-v2/*.jsonl`
// —o, si solo está `ejemplo.sintetico.jsonl`, sobre ese— y dice si se cumplen las
// puertas para pasar de «arnés» a «sombra» (`evaluarPuertas`, chequeos en
// `arnes-turnos-v2.chequeos.ts`).
//
// NO ESCRIBE NADA, ni siquiera apuntando a producción. Tres barreras, independientes:
//   1. Efectos de MEMORIA: lo que el turno «envía» (mensajes, pases, carrito, estado)
//      queda en un registro; no hay WhatsApp ni Redis.
//   2. El cliente de Supabase es un ESPÍA (`arnes-turnos-v2.espia.ts`): lanza ante
//      `insert`/`update`/`upsert`/`delete`, ante una `rpc` que no sea de solo lectura
//      y ante una escritura de Storage, y cuenta los intentos; el arnés exige 0.
//   3. Lo que el turno trae por defecto y SÍ escribiría se inyecta aparte:
//        - `persistencia: "ninguna"` (la búsqueda no deja cotizaciones ni memoria en Redis);
//        - `leerTasa` y la tasa del catálogo (`conTasaFija`): `getBcvRate` puede salir a la
//          página del BCV y hacer un `upsert` en `exchange_rates`; aquí solo se lee la última
//          tasa guardada;
//        - `esperarLecturas`: no hace nada (la conversación es ficticia);
//        - `cargarDatos`: lee configuración, formas de pago, horario y lecciones con `select`;
//          la conversación (id sintético, sin asesor) la arma el caso.
//
// Entorno (si falta alguna de las tres primeras, el arnés se SALTA con un aviso; no falla):
//   ARNES_SUPABASE_URL    URL de la API de la base (Kong, p. ej. http://127.0.0.1:8000)
//   ARNES_SUPABASE_KEY    llave con la que se LEE (aunque sea service_role: el espía la frena)
//   OPENAI_API_KEY        la del proveedor del modelo (GOOGLE_GENERATIVE_AI_API_KEY si
//                         AI_AGENT_PROVIDER=google o el modelo es gemini-*)
//   ARNES_TASA_BCV        opcional: tasa de respaldo si `exchange_rates` está vacía (base local)
//   ARNES_AHORA           opcional: instante ISO de «ahora» (horario de la tienda, bienvenida);
//                         sin ella, la hora real
//   AI_AGENT_MODEL, AI_AGENT_PROVIDER, AI_AGENT_REASONING: los mismos de producción
//
// Salida: `privado/seba-v2/reporte-<AAAA-MM-DD>.md` (ignorado por git) y un resumen en
// la consola. El arnés FALLA si las puertas no se cumplen o si hubo un intento de escritura.
// ---------------------------------------------------------------------------
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { generateText } from "ai";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";
import { TOOL_KEYS, fetchEnabledToolKeys } from "@/lib/ai/agent-tools";
import { fetchTurnLessons } from "@/lib/ai/lessons";
import { buildCatalogTool } from "@/lib/ai/tools";
import { businessStatus, parseBusinessHours } from "@/lib/business-hours";
import type { PaymentMethodConfig, PaymentMethodCurrency } from "@/lib/payment-methods";
import type { Database } from "@/lib/supabase/database.types";
import { PALABRAS_QUE_NO_SON_NOMBRE, type DatosDeTurno } from "@/lib/seba2/contexto";
import { crearEffectsDeMemoria } from "@/lib/seba2/effects-memoria";
import { runSeba2Turn, type DepsDeTurno } from "@/lib/seba2/turno";
import { type CasoArnes, faltantesDelEntorno, historialDeCaso, parseCasos } from "./arnes-turnos-v2.caso";
import {
  type BorradorDeCaso,
  type ProductoDeArnes,
  type ResultadoDeCaso,
  type TarifaDeModelo,
  chequeosDeCasoFallido,
  correrChequeos,
  evaluarPuertas,
  reporteMarkdown,
  resumirCorrida,
} from "./arnes-turnos-v2.chequeos";
import { type EspiaDeSoloLectura, conTasaFija, crearEspiaDeSoloLectura, RPC_DE_SOLO_LECTURA } from "./arnes-turnos-v2.espia";

type Cliente = SupabaseClient<Database>;

/** Tope de un caso: el turno completo (modelo + herramientas + reescrituras). */
const TOPE_POR_CASO_MS = 90_000;

const CARPETA_DE_CASOS = path.resolve(process.cwd(), "privado", "seba-v2");
const ARCHIVO_DE_EJEMPLO = "ejemplo.sintetico.jsonl";

/**
 * Escribe directo al descriptor 2 y no con `console.*`: vitest descarta la consola de un archivo cuyos tests se
 * saltan todos y, en un entorno sin terminal (el VPS, un agente), la de los tests que pasan; el resumen y los
 * avisos de este arnés son justo lo que hay que leer.
 */
function imprimir(texto: string): void {
  fs.writeSync(2, `${texto}\n`);
}

const faltan = faltantesDelEntorno(process.env);
const puedeCorrer = faltan.length === 0;
if (!puedeCorrer) {
  imprimir(
    `\n[arnés de turnos] SALTADO: falta ${faltan.join(", ")} en el entorno. ` +
      `Ver la cabecera de scripts/arnes-turnos-v2.test.ts. (Esto no es un fallo.)\n`
  );
}

// ------------------------------ Lectura de casos ----------------------------

function archivosDeCasos(): string[] {
  if (!fs.existsSync(CARPETA_DE_CASOS)) {
    throw new Error(`No existe la carpeta de casos ${CARPETA_DE_CASOS} (¿se corre desde la raíz del repo?).`);
  }
  return fs
    .readdirSync(CARPETA_DE_CASOS)
    .filter((f) => f.endsWith(".jsonl") && !f.startsWith("reporte-"))
    .sort();
}

// ------------------------------ Lecturas de la base -------------------------

interface TasaLeida {
  usdAVes: number;
  fecha: string;
}

/** Solo `select`: la última tasa guardada, o `ARNES_TASA_BCV` si la tabla está vacía. */
async function leerTasaGuardada(supabase: Cliente): Promise<TasaLeida> {
  const { data, error } = await supabase
    .from("exchange_rates")
    .select("rate_date, usd_to_ves")
    .order("rate_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`No se pudo leer la tasa BCV guardada: ${error.message}`);
  if (data && Number(data.usd_to_ves) > 0) return { usdAVes: Number(data.usd_to_ves), fecha: data.rate_date };

  const respaldo = Number(process.env.ARNES_TASA_BCV);
  if (Number.isFinite(respaldo) && respaldo > 0) return { usdAVes: respaldo, fecha: "2000-01-01" };
  throw new Error(
    "No hay ninguna tasa BCV guardada en exchange_rates y no se definió ARNES_TASA_BCV. " +
      "El arnés no sale a la página del BCV (escribiría en la base)."
  );
}

async function leerTarifa(supabase: Cliente, etiquetaDeModelo: string | null): Promise<TarifaDeModelo | null> {
  if (!etiquetaDeModelo) return null;
  try {
    const { data, error } = await supabase
      .from("model_pricing")
      .select("model, input_price_per_million, output_price_per_million");
    if (error || !data) return null;
    const corto = etiquetaDeModelo.split("/").pop() ?? etiquetaDeModelo;
    const fila = data.find((f) => f.model === etiquetaDeModelo) ?? data.find((f) => f.model === corto);
    if (!fila) return null;
    return { inputPorMillon: Number(fila.input_price_per_million), outputPorMillon: Number(fila.output_price_per_million) };
  } catch {
    return null;
  }
}

interface FilaConfig {
  welcome_text: string;
  welcome_followups: unknown;
  cashea_datos_text: string;
  cashea_minimo_usd: number | string;
  cashea_seis_cuotas_desde_usd: number | string;
  business_hours: unknown;
}

interface FilaMetodo {
  key: string;
  label: string;
  currency: PaymentMethodCurrency;
  instructions: string;
  seba_entrega: boolean;
  is_active: boolean;
  sort_order: number;
  updated_at: string;
}

/**
 * Primer nombre de un asesor tal como lo usa `cargarDatosDeTurno` (3 letras o más y que no sea una palabra
 * genérica como «asesor» o «ventas»: R2/C2, 17/11/2026).
 */
function primerNombre(nombreVisible: string): string | null {
  const primero = nombreVisible.trim().split(/\s+/)[0] ?? "";
  const limpio = primero.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
  const letras = limpio.replace(/[^\p{L}]/gu, "");
  if (letras.length < 3) return null;
  const sinTildes = letras.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  return PALABRAS_QUE_NO_SON_NOMBRE.has(sinTildes) ? null : limpio;
}

/**
 * Lo mismo que `cargarDatosDeTurno` (`contexto.ts`) pero sobre una conversación FICTICIA: la
 * configuración, las formas de pago, el horario, las lecciones y los nombres de asesores se
 * LEEN de la base; la conversación (id sintético, sin asesor, abierta) y la escalada salen del
 * caso. Todo con `select`, así que el espía no se entera.
 */
async function cargarDatosDeArnes(
  supabase: Cliente,
  caso: CasoArnes,
  conversationId: string,
  ahora: Date
): Promise<DatosDeTurno> {
  const [config, metodos, lessons, agentes, herramientasEncendidas] = await Promise.all([
    supabase
      .from("agent_settings")
      .select("welcome_text, welcome_followups, cashea_datos_text, cashea_minimo_usd, cashea_seis_cuotas_desde_usd, business_hours")
      .eq("id", true)
      .single(),
    supabase
      .from("payment_methods")
      .select("key, label, currency, instructions, seba_entrega, is_active, sort_order, updated_at")
      .eq("is_active", true)
      .order("sort_order")
      .order("label"),
    fetchTurnLessons(supabase, conversationId),
    supabase.from("agents").select("display_name").eq("is_active", true).neq("role", "caja"),
    // Los interruptores del panel (R2/C1, 17/11/2026): el arnés los respeta como el turno real. Solo `select`.
    fetchEnabledToolKeys(supabase),
  ]);

  if (config.error || !config.data) {
    throw new Error(`No se pudo leer agent_settings: ${config.error?.message ?? "la fila no existe"}`);
  }
  if (metodos.error) throw new Error(`No se pudieron leer las formas de pago: ${metodos.error.message}`);
  const fila = config.data as unknown as FilaConfig;

  const businessHours = parseBusinessHours(fila.business_hours ?? undefined);
  const estado = businessStatus(ahora, businessHours);

  const vistos = new Set<string>();
  const nombresDeAsesores: string[] = [];
  for (const a of agentes.data ?? []) {
    const nombre = primerNombre(a.display_name ?? "");
    if (!nombre || vistos.has(nombre.toLowerCase())) continue;
    vistos.add(nombre.toLowerCase());
    nombresDeAsesores.push(nombre);
  }

  const escaladaAbierta = caso.escaladaAbierta === true;
  const haceDeAsesor = caso.historial.filter((m) => m.de === "asesor").map((m) => m.haceMin);

  return {
    conversacion: {
      id: conversationId,
      contactId: randomUUID(),
      assignedAgentId: null,
      aiEnabled: true,
      status: "open",
      welcomeSentAt: null,
      lastCustomerMessageAt: ahora.toISOString(),
      escalationArea: null,
    },
    customerName: null,
    config: {
      welcomeText: fila.welcome_text,
      welcomeFollowups: Array.isArray(fila.welcome_followups) ? (fila.welcome_followups as string[]) : [],
      casheaDatosText: fila.cashea_datos_text,
      casheaMinimoUsd: Number(fila.cashea_minimo_usd),
      casheaSeisCuotasDesdeUsd: Number(fila.cashea_seis_cuotas_desde_usd),
    },
    metodos: ((metodos.data ?? []) as unknown as FilaMetodo[]).map(
      (m): PaymentMethodConfig => ({
        key: m.key,
        label: m.label,
        currency: m.currency,
        instructions: m.instructions,
        sebaEntrega: m.seba_entrega,
        isActive: m.is_active,
        sortOrder: m.sort_order,
        updatedAt: m.updated_at,
      })
    ),
    businessHours,
    tiendaAbierta: estado.open,
    cuandoAbre: !estado.open && estado.nextOpening ? `${estado.nextOpening.dayLabel} a las ${estado.nextOpening.time}` : null,
    lessons,
    nombresDeAsesores,
    escaladaAbierta,
    esperaDeAsesor: escaladaAbierta ? { area: "ventas", minutos: 5 } : null,
    asesorEscribioHaceMin: haceDeAsesor.length > 0 ? Math.min(...haceDeAsesor) : null,
    herramientas: {
      catalogo: herramientasEncendidas.has(TOOL_KEYS.catalog),
      biblioteca: herramientasEncendidas.has(TOOL_KEYS.knowledge),
    },
  };
}

async function idsDeSaintCodes(supabase: Cliente, codigos: string[]): Promise<string[]> {
  if (codigos.length === 0) return [];
  const { data, error } = await supabase.from("products").select("id, saint_code").in("saint_code", codigos);
  if (error) throw new Error(`No se pudieron resolver los códigos de yaCotizados: ${error.message}`);
  const encontrados = new Set((data ?? []).map((p) => p.saint_code));
  const sinFila = codigos.filter((c) => !encontrados.has(c));
  if (sinFila.length > 0) imprimir(`[arnés de turnos] yaCotizados: no existen en la base ${sinFila.join(", ")}; se ignoran.`);
  return (data ?? []).map((p) => p.id);
}

async function productosDeArnes(supabase: Cliente, ids: string[]): Promise<Record<string, ProductoDeArnes>> {
  if (ids.length === 0) return {};
  const { data, error } = await supabase.from("products").select("id, saint_code, name").in("id", ids);
  if (error) throw new Error(`No se pudieron leer los productos cotizados: ${error.message}`);
  return Object.fromEntries((data ?? []).map((p) => [p.id, { saintCode: p.saint_code, nombre: p.name }]));
}

// ------------------------------ Un caso -------------------------------------

interface ContextoDeCorrida {
  supabase: Cliente;
  /** Cliente espiado que recibe el turno. */
  cliente: Cliente;
  tasa: TasaLeida;
  ahora: Date;
}

async function correrCaso(caso: CasoArnes, ctx: ContextoDeCorrida): Promise<ResultadoDeCaso> {
  const conversationId = randomUUID();
  const efectos = crearEffectsDeMemoria({
    estado: caso.estado,
    yaCotizados: await idsDeSaintCodes(ctx.cliente, caso.yaCotizados ?? []),
  });

  const control = new AbortController();
  const temporizador = setTimeout(() => control.abort(new Error(`el caso pasó de ${TOPE_POR_CASO_MS / 1000} s`)), TOPE_POR_CASO_MS);

  const deps: Partial<DepsDeTurno> = {
    cargarDatos: (_supabase, id, ahora) => cargarDatosDeArnes(ctx.cliente, caso, id, ahora),
    esperarLecturas: async () => undefined,
    leerTasa: async () => ctx.tasa.usdAVes,
    construirCatalogo: (d, salida) => buildCatalogTool({ ...d, supabase: conTasaFija(d.supabase, ctx.tasa) }, salida),
    generar: ((opciones: Parameters<typeof generateText>[0]) =>
      generateText({ ...opciones, abortSignal: control.signal })) as unknown as typeof generateText,
  };

  try {
    const entrada = {
      supabase: ctx.cliente,
      conversationId,
      ahora: ctx.ahora,
      iaGlobal: true,
      visto: null,
      persistencia: "ninguna" as const,
      cargarHistorial: async () => historialDeCaso(caso, ctx.ahora),
      deps,
    };
    const resumen = await Promise.race([
      runSeba2Turn(entrada, efectos),
      new Promise<never>((_, rechazar) =>
        control.signal.addEventListener("abort", () => rechazar(control.signal.reason ?? new Error("abortado")), { once: true })
      ),
    ]);

    const productos = await productosDeArnes(ctx.cliente, resumen.productos);
    const chequeos = correrChequeos({ caso, resumen, registro: efectos.registro, productos });
    const borrador: BorradorDeCaso = {
      accion: resumen.accion,
      resumen: resumen.resumen,
      mensajes: efectos.registro.mensajes,
      pases: efectos.registro.pases.map((p) => ({ area: p.area, motivo: p.motivo })),
      guardas: resumen.guardas,
      tokens: resumen.tokens,
      modelo: resumen.modelo,
      duracionMs: resumen.duracionMs,
    };
    return { id: caso.id, fuente: caso.fuente, chequeos, borrador, error: null };
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : String(err);
    // Lo que alcanzó a «enviar» antes de reventar sirve para entender por qué.
    const borrador: BorradorDeCaso = {
      accion: "error",
      resumen: mensaje,
      mensajes: efectos.registro.mensajes,
      pases: efectos.registro.pases.map((p) => ({ area: p.area, motivo: p.motivo })),
      guardas: [],
      tokens: null,
      modelo: null,
      duracionMs: 0,
    };
    return { id: caso.id, fuente: caso.fuente, chequeos: chequeosDeCasoFallido(mensaje), borrador, error: mensaje };
  } finally {
    clearTimeout(temporizador);
  }
}

// ------------------------------ El arnés ------------------------------------

describe.skipIf(!puedeCorrer)("arnés de turnos de Seba v2", () => {
  const resultados: ResultadoDeCaso[] = [];
  const archivosLeidos: string[] = [];
  let espia: EspiaDeSoloLectura<Cliente> | null = null;
  let clienteSinEspiar: Cliente | null = null;
  const ahora = process.env.ARNES_AHORA ? new Date(process.env.ARNES_AHORA) : new Date();

  afterAll(async () => {
    // Se escribe aunque algún `it` haya fallado: el reporte es justo lo que explica el fallo.
    const fecha = ahora.toISOString().slice(0, 10);
    const modelo = resultados.find((r) => r.borrador?.modelo)?.borrador?.modelo ?? null;
    const tarifa = clienteSinEspiar ? await leerTarifa(clienteSinEspiar, modelo) : null;
    const reporte = reporteMarkdown({
      fecha,
      archivos: archivosLeidos,
      resultados,
      tarifa,
      intentosDeEscritura: espia?.intentosDeEscritura() ?? 0,
      detalleDeIntentos: espia?.detalleDeIntentos(),
    });
    fs.mkdirSync(CARPETA_DE_CASOS, { recursive: true });
    const destino = path.join(CARPETA_DE_CASOS, `reporte-${fecha}.md`);
    fs.writeFileSync(destino, reporte, "utf8");

    const resumen = resumirCorrida(resultados);
    const puertas = evaluarPuertas(resumen);
    imprimir(`\n[arnés de turnos] ${resumen.totalCasos} caso(s), ${resumen.casosFallidos} con algún chequeo fallido.`);
    for (const [nombre, t] of Object.entries(resumen.porChequeo)) {
      imprimir(`  ${nombre}: ${t.ok}/${t.aplica}`);
    }
    imprimir(`[arnés de turnos] puertas: ${puertas.ok ? "ABIERTAS" : "CERRADAS"}`);
    for (const f of puertas.fallas) imprimir(`  ✗ ${f}`);
    for (const a of puertas.avisos) imprimir(`  (aviso) ${a}`);
    imprimir(`[arnés de turnos] reporte: ${destino}\n`);
  });

  it(
    "corre los casos de a uno, sin escribir nada",
    async () => {
      const real = createClient<Database>(process.env.ARNES_SUPABASE_URL as string, process.env.ARNES_SUPABASE_KEY as string, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      clienteSinEspiar = real;
      espia = crearEspiaDeSoloLectura<Cliente>(real);

      const archivos = archivosDeCasos();
      if (archivos.length === 0) throw new Error(`No hay ningún .jsonl de casos en ${CARPETA_DE_CASOS}.`);
      if (archivos.length === 1 && archivos[0] === ARCHIVO_DE_EJEMPLO) {
        imprimir("[arnés de turnos] solo el ejemplo sintético: se corre ese. Los casos reales van en privado/seba-v2/*.jsonl.");
      }
      const casos: CasoArnes[] = [];
      for (const archivo of archivos) {
        casos.push(...parseCasos(fs.readFileSync(path.join(CARPETA_DE_CASOS, archivo), "utf8"), archivo));
        archivosLeidos.push(archivo);
      }

      // Las lecturas previas van por el espía igual que todo lo demás.
      const tasa = await leerTasaGuardada(espia.cliente);
      const ctx: ContextoDeCorrida = { supabase: real, cliente: espia.cliente, tasa, ahora };

      for (const [i, caso] of casos.entries()) {
        const resultado = await correrCaso(caso, ctx);
        resultados.push(resultado);
        const fallos = resultado.chequeos.filter((c) => c.aplica && !c.ok).length;
        imprimir(`[arnés de turnos] ${i + 1}/${casos.length} ${caso.id}: ${fallos === 0 ? "ok" : `${fallos} chequeo(s) fallido(s)`}`);
      }
      expect(resultados).toHaveLength(casos.length);
    }
  );

  it("no intentó escribir nada en la base", () => {
    expect(espia, "el arnés no llegó a crear el espía").not.toBeNull();
    expect(espia?.detalleDeIntentos() ?? [], `RPC de solo lectura permitidas: ${RPC_DE_SOLO_LECTURA.join(", ")}`).toEqual([]);
    expect(espia?.intentosDeEscritura()).toBe(0);
  });

  it("se cumplen las puertas «arnés → sombra»", () => {
    const puertas = evaluarPuertas(resumirCorrida(resultados));
    expect(puertas.fallas).toEqual([]);
    expect(puertas.ok).toBe(true);
  });
});
