import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchCurrentAgent } from "@/lib/data";
import { errorText, log } from "@/lib/log";
import { agentAccountPatchSchema, firstIssueMessage, type AgentAccountPatchResponse } from "@/lib/agent-account";

// ---------------------------------------------------------------------------
// Editar el nombre visible y la contraseña de una cuenta del CRM (T6, "Ronda
// del cliente", 30/9/2026).
//
// Hasta esta fecha solo se podía desde Supabase Studio, y los administradores
// del negocio no tienen acceso ahí. La contraseña vive en `auth.users`
// (GoTrue): cambiarla exige `auth.admin.updateUserById`, que solo existe con
// `service_role`. Por eso esta ruta usa el cliente admin — y como ese cliente
// salta la RLS de `agents` y el trigger `enforce_agents_role_guard`
// (20260928050000), la guarda de "solo admin" la hace ESTA ruta, y el cliente
// admin no se crea hasta haberla pasado. Mismo patrón de dos capas que
// `api/conversations/[id]/close`: la sesión normal solo dice quién pide.
//
// La contraseña no aparece jamás en logs, respuestas ni mensajes de error: el
// log lleva los NOMBRES de los campos, y un error de GoTrue se traduce a un
// motivo propio en vez de copiar su texto.
// ---------------------------------------------------------------------------

type Json = AgentAccountPatchResponse | { error: string };

function json(body: Json, status: number) {
  return NextResponse.json(body, { status });
}

const NOT_FOUND = "No existe ese asesor.";

interface AuthErrorLike {
  code?: string;
  status?: number;
}

/**
 * El motivo que ve el admin cuando GoTrue rechaza la contraseña. Nunca se
 * copia `error.message`: es texto en inglés del proveedor y nada garantiza
 * que no repita lo que se le mandó.
 */
function passwordFailureReason(error: unknown): string {
  const { code, status } = (error ?? {}) as AuthErrorLike;
  switch (code) {
    case "weak_password":
      return "el servicio de acceso la considera demasiado débil.";
    case "same_password":
      return "es igual a la contraseña actual.";
    case "user_not_found":
      return "la cuenta de acceso de ese asesor no existe.";
    default:
      return typeof status === "number"
        ? `el servicio de acceso respondió con el código ${status}.`
        : "el servicio de acceso no respondió.";
  }
}

/** Texto de log de un error, con cualquier aparición de la contraseña tapada. */
function redacted(error: unknown, password: string | undefined): string {
  const text = errorText(error);
  return password ? text.split(password).join("[oculto]") : text;
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id: targetId } = await context.params;

  // 1. Sesión.
  const supabase = await createClient();
  let agent;
  try {
    agent = await fetchCurrentAgent(supabase);
  } catch (err) {
    log.error("asesor_edicion_sesion_no_consultable", { targetId, detail: errorText(err) });
    return json({ error: "No se pudo verificar la sesión." }, 500);
  }
  if (!agent) return json({ error: "Sin sesión." }, 401);

  // 2. Solo admin. El cliente admin todavía no existe en este punto.
  if (agent.role !== "admin") {
    return json({ error: "Solo un administrador puede editar cuentas." }, 403);
  }

  // 3. Cuerpo.
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: "El cuerpo de la petición no es JSON válido." }, 400);
  }
  const parsed = agentAccountPatchSchema.safeParse(raw);
  if (!parsed.success) return json({ error: firstIssueMessage(parsed.error) }, 400);
  const { displayName, password } = parsed.data;

  // 4. El asesor existe. Un id que no es UUID haría que PostgREST responda
  // 22P02 (un 500 que no dice nada): para quien pide, no existe.
  if (!z.uuid().safeParse(targetId).success) return json({ error: NOT_FOUND }, 404);

  const admin = createAdminClient();
  const { data: target, error: readError } = await admin.from("agents").select("id").eq("id", targetId).maybeSingle();
  if (readError) {
    log.error("asesor_edicion_lectura_fallida", { targetId, byId: agent.id, detail: errorText(readError) });
    return json({ error: "No se pudo leer ese asesor." }, 500);
  }
  if (!target) return json({ error: NOT_FOUND }, 404);

  const failures: string[] = [];
  let nameUpdated = false;
  let passwordUpdated = false;

  // 5. Nombre visible. La UI muestra siempre `agents.display_name`; el
  // metadata de auth solo lo lee `handle_new_agent` al crear el usuario, así
  // que un fallo ahí no invalida el nombre: queda un aviso y nada más.
  if (displayName !== undefined) {
    const { data: rows, error: nameError } = await admin
      .from("agents")
      .update({ display_name: displayName })
      .eq("id", targetId)
      .select("id");
    if (nameError || !rows || rows.length === 0) {
      log.error("asesor_nombre_no_cambiado", {
        targetId,
        byId: agent.id,
        detail: nameError ? errorText(nameError) : "el UPDATE no afectó ninguna fila",
      });
      failures.push("No se pudo cambiar el nombre visible.");
    } else {
      nameUpdated = true;
      try {
        const { error: metaError } = await admin.auth.admin.updateUserById(targetId, {
          user_metadata: { display_name: displayName },
        });
        if (metaError) {
          log.warn("asesor_metadata_nombre_no_sincronizado", { targetId, detail: errorText(metaError) });
        }
      } catch (err) {
        log.warn("asesor_metadata_nombre_no_sincronizado", { targetId, detail: errorText(err) });
      }
    }
  }

  // 6. Contraseña. La sesión de quien la cambia sigue viva: GoTrue no
  // revoca los refresh tokens al actualizar por la API de admin.
  if (password !== undefined) {
    let authError: unknown = null;
    try {
      const { error } = await admin.auth.admin.updateUserById(targetId, { password });
      authError = error;
    } catch (err) {
      authError = err;
    }
    if (authError) {
      log.error("asesor_clave_no_cambiada", { targetId, byId: agent.id, detail: redacted(authError, password) });
      failures.push(`No se pudo cambiar la contraseña: ${passwordFailureReason(authError)}`);
    } else {
      passwordUpdated = true;
    }
  }

  const campos = [nameUpdated && "nombre", passwordUpdated && "contraseña"].filter(Boolean).join(",");
  if (campos) log.info("asesor_editado", { targetId, byId: agent.id, campos });

  if (failures.length === 0) return json({ ok: true, nameUpdated, passwordUpdated }, 200);

  // Nunca un «guardado» a medias en silencio: 207 si algo quedó, 500 si nada.
  const status = nameUpdated || passwordUpdated ? 207 : 500;
  return json({ ok: false, nameUpdated, passwordUpdated, error: failures.join(" ") }, status);
}
