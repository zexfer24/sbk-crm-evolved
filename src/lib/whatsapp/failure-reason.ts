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
  131026:
    "El número no está en WhatsApp o no puede recibir mensajes. Confirma el número con el cliente.",
  131047:
    "Pasaron más de 24 h desde el último mensaje del cliente: hasta que vuelva a escribir solo entra una plantilla aprobada.",
  131049: "Meta no entregó el mensaje para cuidar la experiencia del usuario.",
  131051: "Meta no sabe entregar este tipo de mensaje.",
  131053: "Meta no pudo procesar el archivo adjunto.",
  132000: "La plantilla no coincide con lo que Meta tiene aprobado.",
  132001: "La plantilla no existe o no está aprobada en ese idioma.",
  133010: "El número de la tienda no está registrado en la Cloud API.",
  190: "El token de acceso venció: hay que renovarlo en el servidor.",
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
