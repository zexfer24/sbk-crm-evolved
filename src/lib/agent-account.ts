import { z } from "zod";

// ---------------------------------------------------------------------------
// Edición de cuentas del equipo desde Control IA (T6, "Ronda del cliente",
// 30/9/2026).
//
// Hasta esta fecha el nombre visible y la contraseña de un asesor solo se
// podían cambiar desde Supabase Studio, y los administradores del negocio no
// tienen acceso ahí. Este módulo es puro y lo comparten los dos lados: la
// ruta `PATCH /api/agents/[id]` valida el cuerpo con `agentAccountPatchSchema`
// y el modal de la pestaña «Equipo» valida campo por campo con
// `validateAgentAccountDraft`, con los MISMOS mensajes — un tope distinto en
// cada lado haría que el modal deje pasar algo que la ruta después rechaza.
//
// La contraseña se valida sin recortar (un espacio es un carácter legítimo)
// y ningún mensaje la repite: los mensajes son textos fijos, nunca el valor.
// ---------------------------------------------------------------------------

const DISPLAY_NAME_MAX = 60;
const PASSWORD_MIN = 8;
// 72 es el límite de bcrypt, el hash de GoTrue: lo que pase de ahí se ignora
// en silencio al comparar, así que se rechaza antes de guardarlo.
const PASSWORD_MAX = 72;

const MSG_NAME_EMPTY = "El nombre visible no puede quedar vacío.";
const MSG_NAME_LONG = `El nombre visible admite hasta ${DISPLAY_NAME_MAX} caracteres.`;
const MSG_PASSWORD_SHORT = `La contraseña debe tener al menos ${PASSWORD_MIN} caracteres.`;
const MSG_PASSWORD_LONG = `La contraseña admite hasta ${PASSWORD_MAX} caracteres.`;
const MSG_NOTHING = "Nada que cambiar.";
const MSG_MISMATCH = "Las contraseñas no coinciden.";

const displayNameSchema = z
  .string({ error: "El nombre visible debe ser texto." })
  .trim()
  .min(1, MSG_NAME_EMPTY)
  .max(DISPLAY_NAME_MAX, MSG_NAME_LONG);

const passwordSchema = z
  .string({ error: "La contraseña debe ser texto." })
  .min(PASSWORD_MIN, MSG_PASSWORD_SHORT)
  .max(PASSWORD_MAX, MSG_PASSWORD_LONG);

/**
 * Cuerpo de `PATCH /api/agents/[id]`. Estricto a propósito: un `role` o un
 * `email` en el cuerpo se rechaza en vez de ignorarse, para que nadie crea
 * que cambió algo que esta ruta no toca (correo y rol quedan fuera de T6).
 */
export const agentAccountPatchSchema = z
  .strictObject(
    {
      displayName: displayNameSchema.optional(),
      password: passwordSchema.optional(),
    },
    {
      error: (issue) =>
        issue.code === "unrecognized_keys"
          ? "Solo se puede cambiar el nombre visible y la contraseña."
          : "El cuerpo de la petición no es válido.",
    }
  )
  .refine((body) => body.displayName !== undefined || body.password !== undefined, { error: MSG_NOTHING });

export type AgentAccountPatch = z.infer<typeof agentAccountPatchSchema>;

/** El primer mensaje de un error de zod, que es el que se le muestra al usuario. */
export function firstIssueMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "El cuerpo de la petición no es válido.";
}

/**
 * Respuesta de la ruta. `ok: false` con alguno de los dos en `true` es una
 * edición a medias (HTTP 207): el modal dice qué quedó y qué no, nunca un
 * «guardado» en silencio.
 */
export interface AgentAccountPatchResponse {
  ok: boolean;
  nameUpdated?: boolean;
  passwordUpdated?: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Validación del modal
// ---------------------------------------------------------------------------

export interface AgentAccountDraft {
  /** El nombre que tenía el asesor al abrir el modal: sin cambio, no se manda. */
  originalDisplayName: string;
  displayName: string;
  /** Vacía = no se cambia la contraseña. */
  password: string;
  confirmPassword: string;
}

export type AgentAccountField = "displayName" | "password" | "confirmPassword";

export interface AgentAccountDraftResult {
  errors: Partial<Record<AgentAccountField, string>>;
  /** Solo lo que cambió: es exactamente el cuerpo que se manda a la ruta. */
  patch: { displayName?: string; password?: string };
  /** Sin cambios, el botón Guardar queda deshabilitado. */
  hasChanges: boolean;
  isValid: boolean;
}

export function validateAgentAccountDraft(draft: AgentAccountDraft): AgentAccountDraftResult {
  const errors: AgentAccountDraftResult["errors"] = {};
  const patch: AgentAccountDraftResult["patch"] = {};

  const trimmedName = draft.displayName.trim();
  if (trimmedName !== draft.originalDisplayName.trim()) {
    const parsed = displayNameSchema.safeParse(draft.displayName);
    if (parsed.success) patch.displayName = parsed.data;
    else errors.displayName = firstIssueMessage(parsed.error);
  }

  if (draft.password !== "") {
    const parsed = passwordSchema.safeParse(draft.password);
    if (parsed.success) patch.password = parsed.data;
    else errors.password = firstIssueMessage(parsed.error);
  }

  if (draft.password !== draft.confirmPassword) {
    errors.confirmPassword = MSG_MISMATCH;
  }

  const hasChanges = trimmedName !== draft.originalDisplayName.trim() || draft.password !== "";
  // Sin cambios no se valida como error: el botón ya queda deshabilitado.
  // Una confirmación escrita sin contraseña sí es un error (el asesor creyó
  // estar cambiándola), aunque no haya nada que mandar.
  return { errors, patch, hasChanges, isValid: Object.keys(errors).length === 0 && hasChanges };
}
