# Ventas cerradas de ejemplo

Las fichas completas, con la conversación, están en `privado/ejemplos/` (fuera de git). Acá va solo el índice y el resumen de cada una. Ordenadas: primero las ejemplares, de la más rápida a la más lenta.

| # | Ficha | Producto | Pago | Entrega | Del 1.er mensaje al cierre | Calidad |
|---|---|---|---|---|---|---|
| 1 | `3317c4c4` | Casco visto en Cashea, talla M | cashea_app_directo | mrw_envio | 27 min | ejemplar |
| 2 | `4844016a` | 2 potes de aceite Ipone 15W50 semisintético | cashea_app_directo | mrw_envio | 28 min | ejemplar |
| 3 | `b0cffc0a` | impermeable Givi talla L | cashea_link | mrw_envio | 44 min | ejemplar |
| 4 | `29b46931` | rin trasero Bera GR | cashea_link | mrw_envio | 51 min | ejemplar |
| 5 | `4183b1b9` | defensa para moto Toro Rex 250 | cashea_link | mrw_envio | 60 min | ejemplar |
| 6 | `dacfbbe9` | Amortiguadores para EK Xpress, negros de un resorte | cashea_link | mrw_envio | 2.3 h | ejemplar |
| 7 | `ad7bee7e` | defensas Bera Kavak | cashea_link | mrw_envio | 2.9 h | ejemplar |
| 8 | `722131b4` | 2 cauchos Timsun, tripa 18 y 2 aceites Oilstone 20W50 mineral | cashea_link | mrw_envio | 4.0 h | ejemplar |
| 9 | `26332b30` | maleta de moto (link de Cashea, tipo Federal 45 L) | cashea_link | mrw_envio | 13.6 h | ejemplar |
| 10 | `7fa7e028` | aceite Motul 15W50 semisintético, lubricante de cadena y pasamontañas para mujer | cashea_link | mrw_envio | 16.4 h | ejemplar |
| 11 | `c10cd66d` | 2 maletas de 45L Federal | cashea_link | mrw_envio | 26.0 h | ejemplar |
| 12 | `5f9a3054` | Guantes largos MT talla L, pasamontañas dama y caballero | cashea_app_directo | mrw_envio | 49 min | buena |
| 13 | `5b383e5e` | casco talla S negro brillante (cambiado a M brillante) | no_se_ve | mrw_envio | 57 min | buena |
| 14 | `7e6ec5ca` | forro impermeable para moto (20$) y aceite Ipone 15W50 (18$) | cashea_link | mrw_envio | 57 min | buena |
| 15 | `29815c44` | aceite Motul 15W50 4T semisintético | cashea_link | mrw_envio | 68 min | buena |
| 16 | `fb255cdf` | 2 pares de guantes, pasamontañas y buff doble | cashea_link | mrw_envio | 2.2 h | buena |
| 17 | `27758d0c` | casco Batman talla M | cashea_link | mrw_envio | 2.4 h | buena |
| 18 | `220f1d24` | corona 42 (428) para Kavak, cadena de o-ring y pica cadena | cashea_link | mrw_envio | 3.9 h | buena |
| 19 | `86d98f42` | parrilla para Bera Kavak | cashea_link | mrw_envio | 9.2 h | buena |

## Resumen de cada ejemplo

### `3317c4c4` — Casco visto en Cashea, talla M
- **Por qué es modelo:** Cliente ya en la app, disponibilidad confirmada en 11 min y guía en otros 14: flujo mínimo y limpio.
- **Qué hizo comprar:** Confirmó la talla M antes de pagar en la app y el asesor dijo que ofertara con confianza.
- **Secuencia:** pregunta_producto → otro → confirma_disponibilidad → explica_cashea → cliente_compra → embala_y_envia_guia → postventa_tracking
- **Seba v2 puede:** Confirmar stock de talla desde catálogo; Decir que puede comprar con confianza; Pedir cédula y enviar guía
- **Persona:** Verificar compra y generar guía

### `4844016a` — 2 potes de aceite Ipone 15W50 semisintético
- **Por qué es modelo:** Sin fricción: precio en 9 min, compra directa y guía en 17 min desde el primer mensaje.
- **Qué hizo comprar:** Precio rápido y compra directa por Cashea de algo que ya conocía.
- **Secuencia:** pregunta_producto → otro → da_precio → cliente_compra → pide_cedula_titular → embala_y_envia_guia
- **Seba v2 puede:** confirmar stock y precio del aceite Ipone; indicar que compre por la app o link con envío gratis; pedir la cédula cuando avise que terminó; enviar la guía
- **Persona:** verificar la compra en Cashea; embalar y generar la guía

### `b0cffc0a` — impermeable Givi talla L
- **Por qué es modelo:** Un solo asesor, respuestas en 1-2 min, link con la primera pregunta y guía a los 9 min de la compra.
- **Qué hizo comprar:** Precio, tallas y Cashea resueltos en 3 minutos y link enviado en el mismo mensaje; compró en 30 minutos.
- **Secuencia:** pregunta_producto → da_precio → explica_cashea → envia_link_cashea → pide_talla_color_medida → cliente_compra → embala_y_envia_guia → despedida
- **Seba v2 puede:** Dar precio y tallas desde el catálogo; Confirmar que acepta Cashea y enviar el link; Preguntar la talla; Enviar PLANTILLA_10 al ver la captura
- **Persona:** Validar la compra en Cashea; Embalar y sacar la guía

### `29b46931` — rin trasero Bera GR
- **Por qué es modelo:** Detectó y corrigió el error del cliente en 50 minutos, con cierre elogiado.
- **Qué hizo comprar:** El asesor detectó el error (retiro en vez de envío), mandó el link correcto y guió a hacerlo de nuevo.
- **Secuencia:** cliente_compra → pide_cedula_titular → explica_envio → corrige_error → envia_link_cashea → explica_cashea → cliente_compra → embala_y_envia_guia → despedida
- **Seba v2 puede:** Reconocer error de modalidad (retiro vs envío); Enviar el link y explicar cómo repetir la compra
- **Persona:** Cancelar la orden con retiro y generar guía

### `4183b1b9` — defensa para moto Toro Rex 250
- **Por qué es modelo:** Venta de ticket alto cerrada en 1 h: pocas preguntas, link a los 15 min de la consulta y guía a los 11 min de la captura; el cliente lo dijo.
- **Qué hizo comprar:** Foto + precio, confirmación de Cashea y envío gratis a su ciudad (Calabozo) y link: compró a los 20 min del primer precio.
- **Secuencia:** pregunta_producto → saludo → pide_dato_moto → confirma_disponibilidad → envia_foto_producto → explica_cashea → envia_link_cashea → cliente_compra → pide_cedula_titular → embala_y_envia_guia → despedida
- **Seba v2 puede:** Confirmar defensa Toro Rex 250 y precio desde el catálogo; Explicar Cashea envíos gratis; Enviar el link; Pedir cédula una vez y enviar plantilla
- **Persona:** Validar la compra en Cashea; Embalar y sacar la guía

### `dacfbbe9` — Amortiguadores para EK Xpress, negros de un resorte
- **Por qué es modelo:** Todo el flujo (consulta, datos, link, comprobante, guía) en 2 horas y 16 min, con pocas esperas.
- **Qué hizo comprar:** Precio, color confirmado y envío gratis por Cashea; compró en cuanto recibió el link.
- **Secuencia:** pregunta_producto → da_precio → explica_envio → cliente_compra → envia_datos_pago → envia_datos_pago → envia_link_cashea → envia_comprobante → embala_y_envia_guia
- **Seba v2 puede:** Responder precio, color y tipo; Explicar envío gratis; Pedir datos y mandar link; Enviar guía
- **Persona:** Verificar compra y despachar

### `ad7bee7e` — defensas Bera Kavak
- **Por qué es modelo:** Sin fricciones: cinco pasos claros, un solo asesor al inicio y guía a los 20 min de la cédula.
- **Qué hizo comprar:** El cliente llegó decidido a comprar un producto concreto y le dieron el link en 35 minutos.
- **Secuencia:** pregunta_producto → envia_link_cashea → cliente_compra → pide_cedula_titular → embala_y_envia_guia → despedida
- **Seba v2 puede:** Reconocer el producto y mandar el link al instante; Pedir cédula una vez; Enviar mensaje de embalaje; Pedir foto/etiqueta en postventa
- **Persona:** Validar la compra en Cashea; Embalar y sacar la guía

### `722131b4` — 2 cauchos Timsun, tripa 18 y 2 aceites Oilstone 20W50 mineral
- **Por qué es modelo:** Venta cruzada completa: asesoría, alternativas por producto, links en carrito único y guía en minutos.
- **Qué hizo comprar:** Asesoría paso a paso en 3 horas con complementos (tripa, aceite); envío gratis a Tocuyito.
- **Secuencia:** pregunta_producto → otro → pide_dato_moto → da_precio → ofrece_alternativa → explica_envio → ofrece_alternativa → envia_datos_pago → envia_link_cashea → cliente_compra → confirma_compra → embala_y_envia_guia
- **Seba v2 puede:** Pedir modelo y medida; Ofrecer cauchos, tripa y aceite; Dar precios y fotos; Mandar un solo carrito
- **Persona:** Verificar compra y generar guía

### `26332b30` — maleta de moto (link de Cashea, tipo Federal 45 L)
- **Por qué es modelo:** Flujo completo y ordenado: pregunta de proceso, link, guía paso a paso, cédula y guía en 2,5 h.
- **Qué hizo comprar:** Quería saber el proceso Cashea y el envío gratis; se decidió al recibir el link con instrucciones paso a paso y la foto del espaldar.
- **Secuencia:** pregunta_producto → confirma_disponibilidad → envia_link_cashea → explica_cashea → pregunta_producto → envia_foto_producto → cliente_compra → pide_cedula_titular → embala_y_envia_guia → postventa_tracking
- **Seba v2 puede:** Explicar el proceso Cashea paso a paso; Responder envío gratis, tiempo de llegada; Enviar foto del producto; Enviar link con PLANTILLA_03; Pedir cédula y enviar PLANTILLA_04
- **Persona:** Validar la compra en Cashea; Embalar y sacar la guía

### `7fa7e028` — aceite Motul 15W50 semisintético, lubricante de cadena y pasamontañas para mujer
- **Por qué es modelo:** Del primer mensaje al link en 2 minutos y compra en la misma noche, con confianza (original, distribuidor).
- **Qué hizo comprar:** Original garantizado, distribuidor y envío gratis a Caracas con Cashea; el link llegó en 2 minutos.
- **Secuencia:** pregunta_producto → confirma_disponibilidad → explica_cashea → envia_link_cashea → cliente_compra → embala_y_envia_guia → despedida
- **Seba v2 puede:** confirmar el aceite original con stock; preguntar ciudad y método de pago; enviar el link en el primer mensaje; avisar cuando salga el despacho
- **Persona:** verificar la compra y el pedido completo; embalar y generar la guía

### `c10cd66d` — 2 maletas de 45L Federal
- **Por qué es modelo:** Seba hizo el trabajo inicial en un minuto y el asesor remató; modelo de cómo automatizar precio, Cashea y link.
- **Qué hizo comprar:** Seba dio precio y link en un minuto, y nivel 6 con 0% y 6 cuotas; el asesor solo corrigió el plan de cuotas en la app.
- **Secuencia:** pregunta_producto → da_precio → explica_cashea → explica_cashea → otro → explica_cashea → cliente_compra → pide_cedula_titular → confirma_compra → embala_y_envia_guia
- **Seba v2 puede:** Dar precio, descripción y link con foto; Explicar inicial y cuotas por nivel; Pedir cédula y avisar de la guía
- **Persona:** Verificar compra y generar guía

### `5f9a3054` — Guantes largos MT talla L, pasamontañas dama y caballero
- **Por qué es modelo:** Venta cerrada en una hora con venta cruzada para alcanzar el mínimo; Seba estorbó al inicio.
- **Qué hizo comprar:** Alcanzó el mínimo de 25$ sumando pasamontañas a los guantes; talla L aceptada tras explicar equivalencias.
- **Secuencia:** pregunta_producto → otro → da_precio → pide_talla_color_medida → explica_cashea → ofrece_alternativa → cliente_compra → confirma_compra → embala_y_envia_guia
- **Seba v2 puede:** Dar precio y tallas de guantes; Informar el mínimo de 25$; Ofrecer complementos con foto; Pedir cédula
- **Persona:** Verificar compra y despachar

### `5b383e5e` — casco talla S negro brillante (cambiado a M brillante)
- **Por qué es modelo:** Resolvió el agotado con alternativa y cierre en ~1 h; cambió de asesor tres veces.
- **Qué hizo comprar:** Ante el agotado, el asesor ofreció otra variante y fotos y el cliente aceptó talla M brillante.
- **Secuencia:** cliente_compra → otro → pide_talla_color_medida → informa_agotado → ofrece_alternativa → envia_foto_producto → confirma_disponibilidad → pide_talla_color_medida → confirma_compra → embala_y_envia_guia
- **Seba v2 puede:** Detectar compra reciente y consultar stock por talla/color; Ofrecer alternativa con fotos; Enviar plantilla de guía
- **Persona:** Cambiar la orden en la app y generar guía

### `7e6ec5ca` — forro impermeable para moto (20$) y aceite Ipone 15W50 (18$)
- **Por qué es modelo:** Cierre en ~1 h con cálculo claro de inicial y cuotas; ruido por dos asesores a la vez.
- **Qué hizo comprar:** Compró lo que había con precio claro, y el asesor calculó total, inicial y cuotas al instante.
- **Secuencia:** pregunta_producto → otro → envia_foto_producto → da_precio → informa_agotado → cliente_compra → explica_cashea → envia_link_cashea → cliente_compra → embala_y_envia_guia
- **Seba v2 puede:** dar precios y foto de forro y guardafango con stock; calcular total, inicial y cuotas según nivel; explicar cómo agregar dos links al carrito; avisar cuando lleguen los cubre levas blancos
- **Persona:** generar los links personalizados; verificar compra y guía

### `29815c44` — aceite Motul 15W50 4T semisintético
- **Por qué es modelo:** Venta rápida: stock, link y guía en ~1 h, el único estorbo fue el paso por Seba sin respuesta de stock.
- **Qué hizo comprar:** Ya había elegido el aceite y solo necesitó confirmar disponibilidad y envío gratis; recibió el link a los 20 min.
- **Secuencia:** pregunta_producto → explica_envio → otro → confirma_disponibilidad → envia_link_cashea → cliente_compra → explica_envio → embala_y_envia_guia
- **Seba v2 puede:** confirmar disponibilidad del aceite con catálogo con stock; enviar el link de compra del producto; leer fotos de la agencia de destino y registrar los datos; avisar la hora de salida del envío
- **Persona:** verificar que la compra entró en Cashea; embalar y generar la guía

### `fb255cdf` — 2 pares de guantes, pasamontañas y buff doble
- **Por qué es modelo:** Armó el pedido sobre el mínimo con una alternativa; Seba mandó catálogos innecesarios al inicio.
- **Qué hizo comprar:** Alternativa económica a los guantes agotados y total justo sobre el mínimo de 25$.
- **Secuencia:** pregunta_producto → otro → otro → ofrece_alternativa → pide_talla_color_medida → da_precio → envia_datos_pago → envia_link_cashea → envia_comprobante → embala_y_envia_guia
- **Seba v2 puede:** Leer la foto para saber que son guantes; Ofrecer alternativa similar; Armar total y links; Pedir talla
- **Persona:** Verificar compra y generar guía

### `27758d0c` — casco Batman talla M
- **Por qué es modelo:** Venta en ~2 h 30 con envío a Maracaibo, buen cierre y cliente muy satisfecho; el único error fue no responder la talla.
- **Qué hizo comprar:** Vio el casco en TikTok, tuvo precio y envío gratis, y recibió la confirmación del asesor y la promesa de enviarlo en su caja original.
- **Secuencia:** pregunta_producto → da_precio → explica_cashea → pide_cedula_titular → pide_cedula_titular → envia_link_cashea → confirma_disponibilidad → cliente_compra → embala_y_envia_guia
- **Seba v2 puede:** responder precio y talla M del Batman con stock; pedir los cuatro datos en una sola plantilla; enviar el link y recordar elegir envío gratis; anotar la petición de caja original para el humano
- **Persona:** generar el link personalizado; verificar la compra y embalar con caja original

### `220f1d24` — corona 42 (428) para Kavak, cadena de o-ring y pica cadena
- **Por qué es modelo:** El asesor fue honesto sobre el agotado y la venta cerró en 40 min después de la primera respuesta; solo hubo 2 h 39 min de espera inicial.
- **Qué hizo comprar:** Aceptó comprar lo disponible y buscar el piñón aparte, porque se lo dijeron claro; pidió un sticker de regalo.
- **Secuencia:** pregunta_producto → informa_agotado → da_precio → cliente_compra → pide_cedula_titular → envia_link_cashea → cliente_compra → embala_y_envia_guia
- **Seba v2 puede:** avisar de entrada que el piñón 16 sigue agotado; armar el pedido con lo que hay en stock; pedir ciudad y datos del titular; enviar link y guía
- **Persona:** generar el link personalizado; verificar compra y embalar

### `86d98f42` — parrilla para Bera Kavak
- **Por qué es modelo:** Del precio a la guía en 21 minutos, con un solo tropiezo del asesor y una espera inicial por consulta nocturna.
- **Qué hizo comprar:** Parrilla para su moto confirmada con foto y precio, y compra por link en pocos minutos.
- **Secuencia:** pregunta_producto → pide_dato_moto → da_precio → cliente_compra → envia_link_cashea → envia_comprobante → pide_cedula_titular → embala_y_envia_guia
- **Seba v2 puede:** responder la consulta de la publicación fuera de horario; pedir modelo de la moto y confirmar parrilla con stock; enviar foto y precio; enviar el link y pedir cédula al ver la captura
- **Persona:** generar el link personalizado; verificar el pago en Cashea y generar la guía
