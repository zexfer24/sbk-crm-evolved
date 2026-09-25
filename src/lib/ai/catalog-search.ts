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
 */
const RELLENO = new Set(["para", "con", "del", "los", "las", "que", "una", "precio", "tienen", "hay"]);

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
