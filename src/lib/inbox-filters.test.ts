import { describe, expect, it } from "vitest";
import type { Agent, Conversation, Tag } from "@/lib/types";
import {
  applyInboxFilters,
  DEFAULT_INBOX_FILTER,
  filtersForRole,
  INBOX_FILTER_LABELS,
  isUnassignedLead,
  isUnread,
  type HandoffKind,
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
  it("le da al administrador las cinco píldoras", () => {
    expect(filtersForRole("admin")).toEqual(["pending", "unassigned", "unread", "mine", "all"]);
  });

  it("trata al supervisor como administrador", () => {
    expect(filtersForRole("supervisor")).toEqual(filtersForRole("admin"));
  });

  it("al asesor le ofrece las mismas cinco píldoras", () => {
    expect(filtersForRole("agent")).toEqual(["pending", "unassigned", "unread", "mine", "all"]);
  });

  it("cada filtro tiene etiqueta", () => {
    for (const role of ["admin", "supervisor", "agent"] as const) {
      for (const filter of filtersForRole(role)) {
        expect(INBOX_FILTER_LABELS[filter]).toBeTruthy();
      }
    }
  });

  // Guardia anti-crecimiento: la reforma del 28/8/2026 (mañana) bajó de cinco
  // píldoras a tres a propósito —los cortes por leído/asignado eran guardas
  // poco fiables (ver inbox-filters.ts, case "unread"). Este test no valida
  // comportamiento nuevo, valida que nadie vuelva a sumar píldoras sin
  // pensarlo: si un rol necesita un corte propio, que sea una decisión de
  // producto explícita, no un agregado silencioso a `filtersForRole`.
  //
  // El tope subió de tres a cuatro el 30/8/2026, y es la MISMA guardia, no
  // una relajada: la reforma de esa fecha trajo de vuelta `pending` por una
  // decisión de producto explícita del operador, medida contra producción
  // (282 filas de "Pendientes" contra 51 de "No leídas", 231 chats
  // leídos-y-sin-responder que no aparecían en ninguna píldora — ver el
  // comentario de `case "pending"` en inbox-filters.ts). El tope se mueve
  // cuando hay una decisión así detrás, nunca por default.
  //
  // Y de cuatro a cinco ese mismo día, con la misma vara: "Sin dueño" es la
  // píldora de la reforma "ningún lead invisible" (Etapa 1, ver CLAUDE.md).
  // No es un corte más de los que ya se veían: son los chats que el SISTEMA
  // soltó —la IA apagada, la ventana de 24 h vencida, tres intentos
  // fallidos—, que hasta ahora no aparecían en ninguna píldora porque
  // ninguna corta por eso. Es el único lugar de la interfaz donde la
  // bitácora de traspasos se ve; sin ella, la Etapa 1 escribe un registro
  // que nadie lee.
  it("ningún rol vuelve a tener más de cinco píldoras", () => {
    for (const role of ["admin", "supervisor", "agent"] as const) {
      expect(filtersForRole(role).length).toBeLessThanOrEqual(5);
    }
  });
});

describe("DEFAULT_INBOX_FILTER", () => {
  it("al entrar a la bandeja se ve el trabajo pendiente de respuesta", () => {
    expect(DEFAULT_INBOX_FILTER).toBe("pending");
  });

  it("es una de las píldoras que ofrece cada rol", () => {
    for (const role of ["admin", "supervisor", "agent"] as const) {
      expect(filtersForRole(role)).toContain(DEFAULT_INBOX_FILTER);
    }
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
 * El corte "pending" ANTIGUO (trabajo con más de 24h sin respuesta, antes
 * llamado "unanswered") y sus ~11 casos de borde —hasReply vitalicio, sin
 * dueño, escalado sin respuesta, muda, etc.— se retiraron de acá con la
 * reforma del 28/8/2026 (tarde) y quedaron en `dashboard.ts`
 * (`awaitingReply`/`isStalePending`), probados en `dashboard-tickets.test.ts`
 * y `data-conversations.test.ts`. Eso sigue así: la ventana de 24h no vuelve
 * a la bandeja.
 *
 * Lo que sí volvió con la reforma del 30/8/2026 es la píldora `pending` de
 * la bandeja —ver el describe de abajo—, con un predicado deliberadamente
 * más simple que el `isStalePending` del Dashboard: abierta + `awaitingReply`,
 * sin ventana de tiempo. El porqué está en el acto (e) del comentario de
 * `case "pending"` en inbox-filters.ts.
 */
describe("applyInboxFilters — 'pending'", () => {
  function ids(todas: Conversation[]) {
    return applyInboxFilters(todas, {
      filter: "pending",
      search: "",
      tagId: null,
      sort: "recent",
      viewer: ANA,
    }).map((c) => c.id);
  }

  it("aparece la abierta que está esperando respuesta del cliente", () => {
    const esperando = conversation({
      id: "esperando",
      lastMessageAt: "2026-08-20T10:00:00Z",
      lastCustomerMessageAt: "2026-08-22T10:00:00Z",
    });

    expect(ids([esperando])).toEqual(["esperando"]);
  });

  it("no aparece la cerrada, aunque el último mensaje sea del cliente", () => {
    const cerradaEsperando = conversation({
      id: "cerrada-esperando",
      status: "closed",
      lastMessageAt: "2026-08-20T10:00:00Z",
      lastCustomerMessageAt: "2026-08-22T10:00:00Z",
    });

    expect(ids([cerradaEsperando])).toEqual([]);
  });

  it("no aparece la abierta ya contestada: el último mensaje no es del cliente", () => {
    const yaContestada = conversation({
      id: "ya-contestada",
      lastMessageAt: "2026-08-22T10:00:00Z",
      lastCustomerMessageAt: "2026-08-20T10:00:00Z",
    });

    expect(ids([yaContestada])).toEqual([]);
  });

  // `awaitingReply` (dashboard.ts) falla cerrado sin mensaje del cliente: una
  // conversación que nunca recibió nada de él no es "trabajo esperando
  // respuesta", es una conversación sin abrir todavía.
  it("no aparece sin lastCustomerMessageAt: awaitingReply falla cerrado", () => {
    const sinMensajeDeCliente = conversation({
      id: "sin-mensaje-cliente",
      lastCustomerMessageAt: null,
    });

    expect(ids([sinMensajeDeCliente])).toEqual([]);
  });
});

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

describe("isUnread", () => {
  it("es la misma definición que usa el filtro 'unread': contador o marca manual", () => {
    expect(isUnread(conversation({ id: "a", unreadCount: 1 }))).toBe(true);
    expect(isUnread(conversation({ id: "b", manuallyUnread: true }))).toBe(true);
    expect(isUnread(conversation({ id: "c" }))).toBe(false);
  });
});

/**
 * T1.6 del plan "Ningún lead invisible": la píldora "Sin dueño" sobre la
 * bitácora de traspasos (`conversation_handoffs`). No pasa por
 * `applyInboxFilters`/`matchesFilter` como pending/unread/mine/all —esos
 * cuatro se pueden recalcular sobre lo que ya tiene cargado
 * `ConversationSummary`; "sin dueño" depende de una tabla que ninguna fila de
 * la bandeja trae hoy— así que se prueba directo la regla pura que usa
 * `fetchUnassignedConversations` (data.ts) sobre lo que la base ya le
 * entrega acotado (`awaiting_reply` más el traspaso más reciente).
 */
describe("isUnassignedLead", () => {
  function handoff(toKind: string, createdAt: string): HandoffKind {
    return { toKind, createdAt };
  }

  it("aparece: awaiting_reply y el traspaso a unassigned sin ninguno posterior", () => {
    const handoffs = [
      handoff("human", "2026-08-29T10:00:00Z"),
      handoff("unassigned", "2026-08-30T10:00:00Z"),
    ];

    expect(isUnassignedLead(true, handoffs)).toBe(true);
  });

  it("no aparece: hubo un traspaso posterior a ai", () => {
    const handoffs = [
      handoff("unassigned", "2026-08-30T10:00:00Z"),
      handoff("ai", "2026-08-30T11:00:00Z"),
    ];

    expect(isUnassignedLead(true, handoffs)).toBe(false);
  });

  it("no aparece: hubo un traspaso posterior a human", () => {
    const handoffs = [
      handoff("unassigned", "2026-08-30T10:00:00Z"),
      handoff("human", "2026-08-30T11:00:00Z"),
    ];

    expect(isUnassignedLead(true, handoffs)).toBe(false);
  });

  it("no aparece sin awaiting_reply, aunque el último traspaso sea a unassigned", () => {
    const handoffs = [handoff("unassigned", "2026-08-30T10:00:00Z")];

    expect(isUnassignedLead(false, handoffs)).toBe(false);
  });

  it("no aparece sin ningún traspaso todavía: no hay 'última fila' que sea unassigned", () => {
    expect(isUnassignedLead(true, [])).toBe(false);
  });

  it("el orden de la lista no importa: siempre gana por fecha, no por posición", () => {
    // El traspaso a unassigned llega SEGUNDO en el arreglo aunque sea el más
    // VIEJO: si la función mirara el último elemento en vez del más reciente
    // por `createdAt`, se equivocaría acá.
    const handoffs = [
      handoff("human", "2026-08-30T11:00:00Z"),
      handoff("unassigned", "2026-08-30T10:00:00Z"),
    ];

    expect(isUnassignedLead(true, handoffs)).toBe(false);
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
