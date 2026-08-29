import { describe, expect, it } from "vitest";
import type { Agent, Conversation, Tag } from "@/lib/types";
import {
  applyInboxFilters,
  DEFAULT_INBOX_FILTER,
  filtersForRole,
  INBOX_FILTER_LABELS,
  isUnread,
  serverFilterTruncated,
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
    expect(filtersForRole("admin")).toEqual(["unread", "mine", "all"]);
  });

  it("trata al supervisor como administrador", () => {
    expect(filtersForRole("supervisor")).toEqual(filtersForRole("admin"));
  });

  it("al asesor le ofrece las mismas tres píldoras", () => {
    expect(filtersForRole("agent")).toEqual(["unread", "mine", "all"]);
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
  // fiables (ver inbox-filters.ts, case "unread"). Este test no valida
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
  it("al entrar a la bandeja se ve lo que nadie ha leído todavía", () => {
    expect(DEFAULT_INBOX_FILTER).toBe("unread");
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

/**
 * El corte "pending" (trabajo con más de 24h sin respuesta, antes llamado
 * "unanswered") y sus ~11 casos de borde —hasReply vitalicio, sin dueño,
 * escalado sin respuesta, cerrada, muda, etc.— se retiraron de acá con la
 * reforma del 28/8/2026 (tarde): esa conducta ya no vive en la bandeja, vive
 * en `dashboard.ts` (`awaitingReply`/`isStalePending`) y se prueba en
 * `dashboard-tickets.test.ts` y `data-conversations.test.ts`.
 */
describe("applyInboxFilters — 'unread'", () => {
  function ids(todas: Conversation[]) {
    return applyInboxFilters(todas, {
      filter: "unread",
      search: "",
      tagId: null,
      sort: "recent",
      viewer: ANA,
    }).map((c) => c.id);
  }

  it("aparece si tiene mensajes sin leer", () => {
    const conMensajesSinLeer = conversation({ id: "con-mensajes", unreadCount: 3 });

    expect(ids([conMensajesSinLeer])).toEqual(["con-mensajes"]);
  });

  it("aparece si está apartada a mano, aunque el contador esté en 0", () => {
    const apartada = conversation({ id: "apartada", unreadCount: 0, manuallyUnread: true });

    expect(ids([apartada])).toEqual(["apartada"]);
  });

  it("no aparece la leída: contador en 0 y sin apartar a mano", () => {
    const leída = conversation({ id: "leida", unreadCount: 0, manuallyUnread: false });

    expect(ids([leída])).toEqual([]);
  });

  // Decisión de diseño del operador (28/8/2026): cerrar un chat no es
  // leerlo. Una conversación cerrada con mensajes sin abrir sigue siendo
  // trabajo de lectura pendiente, así que aparece igual que una abierta.
  it("una conversación cerrada con mensajes sin leer aparece igual", () => {
    const cerradaSinLeer = conversation({ id: "cerrada-sin-leer", unreadCount: 1, status: "closed" });

    expect(ids([cerradaSinLeer])).toEqual(["cerrada-sin-leer"]);
  });

  // Corte GLOBAL de equipo, no por usuario: a quién esté asignada no cambia
  // si aparece en "No leídas".
  it("la asignación no influye: asignada a otro y sin leer aparece igual", () => {
    const deOtroSinLeer = conversation({ id: "de-otro-sin-leer", unreadCount: 1, assignedAgent: BETO });

    expect(ids([deOtroSinLeer])).toEqual(["de-otro-sin-leer"]);
  });
});

describe("serverFilterTruncated", () => {
  it("acusa recorte: la consulta trajo justo el tope y el contador dice que hay más", () => {
    expect(serverFilterTruncated(200, 847)).toBe(true);
  });

  it("no acusa recorte cuando la consulta trajo todo lo que hay: filas y contador coinciden", () => {
    expect(serverFilterTruncated(54, 54)).toBe(false);
  });

  // Trajo menos que el tope, así que no puede haber recortado nada — un
  // contador más alto acá es una carrera entre `fetchInboxCounts` y
  // `fetchConversations` (dos viajes a la base, no uno atómico), no evidencia
  // de que la consulta se quedó corta.
  it("no acusa recorte con menos filas que el tope, aunque el contador diga más (carrera de contador)", () => {
    expect(serverFilterTruncated(54, 847)).toBe(false);
  });

  it("no acusa recorte si el contador coincide justo con el tope: no quedó nadie afuera", () => {
    expect(serverFilterTruncated(200, 200)).toBe(false);
  });

  it("no acusa recorte sin contador disponible: sin dato no hay acusación", () => {
    expect(serverFilterTruncated(200, undefined)).toBe(false);
  });
});

describe("isUnread", () => {
  it("es la misma definición que usa el filtro 'unread': contador o marca manual", () => {
    expect(isUnread(conversation({ id: "a", unreadCount: 1 }))).toBe(true);
    expect(isUnread(conversation({ id: "b", manuallyUnread: true }))).toBe(true);
    expect(isUnread(conversation({ id: "c" }))).toBe(false);
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
