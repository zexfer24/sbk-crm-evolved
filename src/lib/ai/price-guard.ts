// ---------------------------------------------------------------------------
// Guarda de cifras sin fuente: detecta cuando el borrador de Seba trae un
// número de dinero que NO vino de nada de este turno, para que `agent.ts`
// lo reemplace antes de mandarlo. T3, plan "La búsqueda encuentra lo que el
// cliente pide" (25/9/2026). Dos casos reales de producción:
//
//   - 20/9/2026 14:32, con el catálogo apagado: Seba escribió "El
//     intercomunicador sale en *108$ BCV*", copiando al pie de la letra lo
//     que un ASESOR había escrito el 10/9 (244 h antes). Ese día el precio
//     de verdad era 103,71 — `precio3` es fijo en bolívares y el "$ BCV" se
//     recalcula con la tasa del día, así que un precio de hace 10 días ya
//     no es el de hoy.
//   - 13/9/2026 21:04: Seba calculó cuotas de Cashea de memoria ("inicial
//     *$36,60*, saldo *$85,40*, 6 cuotas de *$14,23*") — una cuenta que el
//     prompt (sección 2) ya prohíbe, pero que un modelo puede hacer igual.
//
// Las dos fallan de la misma forma: un número con símbolo de moneda que no
// tiene ninguna fuente en el turno. La fuente puede ser (a) lo que una
// herramienta acaba de devolver, (b) lo que el propio cliente escribió, o
// (c) una lección cargada por el equipo — pero NUNCA el historial completo,
// que es justo donde vivía el "108$ BCV" repetido.
//
// Módulo PURO a propósito, mismo patrón que `identity-guard.ts`: sin
// `import "server-only"` y sin ningún import. Lo usa `agent.ts` (servidor,
// dentro del tool loop) — cualquier import acá arrastraría ese mundo entero
// a quien lo toque primero.
// ---------------------------------------------------------------------------

/** Un número, con o sin separador de miles/decimales (formato VE o US). */
const NUMBER = String.raw`\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`;

/**
 * Tokens de moneda. Los simbólicos (`$`, `US$`) no necesitan frontera de
 * palabra — no son letras, ya se distinguen solos. Los "de palabra" (`USD`,
 * `dólar(es)`, `bolívar(es)`, `BCV`) sí la necesitan en el INICIO
 * (`\b`), para que "absorbedor" o "Bsas" no calcen con "Bs" a mitad de
 * palabra. `Bs`/`Bs.` es el caso especial: un `\b` de cierre después del
 * punto falla siempre (punto y espacio son los dos no-palabra, sin
 * transición), así que el cierre se resuelve con un lookahead negativo que
 * solo rechaza si el carácter siguiente es una letra — "Bs. 88.000" pasa,
 * "Bsas" no (la `a` de después la rechaza).
 */
const CURRENCY = String.raw`(?:US\$|\$|\b(?:USD|d[oó]lares?|bol[ií]vares?|BCV)\b|\bBs\.?(?![A-Za-zÁÉÍÓÚáéíóúÑñ]))`;

/**
 * Espacio opcional entre la cifra y la moneda, tolerando además los
 * marcadores de formato de WhatsApp (`*negrita*`, `_cursiva_`) que a veces
 * quedan pegados justo en el borde ("$_102,84_").
 */
const CONNECTOR = String.raw`[\s*_]*`;

/** Un número, con moneda antes o después. Grupo 1 = moneda antes, grupo 2 = moneda después. */
const MONEY_FIGURE_SOURCE = `${CURRENCY}${CONNECTOR}(${NUMBER})|(${NUMBER})${CONNECTOR}${CURRENCY}`;

/**
 * Todas las cifras de dinero de `text`, en el orden en que aparecen, como
 * texto crudo (sin el símbolo de moneda) — "108$ BCV" da "108"; "Bs.
 * 88.000,00" da "88.000,00". Un número suelto sin moneda pegada ("quedan 5
 * unidades", "6 cuotas") no cuenta, ni tampoco un porcentaje ("30%": el "%"
 * no es un token de moneda).
 *
 * Regex nueva por llamada (no una de módulo con `g` reusada): la trampa de
 * CLAUDE.md sobre `lastIndex` que arrastra estado entre llamadas
 * (`catalog-links.ts`, 18/9/2026) aplica igual acá.
 */
export function moneyFigures(text: string): string[] {
  const re = new RegExp(MONEY_FIGURE_SOURCE, "gi");
  const figuras: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const cruda = match[1] ?? match[2];
    if (cruda) figuras.push(cruda);
  }
  return figuras;
}

/** Todos los números de `text`, con o sin moneda — lo que usan las FUENTES (nunca exigen moneda pegada). */
function extractNumbers(text: string): string[] {
  const re = new RegExp(NUMBER, "g");
  const numeros: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    numeros.push(match[0]);
  }
  return numeros;
}

/**
 * Todas las lecturas plausibles de un número escrito a mano, sin saber de
 * antemano si el separador es venezolano (coma decimal, punto de miles) o
 * estadounidense (al revés):
 *
 *   - Los dos separadores presentes ("1.234,56" o "1,234.56"): el ÚLTIMO que
 *     aparece en el texto es el decimal, sin ambigüedad — una lectura.
 *   - Un solo tipo de separador, repetido ("1.234.567"): son miles sin
 *     ambigüedad — una lectura.
 *   - Un solo separador, una sola vez, con 1 o 2 dígitos después ("36,60",
 *     "12.50"): es un decimal sin ambigüedad — una lectura.
 *   - Un solo separador, una sola vez, con EXACTAMENTE 3 dígitos después
 *     ("88.000"): ambiguo de verdad — puede ser "miles sin decimales"
 *     (88000) o un decimal literal de tres cifras (88) — dos lecturas.
 *   - Sin separador ("108"): el número tal cual.
 */
export function numericReadings(raw: string): number[] {
  const cleaned = raw.trim();
  const separators = cleaned.match(/[.,]/g) ?? [];

  if (separators.length === 0) {
    const n = Number(cleaned);
    return Number.isFinite(n) ? [n] : [];
  }

  if (new Set(separators).size === 2) {
    const lastSepIndex = Math.max(cleaned.lastIndexOf("."), cleaned.lastIndexOf(","));
    const decimalSep = cleaned[lastSepIndex];
    const thousandsSep = decimalSep === "." ? "," : ".";
    const normalizado = cleaned.split(thousandsSep).join("").replace(decimalSep, ".");
    const n = Number(normalizado);
    return Number.isFinite(n) ? [n] : [];
  }

  // `separators.length >= 1` acá seguro (el `length === 0` de arriba ya
  // devolvió) — noUncheckedIndexedAccess no lo sabe, de ahí el `!`.
  const sep = separators[0]!;
  const parts = cleaned.split(sep);

  if (parts.length > 2) {
    const n = Number(parts.join(""));
    return Number.isFinite(n) ? [n] : [];
  }

  const decimales = parts[1]?.length ?? 0;
  if (decimales === 3) {
    const lecturas = new Set<number>();
    const comoMiles = Number(parts.join(""));
    const comoDecimal = Number(parts.join("."));
    if (Number.isFinite(comoMiles)) lecturas.add(comoMiles);
    if (Number.isFinite(comoDecimal)) lecturas.add(comoDecimal);
    return [...lecturas];
  }

  const n = Number(parts.join("."));
  return Number.isFinite(n) ? [n] : [];
}

/** Tolerancia para comparar dos lecturas (redondeos de centavos, nunca exactos al centésimo). */
const TOLERANCIA = 0.005;

/**
 * Todas las lecturas numéricas de CUALQUIER número presente en `texts` —a
 * diferencia de `moneyFigures`, una fuente no necesita moneda pegada: "44"
 * en "tienen los de 44$?" habilita "$44" en la respuesta igual que "44
 * dólares" lo haría.
 */
export function sourceNumbers(texts: string[]): Set<number> {
  const lecturas = new Set<number>();
  for (const text of texts) {
    for (const numero of extractNumbers(text)) {
      for (const lectura of numericReadings(numero)) lecturas.add(lectura);
    }
  }
  return lecturas;
}

/**
 * La primera cifra de dinero de `text` que no calza con NINGUNA lectura de
 * NINGUNA fuente, o `null` si todas tienen de dónde venir (o si `text` no
 * trae ninguna cifra de dinero). `sources` son SOLO las tres fuentes que
 * `agent.ts` arma para este turno (salida de herramientas, ráfaga del
 * cliente, lecciones) — nunca el historial completo.
 */
export function findUnsourcedFigure(text: string, sources: string[]): string | null {
  const cifras = moneyFigures(text);
  if (cifras.length === 0) return null;

  const fuentes = sourceNumbers(sources);
  for (const cifra of cifras) {
    const lecturas = numericReadings(cifra);
    const tieneFuente = lecturas.some((lectura) =>
      [...fuentes].some((fuente) => Math.abs(fuente - lectura) <= TOLERANCIA)
    );
    if (!tieneFuente) return cifra;
  }
  return null;
}
