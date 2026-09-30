// ---------------------------------------------------------------------------
// Casos de la Entrega A2 — "Seba no cotiza lo que no es" (30/9/2026, T1).
//
// Cada caso es UNA llamada a `buscarRepuesto` tal como la haría el modelo (más,
// a veces, el turno previo de una conversación de dos turnos) y lo que tiene
// que salir según las DECISIONES DEL PLAN (`docs/planes/2026-09-30-seba-no-
// cotiza-lo-que-no-es.md`: D1 con la precisión del operador, D1b, D2, D3, D4,
// D5, "ver todo"), NO según lo que la Entrega A "antes cotizaba". Donde una
// decisión cambia a propósito lo que el prompt del VPS esperaba, el caso lleva
// `cambioDeliberado`; donde el plan y el documento del VPS no alcanzan para
// decidir, lleva `duda` (que el orquestador revisa antes de que T5 lo fije).
//
// Los consumen T5 (`tools.test.ts`, con el fake de `buscar_productos` en la
// semántica nueva) y T7 (el arnés contra la base con `catalogo-a2.ts` cargado).
//
// Adaptado a D6 el 30/9/2026 (T5): se cotiza UNA opción en todos los casos —la
// mejor y, a igual relevancia, la de más existencia— y no existe «Hay N más».
// La única excepción es el pedido EXPLÍCITO de ver opciones (sección
// `ver-todo`, casos `ver-opciones-*`): hasta tres con existencia.
//
// Cómo se compara un resultado con un `EsperadoItemA2` (contrato para T5/T7):
//   - `estado`: igual. (Opcional solo en la sección `corrector`, donde lo que
//     se fija es `correccion`.)
//   - `debeCotizar`: lo cotizado (sin contar la alternativa de D2) es
//     EXACTAMENTE esa lista, en ese orden. Con la lista vacía y `estado =
//     "con_existencia"`, se cotiza UNA fila cualquiera que no esté en
//     `nuncaCotizar` (los casos cuyo mejor candidato es una fila de `ruido`).
//   - `nuncaCotizar`: ninguno de esos nombres está entre lo cotizado NI entre lo
//     que se ofrece como «otra opción» (un agotado que se MENCIONA como agotado
//     no cuenta como cotizado).
//   - `agotadosMencionados`: con `estado = "agotados"` sin alternativa, se nombra
//     UN solo agotado y es uno de esta lista (el desempate entre agotados no es
//     una decisión que valga fijar).
//   - `otrasOpciones`: la UNA alternativa con existencia de D2 (es lo único que
//     se cotiza cuando la variante pedida está agotada).
//   - `variantesAgotadas`: el texto de la variante que D2 dice agotada.
//   - `avisos`: inclusión (los que DEBEN aparecer; los demás no se prohíben).
//   - `relajados`: los términos que D3 relajó, en términos normalizados.
//   - `correccion`: las palabras que el corrector cambió (términos ya
//     normalizados: sin acentos, singular), o `null` si NO debe corregir nada.
//     `correccionDescartada`: las que corrigió pero la guarda de producto
//     descartó.
//   - `motivoEscalada`, a nivel de turno: `null` = el turno no escala (pregunta).
// ---------------------------------------------------------------------------

export type SeccionA2 =
  | "2.1"
  | "2.2"
  | "2.3"
  | "2.4"
  | "2.5"
  | "2.6"
  | "2.7"
  | "no-regresion"
  | "corrector"
  | "produccion"
  | "ver-todo";

/** Las secciones del documento de casos, y las que el plan agrega. Todas deben tener al menos un caso. */
export const SECCIONES_A2: readonly SeccionA2[] = [
  "2.1",
  "2.2",
  "2.3",
  "2.4",
  "2.5",
  "2.6",
  "2.7",
  "no-regresion",
  "corrector",
  "produccion",
  "ver-todo",
];

export type EstadoConsultaA2 = "con_existencia" | "agotados" | "generico" | "sin_resultados";

export type AvisoA2 =
  | "universales"
  | "moto_sin_calce"
  | "relajado"
  | "relajado_agotado"
  | "variante_agotada"
  | "varias_opciones";

export type MotivoEscaladaA2 = "confirmar_inventario" | "sin_stock" | "no_identificado";

/** La llamada a `buscarRepuesto`, con los argumentos que el modelo le pasaría. */
export interface LlamadaA2 {
  query: string;
  productos?: string[];
  motoBrand?: string;
  motoModel?: string;
  dependeDeLaMoto?: boolean;
}

export interface CorreccionA2 {
  original: string;
  corregido: string;
}

/** Lo que `catalog-memory.ts` (Redis) debe tener guardado DESPUÉS de un turno (T5 le suma `anio` y `preguntaTipo`). */
export interface MemoriaA2 {
  ultimoQuery: string | null;
  /** Nombres de moto (los de `MOTOS_CONOCIDAS`), sin la cilindrada ni el año. */
  moto: string[];
  anio: string | null;
  preguntaHechaPara: string | null;
  preguntaTipo: "moto" | "producto" | null;
}

/** Lo esperado para UN producto de una lista, o para la consulta simple (`producto: null`). */
export interface EsperadoItemA2 {
  producto: string | null;
  estado?: EstadoConsultaA2;
  debeCotizar: string[];
  nuncaCotizar: string[];
  agotadosMencionados?: string[];
  otrasOpciones?: string[];
  /** D2: la variante pedida que se dice agotada ("azul", "39"). */
  variantesAgotadas?: string[];
  avisos: AvisoA2[];
  relajados?: string[];
  /** Solo con `estado = "generico"` en una consulta simple: cuál pregunta de filtro. */
  preguntaFiltro?: "moto" | "producto";
  correccion: CorreccionA2[] | null;
  correccionDescartada?: CorreccionA2[];
}

export interface EsperadoA2 {
  items: EsperadoItemA2[];
  motivoEscalada: MotivoEscaladaA2 | null;
  /** Los renglones que la nota de la escalada debe traer (producción 29/9: los cinco pedidos). */
  notaIncluye?: string[];
}

export interface TurnoPrevioA2 {
  llamada: LlamadaA2;
  rafagaCliente?: string[];
  esperado: EsperadoA2;
  memoria: MemoriaA2;
}

export interface CasoA2 {
  id: string;
  seccion: SeccionA2;
  descripcion: string;
  llamada: LlamadaA2;
  /** Las líneas del cliente que este turno atiende (la respuesta suelta, la frase de «ver todo»…). */
  rafagaCliente?: string[];
  turnoPrevio?: TurnoPrevioA2;
  esperado: EsperadoA2;
  /** El caso depende de los 14 sinónimos que siembra la migración M4 (`ai_lessons`). */
  requiereSinonimos?: boolean;
  /** Esta decisión del plan cambia a propósito lo que el prompt del VPS esperaba. */
  cambioDeliberado?: string;
  /** Lo que el plan y el documento del VPS no dejan decidir: el orquestador lo revisa. */
  duda?: string;
}

// ---------------------------------------------------------------------------
// Constructores (solo azúcar: los casos quedan legibles)
// ---------------------------------------------------------------------------

function item(parcial: Partial<EsperadoItemA2>): EsperadoItemA2 {
  return { producto: null, debeCotizar: [], nuncaCotizar: [], avisos: [], correccion: null, ...parcial };
}

function una(parcial: Partial<EsperadoItemA2>, motivoEscalada: MotivoEscaladaA2 | null = null): EsperadoA2 {
  return { items: [item(parcial)], motivoEscalada };
}

/** El primer turno típico: la pregunta de filtro por la moto (o por el producto). */
function turnoPregunta(
  llamada: LlamadaA2,
  clave: string,
  tipo: "moto" | "producto",
  ultimoQuery: string = llamada.query,
  extra: Partial<EsperadoItemA2> = {}
): TurnoPrevioA2 {
  return {
    llamada,
    esperado: una({ estado: "generico", preguntaFiltro: tipo, ...extra }),
    memoria: { ultimoQuery, moto: [], anio: null, preguntaHechaPara: clave, preguntaTipo: tipo },
  };
}

// Nombres que se repiten en varios casos.
//
// D6 (decisión del operador, 29/9/2026, noche): se cotiza UNA opción en todos
// los casos —la mejor y, a igual relevancia, la de más existencia— y nunca hay
// «Hay N más». Donde este archivo decía «las tres de mayor existencia», ahora
// dice la UNA de mayor existencia (T5, 30/9/2026). La única excepción es el
// pedido EXPLÍCITO de ver opciones (`ver-opciones-*`): hasta tres.
const ASIENTO_SBR_DE_MAS_EXISTENCIA = ["ASIENTO SBR NEGRO ALDRICH"];
const GUARDAFANGO_HORSE_DE_MAS_EXISTENCIA = ["GUARDAFANGO DELANTERO HORSE NEGRO"];
const INTERCOMUNICADOR_DE_MAS_EXISTENCIA = ["INTERCOMUNICADOR EJEAS V7 PRO"];
/** Las tres de mayor existencia, en ese orden: lo que sale con un pedido explícito de ver opciones (D6). */
const TRES_INTERCOMUNICADORES = [
  "INTERCOMUNICADOR EJEAS V7 PRO",
  "INTERCOMUNICADOR EJEAS V6 PRO",
  "INTERCOMUNICADOR FREEDCONN TCOM",
];
const INTERCOMUNICADORES_PARA_CASCO = [
  "INTERCOMUNICADOR PARA CASCO BLUETOOTH 1000M",
  "INTERCOMUNICADOR PARA CASCO BLUETOOTH 800M",
  "INTERCOMUNICADOR PARA CASCO IMPERMEABLE V6",
];
const TRES_DEFENSAS_DE_OTRAS_MOTOS = ["DEFENSA BRZ 250", "DEFENSA KAVAK", "DEFENSA KLR 650"];
const CAUCHOS_120_70 = ["CAUCHO 12 120/70 TIMSUN", "CAUCHO 13 120/70 BENF", "CAUCHO 12 120/70 JEREZ"];
const AMORTIGUADORES_DE_OTRAS_MOTOS = [
  "AMORTIGUADOR BERA SOCIALISTA",
  "AMORTIGUADOR TRASERO BWS150",
  "AMORTIGUADOR TRASERO BERA SBR ALDRICH",
];
const BATERIAS_DE_OTRAS_MOTOS = ["BATERIA VSTROM 650", "BATERIA DR650", "BATERIA GY6 150"];

// ---------------------------------------------------------------------------
// 2.1 — Cotiza productos de otra moto (D1)
// ---------------------------------------------------------------------------

const CASOS_2_1: CasoA2[] = [
  {
    id: "2.1-01-defensa-parrilla-dt250",
    seccion: "2.1",
    descripcion:
      'Lista "defensa, parrilla" para DT250: la defensa que nombra DT sí se cotiza; la parrilla no tiene ninguna que nombre DT, así que no se elige por orden alfabético (BRZ, KAVAK, KLR) y el asesor confirma cuál le sirve.',
    llamada: { query: "", productos: ["defensa", "parrilla"], motoModel: "DT250", dependeDeLaMoto: true },
    esperado: {
      items: [
        item({
          producto: "defensa",
          estado: "con_existencia",
          debeCotizar: ["DEFENSA DELANTERA SUPER DT LEFOR"],
          nuncaCotizar: TRES_DEFENSAS_DE_OTRAS_MOTOS,
        }),
        item({
          producto: "parrilla",
          estado: "generico",
          avisos: ["moto_sin_calce"],
          nuncaCotizar: ["PARRILLA TRASERA BRZ 250", "PARRILLA KLR 650", "PARRILLA VSTROM 650"],
        }),
      ],
      motivoEscalada: "confirmar_inventario",
    },
  },
  {
    id: "2.1-02-amortiguadores-md-aguila",
    seccion: "2.1",
    descripcion:
      '"amortiguadores" y, después de la pregunta, "MD Aguila 2014": ningún amortiguador nombra MD ni Aguila. Ya se preguntó y el dato no distingue: se escala SIN cotizar (antes cotizaba los de BERA SBR, BERA SOCIALISTA y BWS150).',
    llamada: { query: "MD Aguila 2014" },
    rafagaCliente: ["MD Aguila 2014"],
    turnoPrevio: turnoPregunta({ query: "amortiguadores", dependeDeLaMoto: true }, "amortiguador", "moto"),
    esperado: una(
      { estado: "generico", avisos: ["moto_sin_calce"], nuncaCotizar: AMORTIGUADORES_DE_OTRAS_MOTOS },
      "confirmar_inventario"
    ),
  },
  {
    id: "2.1-03-bateria-arranque-socialista",
    seccion: "2.1",
    descripcion:
      'Lista "batería, arranque" para Bera Socialista: el arranque que nombra SOCIALISTA se cotiza; ninguna batería lo nombra, pero la BATERIA SECA JAGUAR/BERA (116 u.) nombra solo MARCAS y el cliente es marca bera: es compatible y se cotiza con la línea «este es de BERA o universal». VSTROM, DR650 y GY6 son de otras motos y no se cotizan.',
    llamada: {
      query: "",
      productos: ["bateria", "arranque"],
      motoBrand: "Bera",
      motoModel: "Socialista",
      dependeDeLaMoto: true,
    },
    esperado: {
      items: [
        item({
          producto: "bateria",
          estado: "con_existencia",
          debeCotizar: ["BATERIA SECA JAGUAR/BERA 12N6.5"],
          avisos: ["universales"],
          nuncaCotizar: BATERIAS_DE_OTRAS_MOTOS,
        }),
        item({
          producto: "arranque",
          estado: "con_existencia",
          debeCotizar: ["MOTOR DE ARRANQUE BERA SOCIALISTA"],
          nuncaCotizar: ["MOTOR DE ARRANQUE BERA SBR", "MOTOR DE ARRANQUE HORSE", "MOTOR DE ARRANQUE KAVAK"],
        }),
      ],
      motivoEscalada: "confirmar_inventario",
    },
  },
  {
    id: "2.1-04-tacometro-digital-brz",
    seccion: "2.1",
    descripcion:
      'Lista "tacómetro digital, posapiés" para BRZ: ningún tacómetro digital nombra BRZ, pero hay uno digital universal (5 u.): se cotiza con la línea de universales, nunca los de GR250, KAVAK, OWEN ni BERA SBR. Los posapiés no tienen universal y quedan para el asesor.',
    llamada: {
      query: "",
      productos: ["tacometro digital", "posapies"],
      motoModel: "BRZ",
      dependeDeLaMoto: true,
    },
    esperado: {
      items: [
        item({
          producto: "tacometro digital",
          estado: "con_existencia",
          debeCotizar: ["TACOMETRO DIGITAL UNIVERSAL"],
          avisos: ["universales"],
          nuncaCotizar: [
            "TACOMETRO DIGITAL GR250",
            "TACOMETRO DIGITAL KAVAK",
            "TACOMETRO DIGITAL OWEN",
            "TACOMETRO DIGITAL BERA SBR",
            "TACOMETRO ANALOGO UNIVERSAL",
          ],
        }),
        item({
          producto: "posapies",
          estado: "generico",
          avisos: ["moto_sin_calce"],
          nuncaCotizar: ["POSAPIES DELANTERO BERA SBR", "POSAPIES TRASERO HORSE", "POSAPIES KAVAK"],
        }),
      ],
      motivoEscalada: "confirmar_inventario",
    },
  },
  {
    id: "2.1-05-parrilla-defensa-tigrito",
    seccion: "2.1",
    descripcion:
      'Lista "parrilla, defensa" para Tigrito: ninguna nombra Tigrito ni hay universales. No se cotiza nada de otras motos: las dos quedan para el asesor.',
    llamada: { query: "", productos: ["parrilla", "defensa"], motoModel: "Tigrito", dependeDeLaMoto: true },
    esperado: {
      items: [
        item({
          producto: "parrilla",
          estado: "generico",
          avisos: ["moto_sin_calce"],
          nuncaCotizar: ["PARRILLA TRASERA BRZ 250", "PARRILLA KLR 650", "PARRILLA VSTROM 650"],
        }),
        item({
          producto: "defensa",
          estado: "generico",
          avisos: ["moto_sin_calce"],
          nuncaCotizar: TRES_DEFENSAS_DE_OTRAS_MOTOS,
        }),
      ],
      motivoEscalada: "confirmar_inventario",
    },
  },
  {
    id: "2.1-06-defensas-beta-leon",
    seccion: "2.1",
    descripcion:
      '"defensas" y, después de la pregunta, "Beta León": ninguna defensa nombra Beta ni León. Se escala sin cotizar (antes cotizaba las tres primeras del alfabeto).',
    llamada: { query: "Beta León" },
    rafagaCliente: ["Beta León"],
    turnoPrevio: turnoPregunta({ query: "defensas", dependeDeLaMoto: true }, "defensa", "moto"),
    esperado: una(
      { estado: "generico", avisos: ["moto_sin_calce"], nuncaCotizar: TRES_DEFENSAS_DE_OTRAS_MOTOS },
      "confirmar_inventario"
    ),
  },
  {
    id: "2.1-07-rin-trasero-new-runner",
    seccion: "2.1",
    descripcion:
      '"rin trasero" y, después de la pregunta, "Bera New Runner": ningún rin nombra Runner. Se escala sin cotizar; los rines de otras motos (SBR, Horse, EK XPRESS) no se cotizan aunque el cliente dijera Bera.',
    llamada: { query: "Bera New Runner" },
    rafagaCliente: ["Bera New Runner"],
    turnoPrevio: turnoPregunta({ query: "rin trasero", dependeDeLaMoto: true }, "rin", "moto"),
    esperado: una(
      {
        estado: "generico",
        avisos: ["moto_sin_calce"],
        nuncaCotizar: ["RIN TRASERO BERA SBR", "RIN TRASERO PALETA HORSE", "RIN TRASERO EK XPRESS PALETA"],
      },
      "confirmar_inventario"
    ),
    duda: "Mismo criterio que 2.1-03: RIN TRASERO BERA SBR nombra la marca del cliente (Bera) pero no su modelo (Runner); se lo trató como otra moto.",
  },
  {
    id: "2.1-08-defensa-toro-rex",
    seccion: "2.1",
    descripcion:
      '"defensa" y, después de la pregunta, "Toro Rex": ninguna defensa nombra Rex. Se escala sin cotizar.',
    llamada: { query: "Toro Rex" },
    rafagaCliente: ["Toro Rex"],
    turnoPrevio: turnoPregunta({ query: "defensa", dependeDeLaMoto: true }, "defensa", "moto"),
    esperado: una(
      { estado: "generico", avisos: ["moto_sin_calce"], nuncaCotizar: TRES_DEFENSAS_DE_OTRAS_MOTOS },
      "confirmar_inventario"
    ),
  },
  {
    id: "2.1-09-posapies-caucho-runner-6g",
    seccion: "2.1",
    descripcion:
      'Lista "posapiés, caucho" para Runner 6G: los posapiés son de otras motos (no se cotizan); "caucho" es genérico dentro de una lista (D1b): ninguno se elige, "hay varias opciones". Nunca los cauchos rin 10 de scooter.',
    llamada: { query: "", productos: ["posapies", "caucho"], motoModel: "Runner 6G" },
    esperado: {
      items: [
        item({
          producto: "posapies",
          estado: "generico",
          avisos: ["moto_sin_calce"],
          nuncaCotizar: ["POSAPIES DELANTERO BERA SBR", "POSAPIES TRASERO HORSE", "POSAPIES KAVAK"],
        }),
        item({
          producto: "caucho",
          estado: "generico",
          avisos: ["varias_opciones"],
          nuncaCotizar: ["CAUCHO TRASERO 10 3.50 SCOOTER TIMSUN", "CAUCHO DELANTERO 10 3.00 SCOOTER TIMSUN"],
        }),
      ],
      motivoEscalada: "confirmar_inventario",
    },
  },
  {
    id: "2.1-10-tapas-laterales-milan",
    seccion: "2.1",
    descripcion:
      '"tapas laterales blanca" para una Bera Milan: la marca sola no hace calzar la moto. Calza MILAN (motoMarca bera solo ordena): se cotiza UNA TAPA LATERAL MILAN, la de más existencia (negro; ninguna es blanca, así que la variante no restringe) y nunca las 16 de la SBR (D6).',
    llamada: { query: "tapas laterales blanca", motoBrand: "Bera", motoModel: "Milan", dependeDeLaMoto: true },
    esperado: una(
      {
        estado: "con_existencia",
        debeCotizar: ["TAPA LATERAL MILAN NEGRO"],
        nuncaCotizar: [
          "TAPA LATERAL BERA SBR BLANCA DERECHA",
          "TAPA LATERAL BERA SBR BLANCA IZQUIERDA",
          "TAPA LATERAL BERA SBR NEGRA DERECHA",
        ],
      },
      "confirmar_inventario"
    ),
  },
  {
    id: "2.1-11-tubo-de-escape-ek-horsen",
    seccion: "2.1",
    descripcion:
      '"tubo de escape" para EK "horsen": horsen es un tipeo de la moto (horse) y ek solo ordena. Calza HORSE: se cotiza TUBO ESCAPE HORSE 1 TORNASOL (8 u.) y nunca los EK EXPRESS ni EK OWEN.',
    llamada: { query: "tubo de escape", motoBrand: "EK", motoModel: "horsen", dependeDeLaMoto: true },
    esperado: una(
      {
        estado: "con_existencia",
        debeCotizar: ["TUBO ESCAPE HORSE 1 TORNASOL"],
        nuncaCotizar: ["TUBO ESCAPE EK EXPRESS", "TUBO ESCAPE EK OWEN"],
        correccion: [{ original: "horsen", corregido: "horse" }],
      },
      "confirmar_inventario"
    ),
  },
];

// ---------------------------------------------------------------------------
// 2.2 — La moto calza por pedazo de palabra
// ---------------------------------------------------------------------------

const CASOS_2_2: CasoA2[] = [
  {
    id: "2.2-01-maletas-gr250",
    seccion: "2.2",
    descripcion:
      '"maletas" para GR 250: la moto gr no puede calzar con GRIS. Ninguna maleta nombra una moto, así que la moto no decide nada y rige la pregunta de filtro por producto; nunca la MALETA REDONDA 34 LTS TOMCAT GRIS sola.',
    llamada: { query: "maletas", motoBrand: "GR", motoModel: "250", dependeDeLaMoto: false },
    esperado: una({
      estado: "generico",
      preguntaFiltro: "producto",
      nuncaCotizar: ["MALETA REDONDA 34 LTS TOMCAT GRIS"],
    }),
  },
];

// ---------------------------------------------------------------------------
// 2.3 — Medidas, números y años
// ---------------------------------------------------------------------------

/** Los siete formatos de la misma medida que tienen que leerse igual (documento del VPS, 2.3). */
const FORMATOS_130_70_12 = ["130/70-12", "130/70/12", "130 70 12", "130-70-12", "130 - 70 - 12"];
const FORMATOS_130_60_R13 = ["130/60/R13", "130/60 R13"];
const NOTACIONES_DE_RIN = ["n° 18", "nº18", "#18", "numero 18", "no 18", "nro 18", "rin 18"];

const CASOS_2_3: CasoA2[] = [
  ...FORMATOS_130_70_12.map(
    (formato, i): CasoA2 => ({
      id: `2.3-medida-130-70-12-${i + 1}`,
      seccion: "2.3",
      descripcion: `"caucho ${formato}": los tres números son obligatorios y ninguno es cilindrada. Los 130/70-12 existen y están en 0: sale agotado, nunca los 120/70 con stock.`,
      llamada: { query: `caucho ${formato}` },
      esperado: una(
        {
          estado: "agotados",
          agotadosMencionados: ["CAUCHO 12 130/70 TIMSUN", "CAUCHO 12 130/70 BENF"],
          nuncaCotizar: CAUCHOS_120_70,
        },
        "sin_stock"
      ),
    })
  ),
  ...FORMATOS_130_60_R13.map(
    (formato, i): CasoA2 => ({
      id: `2.3-medida-130-60-r13-${i + 1}`,
      seccion: "2.3",
      descripcion: `"caucho ${formato}": R13 es el rin 13. Hay CAUCHO 13 130/60 BENF (7 u.) y JEREZ FIRE (3 u.): se cotiza UNA, la de más existencia (D6).`,
      llamada: { query: `caucho ${formato}` },
      esperado: una(
        {
          estado: "con_existencia",
          debeCotizar: ["CAUCHO 13 130/60 BENF"],
          nuncaCotizar: CAUCHOS_120_70,
        },
        "confirmar_inventario"
      ),
    })
  ),
  {
    id: "2.3-medida-130-80-17-tripa",
    seccion: "2.3",
    descripcion:
      '"tripa trasera rin 130-80-17": «rin» detrás de un sustantivo (tripa) no es producto; queda la medida 130/80/17. Hay TRIPA 17 130/80/17 CARKMOTOS (21 u.).',
    llamada: { query: "tripa trasera rin 130-80-17" },
    esperado: una(
      { estado: "con_existencia", debeCotizar: ["TRIPA 17 130/80/17 CARKMOTOS"] },
      "confirmar_inventario"
    ),
  },
  {
    id: "2.3-medida-90-90-19",
    seccion: "2.3",
    descripcion: '"caucho 90 90 19": tres números obligatorios. Hay CAUCHO 19 90/90 TS712 TIMSUN (4 u.).',
    llamada: { query: "caucho 90 90 19" },
    esperado: una(
      { estado: "con_existencia", debeCotizar: ["CAUCHO 19 90/90 TS712 TIMSUN"] },
      "confirmar_inventario"
    ),
  },
  ...NOTACIONES_DE_RIN.map(
    (notacion, i): CasoA2 => ({
      id: `2.3-rin-${i + 1}`,
      seccion: "2.3",
      descripcion: `"caucho ${notacion}": el rin es solo el número 18 (nunca "n18" ni "no" obligatorios). Hay más de tres cauchos rin 18 con stock y ninguno nombra moto: genérico, se pregunta por producto.`,
      llamada: { query: `caucho ${notacion}` },
      esperado: una({
        estado: "generico",
        preguntaFiltro: "producto",
        nuncaCotizar: ["CAUCHO TRASERO 10 3.50 SCOOTER TIMSUN"],
      }),
    })
  ),
  {
    id: "2.3-tripa-n18",
    seccion: "2.3",
    descripcion:
      '"tripa de moto n° 18": antes quedaba "n18" y daba no identificado. Con el rin 18 leído bien hay más de tres tripas 18 con stock (TRIPA 18 3.00 MOTOR POWER, 540 u., entre ellas): genérico.',
    llamada: { query: "tripa de moto n° 18" },
    esperado: una({ estado: "generico", preguntaFiltro: "producto" }),
  },
  {
    id: "2.3-corona-45",
    seccion: "2.3",
    descripcion:
      '"corona de 45": 45 calza con CORONA 45T (un número seguido de letras). Hay 5 con stock y todas nombran una moto: genérico, se pregunta por la moto.',
    llamada: { query: "corona de 45", dependeDeLaMoto: true },
    esperado: una({ estado: "generico", preguntaFiltro: "moto" }),
  },
  {
    id: "2.3-pinon-14",
    seccion: "2.3",
    descripcion: '"piñón 14": 14 calza con PIÑON 14T. Hay cinco con stock y todos nombran una moto: genérico.',
    llamada: { query: "piñón 14", dependeDeLaMoto: true },
    esperado: una({ estado: "generico", preguntaFiltro: "moto" }),
  },
  {
    id: "2.3-viscosidad-20-50",
    seccion: "2.3",
    descripcion: '"motul 5100 20:50": "20:50" se lee como 20w50, igual que "20/50", "20-50" y "20 50".',
    llamada: { query: "motul 5100 20:50" },
    esperado: una(
      {
        estado: "con_existencia",
        debeCotizar: ["ACEITE MOTUL 5100 20W50 4T"],
        nuncaCotizar: ["ACEITE MOTUL 5100 15W50 4T", "ACEITE MOTUL 5000 20W50 4T"],
      },
      "confirmar_inventario"
    ),
  },
  // --- Años: un año es de la moto, nunca un término obligatorio del producto ---
  {
    id: "2.3-anio-amortiguador-sbr-2023",
    seccion: "2.3",
    descripcion:
      '"amortiguador" y, después de la pregunta, "un sbr 2023": el año no es obligatorio (antes exigía 2023 y no encontraba nada). Calza SBR con cinco amortiguadores con stock: UNA, la de mayor existencia (D6; antes tres y «Hay 2 opciones más»).',
    llamada: { query: "un sbr 2023" },
    rafagaCliente: ["un sbr 2023"],
    turnoPrevio: turnoPregunta({ query: "amortiguador", dependeDeLaMoto: true }, "amortiguador", "moto"),
    esperado: una(
      {
        estado: "con_existencia",
        debeCotizar: ["AMORTIGUADOR TRASERO BERA SBR ALDRICH"],
        nuncaCotizar: ["AMORTIGUADOR BERA SOCIALISTA"],
      },
      "confirmar_inventario"
    ),
  },
  {
    id: "2.3-anio-tanque-rkv-rojo-2014",
    seccion: "2.3",
    descripcion:
      '"tanque rkv" y después "rojo 2014": 2014 es el año de la moto, no un término: no puede calzar con TANQUE OWEN 2014 AZUL. Los RKV rojos están en 0 (variante agotada) y no hay otro RKV con existencia.',
    llamada: { query: "rojo 2014" },
    rafagaCliente: ["rojo 2014"],
    turnoPrevio: {
      llamada: { query: "tanque rkv", dependeDeLaMoto: true },
      esperado: una(
        { estado: "agotados", agotadosMencionados: ["TANQUE RKV 200 NEGRO", "TANQUE RKV 200 ROJO", "TANQUE RKV 200 AZUL"] },
        "sin_stock"
      ),
      memoria: { ultimoQuery: "tanque rkv", moto: ["rkv"], anio: null, preguntaHechaPara: null, preguntaTipo: null },
    },
    esperado: una(
      {
        estado: "agotados",
        agotadosMencionados: ["TANQUE RKV 200 ROJO"],
        avisos: ["variante_agotada"],
        nuncaCotizar: ["TANQUE OWEN 2014 AZUL"],
      },
      "sin_stock"
    ),
    duda: "El turno previo de 'tanque rkv' no puede citar EXACTAMENTE cuáles 3 de los 4 RKV agotados se listan (hasta 3, el desempate final es por nombre): el arnés debe comparar solo el estado.",
  },
  {
    id: "2.3-anio-bateria-bera-dt-2014",
    seccion: "2.3",
    descripcion:
      '"batería" y después "Bera Dt 2014": "dt 2014" no se une en dt2014; dt es la moto, 2014 el año. Ninguna batería nombra DT: nunca se cotizan las de VSTROM, DR650 ni GY6, pero la BATERIA SECA JAGUAR/BERA nombra solo MARCAS y el cliente es marca bera: es la única compatible y se cotiza con la línea «este es de BERA o universal» (resolución 1 del orquestador: antes de M1 se escalaba sin cotizar).',
    llamada: { query: "Bera Dt 2014" },
    rafagaCliente: ["Bera Dt 2014"],
    turnoPrevio: turnoPregunta({ query: "bateria", dependeDeLaMoto: true }, "bateria", "moto"),
    esperado: una(
      {
        estado: "con_existencia",
        debeCotizar: ["BATERIA SECA JAGUAR/BERA 12N6.5"],
        avisos: ["universales"],
        nuncaCotizar: BATERIAS_DE_OTRAS_MOTOS,
      },
      "confirmar_inventario"
    ),
    cambioDeliberado:
      "Antes se escalaba sin cotizar (ninguna batería nombra DT). Con el refinamiento de M1 (marca sin modelo) la JAGUAR/BERA, que nombra solo marcas, es compatible con un cliente de marca bera: se cotiza con la línea de universales de su marca. Consecuencia de la resolución 1 del orquestador sobre 2.1-03.",
  },
  ...[
    {
      id: "gr-2025",
      respuesta: "GR 2025",
      debe: ["PASTILLA FRENO DELANTERO GR250"],
    },
    {
      id: "empire-gs-2026",
      respuesta: "Empire GS 2026",
      debe: ["PASTILLA FRENO DELANTERO EMPIRE GS 150"],
    },
    {
      id: "bera-kavak-2025",
      respuesta: "bera kavak 2025",
      debe: ["PASTILLA FRENO DELANTERO KAVAK MOTOR 150"],
    },
  ].map(
    ({ id, respuesta, debe }): CasoA2 => ({
      id: `2.3-anio-${id}`,
      seccion: "2.3",
      descripcion: `"pastillas de freno" y después "${respuesta}": el año no puede ser obligatorio (antes daba sin resultados). Calza la moto y se cotiza UNA de las que la nombran, la de más existencia (D6).`,
      llamada: { query: respuesta },
      rafagaCliente: [respuesta],
      turnoPrevio: turnoPregunta({ query: "pastillas de freno", dependeDeLaMoto: true }, "freno+pastilla", "moto"),
      esperado: una(
        {
          estado: "con_existencia",
          debeCotizar: debe,
          nuncaCotizar: ["PASTILLA FRENO DELANTERO BERA SBR 200", "PASTILLA FRENO DELANTERO YAMAHA YBR 125"],
        },
        "confirmar_inventario"
      ),
    })
  ),
  {
    id: "2.3-anio-24-respuesta-a-la-moto",
    seccion: "2.3",
    descripcion:
      '"asiento" y después "sbr 24": un número de 2 dígitos después de la pregunta por la MOTO es el año (`anio`), nunca una medida obligatoria (antes exigía "24" y no encontraba nada). Calza SBR: UNA, la de mayor existencia (D6; antes tres y «Hay 3 opciones más»).',
    llamada: { query: "sbr 24" },
    rafagaCliente: ["sbr 24"],
    turnoPrevio: turnoPregunta({ query: "asiento", dependeDeLaMoto: true }, "asiento", "moto"),
    esperado: una(
      { estado: "con_existencia", debeCotizar: ASIENTO_SBR_DE_MAS_EXISTENCIA },
      "confirmar_inventario"
    ),
    duda: "La memoria (`anio`, `preguntaTipo`) es de T5; el documento del VPS describe este caso como respuesta a «la pregunta por el año», pero con `sbr` en la consulta la moto calza y no hay pregunta de año. Se modeló como respuesta a la pregunta por la moto (`preguntaTipo: 'moto'`).",
  },
  // --- Tallas y unidades ---
  {
    id: "2.3-talla-chaqueta-2xl",
    seccion: "2.3",
    descripcion:
      '"chaqueta 2xl": 2xl es la talla XXL (2xl↔xxl). Una sola chaqueta lo lleva y tiene stock: la variante restringe (hay stock en el subconjunto).',
    llamada: { query: "chaqueta 2xl" },
    esperado: una(
      { estado: "con_existencia", debeCotizar: ["CHAQUETA CORDURA NEGRA XXL"] },
      "confirmar_inventario"
    ),
  },
  {
    id: "2.3-talla-casco-58cm",
    seccion: "2.3",
    descripcion:
      '"casco frankie 58cm": 58cm es una talla de casco (variante), nunca un término obligatorio: no tumba la búsqueda. Hay cuatro cascos Frankie con stock: genérico.',
    llamada: { query: "casco frankie 58cm" },
    esperado: una({ estado: "generico", preguntaFiltro: "producto" }),
  },
  {
    id: "2.3-unidad-pulgadas",
    seccion: "2.3",
    descripcion:
      '"pantalla 7 pulgadas": el 7 calza con 7PULGADAS y con 7PUL. Hay dos pantallas de 7 pulgadas con stock: se cotiza UNA, la de más existencia (D6).',
    llamada: { query: "pantalla 7 pulgadas" },
    esperado: una(
      {
        estado: "con_existencia",
        debeCotizar: ["PANTALLA GPS 7PULGADAS UNIVERSAL"],
      },
      "confirmar_inventario"
    ),
  },
];

// ---------------------------------------------------------------------------
// 2.4 — El corrector de tipeos empeora
// ---------------------------------------------------------------------------

const CASOS_2_4: CasoA2[] = [
  {
    id: "2.4-pareja-una-vuelta",
    seccion: "2.4",
    descripcion:
      '"intercomunicador para parejas": pareja NO se corrige a para (distancia 2 y `para` es relleno): antes salía AGOTADO con los 3 INTERCOMUNICADOR PARA CASCO en 0 habiendo 5 con stock. Pareja no está en ningún nombre: D3 la relaja y quedan los ocho intercomunicadores (cinco con stock): genérico, se pregunta por producto. Nunca un agotado.',
    llamada: { query: "intercomunicador para parejas", dependeDeLaMoto: false },
    esperado: una({
      estado: "generico",
      preguntaFiltro: "producto",
      avisos: ["relajado"],
      relajados: ["pareja"],
      nuncaCotizar: INTERCOMUNICADORES_PARA_CASCO,
      correccion: null,
    }),
    duda: "Con D3 la línea «No encontré 'pareja' en el nombre…» y la escalada `confirmar_inventario` aplican cuando calza; aquí, además, es genérico (5 con stock) y por la regla de la única pregunta no escala en este turno. Se escribió: pregunta, sin escalar, con el aviso `relajado` registrado.",
  },
  {
    id: "2.4-pareja-ni-idea",
    seccion: "2.4",
    descripcion:
      '"intercomunicador para parejas" y después "ni idea": el caso de la mutación de `pideVerTodo` sin «ni idea». Ver todo: UNA, la de mayor existencia (EJEAS V7 PRO, 8 u.; D6, «ni idea» no es pedir opciones). Nunca los agotados.',
    llamada: { query: "intercomunicador para parejas", dependeDeLaMoto: false },
    rafagaCliente: ["ni idea"],
    turnoPrevio: {
      llamada: { query: "intercomunicador para parejas", dependeDeLaMoto: false },
      esperado: una({
        estado: "generico",
        preguntaFiltro: "producto",
        avisos: ["relajado"],
        relajados: ["pareja"],
      }),
      memoria: {
        ultimoQuery: "intercomunicador para parejas",
        moto: [],
        anio: null,
        preguntaHechaPara: "intercomunicador",
        preguntaTipo: "producto",
      },
    },
    esperado: una(
      {
        estado: "con_existencia",
        debeCotizar: INTERCOMUNICADOR_DE_MAS_EXISTENCIA,
        avisos: ["relajado"],
        relajados: ["pareja"],
        nuncaCotizar: INTERCOMUNICADORES_PARA_CASCO,
      },
      "confirmar_inventario"
    ),
    duda: "La clave `preguntaHechaPara` de la memoria depende de si se guarda con los grupos originales («intercomunicador+pareja») o con los relajados («intercomunicador»); se escribió la segunda.",
  },
  {
    id: "2.4-llanta",
    seccion: "2.4",
    descripcion:
      '"llanta": `lata` tiene 4 letras y no suena igual, así que no se corrige. Da sin resultados; nunca LIGA FRENO LATA.',
    llamada: { query: "llanta" },
    esperado: una(
      { estado: "sin_resultados", nuncaCotizar: ["LIGA FRENO LATA"], correccion: null },
      "no_identificado"
    ),
  },
  {
    id: "2.4-relacion-owen-ek",
    seccion: "2.4",
    descripcion:
      '"relación" para Owen EK: relación → corona/piñón (sinónimo de D4), nunca reparacion. Calza OWEN: se cotiza UNA, la de más existencia (el piñón 14T, 6 u., gana a la corona 41T, 4 u.; D6); nunca KIT REPARACION CALIPER OWEN.',
    llamada: { query: "relación", motoBrand: "EK", motoModel: "Owen", dependeDeLaMoto: true },
    requiereSinonimos: true,
    esperado: una(
      {
        estado: "con_existencia",
        debeCotizar: ["PIÑON 14T EK OWEN"],
        nuncaCotizar: ["KIT REPARACION CALIPER OWEN"],
        correccion: null,
      },
      "confirmar_inventario"
    ),
  },
  {
    id: "2.4-relacion-17-por-36-horse-lista",
    seccion: "2.4",
    descripcion:
      'Lista "corona 36, piñón 17" para Horse (lo que el asesor entiende de "relación 17 por 36"): CORONA 36T HORSE (200 u.) y PIÑON 17T HORSE.',
    llamada: { query: "", productos: ["corona 36", "piñon 17"], motoModel: "Horse", dependeDeLaMoto: true },
    esperado: {
      items: [
        item({ producto: "corona 36", estado: "con_existencia", debeCotizar: ["CORONA 36T HORSE"], nuncaCotizar: ["CORONA 36T BERA SBR"] }),
        item({ producto: "piñon 17", estado: "con_existencia", debeCotizar: ["PIÑON 17T HORSE"], nuncaCotizar: ["PIÑON 17T BERA SBR"] }),
      ],
      motivoEscalada: "confirmar_inventario",
    },
  },
  {
    id: "2.4-relacion-17-por-36-horse-literal",
    seccion: "2.4",
    descripcion:
      '"relación 17 por 36" tal cual, para Horse: ningún producto trae 17 y 36 juntos ni se pueden relajar (cada número co-ocurre con la cabeza). No corrige a "reparacion"; sale sin resultados.',
    llamada: { query: "relación 17 por 36", motoModel: "Horse", dependeDeLaMoto: true },
    requiereSinonimos: true,
    esperado: una(
      { estado: "sin_resultados", nuncaCotizar: ["KIT REPARACION CALIPER OWEN"], correccion: null },
      "no_identificado"
    ),
    duda: "El documento del VPS espera que se busquen corona 36T y piñón 17T, pero eso solo pasa si el MODELO parte el pedido en `productos` (ver 2.4-relacion-17-por-36-horse-lista). Con la frase literal, D3 no relaja números que co-ocurren con la cabeza, así que da sin resultados. Decidir si se quiere una regla para «N por M» (relación de transmisión).",
  },
  {
    id: "2.4-vicera-frankie",
    seccion: "2.4",
    descripcion:
      '"casco Frankie negro vicera azul": vicera→visera es una corrección válida, pero el reintento no puede cambiar el producto pedido (casco) por otro (visera): la guarda de producto lo descarta. Con vicera relajada, negro y azul restringen: CASCO FRANKIE NEGRO MATE V/AZUL (2 u.); nunca la VISERA CASCO FRANKIE.',
    llamada: { query: "casco frankie negro vicera azul" },
    esperado: una(
      {
        estado: "con_existencia",
        debeCotizar: ["CASCO FRANKIE NEGRO MATE V/AZUL"],
        nuncaCotizar: ["VISERA CASCO FRANKIE"],
        avisos: ["relajado"],
        relajados: ["vicera"],
        correccion: null,
        correccionDescartada: [{ original: "vicera", corregido: "visera" }],
      },
      "confirmar_inventario"
    ),
  },
  {
    id: "2.4-carplay",
    seccion: "2.4",
    descripcion: '"carplay": no se corrige a `cara` (candidato de 4 letras que no suena igual). Sin resultados.',
    llamada: { query: "carplay" },
    esperado: una({ estado: "sin_resultados", correccion: null }, "no_identificado"),
  },
  {
    id: "2.4-caucho-kenda-70-120",
    seccion: "2.4",
    descripcion:
      '"caucho kenda 70/120": kenda NO se corrige a `anda`. Kenda no está en ningún nombre y no es marca conocida: D3 la relaja y se cotiza UNA de lo más parecido (los cauchos 120/70; la de más existencia, D6).',
    llamada: { query: "caucho kenda 70/120" },
    esperado: una(
      { estado: "con_existencia", avisos: ["relajado"], relajados: ["kenda"], correccion: null },
      "confirmar_inventario"
    ),
    duda: "Los tres CAUCHO 120/70 son `ruido` del fixture (los necesita el caso 130/70-12), por eso `debeCotizar` va vacío; el arnés debe verificar que lo cotizado sean solo cauchos 120/70.",
  },
  {
    id: "2.4-cascos-dama-negro",
    seccion: "2.4",
    descripcion:
      '"cascos dama negro": dama NO se corrige a `gama` (candidato de 4 letras). Dama no está en ningún nombre: D3 la relaja; hay muchos cascos negros con stock: genérico.',
    llamada: { query: "cascos dama negro" },
    esperado: una({
      estado: "generico",
      preguntaFiltro: "producto",
      avisos: ["relajado"],
      relajados: ["dama"],
      correccion: null,
    }),
  },
];

// ---------------------------------------------------------------------------
// 2.5 — El opcional que calza entero se pierde entre los demás (variantes, D2)
// ---------------------------------------------------------------------------

const CASOS_2_5: CasoA2[] = [
  {
    id: "2.5-tanque-azul-sbr-2024",
    seccion: "2.5",
    descripcion:
      '"tanque azul" para una SBR 2024: los tanques SBR azules están en 0. D2 con D6: se dice «azul agotado» y se ofrece UNA alternativa con existencia de la misma moto (el rojo, 5 u., gana al blanco, 3 u.); nunca el EK XPRESS II 2024 azul (otra moto) ni el OWEN 2014.',
    llamada: { query: "tanque azul", motoBrand: "Bera", motoModel: "SBR 2024", dependeDeLaMoto: true },
    esperado: una(
      {
        estado: "agotados",
        avisos: ["variante_agotada"],
        variantesAgotadas: ["azul"],
        otrasOpciones: ["TANQUE SBR ROJO"],
        nuncaCotizar: ["TANQUE EK XPRESS II 2024 AZUL", "TANQUE OWEN 2014 AZUL"],
      },
      "confirmar_inventario"
    ),
    duda: "Motivo de la escalada: hay otras opciones con existencia, así que se escribió `confirmar_inventario`; con solo agotados y sin ofrecer nada sería `sin_stock`.",
  },
  {
    id: "2.5-tanque-gris-sbr",
    seccion: "2.5",
    descripcion:
      '"tanque gris" para una SBR: los dos grises están en 0. Se dice «gris agotado» y se ofrece UNA alternativa SBR con existencia (el rojo; D2 con D6).',
    llamada: { query: "tanque gris", motoModel: "SBR", dependeDeLaMoto: true },
    esperado: una(
      {
        estado: "agotados",
        avisos: ["variante_agotada"],
        variantesAgotadas: ["gris"],
        otrasOpciones: ["TANQUE SBR ROJO"],
        nuncaCotizar: ["TANQUE EK XPRESS II 2024 AZUL"],
      },
      "confirmar_inventario"
    ),
  },
  {
    id: "2.5-rin-trasero-paleta-tx250",
    seccion: "2.5",
    descripcion:
      '"rin trasero de paleta" para una TX250: hay 7 rines con paleta y ninguno nombra TX. El único que antes se cotizaba (RIN TRASERO EK XPRESS PALETA, 19 u.) nombra otra moto: no se cotiza, se escala.',
    llamada: { query: "rin trasero de paleta", motoModel: "TX250", dependeDeLaMoto: true },
    esperado: una(
      {
        estado: "generico",
        avisos: ["moto_sin_calce"],
        nuncaCotizar: ["RIN TRASERO EK XPRESS PALETA", "RIN TRASERO PALETA HORSE", "RIN TRASERO PALETA KAVAK"],
      },
      "confirmar_inventario"
    ),
    cambioDeliberado:
      "El documento del VPS esperaba que se siguiera cotizando el único RIN TRASERO EK XPRESS PALETA (19 u.). Por D1 nombra otra moto (EK y XPRESS, no TX): no se cotiza y el asesor confirma cuál le sirve a la TX250.",
  },
  {
    id: "2.5-chaqueta-edge",
    seccion: "2.5",
    descripcion:
      '"chaqueta EDGE": de las 10 chaquetas, las 2 EDGE están agotadas. Se dice «edge agotado» (variante que existe y está en 0) y se ofrece UNA alternativa de la misma familia, la de mayor existencia (MALLA VERANO, 12 u.; D2 con D6); no se pregunta.',
    llamada: { query: "chaqueta EDGE" },
    esperado: una(
      {
        estado: "agotados",
        avisos: ["variante_agotada"],
        variantesAgotadas: ["edge"],
        otrasOpciones: ["CHAQUETA MALLA VERANO NEGRA"],
      },
      "confirmar_inventario"
    ),
  },
  {
    id: "2.5-edge-suelta-sobre-casco",
    seccion: "2.5",
    descripcion:
      '"casco" y después "EDGE" (respuesta suelta): las filas que traen EDGE mandan (variante estricta con stock): se cotiza UNA de los dos CASCO EDGE, la de más existencia (NEGRO MATE, 4 u.; D6); nunca CASCO ELECTRON SIRIUS L/XL.',
    llamada: { query: "EDGE" },
    rafagaCliente: ["EDGE"],
    turnoPrevio: turnoPregunta({ query: "casco", dependeDeLaMoto: false }, "casco", "producto"),
    esperado: una(
      {
        estado: "con_existencia",
        debeCotizar: ["CASCO EDGE NEGRO MATE"],
        nuncaCotizar: ["CASCO ELECTRON SIRIUS L/XL"],
      },
      "confirmar_inventario"
    ),
  },
  {
    id: "2.5-botas-talla-39",
    seccion: "2.5",
    descripcion:
      '"botas talla 39": la talla 39 existe (impermeable) y está en 0. Se dice «talla 39 agotada» y se ofrece UNA bota de la misma familia con existencia, la de más existencia (cuero talla 40, 3 u.; D2 con D6).',
    llamada: { query: "botas talla 39" },
    esperado: una(
      {
        estado: "agotados",
        avisos: ["variante_agotada"],
        variantesAgotadas: ["39"],
        otrasOpciones: ["BOTAS CUERO NEGRAS TALLA 40"],
      },
      "confirmar_inventario"
    ),
    duda: "El documento del VPS no trae el resultado esperado de «botas talla 39» (solo lo cita como palabra que tumba la búsqueda); se modeló como variante agotada con `talla` estricta.",
  },
];

// ---------------------------------------------------------------------------
// 2.6 — Palabra obligatoria que no está en el nombre (D3)
// ---------------------------------------------------------------------------

const CASOS_2_6: CasoA2[] = [
  {
    id: "2.6-manguera-bomba-de-freno",
    seccion: "2.6",
    descripcion:
      '"manguera de bomba de freno delantero" para Bera Socialista: «bomba» existe en el catálogo (BOMBA FRENO…) pero nunca junto a «manguera»: D3 la relaja. Lo más parecido, MANGUERA FRENO DELANTERO BERA L&J, está en 0: se dice que está agotado (nunca un agotado a secas).',
    llamada: {
      query: "manguera de bomba de freno delantero",
      motoBrand: "Bera",
      motoModel: "Socialista",
      dependeDeLaMoto: true,
    },
    esperado: una(
      {
        estado: "agotados",
        avisos: ["relajado_agotado"],
        relajados: ["bomba"],
        agotadosMencionados: ["MANGUERA FRENO DELANTERO BERA L&J"],
      },
      "sin_stock"
    ),
    duda: "El documento del VPS dice «hoy está en 0, así que tenía que salir agotada»: se leyó como stock 0 de la manguera. Además nombra BERA (la marca de la Socialista) sin nombrar SOCIALISTA: aquí solo se MENCIONA como agotada, no se cotiza.",
  },
  {
    id: "2.6-carburador-pwk",
    seccion: "2.6",
    descripcion:
      '"carburador pwk 30mm cortina plana": «pwk» no aparece en ningún nombre: D3 la relaja y se cotiza CARBURADOR CORTINA PLANA 30MM.',
    llamada: { query: "carburador pwk 30mm cortina plana" },
    esperado: una(
      {
        estado: "con_existencia",
        avisos: ["relajado"],
        relajados: ["pwk"],
        debeCotizar: ["CARBURADOR CORTINA PLANA 30MM"],
        nuncaCotizar: ["CARBURADOR CORTINA PLANA 26MM", "CARBURADOR PZ27 HORSE"],
      },
      "confirmar_inventario"
    ),
    duda: "El documento dice «antes cotizaba; hoy está en 0» y no da el stock: se inventó 4 u. (con 0 saldría `relajado_agotado`).",
  },
  {
    id: "2.6-kit-de-cilindro-pasador-fino",
    seccion: "2.6",
    descripcion:
      '"kit de cilindro pasador fino": «kit» es un opcional (ya no obligatorio), así que ni siquiera hace falta relajar nada: CILINDRO COMPLETO HORSE PASADOR FINO MP.',
    llamada: { query: "kit de cilindro pasador fino" },
    esperado: una(
      {
        estado: "con_existencia",
        debeCotizar: ["CILINDRO COMPLETO HORSE PASADOR FINO MP"],
        nuncaCotizar: ["CILINDRO COMPLETO HORSE PASADOR GRUESO MP", "KIT CILINDRO PISTON BERA SBR"],
      },
      "confirmar_inventario"
    ),
  },
  {
    id: "2.6-ibk-30-litros",
    seccion: "2.6",
    descripcion:
      '"ibk 30 litros": «ibk» no está en ningún nombre: D3 la relaja y queda "30 litros" (un solo grupo): MALETA REDONDA 30 LITROS NEGRA (2 u.).',
    llamada: { query: "ibk 30 litros" },
    esperado: una(
      {
        estado: "con_existencia",
        avisos: ["relajado"],
        relajados: ["ibk"],
        debeCotizar: ["MALETA REDONDA 30 LITROS NEGRA"],
      },
      "confirmar_inventario"
    ),
    duda: "D3 exige que «quede al menos un grupo que no sea un número suelto»: si el grupo de litros (`[30lts, '30 lts', '30 litro', 30lt]`) se cuenta como número suelto, la búsqueda no puede relajar «ibk» y este caso daría sin resultados. Se escribió el resultado del VPS.",
  },
  {
    id: "2.6-caliper-scooter",
    seccion: "2.6",
    descripcion:
      '"caliper de freno scooter": «scooter» existe en el catálogo (cauchos de scooter) pero nunca junto a «caliper»: D3 la relaja. Hay más de tres calipers con stock: genérico.',
    llamada: { query: "caliper de freno scooter", dependeDeLaMoto: true },
    esperado: una({
      estado: "generico",
      preguntaFiltro: "moto",
      avisos: ["relajado"],
      relajados: ["scooter"],
    }),
  },
  {
    id: "2.6-tubo-de-escape-silenciador-sbr",
    seccion: "2.6",
    descripcion:
      '"tubo de escape con silenciador" para SBR: «silenciador» no está en ningún nombre: D3 la relaja. Calza SBR: se cotiza UNO de los dos TUBO ESCAPE BERA SBR, el de más existencia (NEGRO, 7 u.; D6).',
    llamada: { query: "tubo de escape con silenciador", motoModel: "SBR", dependeDeLaMoto: true },
    esperado: una(
      {
        estado: "con_existencia",
        avisos: ["relajado"],
        relajados: ["silenciador"],
        debeCotizar: ["TUBO ESCAPE BERA SBR 200 NEGRO"],
        nuncaCotizar: ["TUBO ESCAPE EK EXPRESS", "TUBO ESCAPE KAVAK"],
      },
      "confirmar_inventario"
    ),
  },
  {
    id: "2.6-parrilla-porta-alforjas-kavak",
    seccion: "2.6",
    descripcion:
      '"parrilla con porta alforjas" para Kavak: «porta» existe (PORTA PLACA…) pero no junto a «parrilla», y «alforja» no existe: D3 relaja las dos. Calza KAVAK: PARRILLA KAVAK LEFOR (14 u.).',
    llamada: { query: "parrilla con porta alforjas", motoModel: "Kavak", dependeDeLaMoto: true },
    esperado: una(
      {
        estado: "con_existencia",
        avisos: ["relajado"],
        relajados: ["porta", "alforja"],
        debeCotizar: ["PARRILLA KAVAK LEFOR"],
        nuncaCotizar: ["PARRILLA KLR 650", "PARRILLA TRASERA BRZ 250"],
      },
      "confirmar_inventario"
    ),
  },
  {
    id: "2.6-aceite-de-motor",
    seccion: "2.6",
    descripcion:
      '"aceite de motor": «motor» existe (TRIPA… MOTOR POWER) pero nunca junto a «aceite»: D3 la relaja. Hay más de tres aceites con stock y ninguno nombra moto: genérico.',
    llamada: { query: "aceite de motor", dependeDeLaMoto: false },
    esperado: una({
      estado: "generico",
      preguntaFiltro: "producto",
      avisos: ["relajado"],
      relajados: ["motor"],
      nuncaCotizar: ["ACEITE ADITIVO TRATAMIENTO METALES SENFI"],
    }),
  },
  {
    id: "2.6-slider-giratorio",
    seccion: "2.6",
    descripcion:
      '"slider giratorio": «giratorio» no está en ningún nombre: D3 la relaja. Hay dos sliders con stock: se cotiza UNO, el de más existencia (D6).',
    llamada: { query: "slider giratorio" },
    esperado: una(
      {
        estado: "con_existencia",
        avisos: ["relajado"],
        relajados: ["giratorio"],
        debeCotizar: ["SLIDER PROTECTOR MOTOR UNIVERSAL"],
      },
      "confirmar_inventario"
    ),
  },
  {
    id: "2.6-pinon-14-reborde-11-hj-cool",
    seccion: "2.6",
    descripcion:
      '"piñón de 14 con reborde de 11" para HJ Cool: «reborde» no está en ningún nombre y el número que va detrás («de 11») se relaja con ella. Calza HJ COOL: PIÑON 14T HJ COOL ALDRICH (3 u.).',
    llamada: { query: "piñón de 14 con reborde de 11", motoBrand: "HJ", motoModel: "Cool", dependeDeLaMoto: true },
    esperado: una(
      {
        estado: "con_existencia",
        avisos: ["relajado"],
        relajados: ["reborde", "11"],
        debeCotizar: ["PIÑON 14T HJ COOL ALDRICH"],
        nuncaCotizar: ["PIÑON 14T BERA SBR", "PIÑON 14T HORSE 200", "PIÑON 14T KAVAK"],
      },
      "confirmar_inventario"
    ),
  },
  {
    id: "2.6-ich-sirius-abatible-3120",
    seccion: "2.6",
    descripcion:
      '"ICH Sirius abatible 3120 negro mate": ni «ich» ni «abatible» están en el nombre; el 3120 va detrás de «abatible» y se relaja con ella (regla de D3, «un número detrás de una palabra relajada»). Negro y mate son variantes estrictas: dejan solo el CASCO SIRIUS 3120 NEGRO MATE (1 u.), que es lo que espera el VPS.',
    llamada: { query: "ICH Sirius abatible 3120 negro mate" },
    esperado: una(
      {
        estado: "con_existencia",
        avisos: ["relajado"],
        relajados: ["ich", "abatible", "3120"],
        debeCotizar: ["CASCO SIRIUS 3120 NEGRO MATE"],
        nuncaCotizar: ["CASCO ELECTRON SIRIUS L/XL"],
      },
      "confirmar_inventario"
    ),
    duda: "El plan dice que D3 NO relaja una marca (`ich` está en MARCAS_CONOCIDAS), así que tal como está escrito este caso daría sin resultados. El resultado del VPS exige que `ich` pueda relajarse cuando NINGUNA fila la trae (el caso Inca sigue protegido porque `inca` sí está en los nombres). Recomendación: relajar una marca solo si no aparece en ningún nombre activo. El fixture usa el nombre citado por el VPS (sin ICH).",
  },
  {
    id: "2.6-caucho-90-90-19-semitaco",
    seccion: "2.6",
    descripcion:
      '"caucho 90 90 19 semitaco": «semitaco» no está en ningún nombre: D3 la relaja. CAUCHO 19 90/90 TS712 TIMSUN (4 u.); nunca los tacómetros.',
    llamada: { query: "caucho 90 90 19 semitaco" },
    esperado: una(
      {
        estado: "con_existencia",
        avisos: ["relajado"],
        relajados: ["semitaco"],
        debeCotizar: ["CAUCHO 19 90/90 TS712 TIMSUN"],
        nuncaCotizar: ["TACOMETRO DIGITAL UNIVERSAL", "TACOMETRO ANALOGO UNIVERSAL"],
      },
      "confirmar_inventario"
    ),
  },
  {
    id: "2.6-caucho-semi-taco",
    seccion: "2.6",
    descripcion:
      '"caucho 90 90 19 semi taco": «semi taco» se lee como «semitaco» (no como `taco`, que calzaría con TACOMETRO). Mismo resultado que con "semitaco".',
    llamada: { query: "caucho 90 90 19 semi taco" },
    esperado: una(
      {
        estado: "con_existencia",
        avisos: ["relajado"],
        relajados: ["semitaco"],
        debeCotizar: ["CAUCHO 19 90/90 TS712 TIMSUN"],
        nuncaCotizar: ["TACOMETRO DIGITAL UNIVERSAL", "TACOMETRO ANALOGO UNIVERSAL"],
      },
      "confirmar_inventario"
    ),
  },
  {
    id: "2.6-caucho-tipo-de-cros",
    seccion: "2.6",
    descripcion:
      '"caucho tipo de cros": el singular «cro» (3 letras) calza como palabra entera y no como prefijo, así que no calza con CROMADO. No existe: D3 la relaja; hay más de tres cauchos con stock: genérico. Nunca LUZ CRUCE CROMADO.',
    llamada: { query: "caucho tipo de cros" },
    esperado: una({
      estado: "generico",
      preguntaFiltro: "producto",
      avisos: ["relajado"],
      relajados: ["cro"],
      nuncaCotizar: ["LUZ CRUCE CROMADO"],
    }),
  },
  {
    id: "2.6-buhos-led",
    seccion: "2.6",
    descripcion:
      '"Búhos LED": «buho» no está en ningún nombre: D3 la relaja y quedan los productos LED (cuatro con stock): genérico.',
    llamada: { query: "Búhos LED" },
    esperado: una({
      estado: "generico",
      preguntaFiltro: "producto",
      avisos: ["relajado"],
      relajados: ["buho"],
    }),
    duda: "El documento del VPS no da producto esperado para «Búhos LED»; se modeló solo con lo que dice D3.",
  },
  {
    id: "2.6-casco-gris-plata",
    seccion: "2.6",
    descripcion:
      '"casco gris plata": «plata» existe (MALETA CUADRADA 45LTS PLATA) pero no junto a «casco»: D3 la relaja. Ningún casco es gris: la variante no restringe; genérico.',
    llamada: { query: "casco gris plata" },
    esperado: una({
      estado: "generico",
      preguntaFiltro: "producto",
      avisos: ["relajado"],
      relajados: ["plata"],
      nuncaCotizar: ["MALETA CUADRADA 45LTS PLATA"],
    }),
    duda: "El documento del VPS no da producto esperado para «casco gris plata»; se modeló solo con lo que dice D3.",
  },
];

// ---------------------------------------------------------------------------
// 2.7 — Sinónimos (D4): los 14 que siembra la migración M4
// ---------------------------------------------------------------------------

const CASOS_2_7: CasoA2[] = [
  {
    id: "2.7-express-xpress",
    seccion: "2.7",
    descripcion:
      '"asiento express": express→xpress. Antes salía agotado con el FORRO ASIENTO EK EXPRESS (0 u.); ASIENTO EK XPRESS BENF tiene 2 u. El parser (T4) lee «express» como la moto XPRESS por alias (`ALIAS_MOTO`) antes de que el sinónimo de M4 llegue a actuar, así que queda anotada como corrección de la moto, igual que horsen→horse.',
    llamada: { query: "asiento express", dependeDeLaMoto: true },
    requiereSinonimos: true,
    esperado: una(
      {
        estado: "con_existencia",
        debeCotizar: ["ASIENTO EK XPRESS BENF"],
        nuncaCotizar: ["FORRO ASIENTO EK EXPRESS"],
        correccion: [{ original: "express", corregido: "xpress" }],
      },
      "confirmar_inventario"
    ),
  },
  {
    id: "2.7-balaclava-pasamontana",
    seccion: "2.7",
    descripcion: '"balaclava": balaclava→pasamontaña. PASAMONTAÑA TERMICO NEGRO (6 u.) gana a BUFF MUJER (3 u.): se cotiza UNO (D6).',
    llamada: { query: "balaclava" },
    requiereSinonimos: true,
    esperado: una(
      {
        estado: "con_existencia",
        debeCotizar: ["PASAMONTAÑA TERMICO NEGRO"],
      },
      "confirmar_inventario"
    ),
  },
  {
    id: "2.7-litros-lts",
    seccion: "2.7",
    descripcion:
      '"maleta 45 litros": litros→lts. Saint escribe «45LTS» pegado y «45 LTS» separado; las dos maletas de 45 tienen stock: se cotiza UNA, la de más existencia (PLATA, 9 u.; D6).',
    llamada: { query: "maleta 45 litros" },
    requiereSinonimos: true,
    esperado: una(
      {
        estado: "con_existencia",
        debeCotizar: ["MALETA CUADRADA 45LTS PLATA"],
        nuncaCotizar: ["MALETA REDONDA 34 LTS TOMCAT GRIS"],
      },
      "confirmar_inventario"
    ),
  },
  {
    id: "2.7-litro-lts",
    seccion: "2.7",
    descripcion: '"maleta 45 litro" (singular): mismo resultado que "litros".',
    llamada: { query: "maleta 45 litro" },
    requiereSinonimos: true,
    esperado: una(
      {
        estado: "con_existencia",
        debeCotizar: ["MALETA CUADRADA 45LTS PLATA"],
      },
      "confirmar_inventario"
    ),
  },
  {
    id: "2.7-espejo-retrovisor",
    seccion: "2.7",
    descripcion: '"espejo": espejo→retrovisor. Dos retrovisores con stock: se cotiza UNO, el de más existencia (D6).',
    llamada: { query: "espejo" },
    requiereSinonimos: true,
    esperado: una(
      {
        estado: "con_existencia",
        debeCotizar: ["RETROVISOR UNIVERSAL NEGRO PAR"],
      },
      "confirmar_inventario"
    ),
  },
  {
    id: "2.7-direccional-luz-cruce",
    seccion: "2.7",
    descripcion: '"direccional": direccional→luz cruce (dos palabras). LUZ CRUCE HORSE 1 (20 u.).',
    llamada: { query: "direccional" },
    requiereSinonimos: true,
    esperado: una(
      { estado: "con_existencia", debeCotizar: ["LUZ CRUCE HORSE 1"] },
      "confirmar_inventario"
    ),
  },
  {
    id: "2.7-porta-maleta-base-maleta",
    seccion: "2.7",
    descripcion:
      '"porta maleta": porta maleta→base maleta (sinónimo de dos palabras, que hoy no calza nunca). Dos bases con stock: se cotiza UNA, la de más existencia (D6); nunca las maletas.',
    llamada: { query: "porta maleta" },
    requiereSinonimos: true,
    esperado: una(
      {
        estado: "con_existencia",
        debeCotizar: ["BASE MALETA COLORES GP"],
        nuncaCotizar: ["MALETA REDONDA 34 LTS TOMCAT GRIS"],
      },
      "confirmar_inventario"
    ),
  },
  {
    id: "2.7-boca-pato-pico-pato",
    seccion: "2.7",
    descripcion:
      '"boca pato" para GR250: boca pato→pico pato (dos palabras). Calza GR250: PICO PATO GR250 (12 u.), no los demás.',
    llamada: { query: "boca pato", motoBrand: "GR", motoModel: "250", dependeDeLaMoto: true },
    requiereSinonimos: true,
    esperado: una(
      {
        estado: "con_existencia",
        debeCotizar: ["PICO PATO GR250"],
        nuncaCotizar: ["PICO PATO BERA SBR", "PICO PATO HORSE"],
      },
      "confirmar_inventario"
    ),
  },
  {
    id: "2.7-luz-led",
    seccion: "2.7",
    descripcion: '"cubre levas luz": luz→led. CUBRE LEVAS LED (31 u.).',
    llamada: { query: "cubre levas luz" },
    requiereSinonimos: true,
    esperado: una({ estado: "con_existencia", debeCotizar: ["CUBRE LEVAS LED"] }, "confirmar_inventario"),
  },
  {
    id: "2.7-empaque-empacadura",
    seccion: "2.7",
    descripcion: '"empaque": empaque→empacadura. Dos empacaduras con stock: se cotiza UNA, la de más existencia (D6).',
    llamada: { query: "empaque" },
    requiereSinonimos: true,
    esperado: una(
      {
        estado: "con_existencia",
        debeCotizar: ["EMPACADURA CULATA BERA SBR"],
      },
      "confirmar_inventario"
    ),
  },
  {
    id: "2.7-scuda-escuda",
    seccion: "2.7",
    descripcion: '"scuda": scuda→escuda. ESCUDA PARAMOTOR UNIVERSAL.',
    llamada: { query: "scuda" },
    requiereSinonimos: true,
    esperado: una(
      { estado: "con_existencia", debeCotizar: ["ESCUDA PARAMOTOR UNIVERSAL"] },
      "confirmar_inventario"
    ),
  },
  {
    id: "2.7-rones-rin",
    seccion: "2.7",
    descripcion: '"rones": rones→rin. Hay muchos rines con stock: genérico (se pregunta por la moto).',
    llamada: { query: "rones", dependeDeLaMoto: true },
    requiereSinonimos: true,
    esperado: una({ estado: "generico", preguntaFiltro: "moto" }),
  },
  {
    id: "2.7-kit-de-rodaje-kit-rodamiento",
    seccion: "2.7",
    descripcion:
      '"kit de rodaje": kit de rodaje→kit rodamiento. Hay cuatro kits de rodamiento con stock y todos nombran moto: genérico.',
    llamada: { query: "kit de rodaje", dependeDeLaMoto: true },
    requiereSinonimos: true,
    esperado: una({ estado: "generico", preguntaFiltro: "moto" }),
  },
  {
    id: "2.7-foco-faro",
    seccion: "2.7",
    descripcion: '"foco": foco→faro. Hay cuatro faros con stock: genérico.',
    llamada: { query: "foco", dependeDeLaMoto: true },
    requiereSinonimos: true,
    esperado: una({ estado: "generico", preguntaFiltro: "moto" }),
  },
  {
    id: "2.7-relacion-corona-pinon",
    seccion: "2.7",
    descripcion:
      '"relacion": relación→corona y relación→piñón (las dos filas del mismo sinónimo). Hay muchas coronas y piñones con stock: genérico.',
    llamada: { query: "relacion", dependeDeLaMoto: true },
    requiereSinonimos: true,
    esperado: una({ estado: "generico", preguntaFiltro: "moto", nuncaCotizar: ["KIT REPARACION CALIPER OWEN"] }),
  },
];

// ---------------------------------------------------------------------------
// No regresión (sección 5 del documento del VPS)
// ---------------------------------------------------------------------------

const CASOS_NO_REGRESION: CasoA2[] = [
  {
    id: "nr-01-aceite-inca",
    seccion: "no-regresion",
    descripcion: '"aceite 20w50 semi sintetico inca": la marca es obligatoria (el caso Inca no puede volver). ACEITE INCA 20W50 4T.',
    llamada: { query: "aceite 20w50 semi sintetico inca", dependeDeLaMoto: false },
    esperado: una(
      {
        estado: "con_existencia",
        debeCotizar: ["ACEITE INCA 20W50 4T"],
        nuncaCotizar: ["ACEITE MOTUL 5100 20W50 4T", "ACEITE IPONE 20W50 4T", "ACEITE MOTUL 5000 20W50 4T"],
      },
      "confirmar_inventario"
    ),
  },
  {
    id: "nr-02-aceite-oilstone",
    seccion: "no-regresion",
    descripcion: '"aceite 4 tiempos oilstone": ACEITE OILSTONE 4T 20W50 1L.',
    llamada: { query: "aceite 4 tiempos oilstone", dependeDeLaMoto: false },
    esperado: una(
      { estado: "con_existencia", debeCotizar: ["ACEITE OILSTONE 4T 20W50 1L"] },
      "confirmar_inventario"
    ),
  },
  {
    id: "nr-03-motul-15w50",
    seccion: "no-regresion",
    descripcion: '"aceite motul semi sintetico 5100 15w50": ACEITE MOTUL 5100 15W50 4T, nunca el 20W50.',
    llamada: { query: "aceite motul semi sintetico 5100 15w50", dependeDeLaMoto: false },
    esperado: una(
      {
        estado: "con_existencia",
        debeCotizar: ["ACEITE MOTUL 5100 15W50 4T"],
        nuncaCotizar: ["ACEITE MOTUL 5100 20W50 4T", "ACEITE MOTUL 5000 20W50 4T"],
      },
      "confirmar_inventario"
    ),
  },
  {
    id: "nr-04-rolineras",
    seccion: "no-regresion",
    descripcion: 'Lista "rolinera 6301 / 6302 / 6202": las tres cotizadas.',
    llamada: { query: "", productos: ["rolinera 6301", "rolinera 6302", "rolinera 6202"] },
    esperado: {
      items: [
        item({ producto: "rolinera 6301", estado: "con_existencia", debeCotizar: ["ROLINERA 6301 2RS"] }),
        item({ producto: "rolinera 6302", estado: "con_existencia", debeCotizar: ["ROLINERA 6302 2RS"] }),
        item({ producto: "rolinera 6202", estado: "con_existencia", debeCotizar: ["ROLINERA 6202 2RS"] }),
      ],
      motivoEscalada: "confirmar_inventario",
    },
  },
  {
    id: "nr-05-aceite-iphone",
    seccion: "no-regresion",
    descripcion: '"aceite iphone 20/50": iphone→ipone (marca conocida, distancia 1). ACEITE IPONE 20W50 4T; nunca el MOTUL 5000 (que el 50 suelto calzaba).',
    llamada: { query: "aceite iphone 20/50", dependeDeLaMoto: false },
    esperado: una(
      {
        estado: "con_existencia",
        debeCotizar: ["ACEITE IPONE 20W50 4T"],
        nuncaCotizar: ["ACEITE MOTUL 5000 20W50 4T", "ACEITE MOTUL 5000 10W40 4T"],
        correccion: [{ original: "iphone", corregido: "ipone" }],
      },
      "confirmar_inventario"
    ),
  },
  {
    id: "nr-06-botas-impermeables",
    seccion: "no-regresion",
    descripcion:
      '"botas impermeables": las siete están en 0: agotados (hasta tres listadas), nunca "tenemos". Las botas de cuero no son impermeables y no entran.',
    llamada: { query: "botas impermeables", dependeDeLaMoto: false },
    esperado: una({ estado: "agotados" }, "sin_stock"),
  },
  {
    id: "nr-07-tanque-rkv",
    seccion: "no-regresion",
    descripcion: '"tanque rkv": los cuatro RKV están en 0: agotados. Nunca el OWEN 2014 ni el EK XPRESS II.',
    llamada: { query: "tanque rkv", dependeDeLaMoto: true },
    esperado: una(
      { estado: "agotados", nuncaCotizar: ["TANQUE OWEN 2014 AZUL", "TANQUE EK XPRESS II 2024 AZUL"] },
      "sin_stock"
    ),
  },
  {
    id: "nr-08-defensa-gxs-250",
    seccion: "no-regresion",
    descripcion:
      '"defensa" para "gxs 250": ninguna defensa nombra GXS y todas nombran OTRA moto (no hay universales): se escala sin cotizar, y nunca DEFENSA BRZ 250 por compartir el 250.',
    llamada: { query: "defensa", motoModel: "gxs 250", dependeDeLaMoto: true },
    esperado: una(
      {
        estado: "generico",
        avisos: ["moto_sin_calce"],
        nuncaCotizar: ["DEFENSA BRZ 250"],
      },
      "confirmar_inventario"
    ),
    cambioDeliberado:
      "La tabla de no regresión del VPS decía «pregunta (una sola vez)». Resolución 2 del orquestador: con la moto dada que no calza y la familia dependiendo de la moto, se decide con los compatibles con existencia — aquí ninguno (todas las defensas nombran otra moto y no hay universales): se escala sin cotizar. La pregunta de filtro solo queda con MÁS de tres compatibles con existencia.",
  },
  {
    id: "nr-08b-aceite-sbr-no-cotiza-la-bomba",
    seccion: "no-regresion",
    descripcion:
      '"aceite" para una Bera SBR (T5b): BOMBA DE ACEITE BERA SBR puntúa «aceite» y nombra la SBR, pero no EMPIEZA con «aceite»: la moto no calza con ella. Entre los aceites (más de tres con existencia, ninguno nombra moto) rige la regla sin moto: la pregunta de filtro. Nunca la bomba.',
    llamada: { query: "aceite", motoBrand: "Bera", motoModel: "SBR", dependeDeLaMoto: false },
    esperado: una({
      estado: "generico",
      preguntaFiltro: "producto",
      nuncaCotizar: ["BOMBA DE ACEITE BERA SBR"],
    }),
  },
  {
    id: "nr-08c-aceite-inca-sbr-cotiza-el-aceite",
    seccion: "no-regresion",
    descripcion:
      '"aceite inca" para una Bera SBR (T5b): un aceite concreto se cotiza aunque la moto no calce con ninguno; la bomba de aceite BERA SBR no compite.',
    llamada: { query: "aceite inca", motoBrand: "Bera", motoModel: "SBR", dependeDeLaMoto: false },
    esperado: una(
      { estado: "con_existencia", debeCotizar: ["ACEITE INCA 20W50 4T"], nuncaCotizar: ["BOMBA DE ACEITE BERA SBR"] },
      "confirmar_inventario"
    ),
  },
  {
    id: "nr-09-asiento-sbr",
    seccion: "no-regresion",
    descripcion: '"asiento sbr": UNA, la de mayor existencia (NEGRO ALDRICH, 15 u.; D6, antes tres y «Hay 3 opciones más»; hay 6 ASIENTO SBR con stock).',
    llamada: { query: "asiento sbr", dependeDeLaMoto: true },
    esperado: una(
      { estado: "con_existencia", debeCotizar: ASIENTO_SBR_DE_MAS_EXISTENCIA, nuncaCotizar: ["ASIENTO HORSE NEGRO"] },
      "confirmar_inventario"
    ),
  },
  {
    id: "nr-10-juego-de-pastilla-gr-250",
    seccion: "no-regresion",
    descripcion: '"juego de pastilla" para GR 250: GR250 sí calza (no GRIS). UNA pastilla GR250, la de más existencia (la delantera, 6 u.; D6).',
    llamada: { query: "juego de pastilla", motoBrand: "GR", motoModel: "250", dependeDeLaMoto: true },
    esperado: una(
      {
        estado: "con_existencia",
        debeCotizar: ["PASTILLA FRENO DELANTERO GR250"],
        nuncaCotizar: ["PASTILLA FRENO DELANTERO BERA SBR 200"],
      },
      "confirmar_inventario"
    ),
  },
  {
    id: "nr-11-casco-givi-h11-7",
    seccion: "no-regresion",
    descripcion: '"casco givi h11.7 talla xl": CASCO GIVI H11.7 (la talla XL no está en ningún nombre y no restringe).',
    llamada: { query: "casco givi h11.7 talla xl", dependeDeLaMoto: false },
    esperado: una(
      {
        estado: "con_existencia",
        debeCotizar: ["CASCO GIVI H11.7"],
        nuncaCotizar: ["CASCO GIVI H50.7 FLIP"],
      },
      "confirmar_inventario"
    ),
  },
  {
    id: "nr-12-caucho-21-delantero-18-trasero",
    seccion: "no-regresion",
    descripcion:
      'Lista "caucho 21 delantero / caucho 18 trasero": el 21 tiene dos con stock y se cotiza UNA, la de más existencia (D6); el 18 tiene cinco con stock y es un ítem genérico dentro de una lista (D1b): no se cotiza, "hay varias opciones".',
    llamada: { query: "", productos: ["caucho 21 delantero", "caucho 18 trasero"] },
    esperado: {
      items: [
        item({
          producto: "caucho 21 delantero",
          estado: "con_existencia",
          debeCotizar: ["CAUCHO 21 2.75 TIMSUN"],
        }),
        item({
          producto: "caucho 18 trasero",
          estado: "generico",
          avisos: ["varias_opciones"],
          nuncaCotizar: ["CAUCHO 18 2.75 TIMSUN", "CAUCHO TRASERO 10 3.50 SCOOTER TIMSUN"],
        }),
      ],
      motivoEscalada: "confirmar_inventario",
    },
    cambioDeliberado:
      "El documento del VPS esperaba que se cotizaran los dos. D1b (opción (a) del operador) dice que un ítem genérico dentro de una lista NO se cotiza: el rin 18 tiene más de tres cauchos con stock, así que queda como «varias opciones» (igual que el «caucho n° 18 delantero» de la lista de producción del 29/9).",
  },
  {
    id: "nr-13-timsum-de-pista",
    seccion: "no-regresion",
    descripcion: '"timsum de pista": timsum→timsun (marca conocida). CAUCHO 17 90/90 TIMSUN PISTA.',
    llamada: { query: "timsum de pista" },
    esperado: una(
      {
        estado: "con_existencia",
        debeCotizar: ["CAUCHO 17 90/90 TIMSUN PISTA"],
        correccion: [{ original: "timsum", corregido: "timsun" }],
      },
      "confirmar_inventario"
    ),
  },
  {
    id: "nr-14-guardafango-horse",
    seccion: "no-regresion",
    descripcion: '"guardafango" para Horse: UNA, la de mayor existencia (DELANTERO NEGRO, 9 u.; D6, antes tres y «Hay 2 opciones más»; 5 con stock).',
    llamada: { query: "guardafango", motoModel: "Horse", dependeDeLaMoto: true },
    esperado: una(
      {
        estado: "con_existencia",
        debeCotizar: GUARDAFANGO_HORSE_DE_MAS_EXISTENCIA,
        nuncaCotizar: ["GUARDAFANGO DELANTERO BERA SBR", "GUARDAFANGO TRASERO KAVAK"],
      },
      "confirmar_inventario"
    ),
  },
  {
    id: "nr-15-motul-5100-20-50",
    seccion: "no-regresion",
    descripcion: '"motul 5100 20/50": ACEITE MOTUL 5100 20W50 4T; nunca el MOTUL 5000 (el 50 suelto calzaba con 5000).',
    llamada: { query: "motul 5100 20/50", dependeDeLaMoto: false },
    esperado: una(
      {
        estado: "con_existencia",
        debeCotizar: ["ACEITE MOTUL 5100 20W50 4T"],
        nuncaCotizar: ["ACEITE MOTUL 5000 20W50 4T", "ACEITE MOTUL 5100 15W50 4T"],
      },
      "confirmar_inventario"
    ),
  },
  {
    id: "nr-16-horsen",
    seccion: "no-regresion",
    descripcion:
      '"guardafango" y después "horsen": horsen se corrige a horse (la moto). UNA, la de mayor existencia (D6).',
    llamada: { query: "horsen" },
    rafagaCliente: ["horsen"],
    turnoPrevio: turnoPregunta({ query: "guardafango", dependeDeLaMoto: true }, "guardafango", "moto"),
    esperado: una(
      {
        estado: "con_existencia",
        debeCotizar: GUARDAFANGO_HORSE_DE_MAS_EXISTENCIA,
        correccion: [{ original: "horsen", corregido: "horse" }],
      },
      "confirmar_inventario"
    ),
  },
  {
    id: "nr-17-beta",
    seccion: "no-regresion",
    descripcion:
      '"defensa" y después "beta": beta es una moto y NO se corrige a bera. Ninguna defensa nombra Beta: se escala sin cotizar.',
    llamada: { query: "beta" },
    rafagaCliente: ["beta"],
    turnoPrevio: turnoPregunta({ query: "defensa", dependeDeLaMoto: true }, "defensa", "moto"),
    esperado: una(
      {
        estado: "generico",
        avisos: ["moto_sin_calce"],
        nuncaCotizar: ["DEFENSA BERA SBR", ...TRES_DEFENSAS_DE_OTRAS_MOTOS],
        correccion: null,
      },
      "confirmar_inventario"
    ),
  },
  {
    id: "nr-18-magneto-dt200",
    seccion: "no-regresion",
    descripcion: '"magneto dt200": dt200 no puede calzar DT2000 (el número que termina el término lleva límite de palabra).',
    llamada: { query: "magneto dt200" },
    esperado: una(
      {
        estado: "con_existencia",
        debeCotizar: ["MAGNETO DT200 MS"],
        nuncaCotizar: ["MAGNETO DT2000 MS"],
      },
      "confirmar_inventario"
    ),
  },
];

// ---------------------------------------------------------------------------
// Corrector — la tabla de la sección 4.3 del plan
// ---------------------------------------------------------------------------

/** Un caso de la tabla del corrector: qué se corrige (o `null`) y, si se puede fijar, qué cotiza. */
function casoCorrector(
  id: string,
  descripcion: string,
  llamada: LlamadaA2,
  correccion: CorreccionA2[] | null,
  parcial: Partial<EsperadoItemA2> = {},
  motivoEscalada: MotivoEscaladaA2 | null = null,
  extra: Partial<CasoA2> = {}
): CasoA2 {
  return {
    id: `corrector-${id}`,
    seccion: "corrector",
    descripcion,
    llamada,
    esperado: una({ ...parcial, correccion }, motivoEscalada),
    ...extra,
  };
}

const CASOS_CORRECTOR: CasoA2[] = [
  casoCorrector(
    "horsen",
    "horsen→horse: distancia 1 contra una moto conocida (corrige la MOTO).",
    { query: "guardafango", motoModel: "horsen", dependeDeLaMoto: true },
    [{ original: "horsen", corregido: "horse" }],
    { estado: "con_existencia", debeCotizar: GUARDAFANGO_HORSE_DE_MAS_EXISTENCIA },
    "confirmar_inventario"
  ),
  casoCorrector(
    "iphone",
    "iphone→ipone: distancia 1 (la marca del aceite se llama IPONE).",
    { query: "aceite iphone" },
    [{ original: "iphone", corregido: "ipone" }],
    { estado: "con_existencia", debeCotizar: ["ACEITE IPONE 20W50 4T"] },
    "confirmar_inventario"
  ),
  casoCorrector(
    "motopower",
    "motopower→motorpower: distancia 1.",
    { query: "cadena motopower" },
    [{ original: "motopower", corregido: "motorpower" }],
    {
      estado: "con_existencia",
      debeCotizar: ["CADENA 428 MOTORPOWER 120L"],
      nuncaCotizar: ["CADENA 428 DID 120L"],
    },
    "confirmar_inventario"
  ),
  casoCorrector(
    "ciguanal",
    "ciguañal→cigueñal: distancia 1 (términos ya sin acentos: ciguanal→ciguenal).",
    { query: "ciguañal" },
    [{ original: "ciguanal", corregido: "ciguenal" }],
    { estado: "con_existencia", debeCotizar: ["CIGUEÑAL HORSE 150"] },
    "confirmar_inventario"
  ),
  casoCorrector(
    "tisum",
    "tisum→timsun: es una marca conocida, se acepta con la distancia del umbral por largo.",
    { query: "caucho tisum pista" },
    [{ original: "tisum", corregido: "timsun" }],
    { estado: "con_existencia", debeCotizar: ["CAUCHO 17 90/90 TIMSUN PISTA"] },
    "confirmar_inventario"
  ),
  casoCorrector(
    "stinsun",
    "stinsun→timsun: marca conocida, distancia 2 con 7 letras.",
    { query: "caucho stinsun pista" },
    [{ original: "stinsun", corregido: "timsun" }],
    { estado: "con_existencia", debeCotizar: ["CAUCHO 17 90/90 TIMSUN PISTA"] },
    "confirmar_inventario"
  ),
  casoCorrector(
    "swhera",
    "swhera→switchera: marca conocida.",
    { query: "puños swhera" },
    [{ original: "swhera", corregido: "switchera" }],
    { estado: "con_existencia", debeCotizar: ["PUÑOS SWITCHERA NEGROS"] },
    "confirmar_inventario"
  ),
  casoCorrector(
    "rallo",
    "rallo→rayo: suena igual (ll→y).",
    { query: "rin rallo" },
    [{ original: "rallo", corregido: "rayo" }],
    {
      estado: "con_existencia",
      debeCotizar: ["RIN TRASERO HORSE RAYO"],
    },
    "confirmar_inventario"
  ),
  casoCorrector(
    "siriu",
    "siriu ya existe: es prefijo de SIRIUS, no se corrige (calza directo). Hay dos cascos SIRIUS con stock y D6 cotiza UNO, el de más existencia (CASCO ELECTRON SIRIUS L/XL, 5 u., una fila de ruido del fixture): el caso fija que NO se corrige, no cuál de los dos sale.",
    { query: "casco siriu" },
    null,
    { estado: "con_existencia", debeCotizar: [] },
    "confirmar_inventario"
  ),
  casoCorrector(
    "frente",
    "frente NO se corrige a freno (distancia 2). Sale por D3.",
    { query: "pastillas de frente", dependeDeLaMoto: true },
    null,
    { estado: "generico", preguntaFiltro: "moto", avisos: ["relajado"], relajados: ["frente"] }
  ),
  casoCorrector(
    "compresion",
    "compresion NO se corrige a compresor.",
    { query: "compresion" },
    null,
    { estado: "sin_resultados", nuncaCotizar: ["COMPRESOR AIRE PORTATIL 12V"] },
    "no_identificado"
  ),
  casoCorrector(
    "alante",
    "alante NO se corrige a aislante (distancia 2). Sale por D3.",
    { query: "guardafango alante", dependeDeLaMoto: true },
    null,
    {
      estado: "generico",
      preguntaFiltro: "moto",
      avisos: ["relajado"],
      relajados: ["alante"],
      nuncaCotizar: ["CINTA AISLANTE 3M NEGRA"],
    }
  ),
  casoCorrector(
    "numero",
    "numero NO se corrige a nuevo: en «numero 18» solo queda el número (relleno).",
    { query: "caucho numero 18" },
    null,
    { estado: "generico", preguntaFiltro: "producto" }
  ),
  casoCorrector(
    "relacion",
    "relacion NO se corrige a reparacion: es un sinónimo (corona/piñón).",
    { query: "relacion", dependeDeLaMoto: true },
    null,
    { estado: "generico", preguntaFiltro: "moto", nuncaCotizar: ["KIT REPARACION CALIPER OWEN"] },
    null,
    { requiereSinonimos: true }
  ),
  casoCorrector(
    "medida",
    "medida sale por relleno: no es un término, no se corrige a media.",
    { query: "caucho medida 18" },
    null,
    { estado: "generico", preguntaFiltro: "producto" }
  ),
  casoCorrector(
    "guarda",
    "guarda es prefijo de GUARDAFANGO: no se corrige a guaya.",
    { query: "guarda", dependeDeLaMoto: true },
    null,
    { estado: "generico", preguntaFiltro: "moto", nuncaCotizar: ["GUAYA ACELERADOR UNIVERSAL"] }
  ),
  casoCorrector(
    "diente",
    "diente es prefijo de DIENTES: no se vuelve a poner en plural.",
    { query: "diente" },
    null,
    { estado: "con_existencia", debeCotizar: ["PLACA DIENTES ARRASTRE UNIVERSAL"] },
    "confirmar_inventario"
  ),
  casoCorrector(
    "brazo",
    "brazo es prefijo de BRAZOS.",
    { query: "brazo" },
    null,
    { estado: "con_existencia", debeCotizar: ["BRAZOS SWING BERA SBR"] },
    "confirmar_inventario"
  ),
  casoCorrector(
    "manga",
    "manga es prefijo de MANGAS.",
    { query: "manga" },
    null,
    { estado: "con_existencia", debeCotizar: ["MANGAS TERMICAS CICLISTA"] },
    "confirmar_inventario"
  ),
  casoCorrector(
    "bidon",
    "bidon es prefijo de BIDONES.",
    { query: "bidon" },
    null,
    { estado: "con_existencia", debeCotizar: ["BIDONES PLASTICOS 20 LITROS GASOLINA"] },
    "confirmar_inventario"
  ),
  casoCorrector(
    "bota",
    "bota es prefijo de BOTAS: no se corrige. Hay dos botas de cuero con stock (las impermeables están en 0): se cotiza UNA, la de más existencia (D6).",
    { query: "bota" },
    null,
    {
      estado: "con_existencia",
      debeCotizar: ["BOTAS CUERO NEGRAS TALLA 40"],
    },
    "confirmar_inventario"
  ),
  casoCorrector(
    "proteccion",
    "proteccion es prefijo de PROTECCIONES.",
    { query: "proteccion" },
    null,
    { estado: "con_existencia", debeCotizar: ["PROTECCIONES CODOS RODILLAS NEGRAS"] },
    "confirmar_inventario"
  ),
];

// ---------------------------------------------------------------------------
// Lista de producción del 29/9/2026 (13:14 VE, cliente con una SBR 2025)
// ---------------------------------------------------------------------------

const CASOS_PRODUCCION: CasoA2[] = [
  {
    id: "produccion-29-9-lista-sbr-2025",
    seccion: "produccion",
    descripcion:
      'La lista real del 29/9: "caucho n° 18 delantero, caucho n° trasero, rodamiento, asiento, aceite" para una SBR 2025. Se cotiza el asiento (UNA, la de mayor existencia; D6) y el rodamiento (el único KIT RODAMIENTO BERA con existencia: nombra solo la MARCA del cliente, así que sirve con la línea «este es de BERA o universal»); los otros tres son "varias opciones" y NO se eligen. Una sola escalada `confirmar_inventario` con los cinco renglones en la nota. "caucho n° 18 delantero" se busca como «caucho 18».',
    llamada: {
      query: "",
      productos: ["caucho n° 18 delantero", "caucho n° trasero", "rodamiento", "asiento", "aceite"],
      motoBrand: "Bera",
      motoModel: "SBR 2025",
    },
    esperado: {
      items: [
        item({
          producto: "caucho n° 18 delantero",
          estado: "generico",
          avisos: ["varias_opciones"],
          nuncaCotizar: ["CAUCHO TRASERO 10 3.50 SCOOTER TIMSUN"],
        }),
        item({
          producto: "caucho n° trasero",
          estado: "generico",
          avisos: ["varias_opciones"],
          nuncaCotizar: [
            "CAUCHO TRASERO 10 3.50 SCOOTER TIMSUN",
            "CAUCHO TRASERO 10 3.00 SCOOTER TIMSUN",
            "CAUCHO TRASERO 10 90/90 SCOOTER BENF",
          ],
        }),
        item({
          producto: "rodamiento",
          estado: "con_existencia",
          debeCotizar: ["KIT RODAMIENTO BERA 38T"],
          avisos: ["universales"],
          nuncaCotizar: ["KIT RODAMIENTO KLR", "KIT RODAMIENTO HORSE", "KIT RODAMIENTO KAVAK"],
        }),
        item({
          producto: "asiento",
          estado: "con_existencia",
          debeCotizar: ASIENTO_SBR_DE_MAS_EXISTENCIA,
          nuncaCotizar: ["ASIENTO BERA SOCIALISTA COMPLETO", "ASIENTO HORSE NEGRO"],
        }),
        item({
          producto: "aceite",
          estado: "generico",
          avisos: ["varias_opciones"],
          nuncaCotizar: ["ACEITE ADITIVO TRATAMIENTO METALES SENFI", "ACEITE DE BASTONES 10W SENFI"],
        }),
      ],
      motivoEscalada: "confirmar_inventario",
      notaIncluye: ["caucho n° 18 delantero", "caucho n° trasero", "rodamiento", "asiento", "aceite"],
    },
    cambioDeliberado:
      "El plan (§6) y el operador escribieron «rodamiento → varias opciones (los KIT RODAMIENTO BERA no nombran SBR)». Con el refinamiento de M1 (marca sin modelo), KIT RODAMIENTO BERA 38T nombra solo la MARCA del cliente (bera) y es compatible: como es el único compatible con existencia, se cotiza (UNO) con la línea de universales de su marca. Si en producción los compatibles son más de tres, el ítem vuelve a ser «varias opciones». Consecuencia de la resolución 1 del orquestador; se avisa en el reporte de T5.",
  },
];

// ---------------------------------------------------------------------------
// «Ver todo» — frases que el cliente dice cuando no sabe precisar
// ---------------------------------------------------------------------------

/** Las frases del plan que `pideVerTodo` gana, cada una con su caso. */
export const FRASES_VER_TODO_A2: readonly string[] = [
  "no sé",
  "ni idea",
  "no tengo idea",
  "la que sea",
  "cualquiera",
  "el que tengas",
  "los que tengan",
  "no tengo marca",
  "recomiéndame",
  "cuál me recomiendas",
  "el más económico",
  "la más barata",
];

/** D6: los pedidos EXPLÍCITOS de ver opciones (`pideVerOpciones`); cada uno saca hasta tres. */
export const FRASES_VER_OPCIONES_A2: readonly string[] = [
  "muéstrame todas",
  "qué opciones hay",
  "cuáles tienes",
  "qué tienes",
];

const PRIMER_TURNO_INTERCOMUNICADOR: TurnoPrevioA2 = turnoPregunta(
  { query: "intercomunicador", dependeDeLaMoto: false },
  "intercomunicador",
  "producto"
);

const CASOS_VER_TODO: CasoA2[] = [
  ...FRASES_VER_TODO_A2.map(
    (frase, i): CasoA2 => ({
      id: `ver-todo-${String(i + 1).padStart(2, "0")}`,
      seccion: "ver-todo",
      descripcion: `"intercomunicador" y después «${frase}»: el cliente no sabe precisar (D6: NO es pedir opciones). UNA, la de mayor existencia (EJEAS V7 PRO, 8 u.); se escala. Nunca los 3 agotados.`,
      llamada: { query: "intercomunicador", dependeDeLaMoto: false },
      rafagaCliente: [frase],
      turnoPrevio: PRIMER_TURNO_INTERCOMUNICADOR,
      esperado: una(
        {
          estado: "con_existencia",
          debeCotizar: INTERCOMUNICADOR_DE_MAS_EXISTENCIA,
          nuncaCotizar: INTERCOMUNICADORES_PARA_CASCO,
        },
        "confirmar_inventario"
      ),
    })
  ),
  // D6: la ÚNICA excepción. Un pedido EXPLÍCITO de ver opciones saca hasta tres
  // con existencia, las de más existencia primero, sin «Hay N más».
  ...FRASES_VER_OPCIONES_A2.map(
    (frase, i): CasoA2 => ({
      id: `ver-opciones-${String(i + 1).padStart(2, "0")}`,
      seccion: "ver-todo",
      descripcion: `"intercomunicador" y después «${frase}»: el cliente pide EXPLÍCITAMENTE ver opciones (D6). Salen las TRES de mayor existencia (V7 PRO 8 u., V6 PRO 6 u., FREEDCONN 5 u.), sin «Hay N más»; se escala. Nunca los 3 agotados.`,
      llamada: { query: "intercomunicador", dependeDeLaMoto: false },
      rafagaCliente: [frase],
      turnoPrevio: PRIMER_TURNO_INTERCOMUNICADOR,
      esperado: una(
        {
          estado: "con_existencia",
          debeCotizar: TRES_INTERCOMUNICADORES,
          nuncaCotizar: INTERCOMUNICADORES_PARA_CASCO,
        },
        "confirmar_inventario"
      ),
    })
  ),
  {
    id: "ver-todo-13-ya-se-pregunto-sin-dato",
    seccion: "ver-todo",
    descripcion:
      '"intercomunicador" y después algo que no precisa ni pide ver todo ("ok, gracias"): ya se preguntó una vez y no se vuelve a preguntar; con el hotfix del 29/9 y D6 se entrega UNA, la de mayor existencia (EJEAS V7 PRO, 8 u.), y se escala.',
    llamada: { query: "intercomunicador", dependeDeLaMoto: false },
    rafagaCliente: ["ok, gracias"],
    turnoPrevio: PRIMER_TURNO_INTERCOMUNICADOR,
    esperado: una(
      {
        estado: "con_existencia",
        debeCotizar: INTERCOMUNICADOR_DE_MAS_EXISTENCIA,
        nuncaCotizar: INTERCOMUNICADORES_PARA_CASCO,
      },
      "confirmar_inventario"
    ),
    cambioDeliberado:
      "La resolución 5 del orquestador (T1) decía: ya se preguntó y no llegó un dato → estado `generico` con `varias_opciones` y escala SIN cotizar. El test (4) del hotfix del 29/9 (que se mantiene, por instrucción del orquestador) dice lo contrario: tras la pregunta, aunque el cliente no aporte nada, se entrega UNA. Se aplicó el hotfix; el orquestador decide si la resolución 5 debe volver.",
  },
];

// ---------------------------------------------------------------------------
// Todos
// ---------------------------------------------------------------------------

export const CASOS_A2: readonly CasoA2[] = [
  ...CASOS_2_1,
  ...CASOS_2_2,
  ...CASOS_2_3,
  ...CASOS_2_4,
  ...CASOS_2_5,
  ...CASOS_2_6,
  ...CASOS_2_7,
  ...CASOS_NO_REGRESION,
  ...CASOS_CORRECTOR,
  ...CASOS_PRODUCCION,
  ...CASOS_VER_TODO,
];
