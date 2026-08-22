import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Agent,
  CedulaType,
  MessageType,
  Playbook,
  SaleItemOrigin,
  TagColor,
  WhatsappTemplate,
} from "@/lib/types";

async function insertSystemEvent(
  supabase: SupabaseClient,
  conversationId: string,
  agentId: string | null,
  content: string
) {
  const { error } = await supabase.from("messages").insert({
    conversation_id: conversationId,
    direction: "outbound",
    sender_type: "system",
    sender_agent_id: agentId,
    message_type: "system_event",
    content,
  });
  if (error) throw error;
}

/**
 * Envía un mensaje pasando por /api/messages/send: esa ruta decide si hace
 * falta llamar a la Cloud API de Meta (canal conectado) o solo simularlo
 * (canal de demo), y nunca expone el access token al navegador.
 */
interface SendMessagePayload {
  conversationId: string;
  kind: "text" | "template" | "media";
  content?: string;
  isInternalNote?: boolean;
  templateName?: string;
  templateLanguage?: string;
  replyToMessageId?: string | null;
  mediaUrl?: string;
  mediaType?: MessageType;
}

async function postSendMessage(payload: SendMessagePayload) {
  const res = await fetch("/api/messages/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? "No se pudo enviar el mensaje.");
  }
}

export async function sendMessage(
  conversationId: string,
  content: string,
  isInternalNote: boolean,
  replyToMessageId?: string | null
) {
  await postSendMessage({ conversationId, kind: "text", content, isInternalNote, replyToMessageId });
}

export async function sendTemplateMessage(conversationId: string, template: WhatsappTemplate) {
  await postSendMessage({
    conversationId,
    kind: "template",
    content: template.bodyPreview,
    templateName: template.name,
    templateLanguage: template.language,
  });
}

export async function sendMediaMessage(
  conversationId: string,
  mediaUrl: string,
  mediaType: MessageType,
  caption: string | undefined,
  replyToMessageId?: string | null
) {
  await postSendMessage({
    conversationId,
    kind: "media",
    content: caption,
    mediaUrl,
    mediaType,
    replyToMessageId,
  });
}

export async function markConversationRead(supabase: SupabaseClient, conversationId: string) {
  const { error } = await supabase
    .from("conversations")
    .update({ unread_count: 0 })
    .eq("id", conversationId);
  if (error) throw error;
}

export async function assignToMe(supabase: SupabaseClient, conversationId: string, agent: Agent) {
  const { error } = await supabase
    .from("conversations")
    .update({ assigned_agent_id: agent.id })
    .eq("id", conversationId);
  if (error) throw error;
  await insertSystemEvent(
    supabase,
    conversationId,
    agent.id,
    `${agent.displayName} se auto-asignó la conversación`
  );
}

export async function unassign(supabase: SupabaseClient, conversationId: string, byAgent: Agent, currentAssigneeName: string | null) {
  const { error } = await supabase
    .from("conversations")
    .update({ assigned_agent_id: null })
    .eq("id", conversationId);
  if (error) throw error;
  await insertSystemEvent(
    supabase,
    conversationId,
    byAgent.id,
    `${currentAssigneeName ?? "El agente"} fue desasignado de la conversación`
  );
}

export async function setAiEnabled(
  supabase: SupabaseClient,
  conversationId: string,
  agent: Agent,
  enabled: boolean
) {
  const { error } = await supabase
    .from("conversations")
    .update({ ai_enabled: enabled })
    .eq("id", conversationId);
  if (error) throw error;
  await insertSystemEvent(
    supabase,
    conversationId,
    agent.id,
    enabled
      ? `${agent.displayName} reactivó las respuestas automáticas de la IA`
      : `${agent.displayName} pausó la IA en esta conversación`
  );
}

export async function intervene(supabase: SupabaseClient, conversationId: string, agent: Agent) {
  const { error } = await supabase
    .from("conversations")
    .update({ assigned_agent_id: agent.id })
    .eq("id", conversationId);
  if (error) throw error;
  await insertSystemEvent(
    supabase,
    conversationId,
    agent.id,
    `${agent.displayName} intervino la conversación`
  );
}

export interface ContactSaleDetails {
  displayName: string;
  cedulaType: CedulaType | null;
  cedulaNumber: string | null;
  state: string | null;
  city: string | null;
  address: string | null;
  paymentProofUrl: string | null;
}

/**
 * Un renglón de la venta. El precio viene siempre del catálogo —de la
 * cotización que la IA le dio al cliente, o del inventario cuando el asesor
 * lo agrega— nunca de un número escrito a mano.
 */
export interface SaleLineItem {
  /** Clave del renglón: id de la cotización, o del producto si lo agregó el asesor. */
  id: string;
  origin: SaleItemOrigin;
  productId: string | null;
  description: string;
  unitPrice: number;
  quantity: number;
}

export async function closeSaleWithContactInfo(
  supabase: SupabaseClient,
  conversationId: string,
  contactId: string,
  agent: Agent,
  details: ContactSaleDetails,
  items: SaleLineItem[],
  bcvRate: number
) {
  if (items.length === 0) {
    throw new Error("Agrega al menos un repuesto para poder cerrar la venta.");
  }

  const totalAmount = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);

  const { data: order, error: orderError } = await supabase
    .from("orders")
    .insert({ contact_id: contactId, currency: "USD", total_amount: totalAmount, bcv_rate: bcvRate })
    .select("id")
    .single();
  if (orderError || !order) throw orderError ?? new Error("No se pudo crear la orden de la venta.");

  const { error: itemsError } = await supabase.from("order_items").insert(
    items.map((item) => ({
      order_id: order.id,
      product_id: item.productId,
      description: item.description,
      quantity: item.quantity,
      unit_price: item.unitPrice,
    }))
  );
  if (itemsError) throw itemsError;

  const { error: contactError } = await supabase
    .from("contacts")
    .update({
      display_name: details.displayName,
      cedula_type: details.cedulaType,
      cedula_number: details.cedulaNumber,
      state: details.state,
      city: details.city,
      address: details.address,
    })
    .eq("id", contactId);
  if (contactError) throw contactError;

  const { error: conversationError } = await supabase
    .from("conversations")
    .update({
      deal_status: "won",
      deal_closed_at: new Date().toISOString(),
      deal_payment_proof_url: details.paymentProofUrl,
      deal_verified: false,
      deal_verified_at: null,
      deal_verified_by: null,
      order_id: order.id,
    })
    .eq("id", conversationId);
  if (conversationError) throw conversationError;

  // El evento deja constancia de cuánto de la venta NO pasó por el chat.
  // order_items no distingue la procedencia de cada renglón, así que este
  // es el único rastro de que el asesor agregó algo a mano.
  const agregados = items.filter((item) => item.origin === "inventory").length;
  const detalleAgregados =
    agregados === 0
      ? ""
      : agregados === 1
        ? " (1 repuesto agregado por el asesor)"
        : ` (${agregados} repuestos agregados por el asesor)`;

  await insertSystemEvent(
    supabase,
    conversationId,
    agent.id,
    `Venta cerrada por ${agent.displayName} — $${totalAmount.toFixed(2)}${detalleAgregados}`
  );
}

export async function verifySale(supabase: SupabaseClient, conversationId: string, agent: Agent) {
  const { error } = await supabase
    .from("conversations")
    .update({ deal_verified: true, deal_verified_at: new Date().toISOString(), deal_verified_by: agent.id })
    .eq("id", conversationId);
  if (error) throw error;
  await insertSystemEvent(supabase, conversationId, agent.id, `${agent.displayName} verificó el comprobante de pago`);
}

export async function returnSale(supabase: SupabaseClient, conversationId: string, agent: Agent) {
  const { error } = await supabase
    .from("conversations")
    .update({ deal_status: "returned" })
    .eq("id", conversationId);
  if (error) throw error;
  await insertSystemEvent(supabase, conversationId, agent.id, `${agent.displayName} registró una devolución sobre esta venta`);
}

/** "Elimina" la venta: la saca del feed de Ventas sin borrar la conversación ni su historial. */
export async function deleteSale(supabase: SupabaseClient, conversationId: string, agent: Agent) {
  const { error } = await supabase
    .from("conversations")
    .update({
      deal_status: "none",
      deal_closed_at: null,
      deal_payment_proof_url: null,
      deal_verified: false,
      deal_verified_at: null,
      deal_verified_by: null,
    })
    .eq("id", conversationId);
  if (error) throw error;
  await insertSystemEvent(supabase, conversationId, agent.id, `${agent.displayName} eliminó el registro de esta venta`);
}

export async function addTagToContact(supabase: SupabaseClient, contactId: string, tagId: string) {
  const { error } = await supabase.from("contact_tags").insert({ contact_id: contactId, tag_id: tagId });
  if (error) throw error;
}

export async function removeTagFromContact(supabase: SupabaseClient, contactId: string, tagId: string) {
  const { error } = await supabase
    .from("contact_tags")
    .delete()
    .eq("contact_id", contactId)
    .eq("tag_id", tagId);
  if (error) throw error;
}

export async function addNote(supabase: SupabaseClient, contactId: string, agent: Agent, content: string) {
  const { error } = await supabase.from("notes").insert({
    contact_id: contactId,
    agent_id: agent.id,
    content,
  });
  if (error) throw error;
}

export async function updateNote(supabase: SupabaseClient, noteId: string, content: string) {
  const { error } = await supabase.from("notes").update({ content }).eq("id", noteId);
  if (error) throw error;
}

export async function deleteNote(supabase: SupabaseClient, noteId: string) {
  const { error } = await supabase.from("notes").delete().eq("id", noteId);
  if (error) throw error;
}

export async function createTag(supabase: SupabaseClient, label: string, color: TagColor) {
  const { error } = await supabase.from("tags").insert({ label, color });
  if (error) throw error;
}

export async function updateTag(
  supabase: SupabaseClient,
  tagId: string,
  label: string,
  color: TagColor
) {
  const { error } = await supabase.from("tags").update({ label, color }).eq("id", tagId);
  if (error) throw error;
}

export async function deleteTag(supabase: SupabaseClient, tagId: string) {
  const { error } = await supabase.from("tags").delete().eq("id", tagId);
  if (error) throw error;
}

export async function setAiGloballyEnabled(supabase: SupabaseClient, agent: Agent, enabled: boolean) {
  const { error } = await supabase
    .from("agent_settings")
    .update({ ai_globally_enabled: enabled, updated_by: agent.id, updated_at: new Date().toISOString() })
    .eq("id", true);
  if (error) throw error;
}

/** `null` quita el tope. RLS deja escribir agent_settings solo a supervisor/admin. */
export async function setDailySpendCap(supabase: SupabaseClient, agent: Agent, capUsd: number | null) {
  const { error } = await supabase
    .from("agent_settings")
    .update({ daily_spend_cap_usd: capUsd, updated_by: agent.id, updated_at: new Date().toISOString() })
    .eq("id", true);
  if (error) throw error;
}

export async function createQuickReply(supabase: SupabaseClient, label: string, content: string) {
  const { error } = await supabase.from("quick_replies").insert({ label, content });
  if (error) throw error;
}

export async function updateQuickReply(
  supabase: SupabaseClient,
  id: string,
  label: string,
  content: string
) {
  const { error } = await supabase.from("quick_replies").update({ label, content }).eq("id", id);
  if (error) throw error;
}

export async function deleteQuickReply(supabase: SupabaseClient, id: string) {
  const { error } = await supabase.from("quick_replies").delete().eq("id", id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Escenarios de la IA (respuestas predeterminadas). RLS solo deja escribir a
// supervisores y admins: esto es lo que la IA le dice sola a los clientes.
// ---------------------------------------------------------------------------

/** Campos editables de un escenario. `id` e `isActive` se manejan aparte. */
export type PlaybookDraft = Omit<Playbook, "id" | "isActive">;

function playbookRow(draft: PlaybookDraft) {
  return {
    name: draft.name,
    trigger_description: draft.triggerDescription,
    response_text: draft.responseText,
    attachment_url: draft.attachmentUrl,
    attachment_type: draft.attachmentType,
    after_send: draft.afterSend,
  };
}

export async function createPlaybook(supabase: SupabaseClient, draft: PlaybookDraft) {
  const { error } = await supabase.from("ai_playbooks").insert(playbookRow(draft));
  if (error) throw error;
}

export async function updatePlaybook(supabase: SupabaseClient, id: string, draft: PlaybookDraft) {
  const { error } = await supabase.from("ai_playbooks").update(playbookRow(draft)).eq("id", id);
  if (error) throw error;
}

export async function deletePlaybook(supabase: SupabaseClient, id: string) {
  const { error } = await supabase.from("ai_playbooks").delete().eq("id", id);
  if (error) throw error;
}

/** Apagar un escenario lo saca del reconocimiento sin perder el texto. */
export async function setPlaybookActive(supabase: SupabaseClient, id: string, isActive: boolean) {
  const { error } = await supabase.from("ai_playbooks").update({ is_active: isActive }).eq("id", id);
  if (error) throw error;
}

/** is_active es el mismo campo que usa el escalamiento de la IA para elegir a quién asignar por turno. */
export async function setAgentActive(supabase: SupabaseClient, agentId: string, isActive: boolean) {
  const { error } = await supabase.from("agents").update({ is_active: isActive }).eq("id", agentId);
  if (error) throw error;
}

export async function createAgentSuggestion(supabase: SupabaseClient, agent: Agent, content: string) {
  const { error } = await supabase.from("agent_suggestions").insert({ agent_id: agent.id, content });
  if (error) throw error;
}

export async function markSuggestionReviewed(supabase: SupabaseClient, suggestionId: string, reviewer: Agent) {
  const { error } = await supabase
    .from("agent_suggestions")
    .update({ status: "reviewed", reviewed_at: new Date().toISOString(), reviewed_by: reviewer.id })
    .eq("id", suggestionId);
  if (error) throw error;
}

export async function updateModelPricing(
  supabase: SupabaseClient,
  model: string,
  inputPricePerMillion: number,
  outputPricePerMillion: number,
  agent: Agent
) {
  const { error } = await supabase.from("model_pricing").upsert({
    model,
    input_price_per_million: inputPricePerMillion,
    output_price_per_million: outputPricePerMillion,
    updated_at: new Date().toISOString(),
    updated_by: agent.id,
  });
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Clientes
// ---------------------------------------------------------------------------

/**
 * Datos de la persona, editables desde la ficha del cliente.
 *
 * Son las mismas columnas que llena el cierre de venta; la diferencia es que
 * acá se corrigen sin tener que cerrar una venta de nuevo. El comprobante de
 * pago NO está: ese pertenece a la venta, no al perfil.
 */
export interface ContactProfileEdit {
  displayName: string | null;
  cedulaType: CedulaType | null;
  cedulaNumber: string | null;
  state: string | null;
  city: string | null;
  address: string | null;
}

/** Deja el campo en null cuando queda vacío: "" y null significan lo mismo acá, y null es lo que ya guarda el resto del CRM. */
function orNull(value: string | null): string | null {
  const text = value?.trim() ?? "";
  return text ? text : null;
}

export async function updateContactProfile(
  supabase: SupabaseClient,
  contactId: string,
  edit: ContactProfileEdit
) {
  const { error } = await supabase
    .from("contacts")
    .update({
      display_name: orNull(edit.displayName),
      cedula_type: edit.cedulaType,
      cedula_number: orNull(edit.cedulaNumber),
      state: orNull(edit.state),
      city: orNull(edit.city),
      address: orNull(edit.address),
      updated_at: new Date().toISOString(),
    })
    .eq("id", contactId);

  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Inventario
//
// Escriben sobre la misma tabla que lee la herramienta de catálogo del
// agente: lo que se guarda acá es lo que la IA cotiza en el próximo turno.
// ---------------------------------------------------------------------------

export async function updateProductStock(supabase: SupabaseClient, productId: string, stockQuantity: number) {
  const { error } = await supabase
    .from("products")
    .update({ stock_quantity: stockQuantity, updated_at: new Date().toISOString() })
    .eq("id", productId);

  if (error) throw error;
}

export async function updateProductPrice(supabase: SupabaseClient, productId: string, price: number) {
  const { error } = await supabase
    .from("products")
    .update({ price, updated_at: new Date().toISOString() })
    .eq("id", productId);

  if (error) throw error;
}

/** Desactivar un repuesto lo saca del catálogo que ve la IA, sin borrar su historial de ventas. */
export async function setProductActive(supabase: SupabaseClient, productId: string, isActive: boolean) {
  const { error } = await supabase
    .from("products")
    .update({ is_active: isActive, updated_at: new Date().toISOString() })
    .eq("id", productId);

  if (error) throw error;
}
