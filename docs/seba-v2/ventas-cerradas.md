# Cómo se cierra una venta en SBK: estudio para el rework de Seba

Medido el **24/10/2026** sobre la base de producción, en solo lectura, con conversaciones del 24/8 al
24/10.
- **Cifras de toda la base:** salen de SQL.
- **Proceso, patrones y fricciones:** salen de 190 episodios leídos y mapeados paso a paso por 4
  subagentes (150 ventas asistidas y 40 compras hechas fuera del chat).
- **Revisión a mano:** leí yo 2 de los ejemplares.

**Ejemplos para consultar:**
- `privado/ejemplos/README.md` (fuera de git): 19 ventas cerradas con la conversación anonimizada y
  su anotación.
- los mapas de 190 episodios (en el VPS): los 190 mapas.
- los tiempos de las 1.147 ventas (en el VPS): los tiempos de las 1.147 ventas.

---

## 1. Qué cuenta como venta cerrada

La base no registra ventas: `deal_closed_at` e `invoices` están vacíos. Se reconoce por lo que escribe
el asesor después de vender:

| Señal | Conversaciones |
|---|---|
| "¡Gracias por tu compra!" **y** guía MRW / pedido embalado | **221** |
| Solo "¡Gracias por tu compra!" | 61 |
| Solo guía MRW / "pedido embalado" | 865 |
| **Total con venta** | **1.147** |

- **Los asesores dejaron de mandar el "gracias por tu compra" el 21/9:** era ~88 por semana en
  agosto y bajó a entre 2 y 14 desde esa fecha. Desde entonces la venta se ve en la guía. Por eso
  solo 221 tienen las dos señales, y casi todas son de agosto y septiembre.
- "¡Muchas gracias por preferirnos!" **no** es señal de venta. Es la despedida de cualquier chat: de
  12 conversaciones que solo tenían esa frase, 8 terminaron sin compra.
- **Falsos positivos:** en 2 de 190 episodios leídos la venta no existía (por ejemplo, una plantilla
  de guía mandada por error en 0421ab83). En otro, el marcador quedó en un mensaje anterior al
  cierre real. La señal es confiable, pero no perfecta.

## 2. Hay dos clases de venta

| Clase | Ventas | Qué pasa |
|---|---|---|
| **Venta asistida** | 813 (71 %) | El chat ayuda antes de comprar: disponibilidad, precio, talla, Cashea, link |
| **Compra fuera del chat** | 280 (24 %) | El cliente ya compró en la app de Cashea y escribe para la postventa: "realicé la compra de…", "¿y la guía?" |
| Sin clasificar | 54 (5 %) | — |

**Cómo se paga y se entrega** (150 asistidas leídas):
- **Pago:** Cashea en el 91 % (89 por link que manda el asesor y 47 directo en la app). Pago móvil
  o divisas en 3 casos.
- **Entrega:** envío por MRW en el 94 %. Retiro en tienda 3, delivery local 1.
- En la práctica, **vender por chat en SBK es vender por Cashea con envío MRW**. Las ventas de
  mostrador no dejan huella en el chat y este estudio no las ve.

## 3. El proceso, paso a paso

La secuencia más común en las ventas asistidas:

```
cliente pregunta  →  asesor confirma stock + precio (+ foto, + tallas)
                  →  explica Cashea (nivel, inicial, envío gratis)  →  manda el link de Cashea
cliente compra en la app  →  "Listo" + captura
                  →  asesor pide la cédula del titular (y la talla)  →  verifica en Cashea
                  →  foto del paquete embalado + plantilla de la guía MRW  →  postventa (rastreo)
```

**Tiempos** (de las 1.147 ventas; p50 · p90):

| Tramo | p50 | p90 |
|---|---|---|
| 1.er mensaje del cliente → 1.ª respuesta del asesor | 35 min | 10,3 h |
| 1.er mensaje → primer precio | 73 min | 14 h |
| Primer precio → cierre (guía) | 3,9 h | 40 h |
| 1.er mensaje → cierre, ventas asistidas | 4,8 h | 42 h |
| "Listo, ya compré" → cédula y guía | 25-58 min | 13 h |

- Una venta asistida lleva 24 mensajes de mediana y pasa por 2 asesores distintos.
- Las ejemplares se cierran en menos de una hora (sección 6).

**La velocidad se paga en ventas.** De 6.559 cotizaciones (la primera tras 72 h sin precios en esa
conversación), el 8 % terminó en venta en 7 días. Según cuánto esperó el cliente esa cotización:

| Espera hasta el precio | Cotizaciones | Se vendió en 7 días |
|---|---|---|
| < 5 min | 2.071 | **9,8 %** |
| 5-30 min | 1.658 | 8,4 % |
| 30 min-2 h | 2.032 | 6,6 % |
| 2-12 h | 576 | 6,6 % |
| > 12 h | 222 | **4,1 %** |

Es una correlación, no un experimento: los chats que se contestan tarde pueden ser también los menos
decididos. Aun así, la dirección es clara y coincide con la meta de responder en ≤10 s.

## 4. Lo que hace avanzar una venta

Patrones repetidos en los 150 mapas y en los 19 ejemplos:

1. **Todo en un mensaje.** Precio, stock, tallas, foto y **link de Cashea** juntos. En los
   ejemplares, el cliente compra entre 4 y 30 minutos después de recibir el link (b0cffc0a: 44
   minutos del primer mensaje a la guía).
2. **Contestar la pregunta del cliente sobre Cashea con su nivel.** Inicial y cuotas del nivel que
   dice el cliente, y "envío gratis por Cashea" como gancho. Hoy la tabla de niveles cambió al menos
   dos veces, y hay que confirmarla (pregunta 1-3 de las decisiones del operador).
3. **Completar el mínimo.** Si la compra no llega a los 25 $ del envío gratis, o a los 100 $ de
   las 6 cuotas, el asesor sugiere un producto barato (aceite, guantes, pasamontañas). En los
   ejemplos 07, 14 y 16 la compra creció así.
4. **Urgencia real.** "Queda uno", "es el último", cuando el stock lo dice.
5. **Agotado con alternativa y foto.** No se queda en "no hay" (ejemplo 13: casco S agotado,
   ofreció M y se vendió).
6. **Después de "Listo": cédula una vez, y la guía con foto en minutos.**

## 5. Dónde se traba

| Fricción | Episodios con al menos una (asistidas, de 150) | Compra fuera del chat (de 40) |
|---|---|---|
| **Espera larga** (> 60 min en horario) | **80 (53 %)** | 23 (58 %) |
| Error del asesor | 39 | 6 |
| Stock incorrecto (dicen que hay y no hay, incluso con el cliente ya pagado) | 34 | 4 |
| **Seba estorba** (escala lo simple, repite, no entiende audios, ofrece comprar a quien ya compró) | 33 | 6 |
| Confusión con el envío (eligió "retiro en tienda" por error, copió el número de ejemplo de la guía, quién retira en MRW) | 29 | 7 |
| Dato pedido dos veces | 21 | 7 |
| Error de la app Cashea | 16 | 2 |

En el bot actual, Seba aparece en 505 de las 1.147 ventas, y en los mapas sus pasos son casi siempre
`otro`: saludos, derivaciones o catálogos. En el ejemplo 02, Seba escaló una pregunta de aceite que
podía cotizar, y el asesor tardó 10 minutos en dar el precio.

## 6. Qué copiamos, qué mejoramos y quién lo hace en Seba v2

| Paso | Hoy lo hace | En v2 | Cómo |
|---|---|---|---|
| Confirmar stock, precio, tallas y foto | Asesor (35-73 min) | **Seba, en segundos** | Cotización armada en código (S3b) con stock > 0, foto del producto si existe y tallas de las variantes |
| Explicar Cashea, envío gratis y mínimo | Asesor, con plantillas viejas | **Seba**, con la tabla vigente | La tabla en un solo lugar; Seba la lee y no hace cuentas |
| **Link de Cashea** | Asesor | **Asesor, por ahora** (respuesta 20). Seba junta producto, talla y nivel, y pasa con `listo_para_comprar` | Seba puede sumar: "también lo consigues en la app de Cashea buscando SBK Motors" (respuesta 23). La tabla de links queda como nota para la integración con Cashea |
| Sugerir un complemento para el mínimo | Algunos asesores | **Seba**, una vez por pedido | En código: si el total < 25 $ (o < 100 $), ofrecer 1 producto barato con stock |
| Avisar "elegí envío gratis, no retiro en tienda" antes de comprar | Nadie (≥8 compras salieron mal) | **Seba**, siempre junto al link | Texto fijo |
| "Listo" + captura | Asesor pide la cédula | **Seba pide cédula y talla una vez** y escala con `comprobante_pago` y la nota armada | Bloque M (lee la captura) + motivo de escalada |
| Verificar la compra en Cashea | Asesor | **Asesor** | Solo una persona puede verla |
| Embalar, guía y foto del paquete | Asesor | **Asesor** | — |
| Rastreo ("no me aparece la guía") | Asesor | **Seba** explica el código CS- en rojo **si la guía está en el chat**; si no, escala `pedido_en_camino` | PLANTILLA_15 condicionada |
| Errores, reembolsos y retiro en vez de envío | Asesor | **Asesor** | `cancelar_orden_cashea` |

**Lo que v2 nunca dice:**
- "gracias por tu compra", que es del asesor y solo después de verificar;
- "tenemos" sin stock;
- una cifra que no salga de la cotización armada en el código.

### Decisiones 22 y 23 (contestadas el 24/10)

22. **¿Armamos una tabla producto → link de Cashea?** Los asesores mandaron 1.481 links, pero son
    solo 238 distintos: **los 50 más usados cubren el 77 % de los envíos y los 100 primeros el
    88 %**. Una tabla de unas 100 filas, que los asesores mantengan desde el panel, le permite a
    Seba mandar el link en el mismo mensaje que el precio, que es el patrón 1 de las ventas
    ejemplares. Sin la tabla, Seba manda la instrucción de buscar en la app, y el link lo sigue
    mandando un asesor. **Respuesta: queda como nota para cuando se haga la integración con Cashea.**
23. **¿Seba puede invitar a comprar directo en la app de Cashea** ("buscanos como SBK Motors")?
    Hoy lo hace PLANTILLA_03, y 47 de las 150 ventas asistidas se compraron así. **Respuesta: sí,
    aunque por ahora el link lo manda el asesor.**

## 7. Cómo entra al rework

- **S3b, cotizar:** el formato "todo en un mensaje" del §4, el complemento para el mínimo y el aviso
  de "envío gratis, no retiro en tienda" junto al link.
- **S3f, nueva, "después de la compra":**
  - ante "listo", una captura o un "ya compré": pide cédula y talla una sola vez, escala con
    `comprobante_pago` y deja la nota con producto, nivel de Cashea si lo dijo, ciudad y talla;
  - nunca "gracias por tu compra".
- **C2, arnés:**
  - los 19 ejemplos entran como casos de varios turnos, con el éxito medido en dos puntos: Seba
    llega al mismo punto que el asesor (precio + link, o cédula pedida) y en menos mensajes;
  - el set de 311 casos ahora trae `venta_confirmada`: 188 vienen de una venta real.
- **Métrica nueva para la sombra:** del primer mensaje al precio y del precio a la guía, comparados
  con la tabla del §3. Si v2 funciona, el tramo 1.er mensaje → precio baja de 73 min a segundos, y
  la conversión por cotización (8 %) sube.
