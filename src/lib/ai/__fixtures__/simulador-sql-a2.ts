import { normalize } from "@/lib/ai/catalog-search";

// ---------------------------------------------------------------------------
// Simulador en TypeScript de las funciones SQL de la Entrega A2 (30/9/2026,
// T5, plan "Seba no cotiza lo que no es"): `buscar_productos` (M1, migración
// 20260930010000), `corregir_terminos` (M2, 20260930020000) y
// `diagnosticar_terminos` (M3, 20260930030000).
//
// Existe para que `tools.test.ts` pueda correr TODOS los casos de
// `casos-a2.ts` sin base de datos: el fake de Supabase de ese archivo delega
// aquí lo que la base haría. NO prueba el SQL (eso lo hacen
// `supabase/tests/*.sql` y el arnés T7 contra la base real), prueba que la
// lógica de `tools.ts` toma las decisiones correctas sobre lo que el SQL
// devuelve. Por eso replica el SQL al pie de la letra; lo único que traduce
// son las expresiones regulares de Postgres (`\m`, `\M`), que pasan a
// lookarounds de JavaScript. `search_text` es nombre y marca normalizados,
// como en la base (los tests dan marca "Genérico" a casi todo y en el fixture
// es `null`).
//
// Se contrastó contra la base local el 30/9/2026: todas las llamadas que hacen
// los 147 casos (turnos previos incluidos) dieron filas, orden, puntajes y
// ventanas idénticos en `buscar_productos`, `corregir_terminos` y
// `diagnosticar_terminos` (script desechable, no se versiona: el arnés T7 lo
// hace de forma permanente).
//
// Si el SQL cambia, este archivo cambia con él: dos versiones que divergen
// harían pasar tests que la base real rechaza.
// ---------------------------------------------------------------------------

/** Un producto tal como lo ve el simulador (lo que `products` tendría). */
export interface FilaSim {
  id: string;
  name: string;
  brand: string | null;
  price: number;
  currency: string;
  stock_quantity: number;
  updated_at?: string | null;
  compatibilidad?: { moto_brand: string; moto_model: string }[];
  /** Fuerza `puntaje` (los tests que necesitan control fino). */
  puntaje?: number;
  /** Fuerza `puntaje_moto_nombre`. */
  puntaje_moto?: number;
}

/** Los argumentos de `buscar_productos` (los nueve de M1). */
export interface ArgsBuscarSim {
  p_terminos: string[][];
  p_moto?: string[][];
  p_limite?: number;
  p_opcionales?: string[][];
  p_cilindrada?: string[][];
  p_variantes?: string[][];
  p_moto_marca?: string[][];
  p_motos_conocidas?: string[];
  p_marcas_de_moto?: string[];
}

export type TipoPatron = "prod" | "opc" | "var" | "moto" | "moto_marca" | "cil" | "anio" | "inicio";

const PALABRA = "[a-z0-9_]";
/** `\m` de Postgres: comienzo de palabra. */
const INICIO_DE_PALABRA = `(?<!${PALABRA})(?=${PALABRA})`;
/** `\M` de Postgres: fin de palabra. */
const FIN_DE_PALABRA = `(?<=${PALABRA})(?!${PALABRA})`;

/** Espejo de `public.patron_busqueda(alt, tipo)` (M1), como RegExp de JavaScript. */
export function patronBusqueda(alt: string, tipo: TipoPatron): RegExp {
  const nucleo = alt.replace(/[.^$*+?()[\]{}|\\-]/g, "\\$&");

  if (tipo === "prod" || tipo === "opc" || tipo === "var" || tipo === "inicio") {
    const prefijo =
      tipo === "inicio" ? "^" : /^[0-9].*\./.test(alt) ? `(?:${INICIO_DE_PALABRA}|[a-z])` : INICIO_DE_PALABRA;
    const sufijo = /^[a-z]{1,3}$/.test(alt) ? `(?:s|es)?${FIN_DE_PALABRA}` : /[0-9]$/.test(alt) ? "(?:[^0-9]|$)" : "";
    return new RegExp(prefijo + nucleo + sufijo);
  }
  if (tipo === "moto" || tipo === "moto_marca") {
    return new RegExp(`${INICIO_DE_PALABRA}${nucleo}(?:[0-9]|${FIN_DE_PALABRA})`);
  }
  // cil | anio
  return new RegExp(`(?:${INICIO_DE_PALABRA}|[a-z])${nucleo}(?:[^0-9]|$)`);
}

/** El `search_text` de la base (`immutable_unaccent(lower(name || ' ' || brand))`): nombre y marca, normalizados. */
function textoDeBusqueda(fila: FilaSim): string {
  return normalize(`${fila.name} ${fila.brand ?? ""}`).trim();
}

interface AltPatron {
  grupoIdx: number;
  alt: string;
  pat: RegExp;
  inicio: RegExp | null;
}

/** Como mucho 12 grupos y 4 alternativas por grupo, normalizadas y sin vacías (igual que M1). */
function altsDe(grupos: string[][] | undefined, tipo: TipoPatron): AltPatron[] {
  const resultado: AltPatron[] = [];
  (grupos ?? []).slice(0, 12).forEach((grupo, grupoIdx) => {
    for (const cruda of (Array.isArray(grupo) ? grupo : []).slice(0, 4)) {
      const alt = String(cruda).trim().toLowerCase();
      if (alt === "") continue;
      resultado.push({
        grupoIdx,
        alt,
        pat: patronBusqueda(alt, tipo),
        inicio: tipo === "prod" ? patronBusqueda(alt, "inicio") : null,
      });
    }
  });
  return resultado;
}

/** Cuántos grupos distintos calzan (un grupo con dos alternativas que calzan cuenta una vez). */
function gruposQueCalzan(alts: AltPatron[], texto: string): number {
  return new Set(alts.filter((a) => a.pat.test(texto)).map((a) => a.grupoIdx)).size;
}

/** Espejo de `public.buscar_productos` (M1): mismas columnas, mismos conteos antes del límite, mismo orden. */
export function buscarProductosSim(productos: readonly FilaSim[], args: ArgsBuscarSim) {
  const prod = altsDe(args.p_terminos, "prod");
  const opc = altsDe(args.p_opcionales, "opc");
  const moto = altsDe(args.p_moto, "moto");
  const cil = altsDe(args.p_cilindrada, "cil");
  const variantes = altsDe(args.p_variantes, "var");
  const marca = altsDe(args.p_moto_marca, "moto_marca");
  const nVariantes = new Set(variantes.map((a) => a.grupoIdx)).size;

  const marcasDeMoto = new Set((args.p_marcas_de_moto ?? []).slice(0, 50).map((m) => m.trim().toLowerCase()));
  const motosPat = (args.p_motos_conocidas ?? [])
    .slice(0, 200)
    .map((m) => m.trim().toLowerCase())
    .filter((m) => m !== "")
    .map((palabra) => ({ pat: patronBusqueda(palabra, "moto"), esMarca: marcasDeMoto.has(palabra) }));

  const candidatos = productos.filter((p) => {
    if (p.price <= 0) return false;
    const texto = textoDeBusqueda(p);
    return prod.some((a) => texto.includes(a.alt));
  });

  const relevantes = candidatos
    .map((p) => {
      const texto = textoDeBusqueda(p);
      const puntaje = p.puntaje ?? gruposQueCalzan(prod, texto);
      return {
        p,
        texto,
        puntaje,
        puntaje_opcional: gruposQueCalzan(opc, texto),
        puntaje_moto_nombre: p.puntaje_moto ?? gruposQueCalzan(moto, texto),
        puntaje_moto_cilindrada: gruposQueCalzan(cil, texto),
        puntaje_variante: gruposQueCalzan(variantes, texto),
        puntaje_moto_marca: gruposQueCalzan(marca, texto),
        empieza_con_producto: prod.some((a) => a.grupoIdx === 0 && a.inicio?.test(texto)),
      };
    })
    .filter((r) => r.puntaje > 0);

  if (relevantes.length === 0) return [];

  const puntajeMaximo = Math.max(...relevantes.map((r) => r.puntaje));

  const conNombre = relevantes.map((r) => {
    const nombraMoto = motosPat.some((m) => m.pat.test(r.texto));
    const nombraModelo = motosPat.some((m) => !m.esMarca && m.pat.test(r.texto));
    return {
      ...r,
      nombra_moto: nombraMoto,
      nombra_otra_moto:
        nombraMoto && r.puntaje_moto_nombre === 0 && !(r.puntaje_moto_marca > 0 && !nombraModelo),
      es_universal: !nombraMoto || /(?<![a-z0-9_])universal/.test(r.texto),
    };
  });

  const delMaximo = conNombre.filter((r) => r.puntaje === puntajeMaximo);
  // La FAMILIA del pedido (T5b, 30/9/2026): si alguna fila del máximo empieza con la cabeza del
  // pedido, solo esas; las que apenas mencionan la palabra (BOMBA DE ACEITE) son de otro producto
  // y no deciden si la moto calza ni si la familia depende de la moto.
  const hayInicio = delMaximo.some((r) => r.empieza_con_producto);
  const familia = hayInicio ? delMaximo.filter((r) => r.empieza_con_producto) : delMaximo;
  const puntajeMotoMaximo = Math.max(0, ...familia.map((r) => r.puntaje_moto_nombre));
  // El conjunto de decisión: todo el máximo y, si la moto calza, solo las de esa moto.
  const enElConjunto = (r: { puntaje_moto_nombre: number }) =>
    puntajeMotoMaximo === 0 || r.puntaje_moto_nombre === puntajeMotoMaximo;
  const conjunto = delMaximo.filter(enElConjunto);
  const conStock = (r: { p: FilaSim }) => (r.p.stock_quantity ?? 0) > 0;
  const traeTodasLasVariantes = (r: { puntaje_variante: number }) => nVariantes > 0 && r.puntaje_variante === nVariantes;

  const ventanas = {
    filas_con_puntaje_maximo: delMaximo.length,
    puntaje_moto_maximo: puntajeMotoMaximo,
    filas_con_maximo_y_moto: conjunto.length,
    filas_con_maximo_y_stock: conjunto.filter(conStock).length,
    filas_que_nombran_moto: familia.filter((r) => enElConjunto(r) && r.nombra_moto).length,
    filas_universales: conjunto.filter((r) => r.es_universal).length,
    filas_universales_con_stock: conjunto.filter((r) => r.es_universal && conStock(r)).length,
    filas_con_variante: conjunto.filter(traeTodasLasVariantes).length,
    filas_con_variante_y_stock: conjunto.filter((r) => traeTodasLasVariantes(r) && conStock(r)).length,
  };

  const ordenado = [...conNombre].sort(
    (a, b) =>
      b.puntaje - a.puntaje ||
      (puntajeMotoMaximo > 0 ? b.puntaje_moto_nombre - a.puntaje_moto_nombre : 0) ||
      b.puntaje_variante - a.puntaje_variante ||
      Number(b.empieza_con_producto) - Number(a.empieza_con_producto) ||
      b.puntaje_moto_marca - a.puntaje_moto_marca ||
      b.puntaje_moto_cilindrada - a.puntaje_moto_cilindrada ||
      b.puntaje_opcional - a.puntaje_opcional ||
      Number(conStock(b)) - Number(conStock(a)) ||
      (b.p.stock_quantity ?? 0) - (a.p.stock_quantity ?? 0) ||
      a.p.name.localeCompare(b.p.name) ||
      a.p.id.localeCompare(b.p.id)
  );

  const limite = Math.min(Math.max(args.p_limite ?? 10, 1), 50);
  return ordenado.slice(0, limite).map((r) => ({
    id: r.p.id,
    name: r.p.name,
    brand: r.p.brand,
    price: r.p.price,
    currency: r.p.currency,
    stock_quantity: r.p.stock_quantity,
    updated_at: r.p.updated_at ?? null,
    compatibilidad: r.p.compatibilidad ?? [],
    puntaje: r.puntaje,
    puntaje_moto: r.puntaje_moto_nombre + r.puntaje_moto_cilindrada,
    puntaje_maximo: puntajeMaximo,
    puntaje_opcional: r.puntaje_opcional,
    empieza_con_producto: r.empieza_con_producto,
    puntaje_moto_nombre: r.puntaje_moto_nombre,
    puntaje_moto_cilindrada: r.puntaje_moto_cilindrada,
    puntaje_variante: r.puntaje_variante,
    puntaje_moto_marca: r.puntaje_moto_marca,
    nombra_moto: r.nombra_moto,
    nombra_otra_moto: r.nombra_otra_moto,
    es_universal: r.es_universal,
    ...ventanas,
  }));
}

// ---------------------------------------------------------------------------
// diagnosticar_terminos (M3)
// ---------------------------------------------------------------------------

export interface DiagnosticoSim {
  grupo_idx: number;
  en_catalogo: boolean;
  con_cabeza: boolean | null;
}

/** Espejo de `public.diagnosticar_terminos` (M3). */
export function diagnosticarTerminosSim(
  productos: readonly FilaSim[],
  terminos: string[][],
  cabeza: number | null
): DiagnosticoSim[] {
  const grupos = (Array.isArray(terminos) ? terminos : []).slice(0, 12);
  const alts = altsDe(grupos, "prod");

  const calces = new Map<string, Set<number>>();
  for (const p of productos) {
    if (p.price <= 0) continue;
    const texto = textoDeBusqueda(p);
    if (!alts.some((a) => texto.includes(a.alt))) continue;
    const grupos_ = new Set(alts.filter((a) => a.pat.test(texto)).map((a) => a.grupoIdx));
    if (grupos_.size > 0) calces.set(p.id, grupos_);
  }
  const enAlgunProducto = (idx: number) => [...calces.values()].some((g) => g.has(idx));
  const cabezaValida = cabeza !== null && cabeza >= 0 && cabeza < grupos.length;

  return grupos.map((_, idx) => ({
    grupo_idx: idx,
    en_catalogo: enAlgunProducto(idx),
    con_cabeza: !cabezaValida
      ? null
      : idx === cabeza
        ? enAlgunProducto(idx)
        : [...calces.values()].some((g) => g.has(idx) && g.has(cabeza as number)),
  }));
}

// ---------------------------------------------------------------------------
// corregir_terminos (M2)
// ---------------------------------------------------------------------------

/** Espejo de `public.clave_fonetica` (M2). */
export function claveFonetica(texto: string): string {
  return texto
    .replace(/ch/g, "#")
    .replace(/qu/g, "k")
    .replace(/c(?=[ei])/g, "s")
    .replace(/c/g, "k")
    .replace(/ll/g, "y")
    .replace(/v/g, "b")
    .replace(/z/g, "s")
    .replace(/h/g, "")
    .replace(/(.)\1/g, "$1");
}

/** Distancia de Levenshtein (fuzzystrmatch). */
export function levenshtein(a: string, b: string): number {
  const fila = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let anterior = fila[0];
    fila[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const guardado = fila[j];
      fila[j] = Math.min(fila[j] + 1, fila[j - 1] + 1, anterior + (a[i - 1] === b[j - 1] ? 0 : 1));
      anterior = guardado;
    }
  }
  return fila[b.length];
}

/** Trigramas de pg_trgm para UNA palabra: dos espacios delante, uno detrás. */
function trigramas(palabra: string): Set<string> {
  const relleno = `  ${palabra} `;
  const resultado = new Set<string>();
  for (let i = 0; i + 3 <= relleno.length; i++) resultado.add(relleno.slice(i, i + 3));
  return resultado;
}

/** `similarity(a, b)` de pg_trgm para dos palabras sueltas. */
export function similitud(a: string, b: string): number {
  const ta = trigramas(a);
  const tb = trigramas(b);
  let comunes = 0;
  for (const t of ta) if (tb.has(t)) comunes++;
  return comunes / (ta.size + tb.size - comunes);
}

/** Espejo de `public.corregir_terminos` (M2): SOLO los términos que se corrigen, en el orden de llegada. */
export function corregirTerminosSim(
  productos: readonly FilaSim[],
  terminos: string[],
  protegidos: string[],
  marcas: string[],
  excluidos: string[]
): { original: string; corregido: string }[] {
  const norma = (t: string) => normalize(t.trim());
  const setDe = (lista: string[]) => new Set(lista.map(norma));
  const protegidosSet = setDe(protegidos);
  const marcasSet = setDe(marcas);
  const excluidosSet = setDe(excluidos);

  // Vocabulario: palabras de 3+ letras sin dígitos de los productos activos con precio, con su frecuencia.
  const frecuencia = new Map<string, number>();
  for (const p of productos) {
    if (p.price <= 0) continue;
    const palabras = new Set(textoDeBusqueda(p).split(/[^a-z0-9]+/).filter((w) => /^[a-z]{3,}$/.test(w)));
    for (const w of palabras) frecuencia.set(w, (frecuencia.get(w) ?? 0) + 1);
  }
  const vocabulario = [...frecuencia.keys()];

  // Un término repetido cuenta una sola vez (la primera aparición).
  const vistos = new Set<string>();
  const resultado: { original: string; corregido: string }[] = [];

  for (const original of terminos) {
    const n = norma(original);
    if (vistos.has(n)) continue;
    vistos.add(n);
    if (!/^[a-z]+$/.test(n) || n.length < 4) continue;
    if (protegidosSet.has(n) || excluidosSet.has(n)) continue;
    if (vocabulario.some((v) => v.startsWith(n))) continue; // ya existe (prefijo)

    const umbral = n.length <= 4 ? 1 : n.length === 5 ? 2 : 3;
    const candidatos = vocabulario
      .filter((v) => Math.abs(v.length - n.length) <= umbral && levenshtein(n, v) <= umbral)
      .filter((v) => !excluidosSet.has(v))
      .filter((v) => ![`${n}s`, `${n}es`].includes(v) && ![`${v}s`, `${v}es`].includes(n))
      .map((v) => ({
        palabra: v,
        distancia: levenshtein(n, v),
        parecido: similitud(n, v),
        frecuencia: frecuencia.get(v) ?? 0,
        suenaIgual: claveFonetica(n) === claveFonetica(v),
        esMarca: marcasSet.has(v),
      }))
      .filter((c) => c.palabra.length >= 5 || c.suenaIgual)
      .filter((c) => c.distancia <= 1 || c.suenaIgual || c.esMarca)
      .filter((c) => c.distancia < 3 || c.parecido >= 0.3)
      .sort(
        (a, b) =>
          a.distancia - b.distancia ||
          b.parecido - a.parecido ||
          b.frecuencia - a.frecuencia ||
          a.palabra.localeCompare(b.palabra)
      );

    if (candidatos.length > 0) resultado.push({ original, corregido: candidatos[0].palabra });
  }
  return resultado;
}

/** Los 16 sinónimos globales que siembra la migración M4 (20260930040000), tal cual (`from` → `to`). */
export const SINONIMOS_M4: readonly { from: string; to: string }[] = [
  { from: "express", to: "xpress" },
  { from: "balaclava", to: "pasamontaña" },
  { from: "litros", to: "lts" },
  { from: "litro", to: "lts" },
  { from: "espejo", to: "retrovisor" },
  { from: "direccional", to: "luz cruce" },
  { from: "porta maleta", to: "base maleta" },
  { from: "boca pato", to: "pico pato" },
  { from: "luz", to: "led" },
  { from: "empaque", to: "empacadura" },
  { from: "scuda", to: "escuda" },
  { from: "rones", to: "rin" },
  { from: "kit de rodaje", to: "kit rodamiento" },
  { from: "foco", to: "faro" },
  { from: "relacion", to: "corona" },
  { from: "relacion", to: "piñon" },
];
