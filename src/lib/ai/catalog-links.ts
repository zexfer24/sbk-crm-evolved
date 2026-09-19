import type { SupabaseClient } from "@supabase/supabase-js";
import { errorText, log } from "@/lib/log";
import type { CatalogLink } from "@/lib/types";

// ---------------------------------------------------------------------------
// Envoltorio de SERVIDOR para leer los catálogos ACTIVOS dentro de un turno
// de la IA (corrección de la revisión `code-review high` del 19/9/2026,
// punto 6, sobre T3 del plan "Nada sin leer, un solo catálogo y la factura
// Saint", 18/9/2026).
//
// Historia: `agent.ts` importaba `fetchActiveCatalogLinks` de `@/lib/data`
// — ese helper también lo usa el navegador (`crm-shell.tsx`,
// `app/inbox/page.tsx` lo siembran para los mensajes rápidos, T4b), así que
// no puede importar `lib/log.ts` (server-only: arrastraría ese mundo entero
// al bundle del cliente) y avisa sus errores con `console.error`. Dentro del
// turno eso significaba que una lectura fallida de `catalog_links` (red,
// RLS, migración no aplicada) se perdía en la consola del servidor sin
// quedar en la bitácora estructurada — el único rastro visible era
// `escenarios_enlace_sin_resolver` en `matchPlaybook`, que describe la
// consecuencia (fase 0 descarta escenarios con marcador) como si fuera un
// problema de CONFIGURACIÓN del escenario, cuando en realidad la lectura de
// enlaces nunca llegó a completarse.
//
// Este módulo hace la misma consulta, con el mismo criterio de "nunca
// lanza" —un catálogo es un dato de conveniencia, no algo que deba tumbar el
// turno—, pero sobre `lib/log.ts` (`agent.ts` ya lo usa para todo lo demás,
// es indudablemente server-only) y con su propio evento:
// `turno_enlaces_no_legibles`. Mismo patrón EXACTO que `fetchTurnLessons`
// (`lessons.ts`, T5 de "Seba atiende el mostrador"): consulta propia,
// `try/catch` alrededor de la consulta completa (una excepción de red antes
// de que Supabase llegue a resolver `{data, error}` no está cubierta por
// mirar solo `error`), y `log.warn` con `errorText` en cualquiera de los dos
// casos. `fetchActiveCatalogLinks` de `data.ts` NO se toca ni se borra: la
// siguen usando `crm-shell.tsx` y `app/inbox/page.tsx` para sembrar los
// mensajes rápidos del lado del navegador.
// ---------------------------------------------------------------------------

interface RawCatalogLink {
  id: string;
  key: string;
  label: string;
  url: string;
  sort_order: number;
  is_active: boolean;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

function mapCatalogLink(row: RawCatalogLink): CatalogLink {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    url: row.url,
    sortOrder: row.sort_order,
    isActive: row.is_active,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const CATALOG_LINK_COLUMNS = "id, key, label, url, sort_order, is_active, updated_by, created_at, updated_at";

/**
 * Los catálogos ACTIVOS, en orden — lo que necesitan `matchPlaybook` (fase 0,
 * para saber qué escenarios tienen el marcador `{{catalogo:<key>}}`/
 * `{{catalogos}}` resuelto) y `runPlaybook`/`sendPlaybookReply` (para mandar
 * el escenario ya resuelto) dentro de `runAgentTurn`.
 *
 * Nunca lanza: ante cualquier error (de red, de permisos, una tabla que
 * todavía no existe en un entorno viejo) devuelve `[]` y deja
 * `turno_enlaces_no_legibles` en el log — el turno sigue por el flujo
 * genérico sin catálogos, no se cae por esto.
 */
export async function fetchTurnCatalogLinks(
  supabase: SupabaseClient,
  conversationId: string
): Promise<CatalogLink[]> {
  try {
    const { data, error } = await supabase
      .from("catalog_links")
      .select(CATALOG_LINK_COLUMNS)
      .eq("is_active", true)
      .order("sort_order");

    if (error) {
      log.warn("turno_enlaces_no_legibles", { conversationId, detail: errorText(error) });
      return [];
    }

    return (data as RawCatalogLink[]).map(mapCatalogLink);
  } catch (err) {
    log.warn("turno_enlaces_no_legibles", { conversationId, detail: errorText(err) });
    return [];
  }
}
