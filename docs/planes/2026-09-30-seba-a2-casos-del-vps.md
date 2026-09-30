# Entrega A2: los casos medidos por el VPS (29/9/2026)

Esta es la fuente de los casos de prueba de la A2. Se copió tal cual del prompt que
redactó el Claude del VPS, y va con las correcciones del operador al final.
El plan aprobado está en `2026-09-30-seba-no-cotiza-lo-que-no-es.md`.

Todo lo que sigue se verificó contra `products` el 29/9.

## Caso real de producción (29/9, 13:14 VE)

Un cliente con una SBR 2025 mandó esta lista:

- Caucho n° 18 delantero
- Caucho n° trasero
- Rodamiento
- Asiento
- Aceite

Seba le cotizó:

- cauchos **rin 10 de scooter** como "caucho trasero";
- kits de rodamiento Bera 38T y KLR como "rodamiento";
- "ACEITE ADITIVO TRATAMIENTO METALES SENFI" y un aceite de bastones como "aceite".

El "caucho n° 18" dio no identificado porque se unió en `n18`, y hay más de 500 tripas y
cauchos 18. El único acierto fue el asiento SBR.

## 2.1 Cotiza productos de otra moto (16 casos peor; es lo más grave)

Pasa cuando la moto del cliente no calza con ningún nombre y la consulta sale "sin
pregunta" (en una lista, o porque ya se preguntó). Ahí `tools.ts` cotiza las 3 primeras
con stock. La base las ordena por nombre, así que salen las primeras del alfabeto: BRZ,
KAVAK, KLR.

- **Lista "defensa, parrilla" para DT250.** Cotiza defensas BRZ, Kavak y KLR, y parrillas
  de otras motos. Existe DEFENSA DELANTERA SUPER DT LEFOR, con 6 u.
- **"amortiguadores", MD Aguila 2014** (después de la pregunta). Cotiza amortiguadores
  BERA SBR, BERA SOCIALISTA y BWS150.
- **Lista "batería, arranque" para Bera Socialista.** Cotiza baterías VSTROM, DR650 y GY6.
  Existe BATERIA SECA JAGUAR/BERA 12N6.5, con 116 u.
- **Lista "tacómetro digital" para BRZ.** Cotiza tacómetros GR250, KAVAK y OWEN. Hay uno
  digital universal con 5 u.
- **Otros casos del mismo tipo:**
  - lista "parrilla, defensa" para Tigrito;
  - "defensas" para Beta León;
  - "rin trasero" para Bera New Runner;
  - "defensa" para Toro Rex;
  - "posapiés, caucho" para Runner 6G.
- **Aceite y caucho genéricos dentro de una lista** (el caso de producción): cotiza
  aditivos o cauchos de cualquier rin.

**La marca sola hace calzar la moto.**

- **"tapas laterales blanca", Bera Milan.** Calza "bera" y cotiza tapas Bera SBR ("y 15
  más"). TAPA LATERAL MILAN existe (azul, negro y fucsia), pero no dice "bera".
- **"tubo de escape", EK horsen.** Calza "ek" y cotiza TUBO ESCAPE EK EXPRESS y EK OWEN.
  TUBO ESCAPE HORSE 1 TORNASOL tiene 8 u.

## 2.2 La moto calza por pedazo de palabra

"maletas" para **GR 250**: la moto `gr` calza con "**GR**IS". Cotiza solo MALETA REDONDA
34 LTS TOMCAT GRIS, cuando hay 15 maletas con stock.

La moto tiene que calzar como palabra entera o seguida de dígitos: GR250 sí, GRIS no.

## 2.3 Medidas, números y años

**Medida con espacios.** "caucho 130 - 70 - 12" toma el **130 como cilindrada** y cotiza
cauchos **120/70**, que es otra medida, con stock. Los 130/70-12 existen y están en 0, así
que tenía que salir agotado.

Estos formatos tienen que leerse igual: `130/70-12`, `130/70/12`, `130 70 12`,
`130-70-12`, `130 - 70 - 12`, `130/60/R13`, `130/60 R13`, `130-80-17`, `90 90 19`.

**El rin.** En "R13", "rin 17", "#17", "n° 18", "nº18" y "numero 18", el rin es el
número. Hoy "r13", "n18" o "rin" quedan obligatorios y dan no identificado:

- "caucho 130/60/R13". Hay CAUCHO 13 130/60 BENF con 7 u. y JEREZ FIRE con 3 u.
- "tripa de moto n° 18". Hay TRIPA 18 3.00 MOTOR POWER, con 540 u.
- "tripa trasera rin 130-80-17". Hay TRIPA 17 130/80/17 CARKMOTOS, con 21 u.

**Número con sufijo.** "corona de 45" no calza con **CORONA 45T**, y hay 5 con stock.
"piñón 14" no calza con "PIÑON 14T".

Regla sugerida: un número calza con una palabra que empieza con ese número seguido de
**letras** (45T, 30MM, 4PULGADAS), nunca seguido de dígitos. Así 50 sigue sin calzar con
5000, que es lo que arregló la A.

**"20:50".** No se lee como `20w50`: "motul 5100 20:50" antes cotizaba y hoy no encuentra
nada. "20/50", "20-50" y "20 50" ya funcionan.

**Años obligatorios.** Un año (`19xx`/`20xx`) es de la moto; nunca es un término
obligatorio del producto.

- "un sbr 2023", respuesta suelta después de "amortiguador": exige `2023` y no encuentra
  nada. Antes cotizaba 5 amortiguadores SBR.
- "rojo 2014" después de "tanque rkv": exige `2014` y calza con TANQUE **OWEN 2014** AZUL.
- "Bera Dt 2014" después de "batería": une `dt2014`.
- "GR 2025", "Empire GS 2026" y "bera kavak 2025": sin resultados.
- "24" como respuesta a la pregunta por el año, en "asiento sbr": exige `24` y no
  encuentra nada. La nota de la Entrega A lo probó con "24" como medida (guardafango);
  como año falla.

**Tallas y unidades.**

- "2XL" ↔ XXL.
- "litros"/"litro" ↔ LTS (ver 2.7). Saint escribe "45LTS" pegado: MALETA CUADRADA 45LTS
  PLATA, con 9 u.
- "7 pulgadas" ↔ "7PULGADAS"/"7PUL".
- "58cm" en cascos es una talla: no puede ser obligatorio.

## 2.4 El corrector de tipeos empeora (7 casos peor, 3 igual)

El segundo intento cambia palabras válidas por otras que sí existen en el catálogo, y el
reintento "encuentra" algo equivocado:

- **"intercomunicador para parejas".** `pareja`→**`para`**, y sale **agotado** con 3
  "INTERCOMUNICADOR PARA CASCO" en 0. Hay 5 intercomunicadores con stock (EJEAS V7 PRO, 8
  u.). **Es un agotado falso.**
- **"llanta".** `lata`, y cotiza LIGA FRENO LATA.
- **"relación", Owen EK.** `reparacion`, y cotiza KIT REPARACION CALIPER OWEN. Lo mismo
  "relación 17 por 36" para Horse: debía buscar corona 36T HORSE (200 u.) y piñón 17T.
- **"casco Frankie negro vicera azul".** `visera`, y cotiza VISERA CASCO FRANKIE. Se
  pierde CASCO FRANKIE NEGRO MATE V/AZUL (2 u.).
- **"carplay"** → `cara`; **"caucho kenda 70/120"** → `anda`; **"cascos dama negro"** →
  `gama`.
- **Otros:** frente→freno, compresion→compresor, guarda→guaya, alante→aislante,
  numero→nuevo, medida→media.
- **El corrector vuelve a pluralizar el singular que armó el propio código:**
  diente→dientes, brazo→brazos, manga→mangas, bidon→bidones, bota→botas,
  proteccion→protecciones.

**Tienen que seguir funcionando:** horsen→horse, tisum/stinsun→timsun, iphone→ipone,
swhera→switchera, motopower→motorpower, siriu→sirius, rallo→rayo, ciguañal→cigueñal. Y
"beta" sigue protegida.

## 2.5 El opcional que calza entero se pierde entre los demás

Cuando el cliente da un color o variante ("azul", "gris", "paleta", "edge") y hay filas
que lo tienen, esas filas deberían mandar. Hoy el opcional solo ordena, y lo tapan el tope
de 3, el desempate por stock o la pregunta de filtro:

- **"tanque azul", SBR 2024.** Los tanques SBR azules (agotados) desaparecen. Cotiza EK
  XPRESS II 2024 azul (otra moto) y SBR rojos. Tenía que decir que en azul están
  agotados.
- **"tanque gris", SBR.** Los dos grises están en 0, y cotiza rojos y blanco sin decirlo.
- **"rin trasero de paleta", TX250.** 7 filas calzan rin y paleta, así que es genérico y
  pregunta. Antes cotizaba el único RIN TRASERO EK XPRESS PALETA (19 u.).
- **"chaqueta EDGE".** Hay 10 chaquetas, así que pregunta. Las 2 Edge existen y están
  agotadas.
- **"EDGE"** (respuesta suelta sobre un casco): cotiza ELECTRON SIRIUS L/XL.

## 2.6 Palabra obligatoria que no está en el nombre (25 casos igual y 6 peor)

Es la clase más grande que queda. La marca tiene que seguir siendo obligatoria (el caso
Inca no puede volver), pero hay palabras que no son ni producto ni marca y tumban la
búsqueda:

- **"manguera de bomba de freno delantero", Bera Socialista** → MANGUERA FRENO DELANTERO
  BERA L&J. Antes cotizaba; hoy está en 0, así que tenía que salir agotada.
- **"carburador pwk 30mm cortina plana"** → CARBURADOR CORTINA PLANA 30MM. Antes
  cotizaba; hoy está en 0. "pwk" no aparece en ningún nombre del catálogo.
- **"kit de cilindro pasador fino"** → CILINDRO COMPLETO HORSE PASADOR FINO MP. Antes
  cotizaba; hoy está en 0.
- **"ibk 30 litros"** → MALETA REDONDA 30 LITROS NEGRA, 2 u. Antes cotizaba.
- **Otros casos, con el producto esperado cuando se conoce:**
  - "caliper de freno **scooter**" (hay 45 calipers);
  - "tubo de escape con **silenciador**" SBR;
  - "parrilla con **porta alforjas**" Kavak → PARRILLA KAVAK LEFOR, 14 u.;
  - "aceite de **motor**";
  - "slider **giratorio**";
  - "piñón de 14 con **reborde** de 11" HJ Cool → PIÑON 14T HJ COOL ALDRICH, 3 u.;
  - "ICH Sirius **abatible** 3120 negro mate" → CASCO SIRIUS 3120 NEGRO MATE, 1 u.;
  - "caucho 90 90 19 **semitaco**" → CAUCHO 19 90/90 TS712 TIMSUN, 4 u.;
  - "Búhos **LED**";
  - "casco gris **plata**";
  - "botas talla **39**".
- **El patrón:** casi siempre es un complemento unido al producto por "de", "con" o
  "para", o una palabra que no aparece en **ningún** nombre del catálogo.

**Palabra corta que calza con otra familia.** "semi taco": `taco` calza con **TACO**METRO
y cotiza tacómetros. "tipo de cros": `cro` calza con LUZ CRUCE **CRO**MADO. El singular de
una palabra corta no puede dejar un prefijo de 3 letras que calce con cualquier cosa.

## 2.7 Sinónimos que faltan

Son contenido, no código, pero hoy causan **agotados falsos**.

| Sinónimo | Producto que existe |
|---|---|
| **express → xpress** | "asiento express" sale agotado con el FORRO ASIENTO EK EXPRESS (0 u.); ASIENTO EK XPRESS BENF tiene 2 u. |
| balaclava → pasamontaña | PASAMONTAÑA BUFF MUJER, 3 u. |
| litros/litro → lts | MALETA CUADRADA 45 LTS, con stock |
| espejo → retrovisor | |
| direccional → luz cruce | LUZ CRUCE HORSE 1, 20 u. |
| porta maleta → base maleta | |
| boca pato → pico pato | GR250, 12 u. |
| luz → led | CUBRE LEVAS LED, 31 u. |
| empaque → empacadura | |
| scuda → escuda | |
| rones → rin | |
| kit de rodaje → kit rodamiento | |
| foco → faro | |
| relación → corona/piñón | |

## 5. No regresión: pasan hoy y tienen que seguir pasando

| Consulta | Resultado esperado |
|---|---|
| "aceite 20w50 semi sintetico inca" | ACEITE INCA 20W50 4T |
| "aceite 4 tiempos oilstone" | ACEITE OILSTONE 4T 20W50 1L |
| "aceite motul semi sintetico 5100 15w50" | MOTUL 5100 15W50 4T |
| lista "rolinera 6301 / 6302 / 6202" | las tres cotizadas |
| "aceite iphone 20/50" | IPONE 20W50 |
| "botas impermeables" | agotados, nunca "tenemos" |
| "tanque rkv" | agotados |
| "defensa", moto "gxs 250" | pregunta, nunca DEFENSA BRZ 250 |
| "asiento sbr" | las 3 de mayor stock + «Hay N opciones más» |
| "juego de pastilla", GR 250 | pastillas GR250 |
| "casco givi h11.7 talla xl" | CASCO GIVI H11.7 |
| lista "caucho 21 delantero / caucho 18 trasero" | cotiza los dos |
| "timsum de pista" | TIMSUN PISTA |
| "guardafango", moto Horse | 3 de mayor stock + «Hay N opciones más» |
| "motul 5100 20/50" | MOTUL 5100 20W50 |
| "horsen" | se corrige a horse |
| "beta" | no se corrige |

## Correcciones del operador que tocan los casos

1. **Qué es "otra moto".** Un producto nombra otra moto cuando su nombre calza alguna de
   `MOTOS_CONOCIDAS` **y no calza** la moto del cliente. «ASIENTO SBR /SOC ORIGINAL»
   nombra dos motos y sí sirve para una SBR. Va con test explícito.
2. **La lista de producción del 29/9 tiene resultado esperado completo:**
   - asiento → los 3 ASIENTO SBR de mayor existencia, con «Hay N opciones más»;
   - «caucho n° 18 delantero» → «caucho 18» → varias opciones;
   - «caucho n° trasero» → varias opciones;
   - «rodamiento» → varias opciones (los KIT RODAMIENTO BERA no nombran SBR);
   - «aceite» → varias opciones.

   Una sola escalada, `confirmar_inventario`, con los cinco renglones en la nota.
3. **"llanta" y "pareja" no se corrigen.** En «llanta», `lata` tiene 4 letras y no suena
   igual, así que no hay corrección: da sin resultados, nunca LIGA FRENO LATA. En
   «pareja», la distancia es 2 y `para` es relleno, así que tampoco se corrige.
4. **"casco frankie negro vicera azul"** tiene que dar CASCO FRANKIE NEGRO MATE V/AZUL y
   no VISERA CASCO FRANKIE. Corregir vicera→visera está bien, pero el reintento no puede
   cambiar el producto pedido (casco) por otro (visera).
5. **D2 cuando el cliente no dio moto.** Las "otras opciones con existencia" son de la
   misma familia y del mismo conjunto del máximo, hasta 3, por relevancia y después por
   stock. Con moto, son de esa moto (tanque azul SBR → otros tanques SBR, nunca de EK).
6. **`pideVerTodo` tiene que reconocer más respuestas:** «no sé», «ni idea», «no tengo
   idea», «la que sea», «cualquiera», «el que tengas», «los que tengan», «no tengo
   marca», «recomiéndame», «cuál me recomiendas», «el más económico / la más barata».
