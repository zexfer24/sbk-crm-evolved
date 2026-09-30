// ---------------------------------------------------------------------------
// Catálogo de prueba de la Entrega A2 — "Seba no cotiza lo que no es"
// (30/9/2026, plan `docs/planes/2026-09-30-seba-no-cotiza-lo-que-no-es.md`, T1).
//
// Son DATOS, no lógica: los nombres exactos de Saint (en MAYÚSCULAS) que el
// estudio del VPS del 29/9/2026 citó en los casos (`docs/planes/2026-09-30-
// seba-a2-casos-del-vps.md`, secciones 2.1 a 2.7 y la tabla de no regresión),
// con el stock que el caso da, MÁS el ruido que hoy los tapa. Lo consumen
// `casos-a2.ts` (los resultados esperados), `scripts/fixture-a2-sql.ts` (lo
// carga a la base con psql) y, después, el arnés de T7.
//
// Reglas de armado:
//
//   - EL RUIDO VA PRIMERO (`rol: "ruido"`), los correctos después. Es la
//     lección del 26/9/2026 (CLAUDE.md, "Un test SQL de orden tiene que
//     insertar el ruido ANTES que la fila correcta"): con las filas correctas
//     insertadas primero, un `limit` antes del `order` pasa en verde porque el
//     orden físico las favorece. Aquí "ruido" es toda fila que ningún caso
//     espera ver cotizada; "correcto", toda fila que algún caso espera ver
//     cotizada, mencionada como agotada o como «otra opción con existencia», y
//     sus hermanas de familia (para que el tope y el desempate por stock
//     tengan entre qué elegir).
//   - Nombre y stock: cada fila dice de dónde salen. "citado" = el nombre Y el
//     stock son los del documento del VPS; "nombre" = el nombre es el del
//     documento y el stock se inventó (el documento solo dice "con stock" o
//     "en 0" sin cifra, o no lo dice); sin marca = todo inventado para que el
//     caso tenga contra qué medirse (nombre plausible en el estilo de Saint).
//     El test de coherencia no distingue: es para el reporte y para quien
//     ajuste un stock.
//   - Precio en bolívares (`currency = 'VES'`, como llegan de Saint), siempre
//     > 0 (`buscar_productos` filtra `price > 0`), calculado de forma
//     determinista a partir del número de fila.
//   - Cada fila lleva un código `A2FIX-####`. La base NO tiene una columna
//     para él que sea segura: `saint_code` haría que `saint.sync_products()`
//     tratara la fila como vinculada y la diera de baja por ausencia donde
//     exista una fuente Saint, así que el código viaja en `description` y
//     `saint_code` queda `null` (ver `scripts/fixture-a2-sql.ts`).
// ---------------------------------------------------------------------------

export const PREFIJO_CODIGO_A2 = "A2FIX-";

export type RolProductoA2 = "ruido" | "correcto";

export interface ProductoA2 {
  /** `A2FIX-0001`… único. */
  codigo: string;
  /** El nombre exacto de Saint, en MAYÚSCULAS. */
  nombre: string;
  stock: number;
  /** Precio en bolívares. */
  precioBs: number;
  currency: "VES";
  rol: RolProductoA2;
  /** ¿El nombre es literal del documento de casos del VPS? */
  nombreCitado: boolean;
  /** ¿El stock es el que dice el documento? (si no, se inventó, coherente con el resultado esperado.) */
  stockCitado: boolean;
}

type OrigenA2 = "citado" | "nombre";
/** [nombre, stock, origen?] — sin origen, todo inventado. */
type FilaA2 = readonly [nombre: string, stock: number, origen?: OrigenA2];

// ===========================================================================
// RUIDO — va primero.
// ===========================================================================

/** Maletas de relleno (más de 15 con stock): tapan "maletas" para GR 250 y el genérico de "ibk 30 litros". Ninguna es de 30 ni de 45 litros. */
const MALETAS_DE_RELLENO: FilaA2[] = ["CUADRADA", "REDONDA"].flatMap((forma, f) =>
  [36, 40, 42, 48, 50, 52, 55, 60].map((litros, i): FilaA2 => [
    `MALETA ${forma} ${litros} LTS ${["NEGRA", "GRIS OSCURO", "BLANCA", "ROJA"][(i + f) % 4]} ${["FEDERAL", "TOMCAT", "GP"][(i + 2 * f) % 3]}`,
    3 + ((i * 5 + f * 3) % 11),
  ])
);

/** Las 16 tapas laterales de la Bera SBR (8 colores × 2 lados): "tapas laterales blanca" para una Milan las cotizaba ("y 15 más"). */
const TAPAS_LATERALES_SBR: FilaA2[] = ["BLANCA", "NEGRA", "ROJA", "AZUL", "GRIS", "AMARILLA", "NARANJA", "VERDE"].flatMap(
  (color, i): FilaA2[] => [
    [`TAPA LATERAL BERA SBR ${color} DERECHA`, 2 + ((i * 3) % 7)],
    [`TAPA LATERAL BERA SBR ${color} IZQUIERDA`, 2 + ((i * 3 + 1) % 7)],
  ]
);

const RUIDO_FILAS: FilaA2[] = [
  // --- Defensas de otras motos (2.1: "defensa, parrilla" para DT250; "defensas" Beta León; "defensa" Toro Rex; defensa gxs 250) ---
  ["DEFENSA BRZ 250", 5, "nombre"],
  ["DEFENSA KAVAK", 4],
  ["DEFENSA KLR 650", 3],
  ["DEFENSA VSTROM 650", 2],
  ["DEFENSA DR650", 2],
  ["DEFENSA BERA SBR", 6],
  ["DEFENSA EK OWEN", 3],
  ["DEFENSA GR250", 3],

  // --- Parrillas de otras motos ---
  ["PARRILLA TRASERA BRZ 250", 3],
  ["PARRILLA KLR 650", 2],
  ["PARRILLA VSTROM 650", 2],
  ["PARRILLA BERA SBR", 5],
  ["PARRILLA GR250", 2],
  ["PARRILLA HORSE", 4],
  ["PARRILLA EK OWEN", 3],

  // --- Amortiguadores de otras motos (2.1: "amortiguadores", MD Aguila 2014) ---
  ["AMORTIGUADOR BERA SOCIALISTA", 5, "nombre"],
  ["AMORTIGUADOR TRASERO BWS150", 4, "nombre"],
  ["AMORTIGUADOR TRASERO KAVAK 150", 3],
  ["AMORTIGUADOR TRASERO HORSE", 2],
  ["AMORTIGUADOR DELANTERO EK OWEN", 3],

  // --- Baterías de otras motos (2.1: lista "batería, arranque" para Bera Socialista) ---
  ["BATERIA VSTROM 650", 4, "nombre"],
  ["BATERIA DR650", 3, "nombre"],
  ["BATERIA GY6 150", 5, "nombre"],

  // --- Arranque de otras motos ---
  ["MOTOR DE ARRANQUE BERA SBR", 4],
  ["MOTOR DE ARRANQUE HORSE", 3],
  ["MOTOR DE ARRANQUE KAVAK", 2],

  // --- Tacómetros: los de otras motos, y el universal analógico (2.1: "tacómetro digital" para BRZ; `taco` calza con TACOMETRO) ---
  ["TACOMETRO DIGITAL GR250", 4, "nombre"],
  ["TACOMETRO DIGITAL KAVAK", 3, "nombre"],
  ["TACOMETRO DIGITAL OWEN", 3, "nombre"],
  ["TACOMETRO DIGITAL BERA SBR", 6],
  ["TACOMETRO ANALOGO UNIVERSAL", 4],

  // --- Posapiés (de otras motos: para Runner 6G) ---
  ["POSAPIES DELANTERO BERA SBR", 4],
  ["POSAPIES TRASERO HORSE", 3],
  ["POSAPIES KAVAK", 3],

  // --- Tapas laterales de la SBR (2.1: "tapas laterales blanca" para una Milan) ---
  ...TAPAS_LATERALES_SBR,

  // --- Tubos de escape de otras motos (2.1: "tubo de escape" para EK horsen) ---
  ["TUBO ESCAPE EK EXPRESS", 4, "nombre"],
  ["TUBO ESCAPE EK OWEN", 3, "nombre"],
  ["TUBO ESCAPE KAVAK", 2],
  ["TUBO ESCAPE GN125", 2],

  // --- Maletas: la de 34 LTS "GRIS" (la moto `gr` no puede calzar con GRIS) y el relleno ---
  ["MALETA REDONDA 34 LTS TOMCAT GRIS", 4, "nombre"],
  ...MALETAS_DE_RELLENO,

  // --- Tanques que tapan al correcto (2.5 y 2.3) ---
  ["TANQUE OWEN 2014 AZUL", 4, "nombre"],
  ["TANQUE EK XPRESS II 2024 AZUL", 6, "nombre"],

  // --- Cauchos y tripas ---
  // 120/70 con stock: otra medida que "130 - 70 - 12" tomaba por cilindrada.
  ["CAUCHO 12 120/70 TIMSUN", 4],
  ["CAUCHO 13 120/70 BENF", 3],
  ["CAUCHO 12 120/70 JEREZ", 5],
  // Rin 10 de scooter: los cotizaban como "caucho trasero".
  ["CAUCHO TRASERO 10 3.50 SCOOTER TIMSUN", 6],
  ["CAUCHO TRASERO 10 3.00 SCOOTER TIMSUN", 5],
  ["CAUCHO DELANTERO 10 3.00 SCOOTER TIMSUN", 5],
  ["CAUCHO TRASERO 10 90/90 SCOOTER BENF", 4],
  // Más de 3 cauchos y tripas rin 18 con stock: "caucho n° 18" y "tripa de moto n° 18".
  ["CAUCHO 18 2.75 TIMSUN", 8],
  ["CAUCHO 18 3.00 TIMSUN", 6],
  ["CAUCHO 18 90/90 TIMSUN", 7],
  ["CAUCHO 18 110/90 BENF", 4],
  ["CAUCHO 18 2.50 JEREZ", 3],
  ["TRIPA 18 3.00 MOTOR POWER", 540, "citado"],
  ["TRIPA 18 2.75 MOTOR POWER", 120],
  ["TRIPA 18 2.50 GENERICA", 60],
  ["TRIPA 18 3.50 MOTOR POWER", 30],

  // --- Aceites que no son lo que se pidió (producción 29/9: "aceite") ---
  ["ACEITE ADITIVO TRATAMIENTO METALES SENFI", 5, "nombre"],
  ["ACEITE DE BASTONES 10W SENFI", 6, "nombre"],
  ["ACEITE MOTUL 5000 20W50 4T", 5],
  ["ACEITE MOTUL 5000 10W40 4T", 4],

  // --- Rodamientos que no nombran SBR (producción 29/9: "rodamiento") ---
  ["KIT RODAMIENTO KLR", 3, "nombre"],
  ["KIT RODAMIENTO HORSE", 4],
  ["KIT RODAMIENTO KAVAK", 2],

  // --- Asientos de otras motos ---
  ["FORRO ASIENTO EK EXPRESS", 0, "citado"],
  ["ASIENTO BERA SOCIALISTA COMPLETO", 4],
  ["ASIENTO HORSE NEGRO", 6],
  ["ASIENTO KAVAK DOBLE", 3],
  ["ASIENTO EK OWEN", 5],
  ["GOMA ASIENTO UNIVERSAL TRACTOR", 8],

  // --- Rines con paleta (7 en total con el correcto de EK XPRESS) y otros rines ---
  ["RIN TRASERO EK XPRESS PALETA", 19, "citado"],
  ["RIN TRASERO PALETA HORSE", 6],
  ["RIN TRASERO PALETA KAVAK", 4],
  ["RIN DELANTERO PALETA HORSE", 3],
  ["RIN TRASERO PALETA GS150", 5],
  ["RIN TRASERO PALETA EK OWEN", 2],
  ["RIN DELANTERO PALETA KAVAK", 3],
  ["RIN DELANTERO BERA KAVAK ALDRICH", 3],
  ["RIN TRASERO BERA SBR", 5],

  // --- Cascos que no son el pedido ---
  ["VISERA CASCO FRANKIE", 10, "nombre"],
  ["CASCO FRANKIE NEGRO TALLA M", 5],
  ["CASCO FRANKIE ROJO MATE", 3],
  ["CASCO FRANKIE NEGRO BRILLANTE", 4],
  ["CASCO ELECTRON SIRIUS L/XL", 5, "nombre"],
  ["CASCO INTEGRAL NEGRO MATE M", 6],
  ["CASCO ABIERTO BLANCO L", 5],
  ["CASCO LS2 FF353 NEGRO", 4],
  ["CASCO GIVI H50.7 FLIP", 3],

  // --- Intercomunicadores agotados (el falso agotado de "para parejas") ---
  ["INTERCOMUNICADOR PARA CASCO BLUETOOTH 1000M", 0, "nombre"],
  ["INTERCOMUNICADOR PARA CASCO BLUETOOTH 800M", 0, "nombre"],
  ["INTERCOMUNICADOR PARA CASCO IMPERMEABLE V6", 0, "nombre"],

  // --- El corrector cambiaba por estos ---
  ["LIGA FRENO LATA", 6, "nombre"],
  ["KIT REPARACION CALIPER OWEN", 4, "nombre"],
  ["COMPRESOR AIRE PORTATIL 12V", 4],
  ["CINTA AISLANTE 3M NEGRA", 10],
  ["GUAYA ACELERADOR UNIVERSAL", 6],
  ["LUZ CRUCE CROMADO", 4, "nombre"],

  // --- Calipers (más de tres con stock, ninguno "scooter") ---
  ["CALIPER FRENO DELANTERO BERA SBR", 5],
  ["CALIPER FRENO DELANTERO HORSE", 4],
  ["CALIPER FRENO DELANTERO KAVAK", 3],
  ["CALIPER FRENO DELANTERO EK OWEN", 3],
  ["CALIPER FRENO TRASERO GN125", 2],

  // --- Palabras que existen en el catálogo pero nunca junto a la cabeza del pedido (D3, co-ocurrencia) ---
  ["BOMBA FRENO DELANTERO HORSE", 3],
  // Fila de OTRO producto que menciona «aceite» y nombra la SBR (T5b, 30/9/2026): con «aceite»
  // para una SBR, la moto "calzaba" con esta ÚNICA fila y se cotizaba una bomba en vez de un
  // aceite. T5 la había renombrado para esconderlo; M1 ahora calcula si la moto calza solo entre
  // las filas que EMPIEZAN con el producto, y esta fila queda como el caso de regresión.
  ["BOMBA DE ACEITE BERA SBR", 4],
  ["PORTA PLACA UNIVERSAL", 6],
  ["PORTA CELULAR MANILAR", 8],
  ["CARBURADOR PZ27 HORSE", 5],
  ["CARBURADOR CORTINA PLANA 26MM", 3],
  ["CILINDRO COMPLETO HORSE PASADOR GRUESO MP", 3],
  ["KIT CILINDRO PISTON BERA SBR", 4],

  // --- Pastillas de otras motos ---
  ["PASTILLA FRENO DELANTERO BERA SBR 200", 4],
  ["PASTILLA FRENO DELANTERO YAMAHA YBR 125", 4],
  ["PASTILLA FRENO DELANTERO SUZUKI GN125", 4],
  ["PASTILLA FRENO DELANTERO HONDA CBF150", 4],

  // --- Guardafangos de otras motos ---
  ["GUARDAFANGO DELANTERO BERA SBR", 6],
  ["GUARDAFANGO TRASERO KAVAK", 3],

  // --- Cadenas y picos de pato de otras motos ---
  ["CADENA 428 DID 120L", 8],
  ["PICO PATO BERA SBR", 4],
  ["PICO PATO HORSE", 3],
  ["PICO PATO KAVAK", 3],
  ["PICO PATO EK OWEN", 2],

  // --- Faros y luces LED (genéricos: "foco" y "Búhos LED") ---
  ["FARO DELANTERO HORSE", 6],
  ["FARO DELANTERO BERA SBR", 5],
  ["FARO DELANTERO KAVAK", 4],
  ["FARO AUXILIAR UNIVERSAL 12V", 7],
  ["BOMBILLO LED H4 12V", 10],
  ["BOMBILLO LED H7 12V", 6],
  ["FLECHA DIRECCIONAL LED", 8],

  // --- Corona: las de 45T (5 con stock) nombran motos ---
  ["CORONA 45T BERA SBR", 7],
  ["CORONA 45T KAVAK", 5],
  ["CORONA 45T GR250", 4],
  ["CORONA 45T TX200", 6],
  ["CORONA 45T DT200", 3],
  ["CORONA 36T BERA SBR", 5],

  // --- Piñones de otras motos ---
  ["PIÑON 14T BERA SBR", 12],
  ["PIÑON 14T HORSE 200", 9],
  ["PIÑON 14T KAVAK", 5],
  ["PIÑON 17T BERA SBR", 6],
  ["PIÑON 17T KAVAK", 4],

  // --- dt200 no puede calzar DT2000 ---
  ["MAGNETO DT2000 MS", 5],

  // Nota: las chaquetas (las dos EDGE y las otras ocho) y las botas son TODAS
  // "correcto": los casos de variante agotada citan tanto las agotadas como
  // las "otras opciones con existencia" de su misma familia.
];

// ===========================================================================
// CORRECTOS — después del ruido.
// ===========================================================================

const CORRECTOS_FILAS: FilaA2[] = [
  // --- 2.1 Moto que no calza / calza ---
  ["DEFENSA DELANTERA SUPER DT LEFOR", 6, "citado"],
  // A2 T5 (resolución 1 del orquestador): estas dos NOMBRAN SOLO MARCAS (jaguar/bera, bera) y un
  // cliente de marca bera las puede recibir con la línea «de BERA o universal»: por eso ya no son
  // ruido, son lo que un caso espera ver cotizado.
  ["BATERIA SECA JAGUAR/BERA 12N6.5", 116, "citado"],
  ["KIT RODAMIENTO BERA 38T", 5, "nombre"],
  ["PARRILLA KAVAK LEFOR", 14, "citado"],
  ["MOTOR DE ARRANQUE BERA SOCIALISTA", 3],
  ["TACOMETRO DIGITAL UNIVERSAL", 5, "nombre"],
  ["TAPA LATERAL MILAN AZUL", 4, "nombre"],
  ["TAPA LATERAL MILAN NEGRO", 6, "nombre"],
  ["TAPA LATERAL MILAN FUCSIA", 2, "nombre"],
  ["TUBO ESCAPE HORSE 1 TORNASOL", 8, "citado"],
  ["TUBO ESCAPE BERA SBR 200 NEGRO", 7],
  ["TUBO ESCAPE BERA SBR 200 CROMADO", 3],

  // --- 2.1 y 2.3: amortiguadores de la SBR (5 con existencias distintas; "un sbr 2023" cotizaba estos 5) ---
  ["AMORTIGUADOR TRASERO BERA SBR ALDRICH", 12],
  ["AMORTIGUADOR TRASERO BERA SBR AUTOASIA", 8],
  ["AMORTIGUADOR DELANTERO BERA SBR", 6],
  ["AMORTIGUADOR BASTON BERA SBR", 4],
  ["AMORTIGUADOR TRASERO GAS BERA SBR", 2],

  // --- 2.2 y 2.7: maletas del correcto ---
  ["MALETA CUADRADA 45LTS PLATA", 9, "citado"],
  ["MALETA CUADRADA 45 LTS NEGRA FEDERAL", 6, "nombre"],
  ["MALETA REDONDA 30 LITROS NEGRA", 2, "citado"],

  // --- 2.3 Medidas ---
  ["CAUCHO 12 130/70 TIMSUN", 0, "nombre"],
  ["CAUCHO 12 130/70 BENF", 0, "nombre"],
  ["CAUCHO 13 130/60 BENF", 7, "citado"],
  ["CAUCHO 13 130/60 JEREZ FIRE", 3, "citado"],
  ["CAUCHO 19 90/90 TS712 TIMSUN", 4, "citado"],
  ["CAUCHO 17 90/90 TIMSUN PISTA", 5],
  ["CAUCHO 21 2.75 TIMSUN", 5],
  ["CAUCHO 21 80/100 BENF", 3],
  ["TRIPA 17 130/80/17 CARKMOTOS", 21, "citado"],
  ["ACEITE MOTUL 5100 20W50 4T", 8],
  ["ACEITE MOTUL 5100 15W50 4T", 6],
  ["PANTALLA GPS 7PULGADAS UNIVERSAL", 3],
  ["PANTALLA MONITOR 7PUL ANDROID", 2],

  // --- Aceites del caso de no regresión ---
  ["ACEITE INCA 20W50 4T", 9],
  ["ACEITE OILSTONE 4T 20W50 1L", 7],
  ["ACEITE IPONE 20W50 4T", 12],

  // --- Coronas y piñones (relación, corona de 45, piñón de 14 con reborde) ---
  ["CORONA 36T HORSE", 200, "citado"],
  ["CORONA 41T EK OWEN", 4],
  ["PIÑON 14T HJ COOL ALDRICH", 3, "citado"],
  ["PIÑON 14T EK OWEN", 6],
  ["PIÑON 17T HORSE", 8],

  // --- Rolineras (lista "rolinera 6301 / 6302 / 6202": las tres cotizadas) ---
  ["ROLINERA 6301 2RS", 12],
  ["ROLINERA 6302 2RS", 9],
  ["ROLINERA 6202 2RS", 10],

  // --- Asientos ---
  ["ASIENTO SBR /SOC ORIGINAL", 7],
  ["ASIENTO SBR NEGRO ALDRICH", 15],
  ["ASIENTO SBR ROJO ALDRICH", 4],
  ["ASIENTO SBR AZUL LEFOR", 11],
  ["ASIENTO SBR GRIS/NEGRO AUTOASIA", 2],
  ["ASIENTO SBR ORIGINAL BENF", 9],
  ["ASIENTO EK XPRESS BENF", 2, "citado"],

  // --- 2.5 Variantes: tanques, rines, chaquetas, cascos ---
  ["TANQUE SBR ROJO", 5],
  ["TANQUE SBR BLANCO", 3],
  ["TANQUE SBR AZUL", 0],
  ["TANQUE SBR 2024 AZUL", 0],
  ["TANQUE SBR GRIS", 0],
  ["TANQUE SBR 2024 GRIS", 0],
  ["TANQUE RKV 200 NEGRO", 0],
  ["TANQUE RKV 200 ROJO", 0],
  ["TANQUE RKV 200 AZUL", 0],
  ["TANQUE RKV 200 BLANCO", 0],
  // "RAYO" en singular (y "RAYOS" en el otro): el corrector de M2 solo acepta "rayo" para "rallo"
  // por sonido si la palabra "rayo" existe en el vocabulario del catálogo.
  ["RIN TRASERO HORSE RAYO", 4],
  ["RIN DELANTERO HORSE RAYOS", 3],
  ["CHAQUETA EDGE NEGRA", 0, "nombre"],
  ["CHAQUETA EDGE GRIS", 0, "nombre"],
  ["CHAQUETA CORDURA NEGRA XXL", 3],
  ["CHAQUETA MALLA VERANO NEGRA", 12],
  ["CHAQUETA CORDURA IMPERMEABLE ROJA", 9],
  ["CHAQUETA PROTECCION CUERO NEGRA", 7],
  ["CHAQUETA ANTIFRICCION GRIS", 5],
  ["CHAQUETA URBANA NEGRA L", 4],
  ["CHAQUETA IMPERMEABLE AMARILLA", 2],
  ["CHAQUETA TERMICA INVIERNO", 1],
  ["CASCO EDGE NEGRO MATE", 4],
  ["CASCO EDGE BLANCO", 2],
  ["CASCO FRANKIE NEGRO MATE V/AZUL", 2, "citado"],
  ["CASCO GIVI H11.7", 4, "nombre"],
  ["CASCO SIRIUS 3120 NEGRO MATE", 1, "citado"],

  // --- Botas: 7 impermeables en 0 (siete botas en cero) y dos de cuero con stock ---
  ["BOTAS IMPERMEABLES NEGRAS TALLA 38", 0],
  ["BOTAS IMPERMEABLES NEGRAS TALLA 39", 0],
  ["BOTAS IMPERMEABLES NEGRAS TALLA 40", 0],
  ["BOTAS IMPERMEABLES NEGRAS TALLA 41", 0],
  ["BOTAS IMPERMEABLES NEGRAS TALLA 42", 0],
  ["BOTAS IMPERMEABLES NEGRAS TALLA 43", 0],
  ["BOTAS IMPERMEABLES NEGRAS TALLA 44", 0],
  ["BOTAS CUERO NEGRAS TALLA 40", 3],
  ["BOTAS CUERO NEGRAS TALLA 41", 2],

  // --- Intercomunicadores con stock (5): "para parejas" no puede salir agotado ---
  ["INTERCOMUNICADOR EJEAS V7 PRO", 8, "citado"],
  ["INTERCOMUNICADOR EJEAS V6 PRO", 6],
  ["INTERCOMUNICADOR FREEDCONN TCOM", 5],
  ["INTERCOMUNICADOR BLUETOOTH UNIVERSAL 2 CASCOS", 4],
  ["INTERCOMUNICADOR MOTO BT 5.0 IMPERMEABLE", 3],

  // --- 2.6 Palabra obligatoria que no está en el nombre ---
  ["MANGUERA FRENO DELANTERO BERA L&J", 0, "nombre"],
  ["CARBURADOR CORTINA PLANA 30MM", 4, "nombre"],
  ["CILINDRO COMPLETO HORSE PASADOR FINO MP", 2, "nombre"],
  ["SLIDER PROTECTOR MOTOR UNIVERSAL", 5],
  ["SLIDER ANTICAIDAS TRASERO UNIVERSAL", 3],
  ["CUBRE LEVAS LED", 31, "citado"],

  // --- 2.4 y tabla del corrector ---
  ["CADENA 428 MOTORPOWER 120L", 10],
  ["CIGUEÑAL HORSE 150", 3],
  ["CIGUEÑAL BERA SBR", 2],
  ["PUÑOS SWITCHERA NEGROS", 5],
  ["PLACA DIENTES ARRASTRE UNIVERSAL", 3],
  ["BRAZOS SWING BERA SBR", 2],
  ["MANGAS TERMICAS CICLISTA", 4],
  ["BIDONES PLASTICOS 20 LITROS GASOLINA", 6],
  ["PROTECCIONES CODOS RODILLAS NEGRAS", 5],

  // --- No regresión ---
  ["PASTILLA FRENO DELANTERO GR250", 6],
  ["PASTILLA FRENO TRASERA GR250", 4],
  ["PASTILLA FRENO DELANTERO EMPIRE GS 150", 4],
  ["PASTILLA FRENO DELANTERO KAVAK MOTOR 150", 5],
  ["GUARDAFANGO DELANTERO HORSE NEGRO", 9],
  ["GUARDAFANGO DELANTERO HORSE ROJO", 7],
  ["GUARDAFANGO TRASERO HORSE", 5],
  ["GUARDAFANGO DELANTERO HORSE AZUL", 3],
  ["GUARDAFANGO TRASERO HORSE 1 GRIS", 2],
  ["MAGNETO DT200 MS", 5],
  ["DISCO FRENO DELANTERO DT200 VIEJO ALDRIC", 2],

  // --- 2.7 Sinónimos ---
  ["PASAMONTAÑA BUFF MUJER", 3, "citado"],
  ["PASAMONTAÑA TERMICO NEGRO", 6],
  ["RETROVISOR UNIVERSAL NEGRO PAR", 10],
  ["RETROVISOR HORSE ALUMINIO", 4],
  ["LUZ CRUCE HORSE 1", 20, "citado"],
  ["BASE MALETA COLORES GP", 6],
  ["BASE MALETA UNIVERSAL", 5],
  ["PICO PATO GR250", 12, "citado"],
  ["EMPACADURA CULATA BERA SBR", 6],
  ["EMPACADURA TAPA MOTOR HORSE", 4],
  ["ESCUDA PARAMOTOR UNIVERSAL", 3],
];

// ===========================================================================
// Armado
// ===========================================================================

function armar(filas: FilaA2[], rol: RolProductoA2, desde: number): ProductoA2[] {
  return filas.map(([nombre, stock, origen], i) => {
    const n = desde + i;
    return {
      codigo: `${PREFIJO_CODIGO_A2}${String(n).padStart(4, "0")}`,
      nombre,
      stock,
      // Determinista, siempre > 0 y con dos decimales: el precio no decide ningún caso.
      precioBs: Math.round((90 + ((n * 137) % 4200) + (n % 10) / 10) * 100) / 100,
      currency: "VES",
      rol,
      nombreCitado: origen === "citado" || origen === "nombre",
      stockCitado: origen === "citado",
    };
  });
}

/** El catálogo completo, EN EL ORDEN EN QUE SE INSERTA: el ruido primero. */
export const CATALOGO_A2: readonly ProductoA2[] = [
  ...armar(RUIDO_FILAS, "ruido", 1),
  ...armar(CORRECTOS_FILAS, "correcto", RUIDO_FILAS.length + 1),
];
