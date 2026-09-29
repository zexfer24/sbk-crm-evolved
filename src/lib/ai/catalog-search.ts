// ---------------------------------------------------------------------------
// Cómo se busca en el catálogo.
//
// Vive aparte de tools.ts porque acá está la parte que se equivoca en
// silencio: si la consulta no calza, el agente no falla — responde con toda
// seguridad que el repuesto no existe. Un "no tenemos" falso le cuesta una
// venta a la tienda y nadie se entera nunca.
//
// T1, plan "La búsqueda encuentra lo que el cliente pide" (25-26/9/2026):
// simulando el agente contra el catálogo real (6.035 productos de Saint) la
// búsqueda vieja fallaba en casi la mitad de los casos, por motivos que no
// eran solo la frase completa contra el nombre:
//
//   1. El cliente escribe "bujía NGK". Ningún producto se llama así: el
//      nombre es "Bujía CR7HSA" y NGK es la marca. Buscando la frase
//      completa no aparece nada, aunque el repuesto esté en el estante.
//   2. Nadie escribe acentos por WhatsApp. "bujia" no calza con "Bujía".
//   3. El catálogo escribe en plural ("Pastillas de freno") y el cliente
//      pregunta en singular ("pastilla") o al revés — sin singularizar, ni
//      uno calza con el otro.
//   4. Medidas y modelos cortos ("45", "DT 200") se descartaban por tener
//      menos de tres letras, justo lo que un asesor necesita para acertar
//      la moto o el tamaño exacto.
//
// Por eso: se parte en palabras, se singulariza cada una, se conservan los
// números cortos y las uniones letra+número ("dt200"), se le quita el
// relleno ("para", "precio"...) y se busca cada término por separado sobre
// una columna ya normalizada en la base (products.search_text, sin acentos
// y en minúsculas). `searchTerms` (plano) sigue existiendo porque también lo
// usa la biblioteca (`knowledge.ts`); el catálogo usa además
// `catalogTermGroups`, que agrupa alternativas — ver su comentario.
//
// T1, plan "Seba encuentra, no insiste, y el mostrador no deja a nadie
// esperando" (28/9/2026): el estudio del VPS (1.027 turnos, 25-28/9) mostró
// que ni siquiera eso alcanzaba, porque TODOS los términos pesaban igual:
//
//   - Una palabra descriptiva que no está en el nombre ("semi sintético",
//     "gris", "delantero") tumbaba la búsqueda entera si era obligatoria, y
//     la tolerancia N-1 de `tools.ts` la "arreglaba" tirando cualquier
//     término al azar — incluida la MARCA ("defensa gxs 250" cotizaba una
//     DEFENSA BRZ 250).
//   - "250" o "200cc" sueltos son la cilindrada de la moto, no un término del
//     producto; "sbr"/"bera"/"gxs" son la moto, no un repuesto.
//   - "20/50" son dos números sueltos que calzaban "5000".
//
// `catalogQuery` es la entrada nueva: parte la consulta en cuatro
// conjuntos —obligatorios (definen el puntaje), opcionales (solo desempatan),
// moto con nombre y cilindrada (solo ordenan)— que `buscar_productos`
// (migración 20260928010000) recibe por separado. `catalogTermGroups` queda
// como estaba, para `tools.ts`, hasta que T3a cambie esa herramienta a
// `catalogQuery`; después puede retirarse.
// ---------------------------------------------------------------------------

/** Minúsculas y sin diacríticos, igual que hace unaccent() del lado de la base. */
export function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/**
 * Palabras sin plural que además terminan en "s" de fábrica ("tres", "tres
 * repuestos", "seis") — quitarles la "s" les cambiaría el significado
 * ("tre", "sei"). Las de 3 letras o menos (gas, mas, dos, mes, bus, jes) ya
 * quedan afuera por el propio largo mínimo de `singular`; se listan igual
 * por si el día de mañana esa regla de largo cambia.
 */
const NO_PLURAL = new Set(["tres", "seis", "gas", "mas", "jes", "dos", "mes", "bus"]);

/**
 * Singulariza una palabra ya normalizada (sin acentos, en minúsculas), para
 * que calce por inicio de palabra tanto si el cliente escribió singular
 * como si el catálogo trae plural (o al revés).
 *
 * Una palabra con dígitos ("dt200", "20w50") no se toca — nunca es un
 * plural, y tocarla rompería el modelo/medida tal cual lo escribió el
 * cliente.
 */
export function singular(word: string): string {
  if (/[0-9]/.test(word)) return word;

  // "intercomunicadores" -> "intercomunicador", "rines" -> "rin",
  // "motores" -> "motor": la consonante antes de "es" (r/l/n/d/j/y) es la
  // marca de un plural en "-es" en vez de un simple "+s".
  if (/[rlndjy]es$/.test(word) && word.length >= 5) {
    return word.slice(0, -2);
  }

  // "pastillas" -> "pastilla", "baterias" -> "bateria", "cascos" -> "casco".
  if (word.endsWith("s") && word.length >= 4 && !NO_PLURAL.has(word)) {
    return word.slice(0, -1);
  }

  return word;
}

/**
 * Palabras de relleno: sobreviven a "conserva palabras de tres o más
 * letras" porque tienen tres letras o más, pero no describen ningún
 * repuesto — dejarlas como término obligatorio le exige a CADA producto
 * contener la palabra "precio", cosa que ninguno hace. Se filtran DESPUÉS
 * de singularizar ("precios" -> "precio" -> se quita).
 *
 * 28/9/2026 (T1, plan "Seba encuentra, no insiste…"): se suma "ano" ("año"
 * ya normalizado). "asiento sbr año 2020" exigía la palabra "ano" en el
 * nombre de cada producto — ninguno la trae, y la búsqueda daba cero. Lo
 * comparte `searchTerms` (la biblioteca): "garantía del año" tampoco
 * necesita esa palabra para calzar un artículo.
 */
const RELLENO = new Set(["para", "con", "del", "los", "las", "que", "una", "precio", "tienen", "hay", "ano"]);

/** Una palabra de 1 a 4 letras, candidata a unirse con el número que la sigue (dt, sbr, an...). */
function esLetraCorta(token: string): boolean {
  return /^[a-z]{1,4}$/.test(token);
}

/** Un token que son solo dígitos (200, 45, 5100...). */
function esSoloDigitos(token: string): boolean {
  return /^[0-9]+$/.test(token);
}

/** Un token que sobrevive al filtro de largo: letras de 3+, o cualquier cosa con un dígito y 2+ caracteres. */
function esConservable(token: string): boolean {
  if (/[0-9]/.test(token)) return token.length >= 2;
  return token.length >= 3;
}

/** Un término ya resuelto, con sus alternativas de calce (más de una solo cuando salió de unir letra+número). */
interface TerminoCrudo {
  termino: string;
  alternativas: string[];
}

/**
 * Recorre las palabras crudas de la consulta y arma un término por cada
 * hueco que sobrevive al filtro, ya singularizado y sin relleno.
 *
 * El paso de unión letra+número corre ANTES del filtro de largo, sobre las
 * palabras SIN partir: "dt" (2 letras) no llegaría vivo al filtro por su
 * cuenta, pero si el token siguiente es un número se fusionan en "dt200"
 * antes de que el filtro tenga oportunidad de descartar "dt" solo — y ese
 * número ya no vuelve a aparecer suelto (`i++` lo consume).
 *
 * Corrección del orquestador sobre T1 (26/9/2026, "rin 17 perdía la
 * medida"): probando el agente contra consultas reales, "rin 17" armaba UN
 * solo término con "rin" como alternativa suelta dentro del mismo grupo que
 * "rin17"/"rin 17" — y "rin" solo ya calza cualquier rin del catálogo, así
 * que la medida "17" dejaba de ser un requisito real de la búsqueda. La
 * unión ahora distingue por el largo de las letras:
 *
 *   - 1-2 letras ("dt", "cg"): son sigla y número pegados de verdad — nadie
 *     busca "dt" solo esperando un modelo específico — así que siguen
 *     siendo UN término, sin el número suelto como alternativa.
 *   - 3-4 letras ("rin", "sbr"): la palabra vale por sí sola como término
 *     COMPLETO (un cliente puede preguntar "tienen rines?" sin medida), así
 *     que ahora sale como un SEGUNDO término obligatorio aparte, y el
 *     número queda como tercera alternativa del grupo unido (por si el
 *     catálogo lo escribe con espacio en vez de pegado) — nunca como grupo
 *     propio, para no duplicar lo que la unión ya exige.
 *
 * Si la palabra de letras es relleno ("para 12"), no se une: el relleno se
 * filtra como siempre y el número se evalúa solo, en la vuelta siguiente.
 */
function terminosCrudos(query: string): TerminoCrudo[] {
  const palabras = normalize(query).split(/[^a-z0-9]+/).filter(Boolean);
  const terminos: TerminoCrudo[] = [];

  for (let i = 0; i < palabras.length; i++) {
    const token = palabras[i];
    const siguiente = palabras[i + 1];

    if (esLetraCorta(token) && siguiente !== undefined && esSoloDigitos(siguiente)) {
      const enSingular = singular(token);

      if (!RELLENO.has(enSingular)) {
        const unido = token + siguiente;

        if (token.length >= 3) {
          // La sigla es un término completo por su cuenta ("rin", "sbr").
          terminos.push({ termino: enSingular, alternativas: [enSingular] });
          // Y la unión sigue siendo obligatoria aparte, con el número
          // suelto como tercera forma de calzarla (nunca como grupo propio).
          terminos.push({ termino: unido, alternativas: [unido, `${token} ${siguiente}`, siguiente] });
        } else {
          // 1-2 letras: sigla y número solo tienen sentido pegados.
          terminos.push({ termino: unido, alternativas: [unido, `${token} ${siguiente}`] });
        }

        i++; // el número ya se consumió: no vuelve a evaluarse suelto.
        continue;
      }
      // Relleno: cae al procesamiento normal de abajo (se descarta) y el
      // número se evalúa aparte en la próxima vuelta del for.
    }

    if (!esConservable(token)) continue;

    const enSingular = singular(token);
    if (RELLENO.has(enSingular)) continue;

    terminos.push({ termino: enSingular, alternativas: [enSingular] });
  }

  return terminos;
}

/**
 * Términos de búsqueda, en plano — un array simple, sin agrupar. La usa
 * también la biblioteca (`knowledge.ts`), que hereda gratis singular,
 * números cortos, uniones letra+número y relleno.
 *
 * Si no queda ningún término (una búsqueda como "R6", que igual sobrevive
 * por tener un dígito) se usa la consulta entera antes que devolver el
 * catálogo completo.
 *
 * Decisión del 26/9/2026 sobre letra+número con letras de 3-4 ("rin 17"):
 * en plano salen DOS términos, "rin" y "rin17" — nunca el "17" suelto
 * aparte, porque ya viaja adentro de "rin17" y agregarlo como tercer
 * término duplicaría el mismo requisito sin sumar cobertura nueva (acá no
 * hay grupos que lo absorban como alternativa, como sí pasa en
 * `catalogTermGroups`).
 */
export function searchTerms(query: string): string[] {
  const terminos = [...new Set(terminosCrudos(query).map((t) => t.termino))];
  if (terminos.length > 0) return terminos;

  const entero = normalize(query).trim();
  return entero ? [entero] : [];
}

// ---------------------------------------------------------------------------
// Sinónimos de búsqueda — T5c, plan "Seba atiende el mostrador" (18/9/2026,
// requisito 7 del cliente, decisión P3): un asesor le enseña a Seba que
// "pastilla" (jerga que usa el cliente) también busca "pastillas de freno"
// (el nombre real en el catálogo), sin que nadie toque código.
//
// NO reutiliza `products.sinonimos_busqueda` (hallazgo 9 del plan): esa
// columna ya está ocupada por otro flujo. Los sinónimos de esta tarea viven
// en `public.ai_lessons` con `kind = 'sinonimo'` (migración 20260917020000)
// y `tools.ts` los consulta activos antes de armar el filtro del catálogo.
// ---------------------------------------------------------------------------

/** Un par jerga → término real. `isActive` es opcional (por defecto, activo). */
export interface SearchSynonym {
  from: string;
  to: string;
  isActive?: boolean;
}

/**
 * Tope de grupos que arma `catalogTermGroups` — mismo criterio defensivo que
 * el límite de grupos/alternativas de `buscar_productos` (la migración
 * 20260926010000): una consulta absurdamente larga no debe convertirse en
 * una llamada a la base con un jsonb gigante.
 */
const MAX_GRUPOS = 12;

/**
 * Clave de comparación de un sinónimo contra un término ya salido de
 * `terminosCrudos`: se singulariza CADA palabra de `from` (por si algún día
 * alguien carga un sinónimo de dos palabras) y se unen con espacio — para
 * "litros" (una sola palabra) da exactamente `singular("litros")` =
 * "litro", que es la forma en la que el término ya llega agrupado.
 */
function claveSinonimo(from: string): string {
  return normalize(from)
    .split(/\s+/)
    .filter(Boolean)
    .map(singular)
    .join(" ");
}

/**
 * El `to` de un sinónimo se agrega TAL CUAL lo escribió quien lo cargó — es
 * el nombre real del catálogo, no algo que haya que adivinar en singular —
 * solo normalizado y reducido a `[a-z0-9 ]` con los espacios colapsados,
 * para que no arrastre puntuación suelta a la alternativa.
 */
function normalizarDestinoSinonimo(to: string): string {
  return normalize(to)
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Términos de búsqueda del catálogo, agrupados en alternativas — desvío 1
 * del plan (25-26/9/2026): un grupo calza si calza CUALQUIERA de sus
 * alternativas. Hace falta por dos motivos, los dos vistos corriendo el
 * agente contra el catálogo real:
 *
 *   1. Sinónimos. En plano, "maleta 45 litros" + el sinónimo "litros->lts"
 *      daría CUATRO términos obligatorios (maleta, 45, litro, lts) — y
 *      ningún producto dice "litro" Y "lts" a la vez, así que la búsqueda
 *      fallaría. Agrupado da tres: {maleta} {45} {litro|lts}, y "MALETA
 *      CUADRADA 45 LTS" calza los tres.
 *   2. Letra + número. "dt 200" arma el grupo {dt200|dt 200}, así que
 *      calza tanto si el catálogo lo escribe junto como separado, y el
 *      "200" suelto no queda como término obligatorio aparte (calzaría con
 *      cualquier otra cosa que tenga un 200).
 *
 * `buscar_productos` (la migración) recibe exactamente esta forma como
 * `p_terminos`/`p_moto`.
 *
 * Desvío 2 del orquestador sobre T1 (26/9/2026): "caucho 90/90-18" parte en
 * cuatro tokens (caucho, 90, 90, 18) y el "90" repetido armaba DOS grupos
 * idénticos ([["90"],["90"]]) — no agregan ningún requisito nuevo, solo
 * inflan `p_terminos`. Se deduplican los grupos con la MISMA lista de
 * alternativas (después de aplicar sinónimos) y las alternativas repetidas
 * DENTRO de un mismo grupo, conservando siempre el orden de la primera
 * aparición.
 */
export function catalogTermGroups(query: string, synonyms: SearchSynonym[] = []): string[][] {
  const terminos = terminosCrudos(query);
  const grupos: string[][] = [];
  const gruposVistos = new Set<string>();

  for (const { termino, alternativas } of terminos) {
    const grupo = [...new Set(alternativas)];

    for (const synonym of synonyms) {
      if (synonym.isActive === false) continue;
      if (claveSinonimo(synonym.from) !== termino) continue;

      const destino = normalizarDestinoSinonimo(synonym.to);
      if (destino && !grupo.includes(destino)) grupo.push(destino);
    }

    // Separador que no puede aparecer en un término ya normalizado
    // ([a-z0-9 ]): sirve para comparar la lista completa como una sola clave.
    const clave = grupo.join("\u0000");
    if (gruposVistos.has(clave)) continue;
    gruposVistos.add(clave);

    grupos.push(grupo);
  }

  return grupos.slice(0, MAX_GRUPOS);
}

// ---------------------------------------------------------------------------
// catalogQuery — T1, plan "Seba encuentra, no insiste, y el mostrador no deja
// a nadie esperando" (28/9/2026).
// ---------------------------------------------------------------------------

/**
 * Palabras que describen el producto sin ser su nombre ni su marca: si el
 * cliente las dice y el nombre del catálogo no las trae, el producto correcto
 * NO debe caerse. Van a `opcionales`, que solo desempatan.
 *
 * La lista es CERRADA a propósito (pedido del operador, plan del 28/9/2026):
 * cada palabra que se suma acá deja de exigirse en el nombre, así que sumar
 * una es una decisión con test (`catalog-search.test.ts` fija la lista
 * literal). Ya normalizada (sin acentos, minúsculas) y singularizada; el
 * plural y el femenino se resuelven por `singularCatalogo`, y los que
 * necesitan su propia forma (azul/verde/gris/adaptable, donde la regla de
 * plural en "-es" corta de más) están en `PLURALES_IRREGULARES`.
 */
export const DESCRIPTIVAS: ReadonlySet<string> = new Set([
  // colores
  "negro", "negra", "blanco", "blanca", "rojo", "roja", "azul", "verde", "amarillo", "amarilla", "gris",
  "naranja", "plateado", "plateada", "dorado", "dorada", "rosado", "rosada", "morado", "morada", "marron",
  "celeste", "beige", "color",
  // acabado y posición
  "mate", "brillante", "delantero", "delantera", "trasero", "trasera", "izquierdo", "izquierda", "derecho",
  "derecha", "cromado", "cromada",
  // calidad y tipo
  "semi", "sintetico", "mineral", "original", "generico", "universal", "economico", "bueno", "buena",
  "integral", "adaptable",
  // otras
  "moto", "talla", "4t", "2t", "edge", "juego", "par",
]);

/**
 * Marcas y modelos de moto que por sí solos nunca son un repuesto: van a
 * `moto` (solo ORDENAN, y son lo único que puede volver verdadera la
 * coincidencia de moto en `tools.ts`). Ya en minúsculas y singular.
 *
 * Los prefijos de modelo que casi siempre viajan pegados a su número ("dt",
 * "cg", "gn", "en": "dt 200") NO están: se leerían como moto y perderían el
 * número que los hace un modelo real.
 */
export const MOTOS_CONOCIDAS: ReadonlySet<string> = new Set([
  // del catálogo de SBK Motors (nombres que aparecen en los productos)
  "bera", "sbr", "kavak", "horse", "ek", "xpress", "tx", "gs", "gr", "rk", "owen", "jaguar", "lechuza",
  "socialista", "brz", "ava", "mustang", "empire", "md", "beta", "gxs", "deer", "dsr", "tigrito",
  // marcas y modelos comunes del rubro venezolano
  "yamaha", "honda", "suzuki", "kawasaki", "keeway", "haojue", "bajaj", "tvs", "ktm", "ybr", "cbf", "xtz",
  "klr", "nxr", "pulsar", "boxer", "discover",
]);

/**
 * Plurales donde la regla de `singular` ("es" tras r/l/n/d/j/y) corta de
 * más: "azules" -> "azu", "verdes" -> "verd", "adaptables" -> "adaptabl". Y
 * "gris"/"grises": `singular` le quita la "s" a "gris" ("gri"). Solo lo usa
 * `catalogQuery`.
 */
const PLURALES_IRREGULARES: Record<string, string> = {
  gris: "gris",
  azules: "azul",
  verdes: "verde",
  grises: "gris",
  adaptables: "adaptable",
};

function singularCatalogo(word: string): string {
  return PLURALES_IRREGULARES[word] ?? singular(word);
}

/**
 * Palabras cortas que NO se unen con el número que las sigue: "maleta de 45"
 * unía "de"+"45" en "de45" y el 45 dejaba de ser el requisito que era. Se
 * saltan antes de cualquier otra regla.
 */
const NO_UNIR = new Set(["de", "del", "en", "y", "o", "a", "al", "la", "el", "es", "un", "por", "con", "x"]);

/**
 * Viscosidad de aceite: (0|5|10|15|20|25) y (20|30|40|50|60), separados por
 * "/", "-", espacio o la "w" de siempre, valen UN solo término "NNwNN".
 * Restringida a esos valores a propósito: "90/90-18" (medida de caucho) no
 * puede leerse como aceite. Los lookarounds evitan tomar la cola de un
 * número más largo ("100/90" no contiene "0/90").
 */
const VISCOSIDAD_CON_W = /(?<![0-9])(0|5|10|15|20|25)\s*w\s*[-/]?\s*(20|30|40|50|60)(?![0-9])/g;
const VISCOSIDAD_SIN_W = /(?<![0-9a-z])(0|5|10|15|20|25)\s*[/\-\s]\s*(20|30|40|50|60)(?![0-9a-z])/g;
const TIEMPOS = /(?<![0-9a-z])([24])\s*tiempos?(?![a-z])/g;

/**
 * Medida de caucho ("110/90-17", "80/100-14"): el ancho de tres dígitos NO es
 * la cilindrada de una moto — es lo que distingue un caucho de otro. Los
 * números pegados a una barra siguen siendo términos obligatorios, como
 * "90/90-18" siempre lo fue (y la viscosidad, que también lleva barra, ya
 * se convirtió en "NNwNN" antes de llegar acá).
 */
const MEDIDA_CAUCHO = /(?<![0-9])[0-9]{2,3}\s*\/\s*[0-9]{2,3}(?![0-9])/g;

/** La cilindrada suelta: exactamente 3 dígitos entre 50 y 400 (con "cc" se acepta también de 2 dígitos). */
function esCilindrada(token: string): boolean {
  if (!/^[0-9]{3}$/.test(token)) return false;
  const n = Number(token);
  return n >= 50 && n <= 400;
}

export interface CatalogQuery {
  /** Grupos OBLIGATORIOS de producto: definen el puntaje de `buscar_productos`. */
  grupos: string[][];
  /** Grupos que solo DESEMPATAN (colores, "semi", "delantero"…): nunca excluyen. */
  opcionales: string[][];
  /** Marca/modelo de moto CON NOMBRE: ordena, y es lo único que puede volver verdadera la coincidencia de moto. */
  moto: string[][];
  /** Cilindrada suelta ("250", "200cc" sin "cc"): solo ordena, jamás cuenta como moto. */
  cilindrada: string[][];
}

/**
 * Parte una consulta de catálogo en los cuatro conjuntos que recibe
 * `buscar_productos`. Reglas (todas con test):
 *
 *   - Una palabra de `DESCRIPTIVAS` (singularizada) va a `opcionales`;
 *     "4 tiempos"/"2 tiempos" es el opcional "4t"/"2t".
 *   - Una palabra de `MOTOS_CONOCIDAS` va a `moto`, aunque tenga 2 letras.
 *   - "NNNcc" y un número suelto de 3 dígitos entre 50 y 400 son cilindrada
 *     (sin la "cc"); van a `cilindrada`. Un número de 2 dígitos, fuera de
 *     rango ("45", "428") o pegado a una barra de medida de caucho
 *     ("110/90-17") sigue siendo un término del producto.
 *   - La viscosidad es UN grupo "NNwNN" (ver `VISCOSIDAD_SIN_W`).
 *   - "11.7" se conserva con su punto (el decimal de un modelo, "H11.7").
 *   - "año"/"ano" es relleno y el año de 4 dígitos que lo sigue se descarta:
 *     nunca es un requisito del nombre.
 *   - Las uniones letra+número de siempre (dt 200 -> dt200|dt 200; rin 17 ->
 *     rin + rin17|rin 17|17) se conservan, salvo cuando el número es una
 *     cilindrada y las letras son 3-4 ("rin 250"): la sigla queda obligatoria
 *     y el número ordena. Las palabras de `NO_UNIR` no se unen con nada.
 *   - Los sinónimos activos suman su destino como alternativa del grupo
 *     OBLIGATORIO cuyo término coincide (como en `catalogTermGroups`).
 *
 * Deduplica cada conjunto; tope de 12 grupos en cada uno.
 */
export function catalogQuery(query: string, synonyms: SearchSynonym[] = []): CatalogQuery {
  const texto = normalize(query)
    .replace(VISCOSIDAD_CON_W, (_m, a: string, b: string) => ` ${a}w${b} `)
    .replace(VISCOSIDAD_SIN_W, (_m, a: string, b: string) => ` ${a}w${b} `)
    .replace(TIEMPOS, " $1t ");
  const tokens = texto.match(/[a-z0-9]+(?:\.[0-9]+)*/g) ?? [];

  // Posiciones de los números que forman parte de una medida de caucho:
  // nunca se leen como cilindrada. Se calcula sobre la posición de cada token
  // en `texto` (mismo orden que `tokens`).
  const rangosCaucho = [...texto.matchAll(MEDIDA_CAUCHO)].map((m) => [m.index, m.index + m[0].length]);
  const posiciones = [...texto.matchAll(/[a-z0-9]+(?:\.[0-9]+)*/g)].map((m) => m.index);
  const enMedidaCaucho = (indiceToken: number): boolean =>
    rangosCaucho.some(([desde, hasta]) => posiciones[indiceToken] >= desde && posiciones[indiceToken] < hasta);

  const obligatorios: TerminoCrudo[] = [];
  const opcionales: string[] = [];
  const moto: string[] = [];
  const cilindrada: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const siguiente = tokens[i + 1];

    if (NO_UNIR.has(token)) continue;

    const enSingular = singularCatalogo(token);

    if (enSingular === "ano") {
      // "año 2020": el año que sigue nunca es un requisito del nombre.
      if (siguiente !== undefined && /^(19|20)[0-9]{2}$/.test(siguiente)) i++;
      continue;
    }

    if (MOTOS_CONOCIDAS.has(enSingular)) {
      moto.push(enSingular);
      continue;
    }

    const conCc = /^([0-9]{2,3})cc$/.exec(token);
    if (conCc) {
      cilindrada.push(conCc[1]);
      continue;
    }

    if (esSoloDigitos(token)) {
      if (esCilindrada(token) && !enMedidaCaucho(i)) cilindrada.push(token);
      else if (token.length >= 2) obligatorios.push({ termino: token, alternativas: [token] });
      continue;
    }

    if (
      esLetraCorta(token) &&
      siguiente !== undefined &&
      esSoloDigitos(siguiente) &&
      !RELLENO.has(enSingular) &&
      !DESCRIPTIVAS.has(enSingular) &&
      // "rin 250": las letras son una palabra completa y el número es la
      // cilindrada de la moto — no se funden (con 1-2 letras, "dt 200", sí).
      !(esCilindrada(siguiente) && !enMedidaCaucho(i + 1) && token.length >= 3)
    ) {
      const unido = token + siguiente;

      if (token.length >= 3) {
        obligatorios.push({ termino: enSingular, alternativas: [enSingular] });
        obligatorios.push({ termino: unido, alternativas: [unido, `${token} ${siguiente}`, siguiente] });
      } else {
        obligatorios.push({ termino: unido, alternativas: [unido, `${token} ${siguiente}`] });
      }

      i++; // el número ya se consumió.
      continue;
    }

    if (!esConservable(token)) continue;
    if (RELLENO.has(enSingular)) continue;

    if (DESCRIPTIVAS.has(enSingular)) {
      opcionales.push(enSingular);
      continue;
    }

    obligatorios.push({ termino: enSingular, alternativas: [enSingular] });
  }

  const grupos: string[][] = [];
  const gruposVistos = new Set<string>();

  for (const { termino, alternativas } of obligatorios) {
    const grupo = [...new Set(alternativas)];

    for (const synonym of synonyms) {
      if (synonym.isActive === false) continue;
      if (claveSinonimo(synonym.from) !== termino) continue;

      const destino = normalizarDestinoSinonimo(synonym.to);
      if (destino && !grupo.includes(destino)) grupo.push(destino);
    }

    const clave = grupo.join("\u0000");
    if (gruposVistos.has(clave)) continue;
    gruposVistos.add(clave);

    grupos.push(grupo);
  }

  const aGrupos = (terminos: string[]): string[][] =>
    [...new Set(terminos)].slice(0, MAX_GRUPOS).map((t) => [t]);

  return {
    grupos: grupos.slice(0, MAX_GRUPOS),
    opcionales: aGrupos(opcionales),
    moto: aGrupos(moto),
    cilindrada: aGrupos(cilindrada),
  };
}
