// ---------------------------------------------------------------------------
// Los CASOS del arnés de turnos de Seba v2 (17/11/2026, entrega 3 del rework).
//
// Un caso es una línea de un `.jsonl` de `privado/seba-v2/`: una conversación
// armada a mano (o sacada de una real por el Claude del VPS) con lo que se
// espera que el turno haga. Este archivo es PURO —sin base, sin red, sin
// `server-only`—: define la forma del caso, lo valida y lo convierte en el
// historial que el turno carga como si viniera de `loadHistory`. Así se prueba
// en la suite normal, sin levantar nada.
//
// El repositorio es PÚBLICO: los casos reales viven en `privado/seba-v2/*.jsonl`
// (ignorado por git). Lo único versionado es `ejemplo.sintetico.jsonl`, con
// datos inventados.
// ---------------------------------------------------------------------------

import type { ModelMessage } from "ai";
import { historyLine, type HistoryReading } from "@/lib/ai/history-line";
import { parseImageFields, type ImageFields } from "@/lib/media-reading-fields";
import { isArea, type Area } from "@/lib/seba-v2-config";
import type { HistorialDeTurno } from "@/lib/seba2/contexto";
import { esMotivoV2, type MotivoV2 } from "@/lib/seba2/motivos";
import { parseEstadoSeba, type EstadoSeba } from "@/lib/seba2/tipos";

export const FUENTES_DE_CASO = ["ejemplar", "regresion", "saint", "borde"] as const;
export type FuenteDeCaso = (typeof FUENTES_DE_CASO)[number];

export const AUTORES_DE_HISTORIAL = ["cliente", "asesor", "seba"] as const;
export type AutorDeHistorial = (typeof AUTORES_DE_HISTORIAL)[number];

export type LecturaDeCaso = ImageFields | { transcripcion: string };

export interface MensajeDeCaso {
  de: AutorDeHistorial;
  texto: string;
  /** Minutos transcurridos desde ese mensaje hasta «ahora» (mayor = más viejo). */
  haceMin: number;
  /** Lo que el webhook habría leído de un adjunto del cliente (foto o nota de voz). */
  lectura?: LecturaDeCaso;
}

export interface EsperadoDeCaso {
  /** `saint_code` de los productos que serían una cotización correcta. */
  productosValidos?: string[];
  /** Primera palabra del nombre del producto en Saint («CASCO», «ACEITE»…). */
  categoria?: string;
  /** `null` = no se exige nada (igual que omitirlo). */
  debePasar?: { area: Area; motivo?: MotivoV2 } | null;
  noDebePasar?: boolean;
  debeEntregarDatosDePago?: boolean;
  frasesProhibidas?: string[];
}

export interface CasoArnes {
  id: string;
  fuente: FuenteDeCaso;
  historial: MensajeDeCaso[];
  /** Los mensajes de texto que el turno tiene por atender (la ráfaga pendiente). */
  rafaga: string[];
  /** Lecturas de imagen que llegan CON la ráfaga (p. ej. un comprobante). */
  rafagaLecturas?: ImageFields[];
  estado: EstadoSeba | null;
  /** Productos (`saint_code`) que se dan por ya cotizados en la conversación. */
  yaCotizados?: string[];
  escaladaAbierta?: boolean;
  esperado: EsperadoDeCaso;
}

// ------------------------------- Validación ---------------------------------

function esObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === "object" && valor !== null && !Array.isArray(valor);
}

/** Error de un caso con el lugar exacto: `archivo:línea: …`. */
class ErrorDeCaso extends Error {}

function falla(archivo: string, linea: number, detalle: string): never {
  throw new ErrorDeCaso(`${archivo}:${linea}: ${detalle}`);
}

function textos(valor: unknown, donde: string, archivo: string, linea: number): string[] {
  if (!Array.isArray(valor) || valor.some((v) => typeof v !== "string")) {
    falla(archivo, linea, `${donde} tiene que ser un arreglo de textos.`);
  }
  return valor as string[];
}

function parseLectura(valor: unknown, donde: string, archivo: string, linea: number): LecturaDeCaso {
  if (esObjeto(valor) && typeof valor.transcripcion === "string") {
    if (valor.transcripcion.trim() === "") falla(archivo, linea, `${donde}.transcripcion no puede estar vacía.`);
    return { transcripcion: valor.transcripcion };
  }
  const campos = parseImageFields(valor);
  if (!campos) falla(archivo, linea, `${donde} no es una lectura válida (ni {transcripcion} ni una imagen con un «tipo» conocido).`);
  return campos;
}

function parseEsperado(valor: unknown, archivo: string, linea: number): EsperadoDeCaso {
  if (!esObjeto(valor)) falla(archivo, linea, "«esperado» tiene que ser un objeto.");
  const esperado: EsperadoDeCaso = {};

  if (valor.productosValidos !== undefined) {
    esperado.productosValidos = textos(valor.productosValidos, "esperado.productosValidos", archivo, linea);
  }
  if (valor.categoria !== undefined) {
    if (typeof valor.categoria !== "string" || valor.categoria.trim() === "") {
      falla(archivo, linea, "esperado.categoria tiene que ser un texto no vacío.");
    }
    esperado.categoria = valor.categoria;
  }
  if (valor.debePasar !== undefined) {
    if (valor.debePasar === null) {
      esperado.debePasar = null;
    } else {
      if (!esObjeto(valor.debePasar) || !isArea(valor.debePasar.area)) {
        falla(archivo, linea, "esperado.debePasar tiene que ser null o {area, motivo?} con un área válida (pagos, ventas, envios, reclamos).");
      }
      const { area, motivo } = valor.debePasar;
      if (motivo !== undefined && !esMotivoV2(motivo)) {
        falla(archivo, linea, `esperado.debePasar.motivo «${String(motivo)}» no es un motivo de Seba v2.`);
      }
      esperado.debePasar = { area, ...(motivo !== undefined ? { motivo } : {}) } as EsperadoDeCaso["debePasar"];
    }
  }
  if (valor.noDebePasar !== undefined) {
    if (typeof valor.noDebePasar !== "boolean") falla(archivo, linea, "esperado.noDebePasar tiene que ser true o false.");
    esperado.noDebePasar = valor.noDebePasar;
  }
  if (valor.debeEntregarDatosDePago !== undefined) {
    if (typeof valor.debeEntregarDatosDePago !== "boolean") {
      falla(archivo, linea, "esperado.debeEntregarDatosDePago tiene que ser true o false.");
    }
    esperado.debeEntregarDatosDePago = valor.debeEntregarDatosDePago;
  }
  if (valor.frasesProhibidas !== undefined) {
    esperado.frasesProhibidas = textos(valor.frasesProhibidas, "esperado.frasesProhibidas", archivo, linea);
  }
  return esperado;
}

function parseHistorial(valor: unknown, archivo: string, linea: number): MensajeDeCaso[] {
  if (!Array.isArray(valor)) falla(archivo, linea, "«historial» tiene que ser un arreglo.");
  return valor.map((item, i): MensajeDeCaso => {
    const donde = `historial[${i}]`;
    if (!esObjeto(item)) falla(archivo, linea, `${donde} tiene que ser un objeto.`);
    if (!(AUTORES_DE_HISTORIAL as readonly string[]).includes(item.de as string)) {
      falla(archivo, linea, `${donde}.de tiene que ser ${AUTORES_DE_HISTORIAL.join(", ")}.`);
    }
    if (typeof item.texto !== "string") falla(archivo, linea, `${donde}.texto tiene que ser un texto.`);
    // Menos de un minuto dejaría el mensaje pegado a la ráfaga (que se fecha en los últimos segundos).
    if (typeof item.haceMin !== "number" || !Number.isFinite(item.haceMin) || item.haceMin < 1) {
      falla(archivo, linea, `${donde}.haceMin tiene que ser un número de minutos mayor o igual a 1.`);
    }
    const lectura = item.lectura === undefined ? undefined : parseLectura(item.lectura, `${donde}.lectura`, archivo, linea);
    if (lectura === undefined && item.texto.trim() === "") {
      falla(archivo, linea, `${donde}.texto no puede estar vacío si no trae una lectura.`);
    }
    return {
      de: item.de as AutorDeHistorial,
      texto: item.texto,
      haceMin: item.haceMin,
      ...(lectura !== undefined ? { lectura } : {}),
    };
  });
}

/** Hueco máximo entre dos líneas del cliente para que sean la misma ráfaga (`CUSTOMER_BURST_GAP_MINUTES`, 10). */
const HUECO_DE_RAFAGA_MIN = 10;

function parseCaso(crudo: unknown, archivo: string, linea: number): CasoArnes {
  if (!esObjeto(crudo)) falla(archivo, linea, "la línea tiene que ser un objeto JSON.");

  if (typeof crudo.id !== "string" || crudo.id.trim() === "") falla(archivo, linea, "«id» tiene que ser un texto no vacío.");
  if (!(FUENTES_DE_CASO as readonly string[]).includes(crudo.fuente as string)) {
    falla(archivo, linea, `«fuente» tiene que ser ${FUENTES_DE_CASO.join(", ")}.`);
  }

  const historial = parseHistorial(crudo.historial ?? [], archivo, linea);
  const rafaga = textos(crudo.rafaga ?? [], "«rafaga»", archivo, linea);

  let rafagaLecturas: ImageFields[] | undefined;
  if (crudo.rafagaLecturas !== undefined) {
    if (!Array.isArray(crudo.rafagaLecturas)) falla(archivo, linea, "«rafagaLecturas» tiene que ser un arreglo.");
    rafagaLecturas = crudo.rafagaLecturas.map((item, i) => {
      const campos = parseImageFields(item);
      if (!campos) falla(archivo, linea, `rafagaLecturas[${i}] no es una lectura de imagen válida (falta un «tipo» conocido).`);
      return campos;
    });
  }
  if (rafaga.length === 0 && (rafagaLecturas?.length ?? 0) === 0) {
    falla(archivo, linea, "el caso no trae nada que contestar: «rafaga» y «rafagaLecturas» están vacías.");
  }
  if (rafaga.some((l) => l.trim() === "")) falla(archivo, linea, "«rafaga» no puede traer líneas vacías.");

  // Un historial que termina en el cliente, sin respuesta de por medio y a menos de 10 minutos, se fusionaría
  // con la ráfaga: el turno contestaría más de lo que el caso dice.
  const ultimo = [...historial].sort((a, b) => b.haceMin - a.haceMin).at(-1);
  if (ultimo && ultimo.de === "cliente" && ultimo.haceMin <= HUECO_DE_RAFAGA_MIN) {
    falla(
      archivo,
      linea,
      "el historial termina en un mensaje del cliente de hace menos de 10 minutos: se fusionaría con la ráfaga (pon una respuesta en medio o súbele el «haceMin»)."
    );
  }

  let estado: EstadoSeba | null = null;
  if (crudo.estado !== undefined && crudo.estado !== null) {
    estado = parseEstadoSeba(crudo.estado);
    if (estado === null) falla(archivo, linea, "«estado» no es un estado de Seba válido (etapa o entrega desconocida).");
  }

  let yaCotizados: string[] | undefined;
  if (crudo.yaCotizados !== undefined) yaCotizados = textos(crudo.yaCotizados, "«yaCotizados»", archivo, linea);

  if (crudo.escaladaAbierta !== undefined && typeof crudo.escaladaAbierta !== "boolean") {
    falla(archivo, linea, "«escaladaAbierta» tiene que ser true o false.");
  }

  return {
    id: crudo.id,
    fuente: crudo.fuente as FuenteDeCaso,
    historial,
    rafaga,
    ...(rafagaLecturas !== undefined ? { rafagaLecturas } : {}),
    estado,
    ...(yaCotizados !== undefined ? { yaCotizados } : {}),
    ...(crudo.escaladaAbierta !== undefined ? { escaladaAbierta: crudo.escaladaAbierta as boolean } : {}),
    esperado: parseEsperado(crudo.esperado ?? {}, archivo, linea),
  };
}

/**
 * Una línea = un caso. Las líneas en blanco se saltan; una línea inválida lanza un
 * `Error` con el archivo y el número de línea (1 = la primera del archivo). Un `id`
 * repetido también lanza: los reportes se leen por `id`.
 */
export function parseCasos(jsonl: string, archivo: string): CasoArnes[] {
  const casos: CasoArnes[] = [];
  const vistos = new Map<string, number>();

  jsonl.split(/\r?\n/).forEach((texto, indice) => {
    if (texto.trim() === "") return;
    const linea = indice + 1;
    let crudo: unknown;
    try {
      crudo = JSON.parse(texto);
    } catch (err) {
      falla(archivo, linea, `no es JSON válido (${err instanceof Error ? err.message : String(err)}).`);
    }
    const caso = parseCaso(crudo, archivo, linea);
    const previa = vistos.get(caso.id);
    if (previa !== undefined) falla(archivo, linea, `el id «${caso.id}» ya se usó en la línea ${previa}.`);
    vistos.set(caso.id, linea);
    casos.push(caso);
  });

  return casos;
}

// ------------------------------- Historial ----------------------------------

const MS_POR_MINUTO = 60_000;

/** La ráfaga se fecha en los últimos segundos: siempre después de cualquier mensaje del historial (haceMin ≥ 1). */
const SEGUNDOS_ENTRE_LINEAS_DE_RAFAGA = 2;

interface FilaSintetica {
  de: AutorDeHistorial;
  texto: string;
  tipo: "text" | "image" | "audio";
  lectura: HistoryReading | null;
  createdAt: string;
}

function lecturaDeImagen(campos: ImageFields): HistoryReading {
  // `text` es la descripción que el modelo de visión habría dejado; sin ella `historyLine` cae al marcador «no puedes verla».
  return { status: "ok", text: campos.producto_visible ?? campos.tipo.replace(/_/g, " "), fields: campos };
}

function filaDeHistorial(m: MensajeDeCaso, ahora: Date): FilaSintetica {
  const createdAt = new Date(ahora.getTime() - m.haceMin * MS_POR_MINUTO).toISOString();
  if (m.lectura === undefined) return { de: m.de, texto: m.texto, tipo: "text", lectura: null, createdAt };
  if ("transcripcion" in m.lectura) {
    return {
      de: m.de,
      texto: m.texto,
      tipo: "audio",
      lectura: { status: "ok", text: m.lectura.transcripcion, fields: null },
      createdAt,
    };
  }
  return { de: m.de, texto: m.texto, tipo: "image", lectura: lecturaDeImagen(m.lectura), createdAt };
}

/**
 * El historial del caso con la forma EXACTA que devuelve `loadHistory` (cuatro arreglos
 * paralelos) y con ids sintéticos. Orden cronológico: primero el `historial` (el más viejo
 * arriba, sin importar en qué orden se escribió en el archivo) y, al final, la ráfaga como
 * mensajes recientes del cliente —las líneas de texto y luego una foto por cada lectura de
 * `rafagaLecturas`— de modo que `derivarRafaga(historial, null, ahora)` devuelva EXACTAMENTE
 * esa ráfaga y esas lecturas. Una foto o una nota de voz sale como la escribiría
 * `historyLine` (la misma función que usa `loadHistory`).
 */
export function historialDeCaso(caso: CasoArnes, ahora: Date): HistorialDeTurno {
  const previas = caso.historial
    .map((m) => filaDeHistorial(m, ahora))
    .map((fila, orden) => ({ fila, orden }))
    // Estable: dos mensajes del mismo minuto conservan el orden en que se escribieron.
    .sort((a, b) => Date.parse(a.fila.createdAt) - Date.parse(b.fila.createdAt) || a.orden - b.orden)
    .map((x) => x.fila);

  const textosDeRafaga = caso.rafaga.map((texto): Omit<FilaSintetica, "createdAt"> => ({
    de: "cliente",
    texto,
    tipo: "text",
    lectura: null,
  }));
  const fotosDeRafaga = (caso.rafagaLecturas ?? []).map((campos): Omit<FilaSintetica, "createdAt"> => ({
    de: "cliente",
    texto: "",
    tipo: "image",
    lectura: lecturaDeImagen(campos),
  }));
  const deLaRafaga = [...textosDeRafaga, ...fotosDeRafaga];
  const filasDeRafaga: FilaSintetica[] = deLaRafaga.map((fila, i) => ({
    ...fila,
    createdAt: new Date(
      ahora.getTime() - (deLaRafaga.length - i) * SEGUNDOS_ENTRE_LINEAS_DE_RAFAGA * 1000
    ).toISOString(),
  }));

  const historial: HistorialDeTurno = { messages: [], createdAt: [], ids: [], lecturas: [] };
  [...previas, ...filasDeRafaga].forEach((fila, i) => {
    const linea = historyLine({
      sender_type: fila.de === "cliente" ? "customer" : fila.de === "asesor" ? "agent" : "ai",
      content: fila.texto.trim() === "" ? null : fila.texto,
      is_internal_note: false,
      message_type: fila.tipo,
      reading: fila.de === "cliente" ? fila.lectura : null,
    });
    // Una fila que `historyLine` descarta no existe para el modelo (mismo criterio que `loadHistory`).
    if (linea === null) return;
    historial.messages.push({ role: linea.role, content: linea.content } as ModelMessage);
    historial.createdAt.push(fila.createdAt);
    historial.ids.push(`arnes-${caso.id}-${i}`);
    historial.lecturas.push(fila.de === "cliente" ? fila.lectura : null);
  });
  return historial;
}

// ------------------------------- Entorno ------------------------------------

/**
 * Lo que falta en el entorno para correr el arnés (vacío = se puede correr). La llave del
 * modelo depende del proveedor que el turno va a usar: Google si `AI_AGENT_PROVIDER=google` o
 * el modelo empieza por «gemini»; OpenAI en cualquier otro caso.
 */
export function faltantesDelEntorno(env: Record<string, string | undefined>): string[] {
  const faltan: string[] = [];
  if (!env.ARNES_SUPABASE_URL) faltan.push("ARNES_SUPABASE_URL");
  if (!env.ARNES_SUPABASE_KEY) faltan.push("ARNES_SUPABASE_KEY");

  const proveedor = env.AI_AGENT_PROVIDER?.trim().toLowerCase();
  const modelo = env.AI_AGENT_MODEL?.trim() || "gpt-5.6-luna";
  const esGoogle = proveedor === "google" || (proveedor !== "openai" && modelo.startsWith("gemini"));
  const llave = esGoogle ? "GOOGLE_GENERATIVE_AI_API_KEY" : "OPENAI_API_KEY";
  if (!env[llave]) faltan.push(llave);
  return faltan;
}
