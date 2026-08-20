import type { SupabaseClient } from "@supabase/supabase-js";
import type { Agent, CedulaType, MessageType, TagColor, WhatsappTemplate } from "@/lib/types";

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

export async function closeSaleWithContactInfo(
  supabase: SupabaseClient,
  conversationId: string,
  contactId: string,
  agent: Agent,
  details: ContactSaleDetails
) {
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
    })
    .eq("id", conversationId);
  if (conversationError) throw conversationError;

  await insertSystemEvent(supabase, conversationId, agent.id, `Venta cerrada por ${agent.displayName}`);
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
