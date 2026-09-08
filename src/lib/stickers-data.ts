import type { SupabaseClient } from "@supabase/supabase-js";
import type { Sticker } from "@/lib/types";
import { mediaUrlFor } from "@/lib/storage";

/**
 * Lectura de la biblioteca de stickers (T3a, "Seis frentes del buzón",
 * 9/9/2026). Sin `server-only`: corre desde el navegador, igual que el resto
 * de los `-data.ts` que alimentan paneles del cliente — la RLS de
 * `stickers` (`select` para cualquier agente autenticado) es la que decide
 * qué se ve, no este módulo.
 */

interface RawSticker {
  id: string;
  storage_path: string;
  name: string | null;
  animated: boolean;
  created_by: string | null;
  created_at: string;
}

function mapSticker(row: RawSticker): Sticker {
  return {
    id: row.id,
    url: mediaUrlFor(row.storage_path),
    name: row.name,
    animated: row.animated,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/** Los stickers de la biblioteca, más recientes primero. */
export async function fetchStickers(supabase: SupabaseClient): Promise<Sticker[]> {
  const { data, error } = await supabase
    .from("stickers")
    .select("id, storage_path, name, animated, created_by, created_at")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as RawSticker[]).map(mapSticker);
}
