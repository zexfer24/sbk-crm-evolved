// ---------------------------------------------------------------------------
// Los CHEQUEOS del arnés de turnos de Seba v2 (17/11/2026, entrega 3 del rework).
//
// Cada chequeo mira lo que UN turno hizo (el resumen y el registro de los efectos de
// memoria) contra lo que el caso esperaba, y dice si pasó, si no pasó o si no aplica.
// De los resultados salen la tasa por chequeo y por fuente, y las PUERTAS para pasar
// de «arnés» a «sombra» (`evaluarPuertas`). Todo es PURO —sin base, sin red—: el arnés
// real (`arnes-turnos-v2.test.ts`) solo corre los turnos y se los pasa a este archivo.
// ---------------------------------------------------------------------------

import { findUnsourcedFigure } from "@/lib/ai/price-guard";
import { esComprobante, esOrdenCashea } from "@/lib/media-reading-fields";
import type { RegistroDeMemoria } from "@/lib/seba2/effects-memoria";
import type { MensajeDeTurno, ResumenDeTurno, TokensDeTurno } from "@/lib/seba2/tipos";
import type { CasoArnes, FuenteDeCaso } from "./arnes-turnos-v2.caso";

export interface ProductoDeArnes {
  saintCode: string | null;
  nombre: string;
}

export interface EntradaDeChequeo {
  caso: CasoArnes;
  resumen: ResumenDeTurno;
  registro: RegistroDeMemoria;
  /** id de producto → lo que se sabe de él en la base (lo cotizado en el turno). */
  productos: Record<string, ProductoDeArnes>;
}

export interface ResultadoDeChequeo {
  nombre: string;
  /** `false` = el caso no pide este chequeo; no cuenta ni a favor ni en contra. */
  aplica: boolean;
  ok: boolean;
  detalle: string;
}

/** Frases que Seba nunca puede decir, pida lo que pida el caso. */
export const FRASES_PROHIBIDAS_FIJAS = [
  "gracias por tu compra",
  "asistente virtual",
  "soy seba",
  "inteligencia artificial",
] as const;

/** Tope de mensajes por turno (`SEBA2_MAX_MENSAJES`, `salida.ts`). */
export const MAXIMO_DE_MENSAJES = 3;

/** Sin tildes ni mayúsculas: «Teléfono» y «telefono» son la misma palabra. */
export function normalizar(texto: string): string {
  return texto.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function noAplica(nombre: string, detalle: string): ResultadoDeChequeo {
  return { nombre, aplica: false, ok: true, detalle };
}

function resultado(nombre: string, ok: boolean, detalle: string): ResultadoDeChequeo {
  return { nombre, aplica: true, ok, detalle };
}

function cotizados(e: EntradaDeChequeo): { id: string; producto: ProductoDeArnes | null }[] {
  return e.resumen.productos.map((id) => ({ id, producto: e.productos[id] ?? null }));
}

// ------------------------------- Chequeos -----------------------------------

export function productoValido(e: EntradaDeChequeo): ResultadoDeChequeo {
  const nombre = "producto_valido";
  const validos = e.caso.esperado.productosValidos;
  if (!validos || validos.length === 0) return noAplica(nombre, "el caso no trae productos válidos");
  const lista = cotizados(e);
  if (lista.length === 0) return noAplica(nombre, "el turno no cotizó nada");

  const acierto = lista.find((c) => c.producto?.saintCode && validos.includes(c.producto.saintCode));
  if (acierto) return resultado(nombre, true, `cotizó ${acierto.producto?.saintCode}`);
  const vistos = lista.map((c) => c.producto?.saintCode ?? `(sin código: ${c.id})`).join(", ");
  return resultado(nombre, false, `cotizó ${vistos}; se esperaba alguno de ${validos.join(", ")}`);
}

export function mismaCategoria(e: EntradaDeChequeo): ResultadoDeChequeo {
  const nombre = "misma_categoria";
  const categoria = e.caso.esperado.categoria;
  if (!categoria || categoria.trim() === "") return noAplica(nombre, "el caso no trae categoría");
  const lista = cotizados(e);
  if (lista.length === 0) return noAplica(nombre, "el turno no cotizó nada");

  const esperada = normalizar(categoria).trim();
  const fuera = lista.filter((c) => !c.producto || !normalizar(c.producto.nombre).trim().startsWith(esperada));
  if (fuera.length === 0) return resultado(nombre, true, `todo lo cotizado empieza con «${categoria}»`);
  const nombres = fuera.map((c) => c.producto?.nombre ?? `(producto desconocido ${c.id})`).join("; ");
  return resultado(nombre, false, `no empieza con «${categoria}»: ${nombres}`);
}

export function sinCifraSinFuente(e: EntradaDeChequeo): ResultadoDeChequeo {
  const nombre = "sin_cifra_sin_fuente";
  const delModelo = e.registro.mensajes.filter((m) => m.origen === "modelo");
  if (delModelo.length === 0) return noAplica(nombre, "ningún mensaje lo redactó el modelo");

  // Las fuentes son las mismas que acepta el turno: lo que dijo una herramienta o el código en ESTE turno y lo que el cliente escribió.
  const fuentes = [
    ...e.registro.mensajes.filter((m) => m.origen !== "modelo").map((m) => m.texto),
    ...e.caso.rafaga,
    ...e.resumen.rafaga,
  ];
  for (const mensaje of delModelo) {
    const cifra = findUnsourcedFigure(mensaje.texto, fuentes);
    if (cifra !== null) return resultado(nombre, false, `el mensaje ${mensaje.orden} trae «${cifra}» sin fuente en el turno`);
  }
  return resultado(nombre, true, "toda cifra de dinero del modelo tiene fuente");
}

export function pasoCuandoDebia(e: EntradaDeChequeo): ResultadoDeChequeo {
  const nombre = "paso_cuando_debia";
  const debe = e.caso.esperado.debePasar;
  if (debe === null || debe === undefined) return noAplica(nombre, "el caso no exige un pase");

  const pases = e.registro.pases;
  const acierto = pases.find((p) => p.area === debe.area && (debe.motivo === undefined || p.motivo === debe.motivo));
  if (acierto) return resultado(nombre, true, `pasó a ${acierto.area} (${acierto.motivo})`);
  const esperado = `${debe.area}${debe.motivo ? ` (${debe.motivo})` : ""}`;
  if (pases.length === 0) return resultado(nombre, false, `no hubo ningún pase; se esperaba ${esperado}`);
  return resultado(
    nombre,
    false,
    `pasó a ${pases.map((p) => `${p.area} (${p.motivo})`).join(", ")}; se esperaba ${esperado}`
  );
}

export function noPasoCuandoNoDebia(e: EntradaDeChequeo): ResultadoDeChequeo {
  const nombre = "no_paso_cuando_no_debia";
  if (!e.caso.esperado.noDebePasar) return noAplica(nombre, "el caso no prohíbe pasar");
  const pases = e.registro.pases;
  if (pases.length === 0) return resultado(nombre, true, "no hubo pase");
  return resultado(nombre, false, `pasó a ${pases.map((p) => `${p.area} (${p.motivo})`).join(", ")}`);
}

export function datosDePagoCorrectos(e: EntradaDeChequeo): ResultadoDeChequeo {
  const nombre = "datos_de_pago_correctos";
  if (!e.caso.esperado.debeEntregarDatosDePago) return noAplica(nombre, "el caso no exige entregar datos de pago");

  const conTotal = e.registro.mensajes.some((m) => m.origen === "herramienta" && m.texto.includes("Total"));
  const etapa = e.resumen.estadoDespues?.etapa ?? null;
  if (conTotal && etapa === "datos_enviados") return resultado(nombre, true, "envió los datos con su «Total» y quedó en datos_enviados");
  const faltas: string[] = [];
  if (!conTotal) faltas.push("ningún mensaje de una herramienta trae «Total»");
  if (etapa !== "datos_enviados") faltas.push(`el estado final es ${etapa ?? "(sin estado)"}`);
  return resultado(nombre, false, faltas.join("; "));
}

export function sinFrasesProhibidas(e: EntradaDeChequeo): ResultadoDeChequeo {
  const nombre = "sin_frases_prohibidas";
  const frases = [...FRASES_PROHIBIDAS_FIJAS, ...(e.caso.esperado.frasesProhibidas ?? [])];
  for (const mensaje of e.registro.mensajes) {
    const texto = normalizar(mensaje.texto);
    const hallada = frases.find((f) => f.trim() !== "" && texto.includes(normalizar(f)));
    if (hallada) return resultado(nombre, false, `el mensaje ${mensaje.orden} dice «${hallada}»`);
  }
  return resultado(nombre, true, "ninguna frase prohibida");
}

export function maximoTresMensajes(e: EntradaDeChequeo): ResultadoDeChequeo {
  const nombre = "maximo_tres_mensajes";
  const n = e.registro.mensajes.length;
  return resultado(nombre, n <= MAXIMO_DE_MENSAJES, `${n} mensaje(s) enviado(s)`);
}

export function sinGuardasDisparadas(e: EntradaDeChequeo): ResultadoDeChequeo {
  const nombre = "sin_guardas_disparadas";
  const guardas = e.resumen.guardas;
  if (guardas.length === 0) return resultado(nombre, true, "ninguna guarda disparada");
  return resultado(nombre, false, guardas.map((g) => `${g.guarda}: «${g.fragmento}»`).join(" | "));
}

export function comprobanteConPase(e: EntradaDeChequeo): ResultadoDeChequeo {
  const nombre = "comprobante_con_pase";
  const hayComprobante = (e.caso.rafagaLecturas ?? []).some((l) => esComprobante(l) || esOrdenCashea(l));
  if (!hayComprobante) return noAplica(nombre, "la ráfaga no trae un comprobante ni una orden de Cashea");
  const aPagos = e.registro.pases.filter((p) => p.area === "pagos");
  if (aPagos.length > 0) return resultado(nombre, true, `pasó a pagos (${aPagos[0].motivo})`);
  const otros = e.registro.pases.map((p) => p.area).join(", ");
  return resultado(nombre, false, otros ? `pasó a ${otros}, no a pagos` : "no hubo ningún pase a pagos");
}

/** Todos los chequeos, en el orden en que se muestran en el reporte. */
export const CHEQUEOS: readonly ((e: EntradaDeChequeo) => ResultadoDeChequeo)[] = [
  productoValido,
  mismaCategoria,
  sinCifraSinFuente,
  pasoCuandoDebia,
  noPasoCuandoNoDebia,
  datosDePagoCorrectos,
  sinFrasesProhibidas,
  maximoTresMensajes,
  sinGuardasDisparadas,
  comprobanteConPase,
];

export const NOMBRES_DE_CHEQUEOS: readonly string[] = [
  "producto_valido",
  "misma_categoria",
  "sin_cifra_sin_fuente",
  "paso_cuando_debia",
  "no_paso_cuando_no_debia",
  "datos_de_pago_correctos",
  "sin_frases_prohibidas",
  "maximo_tres_mensajes",
  "sin_guardas_disparadas",
  "comprobante_con_pase",
];

export function correrChequeos(entrada: EntradaDeChequeo): ResultadoDeChequeo[] {
  return CHEQUEOS.map((chequeo) => chequeo(entrada));
}

/**
 * Un caso cuyo turno LANZÓ (o se pasó del tiempo) cuenta como fallido en TODOS sus chequeos,
 * con el error en el detalle: un turno que revienta no puede dejar pasar las puertas por
 * «no aplica».
 */
export function chequeosDeCasoFallido(error: string): ResultadoDeChequeo[] {
  return NOMBRES_DE_CHEQUEOS.map((nombre) => ({
    nombre,
    aplica: true,
    ok: false,
    detalle: `el turno no terminó: ${error}`,
  }));
}

// ------------------------------- Resúmenes ----------------------------------

/** Lo que el arnés guarda de cada caso corrido. */
export interface ResultadoDeCaso {
  id: string;
  fuente: FuenteDeCaso;
  chequeos: ResultadoDeChequeo[];
  /** El turno entero (mensajes, pases, guardas…) para mostrar los fallidos; `null` si el turno lanzó. */
  borrador: BorradorDeCaso | null;
  /** Texto del error si el turno lanzó o se pasó del tiempo. */
  error: string | null;
}

export interface BorradorDeCaso {
  accion: ResumenDeTurno["accion"];
  resumen: string;
  mensajes: MensajeDeTurno[];
  pases: { area: string; motivo: string }[];
  guardas: { guarda: string; fragmento: string }[];
  tokens: TokensDeTurno | null;
  modelo: string | null;
  duracionMs: number;
}

export interface TasaDeChequeo {
  aplica: number;
  ok: number;
  fallos: number;
}

export interface ResumenDeCorrida {
  totalCasos: number;
  casosFallidos: number;
  porChequeo: Record<string, TasaDeChequeo>;
  /** fuente → chequeo → tasa */
  porFuente: Record<string, Record<string, TasaDeChequeo>>;
}

function sumar(tasas: Record<string, TasaDeChequeo>, chequeo: ResultadoDeChequeo): void {
  if (!chequeo.aplica) return;
  const t = (tasas[chequeo.nombre] ??= { aplica: 0, ok: 0, fallos: 0 });
  t.aplica += 1;
  if (chequeo.ok) t.ok += 1;
  else t.fallos += 1;
}

export function resumirCorrida(resultados: readonly Pick<ResultadoDeCaso, "id" | "fuente" | "chequeos">[]): ResumenDeCorrida {
  const resumen: ResumenDeCorrida = { totalCasos: resultados.length, casosFallidos: 0, porChequeo: {}, porFuente: {} };
  for (const r of resultados) {
    if (r.chequeos.some((c) => c.aplica && !c.ok)) resumen.casosFallidos += 1;
    const deLaFuente = (resumen.porFuente[r.fuente] ??= {});
    for (const chequeo of r.chequeos) {
      sumar(resumen.porChequeo, chequeo);
      sumar(deLaFuente, chequeo);
    }
  }
  return resumen;
}

// -------------------------------- Puertas -----------------------------------

/** Mínimo de aciertos de `producto_valido` en los casos `saint` para pasar de «arnés» a «sombra». */
export const UMBRAL_PRODUCTO_VALIDO = 0.95;

export interface Puertas {
  ok: boolean;
  fallas: string[];
  /** Puertas que no se pudieron medir (sin casos que las ejerciten); no son fallas pero hay que leerlas. */
  avisos: string[];
}

function porcentaje(parte: number, total: number): string {
  return total === 0 ? "—" : `${((parte / total) * 100).toFixed(1)} %`;
}

/**
 * La puerta «arnés → sombra»:
 *  (a) en los casos `saint`, `producto_valido` en ≥ 95 % de los casos en que aplica y 0 fallos de `misma_categoria`;
 *  (b) 0 fallos de `sin_cifra_sin_fuente` en toda la corrida;
 *  (c) 0 fallos de `comprobante_con_pase` en toda la corrida.
 * Una puerta que ningún caso ejercita (p. ej. sin casos `saint`) no falla, pero deja un aviso.
 */
export function evaluarPuertas(resumen: ResumenDeCorrida): Puertas {
  const fallas: string[] = [];
  const avisos: string[] = [];

  const saint = resumen.porFuente.saint ?? {};
  const producto = saint.producto_valido;
  if (!producto || producto.aplica === 0) {
    avisos.push("(a) sin casos «saint» en que aplique producto_valido: la puerta de producto no se pudo medir");
  } else if (producto.ok / producto.aplica < UMBRAL_PRODUCTO_VALIDO) {
    fallas.push(
      `(a) producto_valido en casos saint: ${porcentaje(producto.ok, producto.aplica)} (${producto.ok}/${producto.aplica}); se exige ${UMBRAL_PRODUCTO_VALIDO * 100} %`
    );
  }
  const categoria = saint.misma_categoria;
  if (categoria && categoria.fallos > 0) {
    fallas.push(`(a) misma_categoria en casos saint: ${categoria.fallos} fallo(s); se exigen 0`);
  }

  const cifras = resumen.porChequeo.sin_cifra_sin_fuente;
  if (cifras && cifras.fallos > 0) fallas.push(`(b) sin_cifra_sin_fuente: ${cifras.fallos} fallo(s); se exigen 0`);

  const comprobante = resumen.porChequeo.comprobante_con_pase;
  if (!comprobante || comprobante.aplica === 0) {
    avisos.push("(c) ningún caso trae un comprobante: la puerta del comprobante no se pudo medir");
  } else if (comprobante.fallos > 0) {
    fallas.push(`(c) comprobante_con_pase: ${comprobante.fallos} fallo(s); se exigen 0`);
  }

  return { ok: fallas.length === 0, fallas, avisos };
}

// -------------------------------- Reporte -----------------------------------

export interface TarifaDeModelo {
  inputPorMillon: number;
  outputPorMillon: number;
}

/** Costo estimado en USD: tokens de entrada y de salida por la tarifa (sin descontar el caché, así que es un techo). */
export function costoEstimado(tokens: TokensDeTurno | null, tarifa: TarifaDeModelo | null): number | null {
  if (!tokens || !tarifa) return null;
  const costo = (tokens.input * tarifa.inputPorMillon + tokens.output * tarifa.outputPorMillon) / 1_000_000;
  return Number.isFinite(costo) ? costo : null;
}

export function mediana(valores: readonly number[]): number | null {
  const limpios = valores.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (limpios.length === 0) return null;
  const medio = Math.floor(limpios.length / 2);
  return limpios.length % 2 === 1 ? limpios[medio] : (limpios[medio - 1] + limpios[medio]) / 2;
}

export interface DatosDeReporte {
  /** AAAA-MM-DD */
  fecha: string;
  archivos: string[];
  resultados: readonly ResultadoDeCaso[];
  tarifa: TarifaDeModelo | null;
  intentosDeEscritura: number;
  detalleDeIntentos?: string[];
}

function celda(texto: string): string {
  return texto.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function tablaDeTasas(tasas: Record<string, TasaDeChequeo>): string[] {
  const filas = ["| chequeo | aplica | ok | fallos | tasa |", "|---|---:|---:|---:|---:|"];
  for (const nombre of NOMBRES_DE_CHEQUEOS) {
    const t = tasas[nombre];
    if (!t) continue;
    filas.push(`| ${nombre} | ${t.aplica} | ${t.ok} | ${t.fallos} | ${porcentaje(t.ok, t.aplica)} |`);
  }
  if (filas.length === 2) filas.push("| (ningún chequeo aplicó) | 0 | 0 | 0 | — |");
  return filas;
}

function bloqueDeBorrador(r: ResultadoDeCaso): string[] {
  const lineas: string[] = [];
  if (r.error !== null) lineas.push(`- Error: ${r.error}`);
  const b = r.borrador;
  if (b === null) return lineas;
  lineas.push(`- Acción: ${b.accion} — ${b.resumen}`);
  if (b.mensajes.length === 0) lineas.push("- Mensajes: (ninguno)");
  for (const m of b.mensajes) {
    lineas.push(`- Mensaje ${m.orden} [${m.origen}${m.tipo === "imagen" ? ", imagen" : ""}]: ${m.texto.replace(/\r?\n/g, " ⏎ ")}`);
  }
  lineas.push(b.pases.length === 0 ? "- Pase: ninguno" : `- Pase: ${b.pases.map((p) => `${p.area} (${p.motivo})`).join(", ")}`);
  lineas.push(
    b.guardas.length === 0 ? "- Guardas: ninguna" : `- Guardas: ${b.guardas.map((g) => `${g.guarda} «${g.fragmento}»`).join(" | ")}`
  );
  return lineas;
}

export function reporteMarkdown(datos: DatosDeReporte): string {
  const resumen = resumirCorrida(datos.resultados);
  const puertas = evaluarPuertas(resumen);
  const out: string[] = [];

  out.push(`# Arnés de turnos de Seba v2 — ${datos.fecha}`, "");
  out.push(`- Archivos: ${datos.archivos.length === 0 ? "(ninguno)" : datos.archivos.join(", ")}`);
  out.push(`- Casos: ${resumen.totalCasos} (${resumen.casosFallidos} con algún chequeo fallido)`);
  out.push(
    `- Intentos de escritura: ${datos.intentosDeEscritura}${
      datos.intentosDeEscritura > 0 && datos.detalleDeIntentos?.length ? ` — ${datos.detalleDeIntentos.join("; ")}` : ""
    }`
  );

  // Costo y duración
  const tokens = datos.resultados.map((r) => r.borrador?.tokens ?? null).filter((t): t is TokensDeTurno => t !== null);
  const entrada = tokens.reduce((s, t) => s + t.input, 0);
  const salida = tokens.reduce((s, t) => s + t.output, 0);
  const costos = datos.resultados.map((r) => costoEstimado(r.borrador?.tokens ?? null, datos.tarifa));
  const conCosto = costos.filter((c): c is number => c !== null);
  out.push(
    `- Tokens: ${entrada} de entrada, ${salida} de salida (${tokens.length} caso(s) con uso medido)`
  );
  out.push(
    conCosto.length > 0 && conCosto.length === tokens.length
      ? `- Costo estimado: USD ${conCosto.reduce((s, c) => s + c, 0).toFixed(4)} (techo: sin descontar el caché)`
      : "- Costo estimado: sin tarifa conocida para el modelo; solo tokens"
  );
  const mediaMs = mediana(datos.resultados.map((r) => r.borrador?.duracionMs ?? Number.NaN));
  out.push(`- Mediana de duración por caso: ${mediaMs === null ? "—" : `${(mediaMs / 1000).toFixed(1)} s`}`, "");

  out.push("## Puertas «arnés → sombra»", "");
  out.push(puertas.ok ? "**ABIERTA**: se cumplen todas las puertas medibles." : "**CERRADA**:");
  for (const falla of puertas.fallas) out.push(`- ${falla}`);
  for (const aviso of puertas.avisos) out.push(`- (aviso) ${aviso}`);
  out.push("");

  out.push("## Tasas por chequeo", "", ...tablaDeTasas(resumen.porChequeo), "");

  out.push("## Tasas por fuente", "");
  const fuentes = Object.keys(resumen.porFuente).sort();
  if (fuentes.length === 0) out.push("(sin casos)", "");
  for (const fuente of fuentes) {
    const casos = datos.resultados.filter((r) => r.fuente === fuente).length;
    out.push(`### ${fuente} (${casos} caso(s))`, "", ...tablaDeTasas(resumen.porFuente[fuente]), "");
  }

  out.push("## Casos fallidos", "");
  const fallidos = datos.resultados.filter((r) => r.error !== null || r.chequeos.some((c) => c.aplica && !c.ok));
  if (fallidos.length === 0) out.push("Ninguno.", "");
  for (const r of fallidos) {
    out.push(`### ${celda(r.id)} (${r.fuente})`, "");
    for (const c of r.chequeos.filter((x) => x.aplica && !x.ok)) out.push(`- ✗ ${c.nombre}: ${c.detalle}`);
    out.push(...bloqueDeBorrador(r), "");
  }

  return `${out.join("\n")}\n`;
}
