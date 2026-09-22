import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { fetchConReintentos } from "@/lib/supabase/fetch-reintentos";

/**
 * Cliente con service_role: bypassa RLS. Solo para rutas server-side sin
 * sesión de usuario (ej. el webhook de Meta). Nunca exponer al cliente.
 *
 * `global.fetch` va envuelto con `fetchConReintentos` (T1, plan "Nada se
 * pierde en un corte ni en un deploy", 21-22/9/2026): un corte de red corto
 * o un Postgres reiniciando se perdía para siempre porque este cliente no
 * reintentaba nada. Cubre PostgREST, las RPC y Storage de un saque —
 * `storage-js` usa este mismo `fetch` — sin tocar ningún llamador de
 * `createAdminClient()`.
 */
export function createAdminClient() {
  return createSupabaseClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: fetchConReintentos(fetch) },
    }
  );
}
