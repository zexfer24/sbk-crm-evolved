import type { CatalogLink } from "@/lib/types";

// ---------------------------------------------------------------------------
// La fuente única de los enlaces de catálogo (T2, plan "Nada sin leer, un
// solo catálogo y la factura Saint", 18/9/2026, D3/D4).
//
// Historia: los catálogos de SBK Motors son archivos de Google Drive de un
// tercero, y hasta esta corrida sus URLs estaban pegadas A MANO dentro del
// texto de tres escenarios ("CATALOGO CASCOS", "Catálogo general" y
// "Ubicación") y de cuatro mensajes rápidos. Cada versión nueva en Drive
// cambia el ID del archivo: el catálogo de cascos tuvo CUATRO IDs distintos
// en 25 días y el 18/9/2026 circulaban DOS a la vez (la IA mandaba uno, un
// mensaje rápido seguía con el viejo) porque la URL vivía copiada en cuatro
// sitios independientes.
//
// Este módulo es la mitad PURA de la solución: valida lo que el supervisor
// carga en `public.catalog_links` y resuelve el marcador que un escenario o
// un mensaje rápido escribe en vez de la URL (`{{catalogo:<key>}}` para uno,
// `{{catalogos}}` para la lista completa de activos). Cambiar la fila acá
// cambia el enlace en los dos consumidores a la vez, sin volver a tocar
// texto. Sin React, sin Supabase: la lectura/escritura vive en `data.ts`/
// `mutations.ts`.
// ---------------------------------------------------------------------------

/** Campos que llegan del formulario del panel; `id`/`isActive`/`updatedBy`/las fechas los pone la base. */
export interface CatalogLinkDraft {
  key: string;
  label: string;
  url: string;
  /** Orden dentro de `{{catalogos}}` y del panel. Sin valor, la fila nace en 0 (el default de la columna). */
  sortOrder?: number;
}

export type CatalogLinkField = "key" | "label" | "url";

const KEY_PATTERN = /^[a-z0-9-]{1,30}$/;
const URL_SCHEME_PATTERN = /^https?:\/\//i;

/**
 * Valida un borrador campo por campo (D10: "un botón deshabilitado sin decir
 * por qué no sirve" — mismo criterio que `validateSaleDraft`, T5 de este
 * mismo plan). `existing` es la lista de OTROS catálogos ya guardados (al
 * editar uno, el llamador la pasa SIN la propia fila: comparar una fila
 * contra sí misma marcaría su propia clave como repetida).
 */
export function validateCatalogLinkDraft(
  draft: CatalogLinkDraft,
  existing: CatalogLink[]
): Partial<Record<CatalogLinkField, string>> {
  const errors: Partial<Record<CatalogLinkField, string>> = {};

  const key = draft.key.trim();
  if (!key) {
    errors.key = "La clave no puede estar vacía.";
  } else if (!KEY_PATTERN.test(key)) {
    errors.key = "La clave solo puede llevar minúsculas, números y guiones (1 a 30 caracteres).";
  } else if (existing.some((link) => link.key.toLowerCase() === key.toLowerCase())) {
    errors.key = "Ya existe un catálogo con esa clave.";
  }

  if (!draft.label.trim()) {
    errors.label = "La etiqueta no puede estar vacía.";
  }

  if (!URL_SCHEME_PATTERN.test(draft.url.trim())) {
    errors.url = "La URL debe empezar con http:// o https://.";
  }

  return errors;
}

/**
 * Propone la clave del marcador a partir de la etiqueta que escribe el
 * supervisor ("Exploradoras y Bombillos" → `exploradoras-y-bombillos"). El
 * supervisor puede corregirla antes de guardar; esto solo evita que tenga
 * que inventar el slug a mano cada vez.
 */
export function slugifyKey(label: string): string {
  const slug = label
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // quita los acentos (la tilde queda como marca combinante aparte tras NFD)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  // El tope de 30 caracteres es el mismo CHECK de la base (`key ~
  // '^[a-z0-9-]{1,30}$'`); se recorta acá para que la clave propuesta ya
  // entre sin que el supervisor tenga que acortarla él mismo, y se le saca
  // cualquier guion que haya quedado colgando justo en el corte.
  return slug.slice(0, 30).replace(/-+$/g, "");
}

/**
 * El marcador de UN catálogo. Los dos regex de más abajo son constantes de
 * MÓDULO con flag `g`: `String.prototype.replace` reinicia `lastIndex` al
 * arrancar cada llamada (por spec), así que usarlas con `.replace()` —como
 * hace `resolveCatalogMarkers`— es seguro. Lo que NO es seguro es llamar
 * `.test()`/`.exec()` sobre ellas directamente más de una vez seguida: esos
 * dos métodos SÍ arrastran `lastIndex` entre llamadas con flag `g`, y la
 * segunda invocación puede dar un falso negativo. Cualquier consumidor nuevo
 * (fase 0 del turno, T3) que necesite solo "¿tiene marcador?" debe resetear
 * `lastIndex = 0` antes de cada `.test()`, o clonar el regex.
 */
export const CATALOG_MARKER = /\{\{\s*cat[aá]logo\s*:\s*([a-z0-9-]+)\s*\}\}/gi;

/** El marcador de la lista completa de catálogos activos. */
export const CATALOG_LIST_MARKER = /\{\{\s*cat[aá]logos\s*\}\}/gi;

/** El marcador canónico que arma el botón "Insertar catálogo" del panel para una clave dada. */
export function catalogMarkerFor(key: string): string {
  return `{{catalogo:${key}}}`;
}

/**
 * La lista completa de catálogos ACTIVOS, ordenada, una línea por catálogo
 * ("• Cascos: https://…"). Es lo que hoy es el escenario "Catálogo general"
 * con siete URLs pegadas a mano; con el marcador `{{catalogos}}` pasa a
 * armarse solo, en el orden que decide `sort_order`.
 */
export function formatCatalogList(links: CatalogLink[]): string {
  return links
    .filter((link) => link.isActive)
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((link) => `• ${link.label}: ${link.url}`)
    .join("\n");
}

/** Lo que devuelve `resolveCatalogMarkers`: el texto con los marcadores resueltos y las claves que NO se pudieron resolver. */
export interface ResolvedCatalogText {
  text: string;
  /**
   * Claves de `{{catalogo:<key>}}` que no calzaron con ningún catálogo ACTIVO
   * (D6: inactivo o inexistente cuentan igual), más la clave sintética
   * `"catalogos"` cuando el texto lleva `{{catalogos}}` y no hay NINGÚN
   * catálogo activo (ver el comentario de más abajo).
   */
  missing: string[];
}

/** La clave sintética que `resolveCatalogMarkers` reporta en `missing` cuando `{{catalogos}}` no tiene ningún catálogo activo para listar. */
const EMPTY_CATALOG_LIST_KEY = "catalogos";

/**
 * Reemplaza los dos marcadores dentro de un texto por su contenido real.
 * Un `{{catalogo:<key>}}` que no calza con ningún catálogo activo se deja TAL
 * CUAL en el texto (D6: "un marcador que no resuelve nunca llega al
 * cliente" — quien llama a esto decide qué hacer con `missing`: fase 0 del
 * turno saca el escenario de los candidatos, el composer avisa con un
 * toast).
 *
 * `{{catalogos}}` con AL MENOS un catálogo activo se reemplaza por la lista;
 * sin ninguno, se trata igual que un marcador individual roto (T3, plan
 * "Nada sin leer, un solo catálogo y la factura Saint", 18/9/2026, ajuste
 * sobre D6 hallado al implementar T3): la primera versión de esta función lo
 * reemplazaba por una lista VACÍA, que le mandaría al cliente "Ver también:
 * " sin nada detrás — un mensaje roto que igual habría salido. Ahora ese caso
 * cuenta como `missing` (con la clave sintética `"catalogos"`) y el marcador
 * queda tal cual, para que fase 0 del turno saque el escenario de los
 * candidatos exactamente como con cualquier otro marcador sin resolver.
 */
export function resolveCatalogMarkers(text: string, links: CatalogLink[]): ResolvedCatalogText {
  const activeByKey = new Map(links.filter((link) => link.isActive).map((link) => [link.key.toLowerCase(), link]));
  const missingKeys = new Set<string>();

  const withSingleMarkersResolved = text.replace(CATALOG_MARKER, (match, rawKey: string) => {
    const found = activeByKey.get(rawKey.toLowerCase());
    if (!found) {
      missingKeys.add(rawKey);
      return match; // el marcador queda tal cual: D6, nunca llega crudo pero tampoco se inventa una URL
    }
    return found.url;
  });

  const withListResolved = withSingleMarkersResolved.replace(CATALOG_LIST_MARKER, (match) => {
    if (activeByKey.size === 0) {
      missingKeys.add(EMPTY_CATALOG_LIST_KEY);
      return match;
    }
    return formatCatalogList(links);
  });

  return { text: withListResolved, missing: [...missingKeys] };
}

// ---------------------------------------------------------------------------
// Aviso de "enlace escrito a mano" (D4). Mismo patrón que `hasHardcodedPrice`
// (`playbook-price.ts`): no corrige ni bloquea nada, solo marca en el panel
// para que el supervisor use el marcador en vez de pegar la URL — así el
// enlace no se queda huérfano de la fuente única la próxima vez que Drive
// rote el archivo.
// ---------------------------------------------------------------------------

const RAW_URL = /https?:\/\/\S+/i;

export function hasRawUrl(text: string): boolean {
  return RAW_URL.test(text);
}
