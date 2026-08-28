import { describe, expect, it } from "vitest";
import type { Agent, Conversation, Tag } from "@/lib/types";
import {
  applyInboxFilters,
  DEFAULT_INBOX_FILTER,
  filtersForRole,
  INBOX_FILTER_LABELS,
} from "@/lib/inbox-filters";

const TAG_MOROSO: Tag = { id: "tag-moroso", label: "Moroso", color: "danger" };
const TAG_VIP: Tag = { id: "tag-vip", label: "VIP", color: "accent" };

function agent(id: string, role: Agent["role"] = "agent"): Agent {
  return { id, displayName: id, fullName: null, avatarUrl: null, role, isActive: true };
}

const ANA = agent("ana");
const BETO = agent("beto");

/** Conversación mínima: solo los campos que miran los filtros. */
function conversation(over: {
  id: string;
  unreadCount?: number;
  manuallyUnread?: boolean;
  assignedAgent?: Agent | null;
  lastMessageAt?: string | null;
  lastCustomerMessageAt?: string | null;
  hasReply?: boolean;
  status?: Conversation["status"];
  tags?: Tag[];
}): Conversation {
  return {
    id: over.id,
    hasReply: over.hasReply ?? false,
    unreadCount: over.unreadCount ?? 0,
    manuallyUnread: over.manuallyUnread ?? false,
    assignedAgent: over.assignedAgent ?? null,
    status: over.status ?? "open",
    // Ojo: `?? default` convertiría un null explícito en fecha. Acá null
    // significa "esta conversación nunca tuvo un mensaje".
    lastMessageAt: "lastMessageAt" in over ? over.lastMessageAt : "2026-08-22T10:00:00Z",
    lastCustomerMessageAt:
      "lastCustomerMessageAt" in over ? over.lastCustomerMessageAt : null,
    contact: {
      id: `c-${over.id}`,
      phoneNumber: "+58000",
      displayName: over.id,
      profileName: null,
      avatarUrl: null,
      cedulaType: null,
      cedulaNumber: null,
      state: null,
      city: null,
      address: null,
      tags: over.tags ?? [],
    },
  } as unknown as Conversation;
}

describe("filtersForRole", () => {
  it("le da al administrador las tres píldoras", () => {
    expect(filtersForRole("admin")).toEqual(["pending", "mine", "all"]);
  });

  it("trata al supervisor como administrador", () => {
    expect(filtersForRole("supervisor")).toEqual(filtersForRole("admin"));
  });

  it("al asesor le ofrece las mismas tres píldoras", () => {
    expect(filtersForRole("agent")).toEqual(["pending", "mine", "all"]);
  });

  it("cada filtro tiene etiqueta", () => {
    for (const role of ["admin", "supervisor", "agent"] as const) {
      for (const filter of filtersForRole(role)) {
        expect(INBOX_FILTER_LABELS[filter]).toBeTruthy();
      }
    }
  });

  // Guardia anti-crecimiento: la reforma del 28/8/2026 bajó de cinco píldoras
  // a tres a propósito —los cortes por leído/asignado eran guardas poco
  // fiables (ver inbox-filters.ts, case "pending"). Este test no valida
  // comportamiento nuevo, valida que nadie vuelva a sumar píldoras sin pensarlo:
  // si un rol necesita un corte propio, que sea una decisión de producto
  // explícita, no un agregado silencioso a `filtersForRole`.
  it("ningún rol vuelve a tener más de tres píldoras", () => {
    for (const role of ["admin", "supervisor", "agent"] as const) {
      expect(filtersForRole(role).length).toBeLessThanOrEqual(3);
    }
  });
});

describe("DEFAULT_INBOX_FILTER", () => {
  it("al entrar a la bandeja se ve lo que falta por atender", () => {
    expect(DEFAULT_INBOX_FILTER).toBe("pending");
  });
});

describe("applyInboxFilters — filtro por bandeja", () => {
  const sinAsignar = conversation({ id: "sin-asignar", unreadCount: 3 });
  const deAnaLeida = conversation({ id: "de-ana-leida", assignedAgent: ANA });
  const deAnaNoLeida = conversation({ id: "de-ana-no-leida", assignedAgent: ANA, unreadCount: 2 });
  const deBeto = conversation({ id: "de-beto", assignedAgent: BETO, unreadCount: 1 });
  const todas = [sinAsignar, deAnaLeida, deAnaNoLeida, deBeto];

  function ids(filter: Parameters<typeof applyInboxFilters>[1]["filter"], viewer = ANA) {
    return applyInboxFilters(todas, {
      filter,
      search: "",
      tagId: null,
      sort: "recent",
      viewer,
    }).map((c) => c.id);
  }

  it("'all' no descarta nada", () => {
    expect(ids("all")).toHaveLength(4);
  });

  it("'mine' deja las del asesor que mira, leídas y no leídas", () => {
    expect(ids("mine")).toEqual(["de-ana-leida", "de-ana-no-leida"]);
  });

  it("'mine' cambia según quién mira", () => {
    expect(ids("mine", BETO)).toEqual(["de-beto"]);
  });
});

// Los casos de `manuallyUnread` que dependían de los filtros `unread` y
// `mine-unread` (retirados en la reforma del 28/8/2026) se fueron de acá: su
// conducta —que marcar un chat como no leído a mano lo saque en las
// secciones correspondientes— vive ahora en inbox-sections.test.ts.

/**
 * El corte que busca trabajo que falta por atender. Antes se llamaba
 * "unanswered" y solo dejaba pasar lo que además no tenía asesor asignado;
 * la reforma del 28/8/2026 lo renombró a "pending" y le quitó esa condición
 * de asignación (ver el comentario del case en inbox-filters.ts).
 */
describe("applyInboxFilters — 'pending'", () => {
  const CLIENTE_HABLÓ = "2026-08-22T10:00:00Z";
  const NOSOTROS_DESPUÉS = "2026-08-22T11:00:00Z";

  function ids(todas: Conversation[]) {
    return applyInboxFilters(todas, {
      filter: "pending",
      search: "",
      tagId: null,
      sort: "recent",
      viewer: ANA,
    }).map((c) => c.id);
  }

  it("deja la libre cuyo último mensaje sigue siendo del cliente", () => {
    const libre = conversation({
      id: "libre",
      lastCustomerMessageAt: CLIENTE_HABLÓ,
      lastMessageAt: CLIENTE_HABLÓ,
    });

    expect(ids([libre])).toEqual(["libre"]);
  });

  // Invertido en la reforma del 28/8/2026: antes esta conversación se
  // descartaba por tener asesor asignado. Pero `assignedAgent` no es una
  // guarda confiable —los asesores de SBK contestan sin asignarse el chat
  // (ver human-handled.ts:17-21)— y con esa condición puesta, el caso más
  // grave de todos —un chat escalado o asignado al que nadie le respondió—
  // quedaba invisible. Ahora debe verse igual que la libre.
  it("muestra la que ya tiene asesor, aunque nadie le haya contestado", () => {
    const tomada = conversation({
      id: "tomada",
      assignedAgent: BETO,
      lastCustomerMessageAt: CLIENTE_HABLÓ,
      lastMessageAt: CLIENTE_HABLÓ,
    });

    expect(ids([tomada])).toEqual(["tomada"]);
  });

  it("descarta la libre que ya fue contestada: el último mensaje es nuestro", () => {
    const contestada = conversation({
      id: "contestada",
      lastCustomerMessageAt: CLIENTE_HABLÓ,
      lastMessageAt: NOSOTROS_DESPUÉS,
    });

    expect(ids([contestada])).toEqual([]);
  });

  /**
   * `hasReply` es un flag vitalicio: lo enciende cualquier salida que no sea
   * del sistema —la IA, el asesor, hasta la plantilla de bienvenida
   * automática que sale con la IA apagada— y nunca se apaga. Hubo un intento
   * (80b66b5) de sumarlo a esta condición para no mostrar al fondo de la
   * lista chats que un asesor ya había respondido a mano. La intención era
   * buena, pero como el backfill dejó ese flag encendido en casi todo el
   * histórico, "Sin contestar" quedó vacío en producción el 28/8/2026: un
   * chat que la IA respondió hace días y al que el cliente volvió a
   * escribir —trabajo pendiente de verdad— quedaba oculto para siempre. Lo
   * que importa es si el último mensaje del hilo es del cliente, no si
   * alguna vez se le contestó.
   */
  it("muestra el hilo donde el cliente volvió a escribir aunque alguna vez se le haya respondido", () => {
    const atendida = conversation({
      id: "atendida",
      hasReply: true,
      lastCustomerMessageAt: CLIENTE_HABLÓ,
      lastMessageAt: CLIENTE_HABLÓ,
    });

    expect(ids([atendida])).toEqual(["atendida"]);
  });

  /**
   * El escenario exacto que vació la píldora en producción el 28/8/2026: la
   * IA le contestó al cliente hace varios días, el cliente volvió a escribir
   * después, y ese mensaje —el último del hilo— nunca recibió respuesta.
   * `hasReply` está encendido desde la respuesta vieja de la IA y así se
   * queda para siempre; lo que decide si hay trabajo pendiente es que
   * `lastMessageAt` sea otra vez del cliente.
   */
  it("muestra el chat donde la IA contestó hace días y el cliente volvió a escribir sin que nadie le respondiera", () => {
    // No hay campo para "cuándo fue la última respuesta": `hasReply` es un
    // booleano vitalicio, sin fecha. Lo único que distingue este chat de uno
    // recién llegado es que `hasReply` ya está en true — la IA respondió en
    // algún momento del pasado — y que, aun así, el último mensaje del hilo
    // (`lastMessageAt` == `lastCustomerMessageAt`) es del cliente, escrito
    // después de esa respuesta.
    const CLIENTE_VOLVIÓ_A_ESCRIBIR = "2026-08-27T15:30:00Z";

    const pendienteDeVerdad = conversation({
      id: "pendiente-de-verdad",
      hasReply: true,
      lastCustomerMessageAt: CLIENTE_VOLVIÓ_A_ESCRIBIR,
      lastMessageAt: CLIENTE_VOLVIÓ_A_ESCRIBIR,
    });

    expect(ids([pendienteDeVerdad])).toEqual(["pendiente-de-verdad"]);
  });

  /**
   * El caso completo que motivó retirar `assignedAgent === null` del filtro:
   * un chat que además está escalado o asignado a un asesor. Con la
   * condición de asignación puesta, este era el pendiente que se perdía —el
   * más grave, porque alguien ya lo tomó y aun así nadie contestó lo último
   * que escribió el cliente.
   */
  it("muestra el chat asignado donde la IA contestó hace días y el cliente volvió a escribir sin que nadie le respondiera", () => {
    const CLIENTE_VOLVIÓ_A_ESCRIBIR = "2026-08-27T15:30:00Z";

    const escaladoSinRespuesta = conversation({
      id: "escalado-sin-respuesta",
      assignedAgent: BETO,
      hasReply: true,
      lastCustomerMessageAt: CLIENTE_VOLVIÓ_A_ESCRIBIR,
      lastMessageAt: CLIENTE_VOLVIÓ_A_ESCRIBIR,
    });

    expect(ids([escaladoSinRespuesta])).toEqual(["escalado-sin-respuesta"]);
  });

  it("descarta la cerrada: un hilo cerrado no es trabajo pendiente", () => {
    const cerrada = conversation({
      id: "cerrada",
      status: "closed",
      lastCustomerMessageAt: CLIENTE_HABLÓ,
      lastMessageAt: CLIENTE_HABLÓ,
    });

    expect(ids([cerrada])).toEqual([]);
  });

  it("descarta la que nunca recibió un mensaje del cliente: no hay nada que contestar", () => {
    const muda = conversation({ id: "muda", lastCustomerMessageAt: null });

    expect(ids([muda])).toEqual([]);
  });

  /**
   * El hilo abierto por una plantilla saliente que el cliente todavía no
   * contestó tampoco entra: `lastMessageAt` null con un mensaje del cliente
   * registrado es la conversación recién creada por el webhook, y ahí sí
   * estamos en deuda.
   */
  it("cuenta como sin contestar el hilo entrante que aún no tiene último mensaje", () => {
    const reciénLlegada = conversation({
      id: "recien",
      lastCustomerMessageAt: CLIENTE_HABLÓ,
      lastMessageAt: null,
    });

    expect(ids([reciénLlegada])).toEqual(["recien"]);
  });

  it("no le importa si está leída o no: leerla no es contestarla", () => {
    const leída = conversation({
      id: "leida",
      unreadCount: 0,
      lastCustomerMessageAt: CLIENTE_HABLÓ,
      lastMessageAt: CLIENTE_HABLÓ,
    });

    expect(ids([leída])).toEqual(["leida"]);
  });
});

describe("applyInboxFilters — etiquetas", () => {
  const conMoroso = conversation({ id: "moroso", tags: [TAG_MOROSO] });
  const conVip = conversation({ id: "vip", tags: [TAG_VIP] });
  const conAmbas = conversation({ id: "ambas", tags: [TAG_MOROSO, TAG_VIP] });
  const sinEtiquetas = conversation({ id: "pelada" });
  const todas = [conMoroso, conVip, conAmbas, sinEtiquetas];

  function ids(tagId: string | null) {
    return applyInboxFilters(todas, {
      filter: "all",
      search: "",
      tagId,
      sort: "recent",
      viewer: ANA,
    }).map((c) => c.id);
  }

  it("sin etiqueta elegida no filtra", () => {
    expect(ids(null)).toHaveLength(4);
  });

  it("deja las conversaciones que llevan esa etiqueta", () => {
    expect(ids(TAG_MOROSO.id)).toEqual(["moroso", "ambas"]);
  });

  it("una etiqueta que nadie tiene no deja nada", () => {
    expect(ids("tag-fantasma")).toEqual([]);
  });
});

describe("applyInboxFilters — orden", () => {
  const vieja = conversation({ id: "vieja", lastMessageAt: "2026-08-01T10:00:00Z" });
  const nueva = conversation({ id: "nueva", lastMessageAt: "2026-08-22T10:00:00Z" });
  const media = conversation({ id: "media", lastMessageAt: "2026-08-10T10:00:00Z" });
  const nunca = conversation({ id: "nunca", lastMessageAt: null });
  const todas = [vieja, nueva, nunca, media];

  function ids(sort: "recent" | "oldest") {
    return applyInboxFilters(todas, {
      filter: "all",
      search: "",
      tagId: null,
      sort,
      viewer: ANA,
    }).map((c) => c.id);
  }

  it("'recent' pone la más nueva arriba", () => {
    expect(ids("recent")).toEqual(["nueva", "media", "vieja", "nunca"]);
  });

  it("'oldest' invierte el orden", () => {
    expect(ids("oldest")).toEqual(["vieja", "media", "nueva", "nunca"]);
  });

  it("las que nunca tuvieron mensaje quedan al final en ambos órdenes", () => {
    expect(ids("recent").at(-1)).toBe("nunca");
    expect(ids("oldest").at(-1)).toBe("nunca");
  });
});

describe("applyInboxFilters — búsqueda", () => {
  const laura = conversation({ id: "laura" });
  const carlos = conversation({ id: "carlos" });

  function ids(search: string) {
    return applyInboxFilters([laura, carlos], {
      filter: "all",
      search,
      tagId: null,
      sort: "recent",
      viewer: ANA,
    }).map((c) => c.id);
  }

  it("busca por nombre sin distinguir mayúsculas", () => {
    expect(ids("LAU")).toEqual(["laura"]);
  });

  it("ignora los espacios de más", () => {
    expect(ids("  carlos  ")).toEqual(["carlos"]);
  });

  it("busca también por número de teléfono", () => {
    expect(ids("+58000")).toHaveLength(2);
  });
});

describe("applyInboxFilters — los criterios se acumulan", () => {
  it("cruza bandeja, etiqueta y orden a la vez", () => {
    const a = conversation({
      id: "a",
      assignedAgent: ANA,
      unreadCount: 1,
      tags: [TAG_VIP],
      lastMessageAt: "2026-08-02T10:00:00Z",
    });
    const b = conversation({
      id: "b",
      assignedAgent: ANA,
      unreadCount: 1,
      tags: [TAG_VIP],
      lastMessageAt: "2026-08-20T10:00:00Z",
    });
    const c = conversation({ id: "c", assignedAgent: ANA, unreadCount: 1, tags: [TAG_MOROSO] });
    const d = conversation({ id: "d", assignedAgent: BETO, unreadCount: 1, tags: [TAG_VIP] });

    const result = applyInboxFilters([a, b, c, d], {
      filter: "mine",
      search: "",
      tagId: TAG_VIP.id,
      sort: "oldest",
      viewer: ANA,
    });

    expect(result.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("no muta el arreglo que recibe", () => {
    const original = [
      conversation({ id: "x", lastMessageAt: "2026-08-01T10:00:00Z" }),
      conversation({ id: "y", lastMessageAt: "2026-08-20T10:00:00Z" }),
    ];
    const copia = [...original];

    applyInboxFilters(original, {
      filter: "all",
      search: "",
      tagId: null,
      sort: "recent",
      viewer: ANA,
    });

    expect(original).toEqual(copia);
  });

  // Antes el buscador solo miraba nombre y número: para volver a un chat había
  // que acordarse de quién era, no servía acordarse de qué se habló.
  describe("buscar por lo que se dijo adentro", () => {
    it("deja pasar la conversación cuyo historial coincide, aunque el nombre no", () => {
      const nombra = conversation({ id: "bujia" });
      const habla = conversation({ id: "otro" });

      const result = applyInboxFilters([nombra, habla], {
        filter: "all",
        search: "bujía",
        tagId: null,
        sort: "recent",
        viewer: ANA,
        messageHitIds: new Set(["otro"]),
      });

      expect(result.map((x) => x.id).sort()).toEqual(["bujia", "otro"]);
    });

    it("sin coincidencias en el historial se comporta como antes", () => {
      const result = applyInboxFilters([conversation({ id: "ana" }), conversation({ id: "beto" })], {
        filter: "all",
        search: "ana",
        tagId: null,
        sort: "recent",
        viewer: ANA,
        messageHitIds: new Set(),
      });

      expect(result.map((x) => x.id)).toEqual(["ana"]);
    });

    // La consulta al servidor tarda: mientras no llega, el buscador tiene que
    // seguir filtrando por nombre en vez de quedarse en blanco.
    it("funciona sin el conjunto de coincidencias, que llega después", () => {
      const result = applyInboxFilters([conversation({ id: "ana" }), conversation({ id: "beto" })], {
        filter: "all",
        search: "ana",
        tagId: null,
        sort: "recent",
        viewer: ANA,
      });

      expect(result.map((x) => x.id)).toEqual(["ana"]);
    });

    it("busca el nombre sin acentos: quien escribe \"jose\" espera encontrar a José", () => {
      const josé = conversation({ id: "jose-perez" });
      josé.contact.displayName = "José Pérez";

      const result = applyInboxFilters([josé, conversation({ id: "otro" })], {
        filter: "all",
        search: "JOSE",
        tagId: null,
        sort: "recent",
        viewer: ANA,
        messageHitIds: new Set(),
      });

      expect(result.map((x) => x.id)).toEqual(["jose-perez"]);
    });

    // El corte por rol manda sobre la búsqueda: encontrar una palabra en el
    // chat de otro asesor no puede meterlo en la bandeja "Míos".
    it("una coincidencia en el historial no salta el filtro de la bandeja", () => {
      const deBeto = conversation({ id: "de-beto", assignedAgent: BETO });

      const result = applyInboxFilters([deBeto], {
        filter: "mine",
        search: "bujia",
        tagId: null,
        sort: "recent",
        viewer: ANA,
        messageHitIds: new Set(["de-beto"]),
      });

      expect(result).toEqual([]);
    });
  });
});
