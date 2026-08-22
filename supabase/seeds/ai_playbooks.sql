-- ============================================================================
-- Respuestas predeterminadas de la IA — punto de partida
--
-- Los cinco casos que SBK Motors ya resuelve a mano hoy. Los textos son un
-- borrador: se editan desde el panel (/agent-control > Respuestas), sin
-- necesidad de tocar este archivo ni volver a desplegar.
--
-- Los dos escenarios con catálogo quedan sin URL a propósito: cada uno lleva
-- el link que configure la repuestera. Un escenario sin adjunto envía solo su
-- texto, así que todos funcionan desde el primer día.
-- ============================================================================

insert into public.ai_playbooks (name, trigger_description, response_text, attachment_type, after_send)
values
  (
    'Postventa Cashea',
    'El cliente avisa que acaba de hacer una compra por Cashea, o cuenta que compró por Cashea sin reportar ningún problema.',
    E'¡Gracias por tu compra! 🏍️\n\nYa estamos procesando tu pedido. Te escribimos por acá apenas tengamos la guía de envío lista.\n\nCualquier cosa que necesites, escríbenos con confianza.',
    null,
    'wait'
  ),
  (
    'Guía de envío · Cashea',
    'El cliente reclama que compró hace días y todavía no le llega la guía de envío o el pedido, Y la compra fue por Cashea (lo dice ahora o lo mencionó antes en la conversación).',
    'Con gusto lo reviso. Pásame la cédula del titular de la cuenta de Cashea, por favor, así busco tu pedido.',
    null,
    'escalate'
  ),
  (
    'Guía de envío · compra directa',
    'El cliente reclama que compró hace días y todavía no le llega la guía de envío o el pedido, y la compra NO fue por Cashea (compró directo) o no ha dicho por dónde compró.',
    'Con gusto lo reviso. Pásame tu nombre y apellido, por favor, así busco tu pedido.',
    null,
    'escalate'
  ),
  (
    'Catálogo general',
    'El cliente pide ver el catálogo, pregunta por accesorios en general, o quiere saber qué tienen disponible sin nombrar un repuesto específico.',
    'Claro que sí, por acá te dejo nuestro catálogo 👇',
    null,
    'wait'
  ),
  (
    'Niveles de Cashea',
    'El cliente pregunta por los niveles de Cashea, cuánto tiene que dar de inicial, o cómo funcionan las cuotas según su nivel.',
    'Te paso la información de los niveles de Cashea 👇',
    null,
    'wait'
  );
