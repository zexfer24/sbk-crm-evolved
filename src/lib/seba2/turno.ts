import "server-only";
import { generateText, isStepCount, type ToolSet } from "ai";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { getBcvRate } from "@/lib/ai/bcv";
import type { SeenMarker } from "@/lib/ai/history-line";
import { buildKnowledgeTool } from "@/lib/ai/knowledge";
import type { TurnLessons } from "@/lib/ai/lessons";
import { currentAgentModelLabel, getAgentModel, type AgentModel } from "@/lib/ai/model";
import { afirmaPromesaDeAsesor } from "@/lib/ai/promise-guard";
import { isCourtesyOnly } from "@/lib/ai/saludo";
import { buildCatalogTool, type CatalogOutcome, type PersistenciaDeCatalogo } from "@/lib/ai/tools";
import { esperarLecturas } from "@/lib/ai/wait-readings";
import type { BusinessHours } from "@/lib/business-hours";
import { fetchProductsByIds } from "@/lib/inventory-data";
import { errorText, log } from "@/lib/log";
import { esOrdenCashea } from "@/lib/media-reading-fields";
import { fotoPrincipal } from "@/lib/product-photos";
import type { Product } from "@/lib/types";
import { decidirApertura, type DecisionDeApertura } from "./apertura";
import {
  cargarDatosDeTurno,
  derivarRafaga,
  recortarHastaElCliente,
  type DatosDeTurno,
  type HistorialDeTurno,
  type RafagaDeTurno,
} from "./contexto";
import type { TurnEffects } from "./effects";
import { instruccionDeReescritura, revisarSalida, type VeredictoDeSalida } from "./guardas";
import { areaDeMotivo, type MotivoV2 } from "./motivos";
import type { RenglonDeNota } from "./nota-asesor";
import { buildSeba2Instructions, type Seba2Context } from "./prompt";
import {
  SEBA2_MAX_MENSAJES,
  citarRafaga,
  pareceAceptacion,
  planearSalida,
  unirMensajesDeTexto,
  type PlanDeSalida,
} from "./salida";
import { crearSesion, type SesionDeTurno } from "./sesion";
import { LINEA_CIERRE_COTIZACION, TEXTO_PASE } from "./textos";
import { buildBuscarRepuestoV2, NOMBRE_BUSCAR_REPUESTO } from "./tool-buscar-repuesto";
import { buildPasarAAsesorTool, ejecutarPase, NOMBRE_PASAR_A_ASESOR } from "./tool-pasar-a-asesor";
import { buildPrepararPagoTool, NOMBRE_PREPARAR_PAGO } from "./tool-preparar-pago";
import {
  buildRecibirComprobanteTool,
  hayComprobanteEnLaRafaga,
  NOMBRE_RECIBIR_COMPROBANTE,
  recibirComprobante,
  type MedioDePago,
} from "./tool-recibir-comprobante";
import {
  estadoInicial,
  type EstadoSeba,
  type OrigenTexto,
  type ResumenDeTurno,
  type TokensDeTurno,
} from "./tipos";

// ---------------------------------------------------------------------------
// El turno de Seba v2 (S8c, entrega 3 del rework, 17/11/2026).
//
// `runSeba2Turn` atiende UNA ráfaga completa del cliente siguiendo el guion de
// `docs/seba-v2/system-prompt-seba-v2.md` y es IDÉNTICO en vivo, en sombra, en
// copiloto y en memoria: lo único que cambia son los `TurnEffects` que recibe. El
// turno no envía, no asigna ni guarda nada por su cuenta; todo pasa por esa
// interfaz. Y no importa `agent.ts` (import circular): el historial llega por
// `cargarHistorial`, inyectado por la costura.
//
// Regla de negocio que no se negocia: ninguna cifra, nombre de producto, dato de
// pago ni promesa de asesor sale del modelo sin control. Los montos y los datos de
// pago los envían las HERRAMIENTAS (origen «herramienta»), los textos fijos los
// pone el código (origen «fijo») y lo que redacta el modelo (origen «modelo») pasa
// las guardas de salida (`guardas.ts`) y, si no pasa, sale el respaldo del código.
// Y la invariante «ningún lead invisible»: una salida que deja al cliente sin
// respuesta deja rastro (`registrarSilencio` o un pase a asesor); un `return` mudo
// es un bug.
//
// El orden del turno (cada paso es una función con nombre, en este archivo):
//   1. datos y estado  2. historial y ráfaga  3. sesión y envoltorio de efectos
//   4. escalada abierta  5. apertura  6. comprobante por código  7. modelo
//   8. plan de salida  9. guardas  10. envío con cesión  11. cierre.
// ---------------------------------------------------------------------------

export { SEBA2_MAX_MENSAJES };

/** Pasos máximos del bucle del modelo (buscar, biblioteca, pagar, pasar). */
export const SEBA2_MAX_PASOS = 5;

/**
 * Techo de tokens de salida de una llamada. Son 700 y no los 500 del brief del
 * VPS: con un modelo que razona el techo INCLUYE el razonamiento, y una llamada a
 * `pasarAAsesor` lleva hasta 900 caracteres de argumentos; con 500 se cortaba a
 * mitad de la herramienta.
 */
export const SEBA2_MAX_OUTPUT_TOKENS = 700;

/**
 * La reescritura de una guarda no necesita más que una línea o dos, pero con un modelo que razona el tope INCLUYE
 * el razonamiento: con 300 se cortaba (R1/C4, 17/11/2026: 500) y un texto cortado se descarta, no se envía.
 */
const REESCRITURA_MAX_TOKENS = 500;

/** Un bloque de cotización de hasta este largo cabe en el pie de una foto. */
const PIE_MAX_CARACTERES = 1000;

/** Una nota para el asesor no pasa de aquí (es un campo corto de su panel). */
const NOTA_MAX_CARACTERES = 900;

const NOMBRE_CONSULTAR_BIBLIOTECA = "consultarBiblioteca";

// ------------------------------- Entrada ------------------------------------

export interface EntradaDeTurno {
  supabase: SupabaseClient<Database>;
  conversationId: string;
  ahora: Date;
  /** ¿La IA global puede correr? (solo para el registro: `contexto.iaGlobal`). */
  iaGlobal: boolean;
  /** Marca «visto hasta» del último turno que atendió (Redis en vivo; último borrador en sombra). */
  visto: SeenMarker | null;
  persistencia: PersistenciaDeCatalogo;
  /** Carga el historial (en producción, `loadHistory` de v1, inyectado para no importar agent.ts). */
  cargarHistorial: (supabase: SupabaseClient<Database>, conversationId: string) => Promise<HistorialDeTurno>;
  precargado?: { lessons?: TurnLessons; businessHours?: BusinessHours };
  /** Inyección para tests y arnés; cada una tiene su default real. */
  deps?: Partial<DepsDeTurno>;
}

export interface DepsDeTurno {
  cargarDatos: typeof cargarDatosDeTurno;
  esperarLecturas: (supabase: SupabaseClient<Database>, conversationId: string) => Promise<unknown>;
  generar: typeof generateText;
  /**
   * El modelo de cada fase. Devuelve el `AgentModel` de v1 (`{ model, providerOptions }`) y no solo el
   * `LanguageModel` que decía el brief: el esfuerzo de razonamiento viaja en `providerOptions`, y sin él
   * «bajo» no se aplicaría.
   */
  modelo: (fase: "redactar" | "identidad") => AgentModel;
  etiquetaDeModelo: () => string;
  cargarProductos: (ids: string[]) => Promise<Product[]>;
  leerTasa: () => Promise<number | null>;
  construirCatalogo: typeof buildCatalogTool;
  construirBiblioteca: typeof buildKnowledgeTool;
}

function depsPorDefecto(supabase: SupabaseClient<Database>): DepsDeTurno {
  return {
    cargarDatos: cargarDatosDeTurno,
    esperarLecturas: (cliente, conversationId) => esperarLecturas(cliente, conversationId),
    generar: generateText,
    // Esfuerzo bajo: el guion decide casi todo (herramientas, textos fijos) y razonar de más solo suma latencia.
    modelo: (fase) => getAgentModel("low", fase),
    etiquetaDeModelo: currentAgentModelLabel,
    cargarProductos: (ids) => fetchProductsByIds(supabase, ids),
    leerTasa: async () => {
      try {
        const tasa = await getBcvRate(supabase);
        return tasa.rate > 0 ? tasa.rate : null;
      } catch (err) {
        // Sin tasa `prepararPago` no inventa un total: pasa el caso a ventas.
        log.warn("seba2_tasa_no_leida", { detail: errorText(err) });
        return null;
      }
    },
    construirCatalogo: buildCatalogTool,
    construirBiblioteca: buildKnowledgeTool,
  };
}

// ------------------------------- La corrida ---------------------------------

/** Un mensaje que SÍ salió: lo que `enviados` recuerda para el tope, la cesión y la red de promesa. */
interface Enviado {
  tipo: "texto" | "imagen";
  /** El texto, o el pie de la imagen. */
  texto: string;
  origen: OrigenTexto;
  /** Salió como parte de la apertura (bienvenida o frase fija): no es una promesa del modelo. */
  apertura: boolean;
}

/** Todo lo que el turno va sabiendo de sí mismo. Se arma una vez, ya cargados datos, historial y ráfaga. */
interface Corrida {
  entrada: EntradaDeTurno;
  deps: DepsDeTurno;
  /** Los efectos tal cual llegaron. */
  effects: TurnEffects;
  /** Los mismos efectos con el envoltorio que cuenta lo enviado: lo que usan el turno y las herramientas. */
  fx: TurnEffects;
  inicio: number;
  datos: DatosDeTurno;
  estadoLeido: EstadoSeba | null;
  historial: HistorialDeTurno;
  rafaga: RafagaDeTurno;
  sesion: SesionDeTurno;
  catalogOutcome: CatalogOutcome;
  enviados: Enviado[];
  /** Un envío salió `{ ok: false }`: no se intenta ninguno más. */
  falloEnvio: boolean;
  /** Entró un mensaje nuevo del cliente a mitad de la salida: se descartó lo que faltaba. */
  cedio: boolean;
  /** Estamos enviando la apertura (para marcar esos mensajes en `enviados`). */
  enApertura: boolean;
  aperturaEnviada: boolean;
  /** El turno decidió con fundamento no escribir (cortesía, nota para el asesor, comprobante ya recibido). */
  decidido: boolean;
  /** El pase se hizo por código porque falló el proveedor o una herramienta: no hay salida del modelo que armar. */
  recuperadoPorCodigo: boolean;
  /** El último error que lanzó una herramienta (el SDK lo traga y sigue). */
  errorDeHerramienta: { nombre: string; error: unknown } | null;
  tokens: TokensDeTurno | null;
  llamadasAlModelo: number;
  /** El `system` de la redacción: la reescritura de una guarda usa el MISMO. */
  system: string;
  /** Frases para el resumen de una línea. */
  detalle: string[];
  cerrado: boolean;
}

/** Lo que se sabe del turno si revienta antes de armar la `Corrida`. */
interface Avance {
  inicio: number;
  corrida: Corrida | null;
  cerrado: boolean;
}

// ------------------------------ Punto de entrada ----------------------------

export async function runSeba2Turn(entrada: EntradaDeTurno, effects: TurnEffects): Promise<ResumenDeTurno> {
  const avance: Avance = { inicio: Date.now(), corrida: null, cerrado: false };
  const deps: DepsDeTurno = { ...depsPorDefecto(entrada.supabase), ...entrada.deps };

  try {
    const corrida = await prepararCorrida(entrada, deps, effects, avance);
    avance.corrida = corrida;
    return await atender(corrida);
  } catch (err) {
    await cerrarConError(entrada, effects, avance, err);
    throw err;
  }
}

/** Pasos 1 a 3: datos, historial, ráfaga, sesión y el envoltorio de efectos. */
async function prepararCorrida(
  entrada: EntradaDeTurno,
  deps: DepsDeTurno,
  effects: TurnEffects,
  avance: Avance
): Promise<Corrida> {
  // Las tres lecturas son independientes entre sí; el historial va DESPUÉS de esperar las lecturas de adjuntos
  // (un turno que cargara el historial antes vería «no puedes verla» de una foto que sigue en vuelo).
  const [datos, estadoLeido] = await Promise.all([
    deps.cargarDatos(entrada.supabase, entrada.conversationId, entrada.ahora, entrada.precargado),
    effects.leerEstado(),
    esperarLecturasSinFallar(entrada, deps),
  ]).then(([d, e]) => [d, e] as const);

  const cargado = await entrada.cargarHistorial(entrada.supabase, entrada.conversationId);
  // La sombra y el copiloto corren a la par del turno real: tienen que ver la conversación como estaba cuando
  // el cliente escribió, no con la respuesta que v1 o un asesor dieron después.
  const historial = effects.modo === "real" ? cargado : recortarHastaElCliente(cargado);
  const rafaga = derivarRafaga(historial, entrada.visto, entrada.ahora);

  const sesion = crearSesion({
    estado: estadoLeido ?? estadoInicial(entrada.ahora),
    escaladaAbierta: datos.escaladaAbierta,
    tiendaAbierta: datos.tiendaAbierta,
    cuandoAbre: datos.cuandoAbre,
    ahora: entrada.ahora,
  });

  // Con una escalada abierta el cliente ya espera a una persona aunque nadie la haya tomado: toda salida de este
  // turno es automática (R1/C3, 17/11/2026), o una respuesta informativa apagaría `awaiting_reply`.
  if (datos.escaladaAbierta) effects.clienteEsperaPersona();

  const corrida: Corrida = {
    entrada,
    deps,
    effects,
    fx: effects,
    inicio: avance.inicio,
    datos,
    estadoLeido,
    historial,
    rafaga,
    sesion,
    catalogOutcome: catalogoVacio(),
    enviados: [],
    falloEnvio: false,
    cedio: false,
    enApertura: false,
    aperturaEnviada: false,
    decidido: false,
    recuperadoPorCodigo: false,
    errorDeHerramienta: null,
    tokens: null,
    llamadasAlModelo: 0,
    system: "",
    detalle: [],
    cerrado: false,
  };
  corrida.fx = envolverEfectos(corrida);
  return corrida;
}

async function esperarLecturasSinFallar(entrada: EntradaDeTurno, deps: DepsDeTurno): Promise<void> {
  try {
    await deps.esperarLecturas(entrada.supabase, entrada.conversationId);
  } catch (err) {
    // Esperar es un favor al cliente que mandó una foto: si falla, el turno sigue con lo que haya.
    log.warn("seba2_espera_de_lecturas_fallida", { conversationId: entrada.conversationId, detail: errorText(err) });
  }
}

function catalogoVacio(): CatalogOutcome {
  return {
    ran: false,
    conExistencia: false,
    agotados: false,
    sinResultados: false,
    generico: false,
    cotizacion: [],
    preguntaFiltro: null,
    consultas: [],
    avisos: [],
    motivoForzado: null,
  };
}

// ------------------------- El envoltorio de efectos -------------------------

/**
 * Todos los envíos del turno —los suyos y los de las herramientas— pasan por
 * este envoltorio: cuenta lo que salió, recuerda si algún envío falló (y entonces
 * no intenta ninguno más) y guarda cada texto para la red de promesa del final.
 */
function envolverEfectos(c: Corrida): TurnEffects {
  const { effects } = c;

  async function enviar(
    tipo: Enviado["tipo"],
    texto: string,
    origen: OrigenTexto,
    hacer: () => Promise<{ ok: boolean }>
  ): Promise<{ ok: boolean }> {
    if (c.falloEnvio) return { ok: false };
    const resultado = await hacer();
    if (resultado.ok) c.enviados.push({ tipo, texto, origen, apertura: c.enApertura });
    else c.falloEnvio = true;
    return resultado;
  }

  return {
    modo: effects.modo,
    escribiendo: () => effects.escribiendo(),
    enviarTexto: (texto, origen) => enviar("texto", texto, origen, () => effects.enviarTexto(texto, origen)),
    enviarImagen: (mediaUrl, pie) =>
      enviar("imagen", pie ?? "", "herramienta", () => effects.enviarImagen(mediaUrl, pie)),
    pasarAAsesor: (i) => effects.pasarAAsesor(i),
    guardarCarrito: (lineas) => effects.guardarCarrito(lineas),
    registrarSilencio: (razon) => effects.registrarSilencio(razon),
    anotarParaAsesor: (texto) => effects.anotarParaAsesor(texto),
    leerEstado: () => effects.leerEstado(),
    guardarEstado: (estado) => effects.guardarEstado(estado),
    reclamarBienvenida: () => effects.reclamarBienvenida(),
    marcarVisto: (marker) => effects.marcarVisto(marker),
    productosYaCotizados: () => effects.productosYaCotizados(),
    hayMensajeNuevoDelCliente: (desde) => effects.hayMensajeNuevoDelCliente(desde),
    clienteEsperaPersona: () => effects.clienteEsperaPersona(),
    cerrar: (resumen) => effects.cerrar(resumen),
  };
}

// ------------------------------ Qué atender ---------------------------------

async function atender(c: Corrida): Promise<ResumenDeTurno> {
  // Sin ráfaga pendiente no hay nada que contestar: se deja el rastro y no se llama al modelo.
  if (c.rafaga.lineas.length === 0) return cerrarSinNadaQueContestar(c);

  // Con la escalada abierta el cliente ya espera a una persona: el turno calla, informa o anota.
  if (c.datos.escaladaAbierta) return atenderConEscaladaAbierta(c);

  return atenderNormal(c);
}

async function cerrarSinNadaQueContestar(c: Corrida): Promise<ResumenDeTurno> {
  await c.fx.registrarSilencio("sin_mensaje_nuevo");
  c.detalle.push("No había ningún mensaje nuevo del cliente que contestar.");
  return cerrarTurno(c);
}

// -------------------------- 4. Con la escalada abierta ----------------------

async function atenderConEscaladaAbierta(c: Corrida): Promise<ResumenDeTurno> {
  if (hayComprobanteEnLaRafaga(c.rafaga.lecturas)) return recibirComprobantePorCodigo(c);

  // Una cortesía sola («ok», «gracias») no se responde: se decide callar, con rastro.
  if (c.rafaga.lineas.every((linea) => isCourtesyOnly(linea))) {
    await c.fx.registrarSilencio("cortesia_tras_escalada");
    c.decidido = true;
    c.detalle.push("El cliente solo agradeció con la escalada abierta: no se le escribió.");
    return cerrarTurno(c);
  }

  // Solo la biblioteca: puede contestar información, nunca cotizar ni volver a pasar el caso.
  const texto = await redactar(c, { soloBiblioteca: true });
  const aprobado = texto.trim() === "" ? null : await pasarGuardas(c, texto.trim());

  if (aprobado !== null) {
    const mensajes = partirEnUno(aprobado);
    await enviarItems(c, mensajes);
    c.detalle.push("Con la escalada abierta contestó información.");
  } else {
    // Lo que el cliente agregó no se pierde: queda en una nota para el asesor. Si la nota falla, LANZA
    // (antes de marcar «visto»): el turno se reintenta.
    await c.fx.anotarParaAsesor(`Mientras espera al asesor, el cliente agregó: ${citarRafaga(c.rafaga.lineas)}`);
    c.decidido = true;
    c.detalle.push("Con la escalada abierta anotó lo que agregó el cliente para el asesor.");
  }
  return cerrarTurno(c);
}

/** Con la escalada abierta sale UN solo mensaje: el texto entero, sin partirlo en párrafos. */
function partirEnUno(texto: string): Item[] {
  return [{ tipo: "texto", texto, origen: "modelo" }];
}

// ------------------------------- 5. Apertura --------------------------------

async function atenderNormal(c: Corrida): Promise<ResumenDeTurno> {
  const decision = decidirApertura({
    conversationId: c.entrada.conversationId,
    ventanaNueva: c.rafaga.ventanaNueva,
    rafaga: c.rafaga.lineas,
    lecturas: c.rafaga.lecturas,
    asesorAtendiendo: c.datos.conversacion.assignedAgentId !== null,
    escaladaAbierta: false,
    estado: c.sesion.estado,
    now: c.entrada.ahora,
    welcomeText: c.datos.config.welcomeText,
    followups: c.datos.config.welcomeFollowups,
    ultimaFraseUsada: c.sesion.estado.ultimaFraseApertura,
  });

  const fin = await abrir(c, decision);
  if (fin === "termina") return cerrarTurno(c);

  if (hayComprobanteEnLaRafaga(c.rafaga.lecturas)) return recibirComprobantePorCodigo(c);

  const texto = await redactar(c, { soloBiblioteca: false });
  if (!c.recuperadoPorCodigo && !c.sesion.terminado) {
    // Si una herramienta terminó el turno, ya dijo todo: el texto del modelo se DESCARTA.
    await armarYEntregarSalida(c, texto);
  }
  await redDePromesa(c);
  return cerrarTurno(c);
}

/**
 * La bienvenida (una por ventana de 24 h) y, si el cliente solo saludó, la frase fija.
 * `"termina"` cuando no queda nada más que decir: la frase fija era la respuesta completa, o un
 * envío falló.
 */
async function abrir(c: Corrida, decision: DecisionDeApertura): Promise<"sigue" | "termina"> {
  if (!decision.apertura) return "sigue";

  c.enApertura = true;
  try {
    if (decision.mensaje1 !== null) {
      // Otro turno ya dio la bienvenida de esta ventana: ni ella ni la frase fija se repiten.
      if (!(await c.fx.reclamarBienvenida())) return "sigue";
      const enviado = await c.fx.enviarTexto(decision.mensaje1, "fijo");
      if (!enviado.ok) return "termina";
      c.aperturaEnviada = true;
    }

    if (decision.mensaje2Fijo !== null) {
      const enviado = await c.fx.enviarTexto(decision.mensaje2Fijo, "fijo");
      if (!enviado.ok) return "termina";
      c.sesion.estado = {
        ...c.sesion.estado,
        ultimaFraseApertura: decision.mensaje2Fijo,
        actualizadoEn: c.entrada.ahora.toISOString(),
      };
      c.detalle.push("El cliente solo saludó: salió la bienvenida y la frase fija.");
      return "termina";
    }
    if (c.aperturaEnviada) c.detalle.push("Mandó la bienvenida.");
    return "sigue";
  } finally {
    c.enApertura = false;
  }
}

// ------------------------- 6. El comprobante por código ----------------------

async function recibirComprobantePorCodigo(c: Corrida): Promise<ResumenDeTurno> {
  const renglones = await renglonesDelEstado(c);
  const estado = c.sesion.estado;

  let medio: MedioDePago = "desconocido";
  if (c.rafaga.lecturas.some((l) => esOrdenCashea(l)) || estado.forma === "cashea") medio = "cashea";
  else if (estado.forma === "pago_movil" || estado.forma === "transferencia" || estado.forma === "binance") {
    medio = estado.forma;
  }

  await recibirComprobante(
    {
      effects: c.fx,
      sesion: c.sesion,
      rafaga: c.rafaga.lineas,
      lecturas: c.rafaga.lecturas,
      pedido: renglones,
      formaLabel: etiquetaDeForma(estado.forma, c.datos),
    },
    medio
  );
  c.decidido = true;
  c.detalle.push("Recibió el comprobante por código, sin llamar al modelo.");
  return cerrarTurno(c);
}

// --------------------------------- 7. Modelo --------------------------------

type ModeloGenerar = (
  opciones: Record<string, unknown>
) => Promise<{ text?: string; usage?: unknown; finishReason?: string }>;

/** El pedido del estado con el nombre real, el código de SAINT y la existencia. Un fallo de lectura no tumba el turno. */
async function renglonesDelEstado(c: Corrida): Promise<RenglonDeNota[]> {
  const lineas = c.sesion.estado.lineas;
  if (lineas.length === 0) return [];
  const productos = await cargarProductosSinFallar(c, lineas.map((l) => l.productId));
  const porId = new Map(productos.map((p) => [p.id, p]));
  const renglones: RenglonDeNota[] = [];
  for (const linea of lineas) {
    const producto = porId.get(linea.productId);
    if (!producto) continue;
    renglones.push({
      cantidad: linea.cantidad,
      nombre: producto.name,
      saintCode: producto.saintCode,
      stock: producto.stockQuantity,
    });
  }
  return renglones;
}

async function cargarProductosSinFallar(c: Corrida, ids: string[]): Promise<Product[]> {
  try {
    return await c.deps.cargarProductos(ids);
  } catch (err) {
    log.warn("seba2_productos_no_cargados", { conversationId: c.entrada.conversationId, detail: errorText(err) });
    return [];
  }
}

function etiquetaDeForma(forma: string | null, datos: DatosDeTurno): string | null {
  if (forma === null) return null;
  if (forma === "cashea") return "Cashea";
  return datos.metodos.find((m) => m.key === forma)?.label ?? forma;
}

function contextoDelPrompt(c: Corrida, renglones: RenglonDeNota[]): Seba2Context {
  const { datos, rafaga, sesion } = c;
  return {
    now: c.entrada.ahora,
    businessHours: datos.businessHours,
    apertura: c.aperturaEnviada,
    customerName: datos.customerName,
    estado: sesion.estado,
    pedido: renglones.map((r) => ({ cantidad: r.cantidad, nombre: r.nombre })),
    formasDeContado: datos.metodos.map((m) => m.label),
    formaElegida: etiquetaDeForma(sesion.estado.forma, datos),
    casheaMinimoUsd: datos.config.casheaMinimoUsd,
    casheaSeisCuotasDesdeUsd: datos.config.casheaSeisCuotasDesdeUsd,
    esperaDeAsesor: datos.esperaDeAsesor,
    lessons: datos.lessons,
    pendingCustomerLines: rafaga.lineas,
    previousConversationCutoffAt: rafaga.cortePrevio,
  };
}

/**
 * Una herramienta que se anota si lanza: el SDK convierte el error de `execute` en
 * una parte del paso y el bucle SIGUE, así que sin esto el turno nunca se enteraría
 * (el caso real: `prepararPago` envió el resumen y el pase del caso falló).
 */
function vigilar<T extends object>(c: Corrida, nombre: string, herramienta: T): T {
  const original = (herramienta as { execute?: (i: unknown, o: unknown) => unknown }).execute;
  if (!original) return herramienta;
  return {
    ...herramienta,
    execute: async (entrada: unknown, opciones: unknown) => {
      try {
        return await original(entrada, opciones);
      } catch (error) {
        c.errorDeHerramienta = { nombre, error };
        throw error;
      }
    },
  };
}

function construirHerramientas(c: Corrida, renglones: RenglonDeNota[], soloBiblioteca: boolean): ToolSet {
  const { entrada, datos, rafaga, sesion, deps } = c;

  // La biblioteca: lo que devuelve es fuente de lo que el modelo cite en este turno (una política, un enlace).
  const biblioteca = deps.construirBiblioteca({ supabase: entrada.supabase, conversationId: entrada.conversationId });
  const consultarBiblioteca = vigilar(c, NOMBRE_CONSULTAR_BIBLIOTECA, {
    ...biblioteca,
    execute: async (tema: unknown, opciones: unknown) => {
      sesion.herramientas.push(NOMBRE_CONSULTAR_BIBLIOTECA);
      const salida = await (biblioteca as unknown as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(
        tema,
        opciones
      );
      sesion.fuentes.push(JSON.stringify(salida));
      return salida;
    },
  });
  if (soloBiblioteca) return { [NOMBRE_CONSULTAR_BIBLIOTECA]: consultarBiblioteca } as unknown as ToolSet;

  const buscarRepuesto = buildBuscarRepuestoV2({
    supabase: entrada.supabase,
    conversationId: entrada.conversationId,
    contactId: datos.conversacion.contactId,
    rafaga: rafaga.lineas,
    persistencia: entrada.persistencia,
    sesion,
    catalogOutcome: c.catalogOutcome,
    construir: deps.construirCatalogo,
  });
  const prepararPago = buildPrepararPagoTool({
    effects: c.fx,
    sesion,
    metodos: datos.metodos,
    cashea: {
      datosText: datos.config.casheaDatosText,
      minimoUsd: datos.config.casheaMinimoUsd,
      seisCuotasDesdeUsd: datos.config.casheaSeisCuotasDesdeUsd,
    },
    cargarProductos: deps.cargarProductos,
    leerTasa: deps.leerTasa,
  });
  const recibirComprobanteTool = buildRecibirComprobanteTool({
    effects: c.fx,
    sesion,
    rafaga: rafaga.lineas,
    lecturas: rafaga.lecturas,
    pedido: renglones,
    formaLabel: etiquetaDeForma(sesion.estado.forma, datos),
  });
  const pasarAAsesor = buildPasarAAsesorTool({
    effects: c.fx,
    sesion,
    rafaga: rafaga.lineas,
    nombresDeAsesores: datos.nombresDeAsesores,
  });

  return {
    [NOMBRE_BUSCAR_REPUESTO]: vigilar(c, NOMBRE_BUSCAR_REPUESTO, buscarRepuesto),
    [NOMBRE_CONSULTAR_BIBLIOTECA]: consultarBiblioteca,
    [NOMBRE_PREPARAR_PAGO]: vigilar(c, NOMBRE_PREPARAR_PAGO, prepararPago),
    [NOMBRE_RECIBIR_COMPROBANTE]: vigilar(c, NOMBRE_RECIBIR_COMPROBANTE, recibirComprobanteTool),
    [NOMBRE_PASAR_A_ASESOR]: vigilar(c, NOMBRE_PASAR_A_ASESOR, pasarAAsesor),
  } as unknown as ToolSet;
}

function sumarUso(c: Corrida, usage: unknown): void {
  const uso = (usage ?? {}) as {
    inputTokens?: number;
    outputTokens?: number;
    inputTokenDetails?: { cacheReadTokens?: number };
    outputTokenDetails?: { reasoningTokens?: number };
  };
  const actual = c.tokens ?? { input: 0, output: 0, cachedInput: 0, reasoning: 0 };
  c.tokens = {
    input: actual.input + (uso.inputTokens ?? 0),
    output: actual.output + (uso.outputTokens ?? 0),
    cachedInput: actual.cachedInput + (uso.inputTokenDetails?.cacheReadTokens ?? 0),
    reasoning: actual.reasoning + (uso.outputTokenDetails?.reasoningTokens ?? 0),
  };
}

/** 25 → «25»; 25.5 → «25,50»: el mismo formato con que `prompt.ts` escribe los montos de Cashea en el sufijo. */
function montoCashea(monto: number): string {
  return Number.isInteger(monto) ? String(monto) : monto.toFixed(2).replace(".", ",");
}

/**
 * Los montos de Cashea que el sufijo del prompt le da al modelo (compra mínima y desde cuánto hay seis cuotas) y
 * que el guion le permite decir son FUENTE de la guarda de cifras: sin esto `cifra_sin_fuente` frenaba una
 * respuesta correcta («la compra mínima es de 25 $»), provocaba una reescritura y a veces un pase innecesario
 * (observado en el arnés, R1/C5, 17/11/2026). La guarda compara el NÚMERO sin importar la forma («25 $», «$25»,
 * «25$»), así que una sola línea con los dos montos cubre cómo los escriba el modelo. Una vez por turno.
 */
function agregarFuenteDeCashea(c: Corrida): void {
  const { casheaMinimoUsd, casheaSeisCuotasDesdeUsd } = c.datos.config;
  const linea = `Cashea: envío gratis · compra mínima ${montoCashea(casheaMinimoUsd)} $ · seis cuotas desde ${montoCashea(casheaSeisCuotasDesdeUsd)} $`;
  if (!c.sesion.fuentes.includes(linea)) c.sesion.fuentes.push(linea);
}

/**
 * Llama al modelo con el guion de v2 y devuelve lo que escribió (`""` si el turno ya se resolvió por
 * código). Si `generar` LANZA: sin nada enviado todavía, relanza (quien llama reintenta; no hay texto a
 * medias); con algo ya enviado (la bienvenida, o el resumen de una herramienta) no relanza: pasa el caso por
 * código para que el cliente no quede con una promesa a medias.
 */
async function redactar(c: Corrida, opciones: { soloBiblioteca: boolean }): Promise<string> {
  const renglones = await renglonesDelEstado(c);
  c.system = buildSeba2Instructions(contextoDelPrompt(c, renglones));
  agregarFuenteDeCashea(c);
  const tools = construirHerramientas(c, renglones, opciones.soloBiblioteca);
  const modelo = c.deps.modelo("redactar");
  const generar = c.deps.generar as unknown as ModeloGenerar;

  c.fx.escribiendo();
  c.llamadasAlModelo += 1;
  let resultado: Awaited<ReturnType<ModeloGenerar>>;
  try {
    resultado = await generar({
      model: modelo.model,
      providerOptions: modelo.providerOptions,
      system: c.system,
      messages: c.historial.messages,
      tools,
      // Una herramienta que deja todo dicho (pago entregado, caso pasado) corta el bucle.
      stopWhen: [isStepCount(SEBA2_MAX_PASOS), () => c.sesion.terminado],
      maxOutputTokens: SEBA2_MAX_OUTPUT_TOKENS,
      // El reintento vive en el control de ritmo (`rate-limit.ts`), no en el SDK (mismo criterio que v1).
      maxRetries: 0,
    });
  } catch (err) {
    await recuperarPorCodigo(c, err);
    return "";
  }
  sumarUso(c, resultado.usage);

  // El SDK no lanza si una herramienta falla: la herramienta terminó el turno (resumen enviado) pero el caso no
  // quedó con nadie. Se trata igual que un fallo del proveedor con algo ya enviado.
  if (c.errorDeHerramienta !== null && c.sesion.terminado && c.sesion.paso === null) {
    await recuperarPorCodigo(c, c.errorDeHerramienta.error);
    return "";
  }
  // El tope de tokens cortó la generación (con un modelo que razona, el tope incluye el razonamiento): el texto
  // quedó a medias y NO se envía. Caso real del arnés (R1/C4, 17/11/2026): «Para pagar con *Cashea*, el envío es
  // gratis y». Sin texto rigen los respaldos de siempre (línea fija, pregunta fija o la red de «vacío»).
  if (resultado.finishReason === "length") {
    log.warn("seba2_texto_cortado", { conversationId: c.entrada.conversationId, fase: "redactar" });
    return "";
  }
  return resultado.text ?? "";
}

/**
 * El modelo o una herramienta fallaron. Sin nada enviado: se relanza. Con algo enviado: se pasa el caso por
 * código (sin texto adicional) para que la invariante «ningún lead invisible» se cumpla; si ese pase también
 * lanza, también se relanza.
 */
async function recuperarPorCodigo(c: Corrida, error: unknown): Promise<void> {
  if (c.enviados.length === 0) throw error;

  const porHerramienta = c.errorDeHerramienta !== null;
  log.error("seba2_fallo_con_envio_previo", {
    conversationId: c.entrada.conversationId,
    causa: porHerramienta ? "herramienta" : "proveedor",
    detail: errorText(error),
  });
  if (c.sesion.paso === null) {
    const cita = citarRafaga(c.rafaga.lineas);
    await pasarPorCodigo(
      c,
      porHerramienta
        ? `No se pudo completar el pase del caso después de enviar el resumen al cliente. El cliente escribió: ${cita}`
        : `No se pudo redactar la respuesta (falló el proveedor). El cliente escribió: ${cita}`
    );
  }
  c.recuperadoPorCodigo = true;
  c.detalle.push("Falló el modelo o una herramienta después de enviar algo: el caso se pasó por código.");
}

/** El pase por código de «otro» a ventas, sin texto: lo que usan el respaldo del proveedor y la red de promesa. */
async function pasarPorCodigo(c: Corrida, nota: string): Promise<void> {
  const motivo: MotivoV2 = "otro";
  await c.fx.pasarAAsesor({ area: areaDeMotivo(motivo), motivo, nota: nota.slice(0, NOTA_MAX_CARACTERES) });
  c.sesion.paso = { area: areaDeMotivo(motivo), motivo };
  c.sesion.estado = { ...c.sesion.estado, etapa: "con_asesor", actualizadoEn: c.entrada.ahora.toISOString() };
}

// ------------------------------- 9. Guardas ---------------------------------

/**
 * Revisa un texto del modelo. Si falla: lo anota en la sesión, pide UNA reescritura y la revisa. Devuelve el
 * texto (original o reescrito) que puede salir, o `null` si ninguno pasa y rige el respaldo del código.
 */
async function pasarGuardas(c: Corrida, texto: string): Promise<string | null> {
  const revisar = (t: string): VeredictoDeSalida =>
    revisarSalida(t, {
      fuentes: c.sesion.fuentes,
      // Con la escalada abierta «un asesor te atiende» es verdad: ya hay quien atienda.
      pasoEnEsteTurno: c.sesion.paso !== null || c.sesion.escaladaAbierta,
      nombresDeAsesores: c.datos.nombresDeAsesores,
      rafaga: c.rafaga.lineas,
    });

  const primero = revisar(texto);
  if (primero.ok) return texto;
  c.sesion.guardas.push({ guarda: primero.guarda, fragmento: primero.fragmento });

  const reescrito = await reescribir(c, texto, primero);
  if (reescrito === null) return null;

  const segundo = revisar(reescrito);
  if (segundo.ok) return reescrito;
  c.sesion.guardas.push({ guarda: segundo.guarda, fragmento: segundo.fragmento });
  return null;
}

async function reescribir(
  c: Corrida,
  texto: string,
  veredicto: Extract<VeredictoDeSalida, { ok: false }>
): Promise<string | null> {
  const modelo = c.deps.modelo("identidad");
  const generar = c.deps.generar as unknown as ModeloGenerar;
  c.llamadasAlModelo += 1;
  try {
    const resultado = await generar({
      model: modelo.model,
      providerOptions: modelo.providerOptions,
      // El MISMO system y los mismos mensajes: el prefijo cacheado se reutiliza. Al final, lo que se escribió y la
      // instrucción de qué no repetir.
      system: c.system,
      messages: [
        ...c.historial.messages,
        { role: "assistant", content: texto },
        { role: "user", content: instruccionDeReescritura(veredicto) },
      ],
      maxOutputTokens: REESCRITURA_MAX_TOKENS,
      maxRetries: 0,
    });
    sumarUso(c, resultado.usage);
    if (resultado.finishReason === "length") {
      // Una reescritura a medias no se envía: cuenta como una que no pasó y rige el respaldo (R1/C4).
      log.warn("seba2_texto_cortado", { conversationId: c.entrada.conversationId, fase: "reescribir" });
      return null;
    }
    const limpio = (resultado.text ?? "").trim();
    return limpio === "" ? null : limpio;
  } catch (err) {
    // Un proveedor caído no tumba el turno: la reescritura «no pasó» y rige el respaldo.
    log.warn("seba2_reescritura_fallida", { conversationId: c.entrada.conversationId, detail: errorText(err) });
    return null;
  }
}

// ----------------------------- 8. La salida ---------------------------------

type Item =
  | { tipo: "imagen"; url: string; pie: string | null }
  | { tipo: "texto"; texto: string; origen: OrigenTexto };

function cupoDeMensajes(c: Corrida): number {
  return Math.max(0, SEBA2_MAX_MENSAJES - c.enviados.length);
}

/** Lo que el cliente leerá en este ítem (el texto, o el pie de la foto). */
function textoDe(item: Item): string {
  return item.tipo === "texto" ? item.texto : (item.pie ?? "");
}

async function armarYEntregarSalida(c: Corrida, textoModelo: string): Promise<void> {
  const fotoDe = await cargarFotoDe(c);
  const plan = planearSalida({
    textoModelo,
    catalogOutcome: c.catalogOutcome,
    fotoDe,
    maxMensajes: Math.max(1, cupoDeMensajes(c)),
  });

  switch (plan.tipo) {
    case "cotizacion":
      await entregarCotizacion(c, plan);
      break;
    case "pregunta":
      await entregarPregunta(c, plan);
      break;
    case "texto":
      await entregarTexto(c, plan.textos);
      break;
    case "vacio":
      await pasarPorRedDeSeguridad(c, plan.huboBusqueda);
      break;
  }

  avanzarEtapaSiAcepta(c, plan);
}

/** La foto principal del producto cotizado, solo si se cotizó UNO con existencia. */
async function cargarFotoDe(c: Corrida): Promise<(productId: string) => string | null> {
  const lineas = c.catalogOutcome.cotizacion;
  if (lineas.length !== 1 || lineas[0].stock <= 0) return () => null;
  const [producto] = await cargarProductosSinFallar(c, [lineas[0].productId]);
  const url = producto ? (fotoPrincipal(producto)?.url ?? null) : null;
  return (productId) => (productId === lineas[0].productId ? url : null);
}

async function entregarCotizacion(c: Corrida, plan: Extract<PlanDeSalida, { tipo: "cotizacion" }>): Promise<void> {
  // El bloque es lo que el cliente ve: de aquí pueden salir las cifras que cite la línea del modelo.
  c.sesion.fuentes.push(plan.bloque);

  const linea = await lineaDeCierre(c, plan);
  const items = armarItemsDeCotizacion(plan, linea);
  const entregados = await enviarItems(c, items);

  const bloqueSalio = entregados.some((item) => textoDe(item).includes(plan.bloque));
  if (bloqueSalio && plan.hayExistencia) {
    // El pedido tentativo es lo que el cliente vio con existencia: un producto por renglón, de a uno.
    const vistos = new Set<string>();
    const lineas = plan.productos
      .filter((p) => p.stock > 0 && !vistos.has(p.productId) && vistos.add(p.productId))
      .map((p) => ({ productId: p.productId, cantidad: 1 }));
    c.sesion.estado = {
      ...c.sesion.estado,
      etapa: "cotizado",
      lineas,
      actualizadoEn: c.entrada.ahora.toISOString(),
    };
  }
  c.detalle.push(
    plan.hayExistencia
      ? `Cotizó ${plan.productos.length} producto(s).`
      : "Dijo que lo pedido está agotado o no se pudo cotizar."
  );
}

/** La línea que cierra la cotización: la del modelo si pasa las guardas, y si no la fija (solo si hay existencia). */
async function lineaDeCierre(
  c: Corrida,
  plan: Extract<PlanDeSalida, { tipo: "cotizacion" }>
): Promise<{ texto: string; origen: OrigenTexto } | null> {
  if (plan.lineaDelModelo !== null) {
    const aprobada = await pasarGuardas(c, plan.lineaDelModelo);
    if (aprobada !== null) return { texto: aprobada, origen: "modelo" };
  }
  return plan.hayExistencia ? { texto: LINEA_CIERRE_COTIZACION, origen: "fijo" } : null;
}

function armarItemsDeCotizacion(
  plan: Extract<PlanDeSalida, { tipo: "cotizacion" }>,
  linea: { texto: string; origen: OrigenTexto } | null
): Item[] {
  const items: Item[] = [];
  if (plan.foto !== null) {
    if (plan.bloque.length <= PIE_MAX_CARACTERES) {
      items.push({ tipo: "imagen", url: plan.foto.url, pie: plan.bloque });
    } else {
      // Un pie más largo no entra en WhatsApp: la foto va sola y el bloque, como texto.
      items.push({ tipo: "imagen", url: plan.foto.url, pie: null });
      items.push({ tipo: "texto", texto: plan.bloque, origen: "herramienta" });
    }
  } else {
    items.push({ tipo: "texto", texto: plan.bloque, origen: "herramienta" });
  }
  if (linea !== null) items.push({ tipo: "texto", texto: linea.texto, origen: linea.origen });
  return items;
}

async function entregarPregunta(c: Corrida, plan: Extract<PlanDeSalida, { tipo: "pregunta" }>): Promise<void> {
  let texto = plan.respaldo;
  let origen: OrigenTexto = "fijo";
  if (plan.origen === "modelo") {
    const aprobada = await pasarGuardas(c, plan.texto);
    if (aprobada !== null) {
      texto = aprobada;
      origen = "modelo";
    }
  }
  await enviarItems(c, [{ tipo: "texto", texto, origen }]);
  c.detalle.push("Hizo una pregunta para encontrar el producto.");
}

async function entregarTexto(c: Corrida, partes: string[]): Promise<void> {
  const aprobados: Item[] = [];
  for (const parte of partes) {
    const aprobada = await pasarGuardas(c, parte);
    if (aprobada !== null) aprobados.push({ tipo: "texto", texto: aprobada, origen: "modelo" });
  }
  // Ningún trozo pasó las guardas: es como si el modelo no hubiera dejado texto.
  if (aprobados.length === 0) {
    await pasarPorRedDeSeguridad(c, c.catalogOutcome.ran);
    return;
  }
  await enviarItems(c, aprobados);
  c.detalle.push("Contestó con el texto del modelo.");
}

/**
 * El modelo no dejó nada usable y ninguna herramienta habló: el cliente nunca queda sin respuesta ni sin dueño.
 * El motivo separa «se buscó y no se identificó» de «no se buscó» (pauta P10); el mensaje es el texto fijo del
 * área; la nota cuenta qué escribió el cliente.
 */
async function pasarPorRedDeSeguridad(c: Corrida, huboBusqueda: boolean): Promise<void> {
  const motivo: MotivoV2 = huboBusqueda ? "no_identificado" : "otro";
  const cita = citarRafaga(c.rafaga.lineas);
  const nota = huboBusqueda
    ? `Se buscó en el inventario y no se pudo identificar el producto; el modelo no dejó una respuesta. El cliente escribió: ${cita}`
    : `El modelo no dejó una respuesta para el cliente. El cliente escribió: ${cita}`;
  log.warn("seba2_salida_vacia", { conversationId: c.entrada.conversationId, motivo });
  await ejecutarPase(
    { effects: c.fx, sesion: c.sesion, rafaga: c.rafaga.lineas, nombresDeAsesores: c.datos.nombresDeAsesores },
    { motivo, nota: nota.slice(0, NOTA_MAX_CARACTERES), mensajeAlCliente: TEXTO_PASE[areaDeMotivo(motivo)] }
  );
  c.detalle.push("El modelo no dejó respuesta: el caso se pasó por código.");
}

/** Si el cliente estaba por decidir y acepta (o habla de pagar) sin que este turno cotice de nuevo, pasa a elegir cómo paga. */
function avanzarEtapaSiAcepta(c: Corrida, plan: PlanDeSalida): void {
  if (plan.tipo === "cotizacion") return;
  if (c.enviados.length === 0) return;
  if (c.sesion.estado.etapa !== "cotizado") return;
  if (!pareceAceptacion(c.rafaga.lineas)) return;
  c.sesion.estado = { ...c.sesion.estado, etapa: "eligiendo_pago", actualizadoEn: c.entrada.ahora.toISOString() };
}

// ------------------------------ 10. Envío -----------------------------------

/**
 * Si hay más mensajes que cupo, une los sobrantes al último de texto (nada se pierde). Una foto cuenta como un
 * mensaje; con cupo para uno solo, la foto sin pie cede su lugar al bloque y una foto con el bloque en el pie se
 * queda sola.
 */
function ajustarAlCupo(items: Item[], cupo: number): Item[] {
  if (cupo <= 0) return [];
  if (items.length <= cupo) return items;

  let imagen = items.find((i): i is Extract<Item, { tipo: "imagen" }> => i.tipo === "imagen") ?? null;
  const textosDelPlan = items.filter((i): i is Extract<Item, { tipo: "texto" }> => i.tipo === "texto");
  if (imagen !== null && cupo === 1) {
    if (imagen.pie !== null) return [imagen];
    imagen = null;
  }

  const lugaresDeTexto = cupo - (imagen === null ? 0 : 1);
  const unidos = unirMensajesDeTexto(
    textosDelPlan.map((t) => ({ texto: t.texto, origen: t.origen })),
    lugaresDeTexto
  ).map((t): Item => ({ tipo: "texto", texto: t.texto, origen: t.origen }));
  return imagen === null ? unidos : [imagen, ...unidos];
}

/**
 * Envía los ítems de la salida, de a uno. Antes de CADA envío mira si el cliente escribió de nuevo: si sí, se
 * descarta lo que falta (el turno ya encolado contesta todo junto). Un envío que falla corta la serie.
 * Devuelve los ítems que sí salieron.
 */
async function enviarItems(c: Corrida, items: Item[]): Promise<Item[]> {
  const cupo = cupoDeMensajes(c);
  const porEnviar = ajustarAlCupo(items, cupo);
  if (porEnviar.length < items.length && cupo <= 0) {
    log.warn("seba2_tope_de_mensajes", { conversationId: c.entrada.conversationId });
  }

  const salieron: Item[] = [];
  for (const item of porEnviar) {
    // Contra la marca de ESTA ráfaga (todo lo que el turno ya vio), nunca contra la «visto» del turno anterior: con
    // esa, los mensajes que se están contestando contaban como nuevos y el turno cedía siempre (R1/C1, 17/11/2026).
    if (await c.fx.hayMensajeNuevoDelCliente(c.rafaga.marcador)) {
      c.cedio = true;
      c.detalle.push("Cedió: el cliente escribió de nuevo y el turno siguiente contesta todo junto.");
      log.info("seba2_turno_cedido", { conversationId: c.entrada.conversationId, enviados: c.enviados.length });
      break;
    }
    const resultado =
      item.tipo === "imagen"
        ? await c.fx.enviarImagen(item.url, item.pie)
        : await c.fx.enviarTexto(item.texto, item.origen);
    if (!resultado.ok) {
      c.detalle.push("Un envío falló.");
      break;
    }
    salieron.push(item);
  }
  return salieron;
}

/** Red de promesa: un texto enviado que afirma un asesor sin que el caso haya pasado se vuelve verdad. */
async function redDePromesa(c: Corrida): Promise<void> {
  if (c.sesion.escaladaAbierta || c.sesion.paso !== null) return;

  // Las frases de la apertura (bienvenida y frase fija) son textos del negocio, no promesas del modelo.
  const promesa = c.enviados
    .filter((e) => !e.apertura)
    .map((e) => afirmaPromesaDeAsesor(e.texto))
    .find((frase) => frase !== null);
  if (!promesa) return;

  log.warn("seba2_promesa_sin_pase", { conversationId: c.entrada.conversationId, frase: promesa.slice(0, 200) });
  await pasarPorCodigo(
    c,
    `Un mensaje enviado decía «${promesa.slice(0, 200)}» pero el turno no había pasado el caso a nadie. Se pasó para que sea verdad. El cliente escribió: ${citarRafaga(c.rafaga.lineas)}`
  );
  c.detalle.push("Un texto enviado prometía un asesor: se pasó el caso para que fuera verdad.");
}

// -------------------------------- 11. Cierre --------------------------------

function accionDelTurno(c: Corrida): ResumenDeTurno["accion"] {
  if (c.sesion.paso !== null) return "escalated";
  if (c.enviados.length > 0) return "answered";
  if (c.falloEnvio) return "error";
  return "skipped";
}

function resumenDeUnaLinea(c: Corrida): string {
  const partes = [...c.detalle];
  const herramientas = [...new Set(c.sesion.herramientas)];
  if (herramientas.length > 0) partes.push(`Herramientas: ${herramientas.join(", ")}.`);
  if (c.sesion.paso !== null) partes.push(`Pasó el caso a ${c.sesion.paso.area} (${c.sesion.paso.motivo}).`);
  partes.push(c.enviados.length === 1 ? "Envió 1 mensaje." : `Envió ${c.enviados.length} mensajes.`);
  return partes.join(" ");
}

/** El resumen con lo que el turno sabe hasta aquí (sirve al cierre normal y al de error). */
function armarResumen(c: Corrida, accion: ResumenDeTurno["accion"], resumen: string): ResumenDeTurno {
  const consultas = c.catalogOutcome.consultas;
  return {
    accion,
    resumen,
    rafaga: c.rafaga.lineas,
    triggerMessageId: c.rafaga.triggerMessageId,
    estadoAntes: c.estadoLeido,
    estadoDespues: c.sesion.estado,
    herramientas: [...c.sesion.herramientas],
    productos: [...c.sesion.productos],
    guardas: [...c.sesion.guardas],
    contexto: {
      iaGlobal: c.entrada.iaGlobal,
      asesorAsignado: c.datos.conversacion.assignedAgentId !== null,
      asesorEscribioHaceMin: c.datos.asesorEscribioHaceMin,
    },
    tokens: c.tokens,
    modelo: c.llamadasAlModelo > 0 ? c.deps.etiquetaDeModelo() : null,
    duracionMs: Date.now() - c.inicio,
    ...(consultas.length > 0 ? { consultasCatalogo: consultas } : {}),
  };
}

/**
 * Guarda el estado, marca «visto» y registra el turno. `marcarVisto` solo si el turno contestó o decidió con
 * fundamento no contestar: si cedió antes de enviar nada, o un envío falló antes de enviar nada, la ráfaga
 * sigue pendiente y el próximo turno la atiende.
 */
async function cerrarTurno(c: Corrida): Promise<ResumenDeTurno> {
  const huboEfecto = c.enviados.length > 0 || c.decidido || c.sesion.paso !== null;
  if (huboEfecto) {
    c.sesion.estado = { ...c.sesion.estado, actualizadoEn: c.entrada.ahora.toISOString() };
    await c.effects.guardarEstado(c.sesion.estado);
  }

  const contesto = c.enviados.length > 0 || (c.decidido && !c.falloEnvio && !c.cedio);
  if (contesto && c.rafaga.marcador !== null) await c.effects.marcarVisto(c.rafaga.marcador);

  const resumen = armarResumen(c, accionDelTurno(c), resumenDeUnaLinea(c));
  c.cerrado = true;
  await c.effects.cerrar(resumen);
  log.info("seba2_turno_cerrado", {
    conversationId: c.entrada.conversationId,
    modo: c.effects.modo,
    accion: resumen.accion,
    mensajes: c.enviados.length,
    herramientas: c.sesion.herramientas.length,
  });
  return resumen;
}

/** Cualquier excepción: se cierra con «error» (sin lanzar desde aquí) y quien llama relanza. Lo ya enviado no se «deshace». */
async function cerrarConError(
  entrada: EntradaDeTurno,
  effects: TurnEffects,
  avance: Avance,
  error: unknown
): Promise<void> {
  const c = avance.corrida;
  if (c?.cerrado || avance.cerrado) return;
  avance.cerrado = true;
  if (c) c.cerrado = true;

  log.error("seba2_turno_fallido", { conversationId: entrada.conversationId, detail: errorText(error) });

  const resumen: ResumenDeTurno = c
    ? armarResumen(c, "error", errorText(error))
    : {
        accion: "error",
        resumen: errorText(error),
        rafaga: [],
        triggerMessageId: null,
        estadoAntes: null,
        estadoDespues: null,
        herramientas: [],
        productos: [],
        guardas: [],
        contexto: { iaGlobal: entrada.iaGlobal, asesorAsignado: false, asesorEscribioHaceMin: null },
        tokens: null,
        modelo: null,
        duracionMs: Date.now() - avance.inicio,
      };
  try {
    await effects.cerrar(resumen);
  } catch (err) {
    // El cierre de un turno que ya falló no puede tapar el error original.
    log.error("seba2_cierre_de_error_fallido", { conversationId: entrada.conversationId, detail: errorText(err) });
  }
}

