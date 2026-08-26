import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Agent,
  CedulaType,
  MessageType,
  PaymentMethod,
  Playbook,
  SaleItemOrigin,
  TagColor,
  WhatsappTemplate,
} from "@/lib/types";
import { PAYMENT_METHOD_LABELS } from "@/lib/types";

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

async function postSendMessage(payload: SendMessagePayload): Promise<string | null> {
  const res = await fetch("/api/messages/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.error ?? "No se pudo enviar el mensaje.");
  }
  // El id de la fila insertada: la cola de envío lo usa para saber cuándo el
  // mensaje real ya está en el hilo y retirar su burbuja provisional.
  return typeof body?.id === "string" ? body.id : null;
}

export async function sendMessage(
  conversationId: string,
  content: string,
  isInternalNote: boolean,
  replyToMessageId?: string | null
): Promise<string | null> {
  return postSendMessage({ conversationId, kind: "text", content, isInternalNote, replyToMessageId });
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

/**
 * Dar el chat por leído limpia las dos señales de "sin leer": los mensajes
 * que el cliente mandó y el apartado que puso el asesor a mano. Si solo se
 * bajara el contador, un chat apartado seguiría en "Sin leer" para siempre
 * por más veces que se abriera.
 */
export async function markConversationRead(supabase: SupabaseClient, conversationId: string) {
  const { error } = await supabase
    .from("conversations")
    .update({ unread_count: 0, manually_unread: false })
    .eq("id", conversationId);
  if (error) throw error;
}

/**
 * Aparta el chat para volver después. No toca `unread_count` a propósito:
 * ese número cuenta mensajes que el cliente mandó y nadie leyó, y subirlo a
 * 1 pondría en la bandeja un mensaje que no existe.
 */
export async function markConversationUnread(supabase: SupabaseClient, conversationId: string) {
  const { error } = await supabase
    .from("conversations")
    .update({ manually_unread: true })
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
  /** Con qué pagó. Obligatorio al cerrar; después no se edita. */
  paymentMethod: PaymentMethod;
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
      deal_payment_method: details.paymentMethod,
      // Quién cerró, no quién tiene asignada la conversación: el hilo puede
      // reasignarse después, o puede cerrarlo el supervisor sobre uno ajeno.
      deal_closed_by: agent.id,
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
    `Venta cerrada por ${agent.displayName} — $${totalAmount.toFixed(2)} · ${PAYMENT_METHOD_LABELS[details.paymentMethod]}${detalleAgregados}`
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
      deal_payment_method: null,
      deal_closed_by: null,
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

/**
 * Campos editables de un escenario. `id` e `isActive` se manejan aparte.
 *
 * Las etiquetas entran como ids y no como `Tag[]`: la relación guarda ids, y
 * pedirle al formulario que arrastre el nombre y el color de vuelta solo
 * abriría la puerta a guardar un nombre que ya no es el de esa etiqueta.
 */
export type PlaybookDraft = Omit<Playbook, "id" | "isActive" | "tags"> & { tagIds: string[] };

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

/**
 * Deja la relación de etiquetas igual a la del borrador, quitando lo que
 * sobra y agregando lo que falta.
 *
 * El atajo obvio —borrar todas e insertarlas de nuevo— deja una ventana en la
 * que el escenario no tiene ninguna, y si el insert falla ahí se queda: un
 * escenario que responde sin etiquetar y nadie se entera hasta leer un caso
 * mal clasificado. Calcular la diferencia no toca las filas que se quedan.
 */
async function syncPlaybookTags(supabase: SupabaseClient, playbookId: string, tagIds: string[]) {
  const { data, error: readError } = await supabase
    .from("ai_playbook_tags")
    .select("tag_id")
    .eq("playbook_id", playbookId);
  if (readError) throw readError;

  const actuales = new Set((data ?? []).map((row) => row.tag_id as string));
  const pedidas = new Set(tagIds);

  const sobran = [...actuales].filter((tagId) => !pedidas.has(tagId));
  if (sobran.length > 0) {
    const { error } = await supabase
      .from("ai_playbook_tags")
      .delete()
      .eq("playbook_id", playbookId)
      .in("tag_id", sobran);
    if (error) throw error;
  }

  const faltan = tagIds.filter((tagId) => !actuales.has(tagId));
  if (faltan.length > 0) {
    const { error } = await supabase
      .from("ai_playbook_tags")
      .insert(faltan.map((tagId) => ({ playbook_id: playbookId, tag_id: tagId })));
    if (error) throw error;
  }
}

export async function createPlaybook(supabase: SupabaseClient, draft: PlaybookDraft) {
  const { data, error } = await supabase
    .from("ai_playbooks")
    .insert(playbookRow(draft))
    .select("id")
    .single();
  if (error) throw error;
  await syncPlaybookTags(supabase, data.id as string, draft.tagIds);
}

export async function updatePlaybook(supabase: SupabaseClient, id: string, draft: PlaybookDraft) {
  const { error } = await supabase.from("ai_playbooks").update(playbookRow(draft)).eq("id", id);
  if (error) throw error;
  await syncPlaybookTags(supabase, id, draft.tagIds);
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

// ---------------------------------------------------------------------------
// Interruptores de herramientas del agente. RLS solo deja escribir a
// supervisores y admins; las filas las siembran las migraciones, no la app.
// ---------------------------------------------------------------------------

export async function setAgentToolEnabled(supabase: SupabaseClient, agent: Agent, key: string, enabled: boolean) {
  const { error } = await supabase
    .from("agent_tools")
    .update({ is_enabled: enabled, updated_by: agent.id })
    .eq("key", key);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Biblioteca de conocimiento de la IA. RLS solo deja escribir a supervisores
// y admins: es la información con la que la IA redacta frente a clientes.
// ---------------------------------------------------------------------------

export async function createKnowledgeCategory(supabase: SupabaseClient, name: string, description: string | null) {
  const { error } = await supabase.from("knowledge_categories").insert({ name, description });
  if (error) throw error;
}

/** Borra también sus entradas (on delete cascade): quien la borra ve la advertencia en el panel. */
export async function deleteKnowledgeCategory(supabase: SupabaseClient, id: string) {
  const { error } = await supabase.from("knowledge_categories").delete().eq("id", id);
  if (error) throw error;
}

/** Campos editables de una entrada. `id` e `isActive` se manejan aparte. */
export interface KnowledgeEntryDraft {
  categoryId: string;
  title: string;
  content: string;
  sourceFilename: string | null;
}

function knowledgeEntryRow(draft: KnowledgeEntryDraft, agent: Agent) {
  return {
    category_id: draft.categoryId,
    title: draft.title,
    content: draft.content,
    source_filename: draft.sourceFilename,
    updated_by: agent.id,
  };
}

export async function createKnowledgeEntry(supabase: SupabaseClient, agent: Agent, draft: KnowledgeEntryDraft) {
  const { error } = await supabase.from("knowledge_entries").insert(knowledgeEntryRow(draft, agent));
  if (error) throw error;
}

export async function updateKnowledgeEntry(
  supabase: SupabaseClient,
  agent: Agent,
  id: string,
  draft: KnowledgeEntryDraft
) {
  const { error } = await supabase.from("knowledge_entries").update(knowledgeEntryRow(draft, agent)).eq("id", id);
  if (error) throw error;
}

/** Apagar una entrada la esconde de la IA sin perder el texto. */
export async function setKnowledgeEntryActive(supabase: SupabaseClient, id: string, isActive: boolean) {
  const { error } = await supabase.from("knowledge_entries").update({ is_active: isActive }).eq("id", id);
  if (error) throw error;
}

export async function deleteKnowledgeEntry(supabase: SupabaseClient, id: string) {
  const { error } = await supabase.from("knowledge_entries").delete().eq("id", id);
  if (error) throw error;
}

/**
 * is_active hace dos cosas con el mismo interruptor: saca al agente del
 * reparto por turno de la IA y le corta la entrada al CRM (el login, las
 * páginas y el envío de mensajes lo comprueban). Apagar a alguien acá es
 * dejarlo fuera de la operación completa, no solo del reparto.
 */
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
