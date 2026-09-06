// ---------------------------------------------------------------------------
// Del código de Meta a algo que el asesor pueda hacer.
//
// Cuando un envío falla, la Cloud API manda un código y un texto en inglés. El
// texto sirve para buscar en la documentación; no sirve para que alguien que
// está atendiendo un chat decida qué hacer a continuación. Y esa decisión es
// justo lo que cambia según el motivo:
//
//   - "el número no existe"  -> pedirle el número bueno al cliente
//   - "pasaron 24 h"         -> esperar a que el cliente vuelva a escribir
//
// Hasta ahora los dos se veían igual —un triángulo rojo— así que el asesor
// hacía lo único que un triángulo rojo sugiere: reintentar. Que no arregla
// ninguno de los dos.
//
// La tabla cubre lo que de verdad pasa en una repuestera. Lo que no esté cae
// al texto de Meta con su código pegado, que es peor que una traducción pero
// mucho mejor que nada — y deja el código a mano para buscarlo.
// ---------------------------------------------------------------------------

const MOTIVOS_CONOCIDOS: Record<number, string> = {
  100: "Meta rechazó la petición por un dato inválido.",
  // El 5/9/2026 a la noche el lead +593987317372 mandó un aviso de cambio de
  // número que el CRM no supo guardar; el 6/9/2026 el asesor le escribió al
  // número viejo y Meta rechazó con 131026, aunque ese número había leído
  // mensajes el 31/8 y el canal despachaba bien (1.553 mensajes esas 24 h):
  // el número no dejó de existir, dejó de ser cuenta de WhatsApp. D4
  // (6/9/2026): la frase ahora manda al asesor a mirar el chat primero.
  131026:
    "Este número ya no recibe WhatsApp. Si en el chat hay un aviso de cambio de número, escríbele al nuevo; si no, confírmalo con el cliente por otro medio.",
  131047:
    "Pasaron más de 24 h desde el último mensaje del cliente: hasta que vuelva a escribir solo entra una plantilla aprobada.",
  131049: "Meta no entregó el mensaje para cuidar la experiencia del usuario.",
  131051: "Meta no sabe entregar este tipo de mensaje.",
  131053: "Meta no pudo procesar el archivo adjunto.",
  132000: "La plantilla no coincide con lo que Meta tiene aprobado (le sobran o faltan variables).",
  132001: "La plantilla no existe o no está aprobada en ese idioma.",
  133010: "El número de la tienda no está registrado en la Cloud API.",
  190: "El token de acceso venció: hay que renovarlo en el servidor.",

  // -------------------------------------------------------------------------
  // Tabla completa T3.3 (5/9/2026). Los códigos que Meta agrupa bajo el mismo
  // motivo en su documentación llevan la misma frase acá: distinguirlos no le
  // suma nada al asesor, que necesita saber QUÉ hacer, no el número exacto.
  // -------------------------------------------------------------------------

  // El cliente cerró la puerta él mismo: no hay nada que reintentar.
  131050:
    "El cliente dejó de aceptar mensajes de marketing de este número por WhatsApp. Puede seguir escribiendo él, pero no se le puede reenviar publicidad.",

  // Ritmo de envío hacia ESE número, no hacia la cuenta entera.
  131056:
    "Se mandaron demasiados mensajes seguidos a este mismo número en poco tiempo. Espera un momento antes de reintentar.",

  // Cupo de la cuenta/app frente a Meta, no de este chat en particular.
  130429: "Se alcanzó el límite de mensajes que Meta deja enviar por ahora. Espera unos minutos y reintenta.",
  80007: "Se alcanzó el límite de mensajes que Meta deja enviar por ahora. Espera unos minutos y reintenta.",
  4: "Se alcanzó el límite de peticiones que Meta deja hacer por ahora. Espera unos minutos y reintenta.",

  // Plantilla: el problema no es el envío, es la plantilla misma.
  132012:
    "Los datos que se pusieron en la plantilla no tienen el formato que espera (una fecha, un monto). Revísalos y reintenta.",
  132015:
    "Meta pausó esta plantilla por baja calidad: no se puede enviar hasta que mejore o se cree una nueva.",
  132016:
    "Meta deshabilitó esta plantilla para siempre por baja calidad repetida: hay que crear una plantilla nueva.",

  // El número o la cuenta del negocio, no este mensaje en particular.
  131037: "El número de WhatsApp del negocio tiene una restricción de Meta y no puede enviar. Revisa el Administrador Comercial.",
  131031:
    "La cuenta de WhatsApp del negocio quedó restringida o deshabilitada por Meta. Revisa el Administrador Comercial.",
  368: "La cuenta de WhatsApp del negocio quedó restringida o deshabilitada por Meta. Revisa el Administrador Comercial.",

  131064:
    "La cuenta llegó a su límite de envío por plantillas de mala calidad repetidas. Hay que mejorar la calidad de las plantillas antes de seguir mandando.",
};

/**
 * Motivo legible del fallo, o null si el mensaje no falló.
 *
 * Devuelve null y no una cadena vacía a propósito: la burbuja distingue "no
 * falló" de "falló y no sabemos por qué", y son dos cosas distintas de mostrar.
 */
export function failureReason(code: number | null, detail: string | null): string | null {
  if (code !== null) {
    const conocido = MOTIVOS_CONOCIDOS[code];
    if (conocido) return conocido;
  }

  const texto = detail?.trim();
  if (texto) return code === null ? texto : `${texto} (código ${code})`;
  if (code !== null) return `Meta rechazó el envío con el código ${code}.`;

  return null;
}

/**
 * Las acciones que la frase de arriba puede sugerir y que además tienen un
 * gesto concreto en la interfaz — hoy solo una: la ventana de 24 h vencida
 * (131047) se arregla abriendo el selector de plantillas, no reintentando.
 * El resto de los motivos ya dice qué hacer en la propia frase (esperar,
 * revisar el Administrador Comercial, pedir el número), pero no tienen un
 * botón que hacer desde la burbuja.
 */
export type FailureAction = "abrir_plantillas";

/** Acción sugerida para el código, o null si la frase ya se basta sola. */
export function failureAction(code: number | null): FailureAction | null {
  if (code === 131047) return "abrir_plantillas";
  return null;
}
