// ---------------------------------------------------------------------------
// Cuán viejo es el inventario.
//
// El catálogo se cargó el 24 de agosto de 2026 y no se volvió a tocar: 5.438
// productos con el mismo `updated_at`. La sincronización vive en una aplicación
// aparte del dueño y todavía no corre. Nadie lo sabía — ni el panel lo mostraba
// ni la IA lo tenía en cuenta al cotizar.
//
// Es el mismo problema que la tasa del BCV, y se resuelve igual: el dato no se
// esconde ni se descarta, se acompaña de su antigüedad y quien lo usa decide
// qué hacer con ella (ver `isStale` en bcv.ts). Un precio de hace tres horas y
// uno de hace tres semanas no se afirman igual, y lo que más importa no es el
// precio sino la existencia: un stock de hace cuatro días puede hacer que la IA
// le prometa a un cliente algo que ya se vendió.
//
// Esto NO sincroniza nada y no intenta hacerlo. Solo hace visible el atraso.
// ---------------------------------------------------------------------------

/**
 * A partir de cuántos días de antigüedad el inventario deja de afirmarse como
 * un hecho.
 *
 * Dos, por el mismo criterio que el BCV: un día de atraso es la vida normal de
 * un dato que se sincroniza a diario; dos ya significa que la sincronización no
 * está corriendo.
 */
export const INVENTORY_STALE_DAYS = 2;

export interface InventoryFreshness {
  /** El `updated_at` más reciente que se está considerando, o null si no hay ninguno. */
  updatedAt: string | null;
  /** Días completos transcurridos. Null cuando no hay fecha: no se sabe, que no es cero. */
  ageDays: number | null;
  isStale: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Antigüedad de un `updated_at`, en días completos.
 *
 * Días transcurridos y no cambios de fecha en el calendario: lo que importa es
 * hace cuánto se tocó el dato, y "ayer a las 11 de la noche" no es un día de
 * atraso. Así tampoco depende de en qué zona horaria se mire.
 */
export function inventoryFreshness(updatedAt: string | null, now: Date = new Date()): InventoryFreshness {
  if (!updatedAt) return { updatedAt: null, ageDays: null, isStale: false };

  const elapsed = now.getTime() - new Date(updatedAt).getTime();
  // Un reloj corrido —el de la base o el del contenedor— no puede dar una
  // antigüedad negativa: en el peor caso, el dato es de ahora mismo.
  const ageDays = Math.max(0, Math.floor(elapsed / DAY_MS));

  return { updatedAt, ageDays, isStale: ageDays >= INVENTORY_STALE_DAYS };
}

/** La antigüedad en dos palabras, para el número grande del panel. */
export function freshnessValue({ ageDays }: InventoryFreshness): string {
  if (ageDays === null) return "—";
  if (ageDays === 0) return "Hoy";
  return ageDays === 1 ? "1 día" : `${ageDays} días`;
}

/**
 * Qué dice la tarjeta debajo del número.
 *
 * Siempre nombra a la IA: el punto de la sección Inventario es que lo que se ve
 * ahí es exactamente lo que la IA lee al cotizar, así que la antigüedad del
 * dato es antigüedad de lo que el cliente va a recibir.
 */
export function freshnessNote(freshness: InventoryFreshness): string {
  const { ageDays, isStale } = freshness;

  if (ageDays === null) {
    return "No se sabe de cuándo son estos datos: no hay ningún repuesto con fecha de actualización.";
  }

  if (isStale) {
    return `Sin cambios desde hace ${ageDays} días. La IA cotiza con esto: precios y unidades pueden no estar al día.`;
  }

  return ageDays === 0
    ? "Al día. Es exactamente lo que la IA cotiza ahora mismo."
    : "De ayer. Es lo que la IA cotiza ahora mismo.";
}

/**
 * Lo que se le agrega al resultado de la herramienta de catálogo cuando el dato
 * ya no se puede afirmar como un hecho. Null cuando está fresco: un matiz de
 * más hace que la IA dude de un precio que está bien.
 */
export function inventoryAgeInstruction({ ageDays, isStale }: InventoryFreshness): string | null {
  if (!isStale || ageDays === null) return null;

  return (
    `El inventario no se actualiza desde hace ${ageDays} días: estos precios y estas unidades pueden haber cambiado. ` +
    `Dalos como lo último que tienes registrado, no como una confirmación. No afirmes que el repuesto está disponible ` +
    `ni que el precio es el de hoy, y ofrécele al cliente que un asesor se lo confirme antes de que venga a la tienda.`
  );
}
