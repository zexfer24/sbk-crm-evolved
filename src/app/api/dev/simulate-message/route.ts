import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchCurrentAgent } from "@/lib/data";
import { runAgentTurn } from "@/lib/ai/agent";

// ---------------------------------------------------------------------------
// Ruta de prueba para el panel de control: simula un mensaje entrante de
// cliente SIN pasar por WhatsApp/Meta, y corre el turno del agente de IA de
// una vez (síncrono, para que el panel pueda mostrar el resultado o el error
// de inmediato). Siempre corre sobre un canal "de prueba" que nunca está
// conectado a Meta, así que nunca sale un mensaje real por WhatsApp.
// ---------------------------------------------------------------------------

const TEST_CHANNEL_ID = "99999999-0000-0000-0000-000000000001";
const TEST_CONTACT_ID = "99999999-0000-0000-0000-000000000002";

interface SimulateBody {
  conversationId?: string;
  text: string;
}

async function ensureTestConversation(supabase: ReturnType<typeof createAdminClient>): Promise<string> {
  await supabase.from("whatsapp_channels").upsert({
    id: TEST_CHANNEL_ID,
    label: "Simulador (panel de control)",
    phone_number: "+00 000 0000000",
    phone_number_id: null,
    status: "pending",
  });

  await supabase.from("contacts").upsert({
    id: TEST_CONTACT_ID,
    phone_number: "+00 000 0000001",
    display_name: "Cliente de prueba",
    profile_name: "Cliente de prueba",
  });

  const { data: existing } = await supabase
    .from("conversations")
    .select("id")
    .eq("contact_id", TEST_CONTACT_ID)
    .eq("whatsapp_channel_id", TEST_CHANNEL_ID)
    .maybeSingle();

  if (existing) return existing.id;

  const { data: created, error } = await supabase
    .from("conversations")
    .insert({ contact_id: TEST_CONTACT_ID, whatsapp_channel_id: TEST_CHANNEL_ID })
    .select("id")
    .single();

  if (error || !created) throw new Error(error?.message ?? "No se pudo crear la conversación de prueba.");
  return created.id;
}

export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "No disponible en producción." }, { status: 404 });
  }

  const body = (await request.json()) as SimulateBody;
  if (!body.text?.trim()) {
    return NextResponse.json({ error: "Falta el texto del mensaje." }, { status: 400 });
  }

  const authedClient = await createClient();
  const agent = await fetchCurrentAgent(authedClient);
  if (!agent) {
    return NextResponse.json({ error: "No autenticado." }, { status: 401 });
  }

  const supabase = createAdminClient();
  const conversationId = body.conversationId ?? (await ensureTestConversation(supabase));

  const { error: insertError } = await supabase.from("messages").insert({
    conversation_id: conversationId,
    direction: "inbound",
    sender_type: "customer",
    message_type: "text",
    content: body.text.trim(),
  });
  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  try {
    await runAgentTurn(conversationId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "El turno del agente falló.";
    return NextResponse.json({ conversationId, error: message }, { status: 502 });
  }

  return NextResponse.json({ conversationId, ok: true });
}
