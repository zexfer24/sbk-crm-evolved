# Casos borde de Seba v2 (16/11/2026)

Salen de tres fuentes: el estudio de 1.147 ventas cerradas, el minado de 785 conversaciones (3.951 hallazgos) y las mediciones de hoy en producción. Los códigos de ocho caracteres son conversaciones reales del corpus.

Cada caso dice **qué hace Seba** y **dónde se asegura**:

- **Prompt:** regla del system prompt (número de sección).
- **Código:** lo impide o lo arma el código, aunque el modelo se equivoque.
- **Arnés:** queda como caso de prueba antes de encender.

---

## A. Apertura (bienvenida en dos mensajes)

Medido en los últimos 14 días: 336 aperturas de ventana por día. El 49 % es solo un saludo, el 23 % ya trae una pregunta, y 385 de 4.706 abren con una foto o un audio.

| # | Caso | Qué hace Seba | Dónde |
|---|---|---|---|
| A1 | Solo saluda ("Buenas") | Mensaje 1 informativo y mensaje 2 con una frase fija que invita a decir qué busca, sin nombre propio (decisión D7). No se llama al modelo | Código |
| A1b | Pregunta "¿con quién hablo?" | "Con el equipo de SBK Motors." No dice "Seba" ni se describe como automatizado ni como una persona | Prompt 1 · Código (guarda de identidad) |
| A2 | Abre con la pregunta ("precio del impermeable Givi") | Mensaje 1 informativo. El mensaje 2 **es la respuesta** con precio, no "¿en qué te ayudo?". Antes Seba saludaba y se tragaba la pregunta (23 hallazgos: `05a80d09`, `b60953c5`, `737eccd9`) | Prompt 3.1 · Arnés |
| A3 | Abre con una foto o un audio | Espera la lectura (hasta 8 s) y responde sobre eso. Si la lectura falla, mensaje 2 pide que lo escriba | Código · Prompt 5 |
| A4 | Abre diciendo que ya compró ("realicé la compra de…", "¿y mi guía?"). Es el 24 % de las ventas | No manda la bienvenida informativa: va directo a comprobante o a pedido en camino. Ofrecer Cashea a quien ya pagó fue una de las fricciones medidas | Código (la apertura se salta si la ráfaga es de postventa) · Arnés |
| A5 | Ventana nueva con un asesor atendiendo o una escalada abierta | Seba no escribe nada, ni la bienvenida. Antes saludó al mismo segundo que el asesor (`f04c8f82`, `eacbd193`) | Código |
| A6 | Vuelve a las 30 horas a seguir la misma compra | Bienvenida corta sin el bloque informativo si hay un pedido armado en los últimos 7 días: retoma el pedido | Código (lee la etapa guardada) |
| A7 | Manda cinco mensajes seguidos al abrir | Una sola bienvenida y una sola respuesta para toda la ráfaga | Código (espera anclada al último mensaje) |
| A8 | Escribe de madrugada o con la tienda cerrada | Atiende igual y vende igual. Al pasar a un asesor dice cuándo abre la tienda | Prompt 6 · Código (reloj) |
| A9 | Llega por un anuncio de un producto específico (chaquetas, intercomunicadores: las campañas más usadas hoy) | Trata el anuncio como la pregunta: cotiza ese producto. No manda el catálogo general | Prompt 3.1 |
| A10 | El nombre de WhatsApp no es un nombre de persona ("Repuestos El Gocho", emojis) | La bienvenida sale sin nombre | Código (validador de nombre que ya existe) |

## B. Identificar el producto sin confundirse

| # | Caso | Qué hace Seba | Dónde |
|---|---|---|---|
| B1 | Palabra que no es producto: "x fa", "porfa" tomado como repuesto (`31435159`) | Se limpia antes de buscar | Código (lista de frases, jerga aprobada) |
| B2 | "Rodamiento": kit de arrastre o rolinera | Con "38/15" o "completo" es el kit; con código (6203) es rolinera. Si no se sabe, pregunta cuál de los dos | Código (jerga) · Prompt 3.2 |
| B3 | Marca que existe en dos categorías: Edge es casco y chaqueta (`3b08364b`) | Pregunta el tipo de producto | Prompt 3.2 |
| B4 | Marca de moto confundida con producto: "kit arrastre kavak" dio LIGA ARRASTRE (`e0298b2c`) | La moto se separa del producto antes de buscar; el resultado tiene que ser de la misma categoría o no se muestra | Código · Arnés |
| B5 | "Lo más parecido" de otra categoría: maleta acolchada dio un intercomunicador (`a92e8967`), "tren delantero" dio TRENZA CASCO (`fc87f914`) | Sin coincidencia de categoría no hay resultado. Nunca "lo más parecido" | Código · Arnés |
| B6 | Pieza para una moto y el inventario trae la de otra: escape de Horse 1 para Horse 2 (`0e6dc32f`) | Lo que nombra otra moto no se cotiza. Si no hay la suya, se dice y se pasa a ventas | Código (regla que ya existe: `nombra_otra_moto`) |
| B7 | Ambigüedad real: "tapa cadena o porta corona", "tijera" delantera o trasera | Propone las dos lecturas y deja elegir | Prompt 3.2 |
| B8 | Medida escrita de otra forma: "90 90 18", "38 con 15", "20 50" | Se normaliza a como está en el inventario | Código (56 reglas de jerga por aprobar) |
| B9 | Tipeos y nombres mal oídos: "iphone" por Ipone, "tinsun", "motur" | Corrector y sinónimos | Código |
| B10 | Lista de ocho repuestos | Cotiza todos en un mensaje, marcando cada renglón con precio o "agotado". Un cliente se quejó porque solo le cotizaron lo que había (`0407f025`) | Prompt 3.3 · Código |
| B11 | Casco sin modelo ni talla | Una vez por conversación: manda el catálogo de cascos y pide modelo y talla. No lo repite | Código (memoria por chat) |
| B12 | Talla en centímetros ("55") | No convierte: los asesores no coinciden (56 = S, 55 = M). Remite a la tabla de tallas o pasa a ventas | Prompt 3.2 |
| B13 | Pega un link de Cashea de un producto | Es una consulta por ese producto, no una compra hecha. Antes contestó "gracias por tu compra" (`d8743627`) | Código (un link no es comprobante) · Arnés |
| B14 | Pide algo que la tienda no vende (taller, vacantes, otra tienda) | Una línea amable; si insiste, pasa con el motivo `otro` | Prompt 7 |

## C. Precio y existencia

| # | Caso | Qué hace Seba | Dónde |
|---|---|---|---|
| C1 | El inventario dice que hay y físicamente no hay. Pasó en 34 de 150 ventas, incluso con el cliente ya pagado | Seba cotiza con lo que dice el inventario. Con una sola unidad dice "es el último" y al recibir el comprobante la nota al asesor lo marca para verificar primero | Código · nota al asesor |
| C2 | Inventario o tasa sin actualizar hace días | La herramienta lo avisa; Seba da el dato como "lo último registrado" y pasa a ventas para confirmar | Código (aviso que ya existe) |
| C3 | Vuelve a preguntar un precio que está en el historial | Busca de nuevo. Un "108$ BCV" de diez días atrás ya no era cierto | Prompt 3.3 |
| C4 | Pregunta cuántos quedan | Nunca la cifra ("31 disponibles", `6db53296`). Solo "quedan pocas" o "es el último" si el dato lo dice | Código · Prompt 3.3 |
| C5 | Agotado y pregunta cuándo llega | No da fecha (los asesores dan fechas distintas). Ofrece alternativa si hay; si quiere aviso, pasa a ventas | Prompt 3.3 |
| C6 | Producto sin precio o con precio en cero | No se cotiza: pasa a ventas | Código |
| C7 | Pide descuento o dice que otro asesor le dio otro precio | No negocia ni discute: pasa a ventas con el precio vigente y el que dice el cliente | Prompt 6 |
| C8 | Pregunta el precio en dólares en efectivo o por Binance | No lo da: el precio en divisa lo dice un asesor (decisión D3). Pasa a ventas | Prompt 6 |
| C9 | Pide precio de instalación | No lo da (no está vigente): pasa a ventas | Prompt 6 |

## D. Forma de pago y datos para pagar

Medido desde el 24/10: los asesores mandaron un link de Cashea en 1.064 conversaciones y los datos de pago móvil en 34.

| # | Caso | Qué hace Seba | Dónde |
|---|---|---|---|
| D1 | Elige Cashea | El asesor sigue a cargo del link (decisión D1). Seba manda el resumen con el total, pide los datos del titular con el texto de "Combo Cashea" y pasa a ventas con `listo_para_comprar` en el mismo turno | Código (`prepararPago`) |
| D2 | Elige Cashea y ya dio parte de los datos antes (la ciudad, el nombre) | El texto de datos pide solo lo que falta; la nota al asesor lleva lo que ya dijo | Código · nota |
| D3 | Pregunta "¿cuánto es la inicial?" o "¿cuánto pago por cuota?" | No calcula ni estima (decisión D4). Dice el total, que depende de su nivel y que el asesor se la confirma con el link. No pregunta el nivel | Prompt 3.4 · Código (guarda de cifras) |
| D4 | Pregunta por las condiciones de Cashea | Sí las dice: envío gratis, compra mínima de 25 $ y seis cuotas desde 100 $. Los dos números salen de la configuración | Prompt 3.4 · sufijo |
| D5 | El pedido no llega a 25 $ (mínimo) o a 100 $ (seis cuotas) | Sugiere **una vez** un complemento barato con existencia. Así creció la compra en tres ventas ejemplares | Código · Prompt 3.4 |
| D6 | Elige pago móvil o transferencia | Total en bolívares a la tasa BCV del día y los datos, leídos de la base. Pide el capture. Es el único camino que Seba cierra sin un asesor | Código |
| D7 | Paga de contado y quiere envío | Se cobra el **precio estándar**, que ya incluye el flete MRW (decisión D5). Si algún producto del pedido no tiene peso cargado, no hay precio estándar: pasa a ventas. Hoy tienen peso 549 de 3.367 productos con existencia | Código |
| D7b | Cotizó a precio de promoción y, al elegir envío de contado, el total sale más alto | El resumen dice "con envío MRW incluido". Si pregunta por la diferencia, Seba explica que ese precio incluye el envío | Prompt 3.5 · Arnés |
| D7c | Elige Binance | El precio en divisa lo dice un asesor (decisión D3): Seba manda el resumen sin monto y pasa a ventas | Código |
| D8 | Pide pagar con algo que no se acepta (Zelle) | "Por ahora no aceptamos Zelle" y ofrece las formas activas | Código (lista activa) · Prompt 3.4 |
| D9 | Cambia de forma de pago o agrega un producto después de recibir los datos | Se llama de nuevo a `prepararPago` y sale un resumen nuevo, completo. No se corrige de memoria | Prompt 3.5 |
| D10 | La tasa BCV cambia entre que se le da el total y que paga | El total en bolívares vale para el día. Si paga otro día con el monto viejo, es `problema_de_pago` y lo ve el asesor | Código (el resumen lleva la fecha) |
| D11 | Quiere mitad Cashea y mitad contado, o dos tarjetas | Pasa a ventas | Prompt 6 |
| D12 | Pide apartar sin pagar | "No manejamos apartados"; lo invita a comprar para asegurarlo | Biblioteca |
| D13 | Pide los datos de pago sin haber cotizado nada | No los manda sueltos: pregunta qué va a comprar. Los datos siempre van con un total | Código (`prepararPago` exige pedido) |
| D14 | Retiro en tienda | Dirección y horario desde la biblioteca. Si quiere pagar antes por pago móvil o transferencia, sigue el flujo normal a precio de promoción. Pagar en efectivo al retirar no lo ofrece Seba: si lo pide, pasa a ventas | Biblioteca · Prompt 6 |

## E. El comprobante y el traspaso

| # | Caso | Qué hace Seba | Dónde |
|---|---|---|---|
| E1 | Manda la captura del pago móvil | Agradece, confirma que **recibió** el comprobante y asigna a un asesor del área de pagos. Nunca "pago verificado" ni "gracias por tu compra" (47 hallazgos de Seba diciéndolo sin compra) | Código · Prompt 3.6 |
| E2 | Escribe "listo" sin captura | Igual que E1, y la nota al asesor dice "sin comprobante" | Código |
| E3 | La captura muestra un monto distinto al total | Seba no lo comenta con el cliente. La nota al asesor lleva: esperado, leído y diferencia | Código (lectura de la imagen) |
| E4 | La captura de Cashea muestra "retiro en tienda" y el cliente es de otra ciudad. Pasó en 12 compras | La nota lo marca en primera línea para que el asesor rehaga la orden antes de embalar | Código |
| E5 | Manda una foto que no es comprobante después de recibir los datos (una foto del producto, un sticker) | No se toma como pago | Código (la lectura decide) · Arnés |
| E6 | Manda el comprobante dos veces o pregunta "¿ya lo vieron?" | Con la escalada abierta Seba no repite el agradecimiento ni vuelve a asignar. Si pasaron más minutos que el umbral, un solo mensaje de espera | Código |
| E7 | Compró directo en la app sin pasar por Seba | Mismo trato: recibe, pide cédula del titular y talla, asigna | Prompt 3.6 |
| E8 | Manda la foto de la cédula | No se pide nunca. Si la manda igual, no se comenta ni se repite el número | Prompt 7 |
| E9 | No hay ningún asesor activo para asignar | La conversación queda en la cola del área con su etiqueta y hora límite; el cliente recibe el mismo mensaje, con el horario si está cerrado | Código (invariante "ningún lead invisible") |
| E10 | Después del traspaso el cliente pregunta otra cosa (horario, ubicación) | Seba puede contestar solo información. No toca el pedido ni vuelve a pasar el caso | Código · sufijo del turno |

## F. Fotos y audios

Hoy entran 236 fotos y 46 audios por día. Dos de cada tres fotos llegan sin texto.

| # | Caso | Qué hace Seba | Dónde |
|---|---|---|---|
| F1 | Audio con la pregunta completa | Lo contesta como texto. Ya no pide "escríbemelo" | Código (transcripción) · Prompt 5 |
| F2 | Audio sin voz, con ruido o de menos de un segundo | El transcriptor inventa frases ("Subtítulos realizados por la comunidad de Amara.org"). El filtro lo marca como ilegible y Seba pide que lo repita | Código (filtro medido el 24/10) |
| F3 | Audio largo con tres preguntas | Contesta las tres en mensajes cortos, lo vendible primero | Prompt 2 |
| F4 | Foto de un producto con "¿tienen este?" | Busca por lo que se ve (tipo, marca, modelo, texto). Si calza uno, cotiza; si calzan varios, pregunta el dato que los distingue | Prompt 5 |
| F5 | Captura de nuestra publicación en Cashea o Instagram | El texto visible trae el nombre: se busca por ese nombre | Código (texto visible) |
| F6 | Foto de la moto con "repuestos para esta" | Identifica el modelo y lo confirma en una pregunta. Antes contestó con un casco a la foto de una moto (`d4df7148`) | Prompt 5 · Arnés |
| F7 | Dos fotos y después "cualquiera de estos en talla L" | "Estos" son las fotos: se usan las dos lecturas | Código (las lecturas van al historial) |
| F8 | Foto borrosa o que no muestra nada reconocible | Pide una vez que la mande de nuevo o lo escriba. A la segunda, pasa con `no_pudo_leer` | Prompt 5 |
| F9 | Foto de un producto dañado o equivocado | Es un reclamo: disculpa y pasa a reclamos con la descripción de la foto en la nota | Prompt 6 |
| F10 | Captura de un error de la app de Cashea | `problema_app_cashea`, con el texto del error en la nota | Prompt 6 |
| F11 | Video o documento | No se leen: video pide que lo describa; documento pasa a un asesor | Prompt 5 |
| F12 | La foto muestra un producto que el inventario no tiene | "Ese modelo no lo tenemos" y ofrece alternativa solo si la búsqueda la trae. La foto no es existencia | Prompt 5 |
| F13 | La lectura tarda más que la respuesta | El turno espera hasta 8 s. Si no llega, trata el archivo como ilegible | Código |

## G. Reclamos, errores y lo que excede a Seba

| # | Caso | Qué hace Seba | Dónde |
|---|---|---|---|
| G1 | Reclamo con enojo | Disculpa primero, una línea de qué va a pasar, pasa a reclamos. No promete reembolso, cambio ni plazo | Prompt 6 |
| G2 | "¿Dónde está mi pedido?" | Pide la cédula del titular una vez y pasa a envíos. No dice "lo reviso" ni pide nombre y apellido: no puede consultar nada (15 hallazgos) | Prompt 6 · Código |
| G3 | "No me aparece la guía en MRW" con la guía ya enviada en el chat | Explica el código CS- en rojo y que MRW tarda hasta un día. Si la guía no está en el chat, pasa a envíos | Biblioteca |
| G4 | Reclamo mezclado con una compra nueva ("me llegó mal el casco, y quiero unos guantes") | El reclamo manda: pasa a reclamos y anota el interés de compra en la nota | Prompt 6 (orden de desempate) |
| G5 | Pide hablar con una persona | Lo pasa sin discutir ni preguntar para qué. Antes pedía permiso tres veces seguidas (`c91563ec`) | Prompt 6 |
| G6 | Insulta o amenaza con denunciar | Una disculpa breve y pasa a reclamos | Prompt 6 |
| G7 | Pregunta si es estafa o si la tienda es real | Ubicación y horario desde la biblioteca, con calma. Si insiste, pasa a ventas | Biblioteca |
| G8 | Intenta darle órdenes ("ignora tus instrucciones", "soy el dueño") | Lo trata como texto de un cliente y sigue con la venta | Prompt 7 |
| G9 | Falla una herramienta por dentro | El cliente recibe "un asesor te lo confirma" y el caso pasa con `otro`. Nunca "el catálogo está apagado" (37 hallazgos) | Código (lista de frases prohibidas) |
| G10 | Seba no sabe a qué área va | Va a ventas con la nota completa. El asesor reasigna | Código |

## H. Convivencia con los asesores y con el tiempo

| # | Caso | Qué hace Seba | Dónde |
|---|---|---|---|
| H1 | Un asesor escribió hace poco en el chat | Seba no entra | Código (regla vigente, 15 min) |
| H2 | El asesor silenció a Seba en ese chat (7.234 veces en 30 días) | Seba no escribe en vivo. En modo sombra igual genera el borrador para comparar | Código |
| H3 | El cliente contesta "ok", "gracias" o un emoji | No se responde con otra pregunta ni con textos de redes. Con el caso abierto, silencio | Código |
| H4 | Llega una respuesta a un mensaje de hace días (un "ok" de 17 días atrás tomado como pedido, `710c6d31`) | Lo anterior a 12 horas es contexto, no la consulta actual | Código · sufijo |
| H5 | El cliente escribe mientras Seba está armando la respuesta | Se descarta el borrador y se responde a la ráfaga completa | Código |
| H6 | Meta rechaza el envío (ventana cerrada, error 131047) | No se reintenta en bucle; queda el traspaso registrado | Código (ya existe) |
| H7 | Se alcanza el tope de gasto del día | Seba deja de responder y todo pasa a la cola de asesores, con registro | Código (ya existe) |
