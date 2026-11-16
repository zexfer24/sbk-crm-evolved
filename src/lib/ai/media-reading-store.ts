import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";
import { leerImagen, transcribirAudio } from "@/lib/ai/media-reading";
import { lecturaDeMediaActiva } from "@/lib/ai/media-reading-switch";
import { visionModelId } from "@/lib/ai/model";
import { errorText, log } from "@/lib/log";

// ---------------------------------------------------------------------------
// Puente entre el webhook y la lectura de adjuntos (plan "Seba lee fotos y
// audios", 16/11/2026, tarea M3). El webhook ya tiene los bytes en memoria
// cuando termina de subir el archivo a storage: acá se escribe la fila
// `pendiente` de `message_readings`, se llama al modelo y se guarda el
// resultado, sin volver a bajar nada.
//
// Regla de oro: NADA de esto puede cambiar el resultado del webhook. Las dos
// funciones exportadas no lanzan nunca; un fallo inesperado deja un
// `log.warn` y la fila (si llegó a existir) en `fallo`.
//
// Privacidad: lo leído es contenido del cliente (a veces una cédula o un
// comprobante). Esto NUNCA loguea el texto ni los campos, solo ids, estado y
// motivo.
// ---------------------------------------------------------------------------

export type ReadingKind = "audio" | "image";

type Admin = SupabaseClient<Database>;

/** `audio` → audio, `image` → image; video, documento, sticker y el resto no se leen. */
export function kindDeLectura(messageType: string | null | undefined): ReadingKind | null {
  if (messageType === "audio") return "audio";
  if (messageType === "image") return "image";
  return null;
}

/** Escribe el cierre de una lectura que no llegó a hacerse (tope, excepción). */
async function guardarFallo(admin: Admin, messageId: string, motivo: string): Promise<void> {
  const { error } = await admin
    .from("message_readings")
    .update({ status: "fallo", error: motivo, updated_at: new Date().toISOString() })
    .eq("message_id", messageId)
    .select("message_id");
  if (error) {
    log.warn("lectura_no_guardada", { messageId, status: "fallo", detail: errorText(error) });
  }
}

/**
 * ¿Ya se alcanzó el tope de gasto diario de la IA? Mismo criterio que
 * `agent_can_run()`: la lectura también gasta, así que respeta el tope. Falla
 * CERRADO: si no se puede consultar, no se gasta (es un freno de gasto).
 */
async function topeDeGasto(admin: Admin): Promise<"ok" | "alcanzado" | "no_consultable"> {
  const [settings, gasto] = await Promise.all([
    admin.from("agent_settings").select("daily_spend_cap_usd").eq("id", true).maybeSingle(),
    admin.rpc("agent_spend_today"),
  ]);
  if (settings.error || gasto.error) {
    log.warn("lectura_tope_no_consultable", {
      detail: errorText(settings.error ?? gasto.error),
    });
    return "no_consultable";
  }
  const tope = settings.data?.daily_spend_cap_usd;
  if (tope === null || tope === undefined) return "ok";
  return Number(gasto.data) >= Number(tope) ? "alcanzado" : "ok";
}

/** Tarifa del modelo de visión; sin fila la lectura se hace igual, sin costo. */
async function preciosDeVision(admin: Admin): Promise<{ input: number; output: number } | undefined> {
  const model = visionModelId();
  const { data, error } = await admin
    .from("model_pricing")
    .select("input_price_per_million, output_price_per_million")
    .eq("model", model)
    .maybeSingle();
  if (error || !data) {
    log.warn("lectura_sin_tarifa", { model, detail: error ? errorText(error) : undefined });
    return undefined;
  }
  return {
    input: Number(data.input_price_per_million),
    output: Number(data.output_price_per_million),
  };
}

/**
 * Lee un audio o una imagen recién subidos y guarda la lectura en
 * `message_readings`. Orden: fila `pendiente` → tope de gasto → modelo →
 * resultado. La fila `pendiente` va PRIMERO a propósito: el turno del agente
 * espera por ella (`wait-readings.ts`) y, sin fila, creería que no hay nada
 * que esperar.
 */
export async function registrarLectura(
  admin: Admin,
  input: { messageId: string; conversationId: string; kind: ReadingKind; bytes: Uint8Array; mime: string },
): Promise<void> {
  if (!lecturaDeMediaActiva()) return;
  const { messageId, conversationId, kind, bytes, mime } = input;

  try {
    // `ignoreDuplicates`: una reentrega del webhook no pisa una lectura ya hecha.
    const { error: pendienteError } = await admin
      .from("message_readings")
      .upsert(
        { message_id: messageId, conversation_id: conversationId, kind, status: "pendiente" },
        { onConflict: "message_id", ignoreDuplicates: true },
      );
    if (pendienteError) {
      // Cubre "el código llegó antes que la migración": no se gasta en una
      // lectura que no se puede guardar.
      log.warn("lectura_no_registrada", { messageId, detail: errorText(pendienteError) });
      return;
    }

    const tope = await topeDeGasto(admin);
    if (tope !== "ok") {
      await guardarFallo(admin, messageId, tope === "alcanzado" ? "tope_de_gasto" : "tope_no_consultable");
      return;
    }

    const ahora = () => new Date().toISOString();
    let parcial: Database["public"]["Tables"]["message_readings"]["Update"];
    if (kind === "audio") {
      const lectura = await transcribirAudio(bytes, mime);
      parcial = {
        status: lectura.status,
        model: lectura.model,
        text: lectura.text,
        fields: null,
        error: lectura.error ?? null,
        duration_ms: lectura.durationMs,
        audio_seconds: lectura.audioSeconds,
        input_tokens: null,
        output_tokens: null,
        cost_usd: lectura.costUsd,
        updated_at: ahora(),
      };
    } else {
      const precios = await preciosDeVision(admin);
      const lectura = await leerImagen(bytes, mime, precios);
      parcial = {
        status: lectura.status,
        model: lectura.model,
        text: lectura.text,
        fields: lectura.fields as Json | null,
        error: lectura.error ?? null,
        duration_ms: lectura.durationMs,
        audio_seconds: null,
        input_tokens: lectura.inputTokens,
        output_tokens: lectura.outputTokens,
        cost_usd: lectura.costUsd,
        updated_at: ahora(),
      };
    }

    const { data, error } = await admin
      .from("message_readings")
      .update(parcial)
      .eq("message_id", messageId)
      .select("message_id");
    if (error || !data || data.length === 0) {
      log.warn("lectura_no_guardada", {
        messageId,
        status: parcial.status,
        detail: error ? errorText(error) : "0 filas afectadas",
      });
    }
  } catch (err) {
    // Las dos funciones de lectura no lanzan, así que esto es una sorpresa:
    // se avisa y se intenta dejar la fila en `fallo` para que el turno no la
    // espere como pendiente.
    log.warn("lectura_excepcion", { messageId, detail: errorText(err) });
    try {
      await guardarFallo(admin, messageId, "excepcion");
    } catch {
      // Sin más red: el aviso de arriba ya quedó.
    }
  }
}

/**
 * La descarga o la subida del adjunto falló: se deja constancia para que el
 * turno no espere una lectura que nunca va a llegar. Sobrescribe cualquier
 * fila previa (sin `ignoreDuplicates`).
 */
export async function registrarFalloDeDescarga(
  admin: Admin,
  input: { messageId: string; conversationId: string; kind: ReadingKind },
): Promise<void> {
  if (!lecturaDeMediaActiva()) return;
  try {
    const { error } = await admin.from("message_readings").upsert(
      {
        message_id: input.messageId,
        conversation_id: input.conversationId,
        kind: input.kind,
        status: "fallo",
        error: "descarga",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "message_id" },
    );
    if (error) {
      log.warn("lectura_no_registrada", { messageId: input.messageId, detail: errorText(error) });
    }
  } catch (err) {
    log.warn("lectura_no_registrada", { messageId: input.messageId, detail: errorText(err) });
  }
}
