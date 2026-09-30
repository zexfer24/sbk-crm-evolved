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
// (migración 20260928010000) recibe por separado. `tools.ts` ya usa
// `catalogQuery` (T3a, 28/9/2026); `catalogTermGroups` quedó sin llamadores de
// producción y se conserva, con su test, solo hasta la limpieza.
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
// a nadie esperando" (28/9/2026); reescrita por la T4 de la Entrega A2 "Seba
// no cotiza lo que no es" (30/9/2026).
//
// El VPS volvió a pasar los 597 turnos del estudio por la Entrega A
// (`6c8ce24`): 116 mejoraron y 53 empeoraron, y el mismo 29/9 a las 13:14 una
// lista de un cliente con una SBR 2025 salió con cauchos rin 10 de scooter,
// kits de rodamiento de otras motos y un aditivo como "aceite". Las causas
// que viven en ESTE archivo (docs/planes/2026-09-30-seba-no-cotiza-lo-que-no-es.md):
//
//   - "130 - 70 - 12" se leía como cilindrada 130 (y cotizaba cauchos 120/70),
//     "n° 18" quedaba como el término "n18", "20:50" no era viscosidad y
//     "45" no calzaba con 45T: los números no tenían gramática.
//   - Un año ("2014", "2025") era un término obligatorio del producto y
//     calzaba con TANQUE OWEN 2014; "dt 2014" se unía en "dt2014".
//   - El color, el acabado y el nombre de variante ("azul", "edge", "paleta")
//     eran solo un desempate, así que el tope, el stock o la pregunta de
//     filtro los tapaban: ahora viajan aparte, en `variantes`.
//   - La moto calzaba por pedazo de palabra y la marca sola ("bera") bastaba:
//     ahora la marca va aparte (`motoMarca`, solo ordena) y `motoDesdeTexto`
//     entiende lo que el modelo escribe en motoBrand/motoModel.
//   - Los sinónimos de dos palabras ("boca pato") no calzaban nunca.
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
 *
 * A2 (30/9/2026): "kit" y "set" se suman (eran obligatorios y tumbaban
 * "kit de cilindro pasador fino"). Los colores, el acabado y las tallas
 * siguen en esta lista pero `catalogQuery` los manda a `variantes` (ver
 * `VARIANTES`, que tiene precedencia): solo "kit", "set" y las demás
 * quedan como opcionales de verdad.
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
  "moto", "talla", "4t", "2t", "edge", "juego", "par", "kit", "set",
]);

/**
 * Lo que distingue UNA variante de un mismo producto: el color, el acabado,
 * el nombre de la versión ("edge", "paleta", "rayo", "tornasol") y la talla.
 * A diferencia de un opcional, la variante NO es un desempate: cuando hay
 * filas que la traen entera, esas filas mandan (T5, `buscarUno`); y si el
 * cliente pide "tanque azul" y los azules están agotados, hay que decirlo en
 * vez de cotizar rojos. Lista CERRADA con test, ya normalizada y singular.
 *
 * Las tallas sueltas ("s", "m", "l", "xl", "xxl", "2xl", "3xl") solo cuentan
 * si el token es exactamente ese, y las de una letra NO cuentan detrás de un
 * número: "1 l" es un litro, no una talla. "xxxl" existe solo para mapear
 * "3xl". Las tallas con la palabra ("talla 39", "talla xl") y los centímetros
 * ("58cm") se resuelven aparte en `catalogQuery`.
 */
export const VARIANTES: ReadonlySet<string> = new Set([
  // colores (los mismos de DESCRIPTIVAS)
  "negro", "negra", "blanco", "blanca", "rojo", "roja", "azul", "verde", "amarillo", "amarilla", "gris",
  "naranja", "plateado", "plateada", "dorado", "dorada", "rosado", "rosada", "morado", "morada", "marron",
  "celeste", "beige",
  // acabado y nombre de versión
  "mate", "brillante", "cromado", "cromada", "edge", "paleta", "rayo", "tornasol",
  // tallas sueltas
  "s", "m", "l", "xl", "xxl", "xxxl", "2xl", "3xl",
]);

/** Cuando una talla tiene dos formas de escribirse en Saint, las dos viajan como alternativas. */
const TALLA_ALTERNATIVAS: ReadonlyMap<string, string[]> = new Map([
  ["2xl", ["xxl", "2xl"]],
  ["xxl", ["xxl", "2xl"]],
  ["3xl", ["xxxl", "3xl"]],
  ["xxxl", ["xxxl", "3xl"]],
]);

/** Lo que puede seguir a la palabra "talla": letras o un número de dos dígitos ("39"). */
const TALLA_DE_LETRAS = new Set(["xs", "s", "m", "l", "xl", "xxl", "xxxl", "2xl", "3xl"]);

/**
 * Marcas y modelos de moto que por sí solos nunca son un repuesto: van a
 * `moto` (solo ORDENAN, y son lo único que puede volver verdadera la
 * coincidencia de moto en `tools.ts`). Ya en minúsculas y singular.
 *
 * Los prefijos de modelo que casi siempre viajan pegados a su número ("dt",
 * "cg", "gn", "en": "dt 200") NO están: se leerían como moto y perderían el
 * número que los hace un modelo real.
 *
 * A2 (30/9/2026): se suman las que salieron de los casos del VPS (milan,
 * runner, leon, rex, aguila, rkv, hj, cool, vstrom, gy6, bws, dr). "dr" tiene
 * 2 letras y sola no es nada: solo cuenta como moto con un número detrás
 * ("dr650", "dr 650"). NO se suman "toro", "new" ni "super": pueden ser una
 * palabra de producto ("BOMBILLO NEW …"), y `motoDesdeTexto` ya las entiende
 * como moto cuando vienen de motoBrand/motoModel, que es donde el modelo las
 * pone ("Bera New Runner"). "express" no se suma: es alias de "xpress"
 * (`ALIAS_MOTO`).
 */
export const MOTOS_CONOCIDAS: ReadonlySet<string> = new Set([
  // del catálogo de SBK Motors (nombres que aparecen en los productos)
  "bera", "sbr", "kavak", "horse", "ek", "xpress", "tx", "gs", "gr", "rk", "owen", "jaguar", "lechuza",
  "socialista", "brz", "ava", "mustang", "empire", "md", "beta", "gxs", "deer", "dsr", "tigrito",
  // marcas y modelos comunes del rubro venezolano
  "yamaha", "honda", "suzuki", "kawasaki", "keeway", "haojue", "bajaj", "tvs", "ktm", "ybr", "cbf", "xtz",
  "klr", "nxr", "pulsar", "boxer", "discover",
  // A2: los que salieron de los casos del VPS (29/9/2026)
  "milan", "runner", "leon", "rex", "aguila", "rkv", "hj", "cool", "vstrom", "gy6", "bws", "dr",
]);

/**
 * Las marcas de moto: sirven para separar la marca del modelo. Cuando la
 * consulta (o el texto de moto del modelo) trae una marca Y un modelo, la
 * marca va a `motoMarca` —que solo ordena— y el modelo a `moto`; con solo
 * marca, la marca va a `moto`. Así "Bera Milan" no calza todas las tapas de
 * Bera SBR por decir "bera" (caso 2.1 del VPS). Toda marca es también una
 * moto conocida. "jaguar" está porque en Saint aparece como marca
 * ("BATERIA SECA JAGUAR/BERA").
 */
export const MARCAS_DE_MOTO: ReadonlySet<string> = new Set([
  "bera", "ek", "empire", "md", "hj", "yamaha", "honda", "suzuki", "kawasaki", "keeway", "haojue", "bajaj", "tvs",
  "ktm", "jaguar",
]);

/**
 * Marcas comerciales de los productos (no de moto), las que aparecen en los nombres de Saint.
 * Es la lista que recibe el corrector de tipeos como `p_marcas` (T5b, 30/9/2026): solo hacia
 * ELLAS se acepta una corrección a distancia 2 o 3. Las motos no van: "kenda" quedaba a distancia
 * 2 de HONDA y el corrector la proponía; las motos se protegen aparte (`p_protegidos`).
 */
export const MARCAS_DE_PRODUCTO: readonly string[] = [
  "timsun", "switchera", "ipone", "motorpower", "motul", "inca", "oilstone", "givi", "ls2", "ich", "benf",
  "lefor", "ejeas", "senfi", "carkmotos", "jerez", "aldrich", "tomcat", "buff", "frankie",
];

/**
 * Lista cerrada de marcas (comerciales y de moto): la usan el corrector, que
 * nunca debe "corregir" hacia otra marca ni desde una, y el relajo de D3, que
 * jamás relaja una marca. `products.brand` está vacía (0 de 6.065 productos),
 * por eso la lista vive en código y se fija con test. "frankie" está porque
 * "casco frankie negro vicera azul" no puede perder su marca.
 */
export const MARCAS_CONOCIDAS: ReadonlySet<string> = new Set([...MARCAS_DE_PRODUCTO, ...MOTOS_CONOCIDAS]);

/**
 * Alias explícitos de moto: escrituras que no están a distancia 1 de la real
 * o que son palabras válidas por sí solas. "express" es como el cliente
 * escribe la XPRESS de EK (el caso "asiento express" salía agotado con el
 * FORRO ASIENTO EK EXPRESS, 29/9/2026).
 */
const ALIAS_MOTO: ReadonlyMap<string, string> = new Map([["express", "xpress"]]);

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
 * El relleno de `searchTerms` MÁS las palabras que en el catálogo no
 * describen nada ("medida", "tipo", "modelo", "marca", "numero", "pulgada").
 * Aparte del `RELLENO` compartido a propósito: la biblioteca
 * (`knowledge.ts`) usa `searchTerms`, y "cuál es la marca de…" sí necesita
 * "marca" para encontrar un artículo.
 *
 * A2, T5 (30/9/2026): se exporta porque el corrector de tipeos lo recibe como
 * `p_excluidos` (`corregir_terminos`, migración 20260930020000): una palabra de
 * relleno ni se corrige ni sirve de candidato ("pareja" no pasa a "para").
 */
export const RELLENO_CATALOGO: ReadonlySet<string> = new Set([...RELLENO, "medida", "tipo", "modelo", "marca", "numero", "pulgada"]);

/**
 * Palabras cortas que NO se unen con el número que las sigue: "maleta de 45"
 * unía "de"+"45" en "de45" y el 45 dejaba de ser el requisito que era. Se
 * saltan antes de cualquier otra regla.
 */
const NO_UNIR = new Set(["de", "del", "en", "y", "o", "a", "al", "la", "el", "es", "un", "por", "con", "x"]);

/** Las palabras tras las que un grupo cuenta como "complemento" (`trasPreposicion`). */
const PREPOSICIONES = new Set(["de", "del", "con", "para"]);

/**
 * Viscosidad de aceite: (0|5|10|15|20|25) y (20|30|40|50|60), separados por
 * "/", "-", ":", espacio o la "w" de siempre, valen UN solo término "NNwNN".
 * Restringida a esos valores a propósito: "90/90-18" (medida de caucho) no
 * puede leerse como aceite. Los lookarounds evitan tomar la cola de un
 * número más largo ("100/90" no contiene "0/90"). El ":" es de A2
 * ("motul 5100 20:50" no encontraba nada).
 */
const VISCOSIDAD_CON_W = /(?<![0-9])(0|5|10|15|20|25)\s*w\s*[-/]?\s*(20|30|40|50|60)(?![0-9])/g;
const VISCOSIDAD_SIN_W = /(?<![0-9a-z])(0|5|10|15|20|25)\s*[/\-\s:]\s*(20|30|40|50|60)(?![0-9a-z])/g;
const TIEMPOS = /(?<![0-9a-z])([24])\s*tiempos?(?![a-z])/g;

/** "semi taco", "semi-taco", "semitaco": es UNA sola palabra de producto (no "taco" ni "semi"). */
const SEMI_TACO = /(?<![a-z])semi[\s-]*tacos?(?![a-z])/g;

/**
 * Medida de caucho: ancho / perfil / rin, separados por "/", "-", espacio o
 * " - " en cualquier mezcla, con una "R" opcional delante del rin
 * ("130/60/R13", "130/60 R13", "130 70 12", "130 - 70 - 12"). Se valida por
 * rango (ancho 50-400, perfil 30-130, rin 8-23): sin un rin plausible no se
 * lee como caucho. Dos números solo son medida si van con "/" ("90/90",
 * "80/100"): con espacio o guion podrían ser cualquier otra cosa ("maleta 45
 * 30"). Los tres (o dos) números salen como marcador `@med_A_P_R`, y cada uno
 * queda como grupo obligatorio: NINGUNO es cilindrada.
 */
const SEP_MEDIDA = String.raw`(?:\s*[-/]\s*|\s+)`;
const MEDIDA_TRES = new RegExp(
  String.raw`(?<![0-9a-z.])([0-9]{2,3})${SEP_MEDIDA}([0-9]{2,3})(?:${SEP_MEDIDA}r?\s*|\s*r)([0-9]{2})(?![0-9])`,
  "g"
);
const MEDIDA_DOS = /(?<![0-9a-z.])([0-9]{2,3})\s*\/\s*([0-9]{2,3})(?![0-9])/g;

/** "45 litros", "45lts", "1 l": litros. Con la "l" sola se distingue de la talla L. */
const LITROS = /(?<![0-9a-z.])([0-9]+(?:\.[0-9]+)?)\s*(litros?|lts?|ltrs?|l)(?![a-z0-9])/g;
const PULGADAS = /(?<![0-9a-z.])([0-9]+(?:\.[0-9]+)?)\s*(?:pulgadas?|pulg|pul)(?![a-z0-9])/g;
const PULGADAS_COMILLAS = /(?<![0-9a-z.])([0-9]+(?:\.[0-9]+)?)\s*"/g;
const CENTIMETROS = /(?<![0-9a-z.])([0-9]{2,3})\s*cm(?![a-z0-9])/g;

/**
 * "n° 18", "nº18", "no 18", "nro 18", "num 18", "numero 18", "n18", "#18":
 * el número de un rin/tamaño, no un término. Se reemplaza por una palabra
 * marcadora (`MARCA_NUMERO`) que le dice al bucle "el próximo número es un
 * grupo obligatorio, nunca cilindrada ni año". La "n"/"no"/"nro"… nunca
 * quedan como términos ni se unen con el número ("n18" nunca).
 */
const MARCA_NUMERO = "zznum";
const NUMERAL = /(?<![a-z0-9])(?:n|no|nro|num|numero)\s*[°º.]?\s*(?=[0-9@])|#\s*(?=[0-9@])/g;

/** Un token o un marcador de los de arriba. */
const TOKEN = /@[a-z0-9_.]+|[a-z0-9]+(?:\.[0-9]+)*/g;

/** La consulta ya normalizada, con las medidas, unidades y numerales resueltos como marcadores. */
function prepararTexto(query: string): string {
  return normalize(query)
    .replace(/(?<=[0-9]),(?=[0-9])/g, ".")
    .replace(SEMI_TACO, " semitaco ")
    .replace(VISCOSIDAD_CON_W, (_m, a: string, b: string) => ` ${a}w${b} `)
    .replace(VISCOSIDAD_SIN_W, (_m, a: string, b: string) => ` ${a}w${b} `)
    .replace(TIEMPOS, " $1t ")
    .replace(MEDIDA_TRES, (m, a: string, p: string, r: string) => {
      const ancho = Number(a);
      const perfil = Number(p);
      const rin = Number(r);
      const plausible = ancho >= 50 && ancho <= 400 && perfil >= 30 && perfil <= 130 && rin >= 8 && rin <= 23;
      return plausible ? ` @med_${a}_${p}_${r} ` : m;
    })
    .replace(MEDIDA_DOS, (m, a: string, p: string) => {
      const ancho = Number(a);
      const perfil = Number(p);
      return ancho >= 50 && ancho <= 400 && perfil >= 30 && perfil <= 130 ? ` @med_${a}_${p} ` : m;
    })
    .replace(LITROS, (_m, n: string, unidad: string) => ` @lit_${n}${unidad === "l" ? "_l" : ""} `)
    .replace(PULGADAS, (_m, n: string) => ` @pulg_${n} `)
    .replace(PULGADAS_COMILLAS, (_m, n: string) => ` @pulg_${n} `)
    .replace(CENTIMETROS, (_m, n: string) => ` @cm_${n} `)
    .replace(NUMERAL, ` ${MARCA_NUMERO} `);
}

/** La cilindrada suelta: exactamente 3 dígitos entre 50 y 400 (con "cc" se acepta también de 2 dígitos). */
function esCilindrada(token: string): boolean {
  if (!/^[0-9]{3}$/.test(token)) return false;
  const n = Number(token);
  return n >= 50 && n <= 400;
}

/** Un año de 4 dígitos entre 1980 y 2035: es de la moto, nunca un término del producto. */
function esAnio(token: string): boolean {
  if (!/^[0-9]{4}$/.test(token)) return false;
  const n = Number(token);
  return n >= 1980 && n <= 2035;
}

/** El "año" que sigue a la palabra "año": más ancho (19xx/20xx) que el suelto. */
const ANIO_TRAS_LA_PALABRA = /^(19|20)[0-9]{2}$/;

/** Cilindrada de un modelo grande pegado o detrás de su moto (dr650, vstrom 650): 3-4 dígitos, 50-1300, no año. */
function esCilindradaDeMoto(token: string): boolean {
  if (!/^[0-9]{3,4}$/.test(token) || esAnio(token)) return false;
  const n = Number(token);
  return n >= 50 && n <= 1300;
}

/** Levenshtein clásico, solo para comparar palabras sueltas contra las motos conocidas. */
function distancia(a: string, b: string): number {
  const fila = Array.from({ length: b.length + 1 }, (_v, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = fila[0];
    fila[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const arriba = fila[j];
      fila[j] = Math.min(fila[j] + 1, fila[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = arriba;
    }
  }
  return fila[b.length];
}

const MOTOS_PARA_CORREGIR = [...MOTOS_CONOCIDAS].filter((m) => m.length >= 5 && /^[a-z]+$/.test(m));

/**
 * Corrige una palabra tipeada a una moto conocida: por alias explícito
 * ("express" -> "xpress") o a distancia 1 ("horsen" -> "horse"). Solo
 * palabras de 5+ letras y solo hacia motos de 5+ letras: "beta" (4) es una
 * moto por derecho propio y NO un tipeo de "bera". `null` si no hay nada que
 * corregir. La corrección de ESTE módulo es de la moto, que solo ORDENA; el
 * corrector de productos (SQL) es otra cosa y tiene sus propios límites.
 */
function corregirMoto(palabra: string): string | null {
  if (palabra.length < 5 || !/^[a-z]+$/.test(palabra) || MOTOS_CONOCIDAS.has(palabra)) return null;

  const alias = ALIAS_MOTO.get(palabra);
  if (alias) return alias;

  for (const moto of MOTOS_PARA_CORREGIR) {
    if (Math.abs(moto.length - palabra.length) <= 1 && distancia(moto, palabra) === 1) return moto;
  }
  return null;
}

/** Palabras que jamás se "corrigen" a una moto: son de otra lista cerrada. */
function esVocabularioCerrado(palabra: string): boolean {
  return (
    DESCRIPTIVAS.has(palabra) ||
    VARIANTES.has(palabra) ||
    RELLENO_CATALOGO.has(palabra) ||
    NO_UNIR.has(palabra) ||
    MARCAS_CONOCIDAS.has(palabra)
  );
}

/** Con marca Y modelo, la marca va aparte; con solo marcas o solo modelos, todo es `moto`. */
function repartirMotos(motos: string[]): { moto: string[]; motoMarca: string[] } {
  const unicas = [...new Set(motos)];
  const marcas = unicas.filter((m) => MARCAS_DE_MOTO.has(m));
  const modelos = unicas.filter((m) => !MARCAS_DE_MOTO.has(m));
  if (marcas.length > 0 && modelos.length > 0) return { moto: modelos, motoMarca: marcas };
  return { moto: unicas, motoMarca: [] };
}

/** Un sinónimo de dos o más palabras, ya preparado para buscarse seguido en la consulta. */
interface SinonimoMulti {
  /** Las palabras del `from` en singular y sin "de"/"del". */
  palabras: string[];
  /** El `from` normalizado tal cual (con su "de", si lo trae): la primera alternativa del grupo. */
  frase: string;
  destino: string;
}

function prepararSinonimosMulti(synonyms: SearchSynonym[]): SinonimoMulti[] {
  const lista: SinonimoMulti[] = [];

  for (const synonym of synonyms) {
    if (synonym.isActive === false) continue;

    const dichas = normalize(synonym.from).split(/\s+/).filter(Boolean);
    const palabras = dichas.filter((w) => w !== "de" && w !== "del").map(singular);
    if (palabras.length < 2) continue;

    const destino = normalizarDestinoSinonimo(synonym.to);
    if (!destino) continue;

    lista.push({ palabras, frase: dichas.join(" "), destino });
  }

  // Primero el más largo: "kit de rodaje" gana sobre un "kit" suelto.
  return lista.sort((a, b) => b.palabras.length - a.palabras.length);
}

/**
 * ¿Alguna frase de la lista aparece SEGUIDA a partir del token `desde`? Tolera
 * un "de"/"del" entre sus palabras aunque el `from` no lo traiga (y el `from`
 * puede traerlo aunque la consulta no lo diga): "kit de rodaje" calza con "kit
 * rodaje". Devuelve cuántos tokens consume (con los "de" del medio).
 */
function buscarSinonimoMulti(
  tokens: string[],
  desde: number,
  lista: SinonimoMulti[]
): { frase: string; destino: string; consumidos: number } | null {
  for (const sinonimo of lista) {
    let j = desde;
    let k = 0;

    while (k < sinonimo.palabras.length && j < tokens.length) {
      if (k > 0 && (tokens[j] === "de" || tokens[j] === "del")) {
        j++;
        continue;
      }
      if (singular(tokens[j]) !== sinonimo.palabras[k]) break;
      j++;
      k++;
    }

    if (k === sinonimo.palabras.length) {
      return { frase: sinonimo.frase, destino: sinonimo.destino, consumidos: j - desde };
    }
  }
  return null;
}

/** Cómo se ubica un grupo obligatorio dentro de la consulta (`gruposInfo`). */
export interface GrupoInfo {
  /** El grupo vino inmediatamente después de "de"/"del"/"con"/"para": es un complemento del producto. */
  trasPreposicion: boolean;
  /**
   * Si el grupo es un número que complementa a una palabra ("reborde de 11",
   * "corona de 45", "caucho 21"), el índice de ESE grupo de palabra en
   * `grupos`. `null` si no es un número o no complementa a nadie (los de una
   * medida de caucho o un numeral "n° 18" tampoco: valen por sí mismos).
   */
  numeroDe: number | null;
}

/** Una palabra de moto que se corrigió (por alias o distancia 1) antes de buscar. */
export interface MotoCorregida {
  original: string;
  corregido: string;
}

export interface CatalogQuery {
  /** Grupos OBLIGATORIOS de producto: definen el puntaje de `buscar_productos`. */
  grupos: string[][];
  /** Paralelo a `grupos`: dónde cayó cada uno (tras "de"/"con"/"para", número de qué palabra). */
  gruposInfo: GrupoInfo[];
  /** Grupos que solo DESEMPATAN (posición, calidad, "kit"…): nunca excluyen. */
  opcionales: string[][];
  /** Color, acabado, "edge"/"paleta"/"rayo"/"tornasol" y talla: estrictas y preferentes (ver `VARIANTES`). */
  variantes: string[][];
  /** Modelo de moto CON NOMBRE (o la marca si es lo único que dijo): ordena, y es lo único que puede volver verdadera la coincidencia de moto. */
  moto: string[][];
  /** La marca de la moto cuando también dio un modelo ("bera" en "bera milan"): solo ordena. */
  motoMarca: string[][];
  /** Cilindrada suelta ("250", "200cc" sin "cc"): solo ordena, jamás cuenta como moto. */
  cilindrada: string[][];
  /** Año de la moto (1980-2035): solo ordena, jamás es un término del producto. */
  anio: string[][];
  /** Las palabras de moto que se corrigieron por alias o distancia 1 (horsen -> horse). */
  motoCorregida: MotoCorregida[];
}

/** Un término obligatorio ya resuelto, con el contexto que necesita `gruposInfo`. */
interface Obligatorio {
  termino: string;
  alternativas: string[];
  tras: boolean;
  /** Índice en `obligatorios` (no en `grupos`: se remapea al final) del grupo de palabra que este número complementa. */
  numeroDe: number | null;
  /** Ya trae su destino (sinónimo de varias palabras): el bucle de sinónimos de una palabra no lo toca. */
  multi: boolean;
}

/**
 * Parte una consulta de catálogo en los conjuntos que recibe
 * `buscar_productos`. Reglas (todas con test):
 *
 *   - Un color, acabado, nombre de versión o talla (`VARIANTES`) va a
 *     `variantes`; "talla X" y "58cm" también. Una palabra de `DESCRIPTIVAS`
 *     (singularizada) va a `opcionales`; "4 tiempos"/"2 tiempos" es el
 *     opcional "4t"/"2t".
 *   - Una palabra de `MOTOS_CONOCIDAS` va a `moto` (o `motoMarca` si trae
 *     además un modelo), aunque tenga 2 letras; "gr250" se parte en moto +
 *     cilindrada. Una moto tipeada a distancia 1 o por alias se corrige y
 *     queda en `motoCorregida`.
 *   - Un año de 1980 a 2035 va a `anio`, nunca a `grupos`, y no se une con
 *     letras ("dt 2014" no es "dt2014").
 *   - "NNNcc" y un número suelto de 3 dígitos entre 50 y 400 son cilindrada
 *     (sin la "cc"); van a `cilindrada`.
 *   - Una medida de caucho (ancho/perfil/rin con `/`, `-`, espacio o " - ", o
 *     con "R" delante del rin) deja cada número como grupo obligatorio y
 *     ninguno es cilindrada. "rin 17", "n° 18", "nro 18", "#17" dejan solo el
 *     número, salvo cuando "rin" es la primera palabra de producto.
 *   - La viscosidad es UN grupo "NNwNN" ("20/50", "20-50", "20 50", "20:50").
 *   - "N litros/lts/lt/l" es UN grupo `[Nlts, "N lts", "N litro", Nlt]`;
 *     "N pulgadas" deja solo `N`; "Nmm" se conserva.
 *   - "kit" y "set" son opcionales; "semi taco" es "semitaco".
 *   - "11.7" se conserva con su punto (el decimal de un modelo, "H11.7").
 *   - Un sinónimo de dos o más palabras que aparece seguido en la consulta es
 *     UN grupo `[frase, destino]`; los de una palabra suman su destino como
 *     alternativa del grupo cuyo término coincide.
 *   - Las palabras cortas: la entereza ("cro" no calza con CROMADO) la da SQL
 *     (`patron_busqueda`); acá "cros" sigue saliendo como el grupo "cro".
 *
 * Deduplica cada conjunto; tope de 12 grupos en cada uno.
 */
export function catalogQuery(query: string, synonyms: SearchSynonym[] = []): CatalogQuery {
  const tokens = prepararTexto(query).match(TOKEN) ?? [];
  const sinonimosMulti = prepararSinonimosMulti(synonyms);

  const obligatorios: Obligatorio[] = [];
  const opcionales: string[] = [];
  const variantes: string[][] = [];
  const motos: string[] = [];
  const cilindrada: string[] = [];
  const anio: string[] = [];
  const motoCorregida: MotoCorregida[] = [];

  // Qué produjo el último término obligatorio, para saber si un número lo complementa.
  let ultimoTipo: "palabra" | "otro" | null = null;
  let ultimaPalabra = -1;
  let marcaNumero = false;
  let motoGrande = false;

  const trasPreposicion = (i: number): boolean => i > 0 && PREPOSICIONES.has(tokens[i - 1]);

  const agregarPalabra = (i: number, termino: string, alternativas: string[], multi = false): void => {
    obligatorios.push({ termino, alternativas, tras: trasPreposicion(i), numeroDe: null, multi });
    ultimoTipo = "palabra";
    ultimaPalabra = obligatorios.length - 1;
  };

  const agregarNumero = (i: number, termino: string, alternativas: string[], complementa: boolean): void => {
    obligatorios.push({
      termino,
      alternativas,
      tras: trasPreposicion(i),
      numeroDe: complementa && ultimoTipo === "palabra" ? ultimaPalabra : null,
      multi: false,
    });
    ultimoTipo = "otro";
  };

  /** Hay un sustantivo de producto (solo letras) antes: "rin" ya no es el producto. */
  const hayPalabraDeProducto = (): boolean => obligatorios.some((o) => /^[a-z]+$/.test(o.termino));

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const siguiente: string | undefined = tokens[i + 1];

    // Las marcas de "el próximo token es un numeral / va detrás de dr" valen solo para el token inmediato.
    const eraNumeral = marcaNumero;
    const eraMotoGrande = motoGrande;
    marcaNumero = false;
    motoGrande = false;

    if (token === MARCA_NUMERO) {
      marcaNumero = true;
      continue;
    }

    if (token.startsWith("@")) {
      const [tipo, ...partes] = token.slice(1).split("_");
      if (tipo === "med") {
        for (const n of partes) agregarNumero(i, n, [n], false);
      } else if (tipo === "lit") {
        const n = partes[0];
        const alternativas = [`${n}lts`, `${n} lts`, `${n} litro`, `${n}lt`];
        // Con la "l" sola ("1 l") también la forma pegada: Saint escribe "1L".
        if (partes[1] === "l") alternativas.push(`${n}l`);
        agregarNumero(i, `${n}lts`, alternativas, true);
      } else if (tipo === "pulg") {
        agregarNumero(i, partes[0], [partes[0]], true);
      } else if (tipo === "cm") {
        variantes.push([`${partes[0]}cm`, `${partes[0]} cm`, partes[0]]);
      }
      continue;
    }

    const sinonimo = buscarSinonimoMulti(tokens, i, sinonimosMulti);
    if (sinonimo) {
      agregarPalabra(i, sinonimo.frase, [sinonimo.frase, sinonimo.destino], true);
      i += sinonimo.consumidos - 1;
      continue;
    }

    if (NO_UNIR.has(token)) continue;

    const enSingular = singularCatalogo(token);

    if (enSingular === "ano") {
      // "año 2020": el año que sigue nunca es un requisito del nombre.
      if (siguiente !== undefined && ANIO_TRAS_LA_PALABRA.test(siguiente)) {
        anio.push(siguiente);
        i++;
      }
      continue;
    }

    // Moto. Se prueba el token TAL CUAL antes que su singular: "xpress" perdía la "s" ("xpres") y no calzaba.
    let moto: string | null = MOTOS_CONOCIDAS.has(token) ? token : MOTOS_CONOCIDAS.has(enSingular) ? enSingular : null;
    // "dr" solo es moto con número detrás: suelto son dos letras sin sentido, como cualquier sigla.
    if (moto === "dr" && !(siguiente !== undefined && esSoloDigitos(siguiente))) moto = null;

    if (moto === null && !esVocabularioCerrado(enSingular) && !esVocabularioCerrado(token)) {
      const corregida = corregirMoto(token) ?? corregirMoto(enSingular);
      if (corregida) {
        moto = corregida;
        motoCorregida.push({ original: token, corregido: corregida });
      }
    }

    if (moto !== null) {
      motos.push(moto);
      if (moto === "dr" || moto === "vstrom") motoGrande = true;
      continue;
    }

    // "gr250", "dr650", "bws150": la moto conocida pegada a su cilindrada (o año).
    const pegado = /^([a-z]{2,10})([0-9]{2,4})$/.exec(token);
    if (pegado && MOTOS_CONOCIDAS.has(pegado[1]) && (esAnio(pegado[2]) || esCilindradaDeMoto(pegado[2]))) {
      motos.push(pegado[1]);
      (esAnio(pegado[2]) ? anio : cilindrada).push(pegado[2]);
      continue;
    }

    const conCc = /^([0-9]{2,3})cc$/.exec(token);
    if (conCc) {
      cilindrada.push(conCc[1]);
      continue;
    }

    if (esSoloDigitos(token)) {
      if (eraNumeral) {
        // "n° 18": el número del rin, siempre un término (aunque sea de un dígito).
        agregarNumero(i, token, [token], false);
      } else if (esAnio(token)) {
        anio.push(token);
      } else if (esCilindrada(token) || (eraMotoGrande && esCilindradaDeMoto(token))) {
        cilindrada.push(token);
      } else if (token.length >= 2) {
        agregarNumero(i, token, [token], true);
      }
      continue;
    }

    if (enSingular === "talla") {
      // "talla xl", "talla 39": la talla es la variante; la palabra "talla" no queda como término.
      if (siguiente !== undefined) {
        if (TALLA_DE_LETRAS.has(siguiente)) {
          variantes.push(TALLA_ALTERNATIVAS.get(siguiente) ?? [siguiente]);
          i++;
        } else if (/^[0-9]{2}$/.test(siguiente)) {
          variantes.push([siguiente]);
          i++;
        }
      }
      continue;
    }

    const variante = VARIANTES.has(token) ? token : VARIANTES.has(enSingular) ? enSingular : null;
    if (variante !== null) {
      // Una talla de una letra detrás de un número no es talla ("cadena 4 m").
      const previo = tokens[i - 1];
      if (variante.length === 1 && previo !== undefined && esSoloDigitos(previo)) continue;
      variantes.push(TALLA_ALTERNATIVAS.get(variante) ?? [variante]);
      continue;
    }

    if (
      esLetraCorta(token) &&
      siguiente !== undefined &&
      esSoloDigitos(siguiente) &&
      !RELLENO_CATALOGO.has(enSingular) &&
      !DESCRIPTIVAS.has(enSingular) &&
      // un año no se une con letras ("dt 2014" no es "dt2014")
      !esAnio(siguiente) &&
      // "rin 250": las letras son una palabra completa y el número es la
      // cilindrada de la moto — no se funden (con 1-2 letras, "dt 200", sí).
      !(esCilindrada(siguiente) && token.length >= 3)
    ) {
      // "caucho rin 17": el sustantivo de producto ya está; el rin es solo su medida.
      if (enSingular === "rin" && hayPalabraDeProducto()) continue;

      const unido = token + siguiente;

      if (token.length >= 3) {
        agregarPalabra(i, enSingular, [enSingular]);
        agregarNumero(i, unido, [unido, `${token} ${siguiente}`, siguiente], false);
      } else {
        agregarNumero(i, unido, [unido, `${token} ${siguiente}`], false);
      }

      i++; // el número ya se consumió.
      continue;
    }

    // "caucho rin 130-80-17": lo que sigue a "rin" es una medida entera, no un número suelto.
    if (enSingular === "rin" && siguiente !== undefined && siguiente.startsWith("@med_") && hayPalabraDeProducto()) {
      continue;
    }

    if (!esConservable(token)) continue;
    if (RELLENO_CATALOGO.has(enSingular)) continue;

    if (DESCRIPTIVAS.has(enSingular)) {
      opcionales.push(enSingular);
      continue;
    }

    agregarPalabra(i, enSingular, [enSingular]);
  }

  const grupos: string[][] = [];
  const gruposInfo: GrupoInfo[] = [];
  const gruposVistos = new Map<string, number>();
  // Índice en `grupos` de cada obligatorio (-1 si no entró por el tope): `numeroDe` apunta al grupo FINAL.
  const indiceFinal: number[] = [];

  obligatorios.forEach((obligatorio, indice) => {
    const grupo = [...new Set(obligatorio.alternativas)];

    if (!obligatorio.multi) {
      for (const synonym of synonyms) {
        if (synonym.isActive === false) continue;
        if (claveSinonimo(synonym.from) !== obligatorio.termino) continue;

        const destino = normalizarDestinoSinonimo(synonym.to);
        if (destino && !grupo.includes(destino)) grupo.push(destino);
      }
    }

    const clave = grupo.join("\u0000");
    const previo = gruposVistos.get(clave);
    if (previo !== undefined) {
      indiceFinal[indice] = previo;
      return;
    }
    if (grupos.length >= MAX_GRUPOS) {
      indiceFinal[indice] = -1;
      return;
    }

    gruposVistos.set(clave, grupos.length);
    indiceFinal[indice] = grupos.length;
    const destinoNumero = obligatorio.numeroDe !== null ? indiceFinal[obligatorio.numeroDe] : undefined;
    grupos.push(grupo);
    gruposInfo.push({
      trasPreposicion: obligatorio.tras,
      numeroDe: destinoNumero !== undefined && destinoNumero >= 0 ? destinoNumero : null,
    });
  });

  const aGrupos = (terminos: string[]): string[][] =>
    [...new Set(terminos)].slice(0, MAX_GRUPOS).map((t) => [t]);

  const variantesUnicas: string[][] = [];
  const variantesVistas = new Set<string>();
  for (const variante of variantes) {
    const clave = variante.join("\u0000");
    if (variantesVistas.has(clave)) continue;
    variantesVistas.add(clave);
    variantesUnicas.push(variante);
  }

  const { moto, motoMarca } = repartirMotos(motos);

  return {
    grupos,
    gruposInfo,
    opcionales: aGrupos(opcionales),
    variantes: variantesUnicas.slice(0, MAX_GRUPOS),
    moto: aGrupos(moto),
    motoMarca: aGrupos(motoMarca),
    cilindrada: aGrupos(cilindrada),
    anio: aGrupos(anio),
    motoCorregida,
  };
}

/** Lo que `motoDesdeTexto` entiende del texto de moto que escribió el modelo. */
export interface MotoDesdeTexto {
  moto: string[][];
  motoMarca: string[][];
  cilindrada: string[][];
  anio: string[][];
  motoCorregida: MotoCorregida[];
}

/** Palabras que en un texto de moto no son ni marca ni modelo. */
const SALTAR_EN_MOTO = new Set([
  "de", "del", "la", "el", "los", "las", "y", "o", "a", "al", "un", "una", "con", "para", "por", "en", "que",
  "moto", "motos", "marca", "modelo", "tipo",
]);

/**
 * Entiende el texto de moto que el modelo escribe en `motoBrand` +
 * `motoModel` ("Bera Milan", "EK horsen", "GR 250", "DT250", "MD Aguila
 * 2014"). A diferencia de `catalogQuery`, acá TODO lo que trae es moto, aunque
 * no esté en `MOTOS_CONOCIDAS` ("Toro Rex", "Runner 6G", "dt"): el modelo ya
 * dijo que es la moto.
 *
 *   - Un año de 1980 a 2035 va a `anio`; "año 2014" también; un número de
 *     2-4 dígitos entre 50 y 1300 (o "150cc") es la cilindrada.
 *   - Letras pegadas a su cilindrada o año ("gr250", "dt250", "sbr2025") se
 *     parten: moto + cilindrada/año. "gy6" (un dígito) queda entera.
 *   - Alias ("express" -> "xpress") y distancia 1 contra las motos conocidas
 *     para palabras de 5+ letras ("horsen" -> "horse"), anotadas en
 *     `motoCorregida`. "beta" (4 letras) nunca se corrige a "bera".
 *   - Con marca (`MARCAS_DE_MOTO`) Y modelo, la marca va a `motoMarca`; con
 *     solo marca, la marca va a `moto`.
 *
 * Es pura: no lanza con ninguna entrada.
 */
export function motoDesdeTexto(texto: string): MotoDesdeTexto {
  const tokens = normalize(texto).replace(/(?<=[0-9]),(?=[0-9])/g, ".").match(/[a-z0-9]+(?:\.[0-9]+)*/g) ?? [];

  const motos: string[] = [];
  const cilindrada: string[] = [];
  const anio: string[] = [];
  const motoCorregida: MotoCorregida[] = [];

  const agregarMoto = (palabra: string): void => {
    const corregida = corregirMoto(palabra);
    if (corregida) {
      motos.push(corregida);
      motoCorregida.push({ original: palabra, corregido: corregida });
    } else {
      motos.push(palabra);
    }
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const siguiente: string | undefined = tokens[i + 1];

    if (token === "ano") {
      if (siguiente !== undefined && ANIO_TRAS_LA_PALABRA.test(siguiente)) {
        anio.push(siguiente);
        i++;
      }
      continue;
    }

    if (SALTAR_EN_MOTO.has(token) || token.length < 2) continue;

    const conCc = /^([0-9]{2,4})cc$/.exec(token);
    if (conCc) {
      cilindrada.push(conCc[1]);
      continue;
    }

    if (esSoloDigitos(token)) {
      if (esAnio(token)) anio.push(token);
      else if (/^[0-9]{2,4}$/.test(token) && Number(token) >= 50 && Number(token) <= 1300) cilindrada.push(token);
      else motos.push(token);
      continue;
    }

    const pegado = /^([a-z]{2,10})([0-9]{2,4})$/.exec(token);
    if (pegado && (esAnio(pegado[2]) || esCilindradaDeMoto(pegado[2]) || esCilindrada(pegado[2]))) {
      agregarMoto(pegado[1]);
      (esAnio(pegado[2]) ? anio : cilindrada).push(pegado[2]);
      continue;
    }

    agregarMoto(token);
  }

  const { moto, motoMarca } = repartirMotos(motos);
  const aGrupos = (terminos: string[]): string[][] =>
    [...new Set(terminos)].slice(0, MAX_GRUPOS).map((t) => [t]);

  return {
    moto: aGrupos(moto),
    motoMarca: aGrupos(motoMarca),
    cilindrada: aGrupos(cilindrada),
    anio: aGrupos(anio),
    motoCorregida: motoCorregida.filter((c, i) => motoCorregida.findIndex((o) => o.original === c.original) === i),
  };
}
