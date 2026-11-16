import { FormattedText } from "@/components/chat/formatted-text";
import "@/components/agent-control/seba-v2.css";

/**
 * Burbuja de vista previa de un texto saliente (T4, "Entrega 2 de Seba v2: los
 * datos del negocio", 16/11/2026). Muestra cómo le va a llegar el texto al
 * cliente por WhatsApp —con `*negrita*`, `_cursiva_`, enlaces y los saltos de
 * línea tal cual— mientras el supervisor lo escribe, para no tener que mandarse
 * un mensaje de prueba. La reutilizan las formas de pago, el bloque de Cashea y
 * (tarea siguiente) la bienvenida.
 *
 * Usa `FormattedText`, el mismo que pinta las burbujas del chat: lo que se ve
 * acá es lo que el asesor vería en la conversación.
 */
export function WhatsappPreview({
  text,
  label,
  emptyHint,
}: {
  text: string;
  /** Nombre accesible de la burbuja ("Vista previa de Pago móvil"). */
  label: string;
  /** Qué decir mientras no hay texto. */
  emptyHint?: string;
}) {
  const isEmpty = text.trim() === "";
  return (
    <div className="ac-sv-preview">
      <div className="ac-sv-bubble" role="group" aria-label={label} data-empty={isEmpty}>
        {isEmpty ? <span className="ac-sv-bubble-empty">{emptyHint ?? "Sin texto todavía"}</span> : <FormattedText text={text} />}
      </div>
    </div>
  );
}
