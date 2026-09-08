import { describe, expect, it } from "vitest";
import type { Agent, Conversation, Tag } from "@/lib/types";
import {
  applyInboxFilters,
  DEFAULT_INBOX_FILTER,
  filtersForRole,
  INBOX_FILTER_LABELS,
  isUnassignedLead,
  isUnread,
  matchesDay,
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
  /** T1 (8/9/2026): lo que mira `matchesDay` cuando no hay `lastMessageAt` todavía. */
  createdAt?: string;
  lastCustomerMessageAt?: string | null;
  /**
   * La respuesta real (T0.2, 5/9/2026): lo único que mira `awaitingReply`
   * (dashboard.ts) desde que dejó de comparar contra `lastMessageAt`. Por
   * defecto null — "nadie respondió" — salvo que el caso lo necesite
   * explícito (ver "ya-contestada" más abajo).
   */
  lastReplyAt?: string | null;
  lastReplySender?: "agent" | "ai" | null;
  hasReply?: boolean;
  status?: Conversation["status"];
  tags?: Tag[];
  /** T1.5 (5/9/2026): lo que mira `case "escalated"` de `matchesFilter`. */
  journeyStage?: Conversation["journeyStage"];
  /** T1.5 (5/9/2026): default `true` — "no escalada" es el caso común del resto de este archivo. */
  aiEnabled?: boolean;
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
    createdAt: over.createdAt ?? "2026-08-22T10:00:00Z",
    lastCustomerMessageAt:
      "lastCustomerMessageAt" in over ? over.lastCustomerMessageAt : null,
    lastReplyAt: "lastReplyAt" in over ? over.lastReplyAt : null,
    lastReplySender: over.lastReplySender ?? null,
    journeyStage: over.journeyStage ?? null,
    aiEnabled: over.aiEnabled ?? true,
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
  it("le da al administrador las seis píldoras, en ese orden", () => {
    expect(filtersForRole("admin")).toEqual([
      "pending",
      "unassigned",
      "escalated",
      "unread",
      "mine",
      "all",
    ]);
  });

  it("trata al supervisor como administrador", () => {
    expect(filtersForRole("supervisor")).toEqual(filtersForRole("admin"));
  });

  it("al asesor le ofrece las mismas seis píldoras", () => {
    expect(filtersForRole("agent")).toEqual(filtersForRole("admin"));
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
  //
  // De cinco a seis el 5/9/2026 (T1.5 del plan "La bandeja que no pierde"):
  // "Escaladas". Tampoco es un corte reciclado — a diferencia de "Sin
  // dueño", que lee la bitácora de traspasos, esta lee el estado VIVO de la
  // conversación (`journeyStage`/`aiEnabled`/`lastReplySender`) para separar
  // lo escalado a un humano que sigue sin una respuesta REAL de alguien del
  // equipo. El tope sube otra vez porque hay, de nuevo, una decisión de
  // producto explícita detrás — no porque el guardia se haya relajado.
  it("ningún rol vuelve a tener más de seis píldoras", () => {
    for (const role of ["admin", "supervisor", "agent"] as const) {
      expect(filtersForRole(role).length).toBeLessThanOrEqual(6);
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

  it("no aparece la abierta ya contestada: hubo una respuesta real después del mensaje del cliente", () => {
    const yaContestada = conversation({
      id: "ya-contestada",
      lastMessageAt: "2026-08-22T10:00:00Z",
      lastCustomerMessageAt: "2026-08-20T10:00:00Z",
      // T0.2: lo que apaga "esperando" es `lastReplyAt`, no `lastMessageAt`.
      lastReplyAt: "2026-08-22T10:00:00Z",
      lastReplySender: "agent",
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
 * T1.5 del plan "La bandeja que no pierde" (5/9/2026): la píldora
 * "Escaladas". A diferencia de "Sin dueño" (más abajo), que lee la bitácora
 * de traspasos, esta se resuelve enteramente sobre columnas de
 * `ConversationSummary` (`journeyStage`/`aiEnabled`/`status`/
 * `lastReplySender`/`awaitingReply`), así que sí pasa por `applyInboxFilters`
 * como "pending"/"unread"/"mine".
 *
 * El matiz que motiva el `|| awaitingReply(c)` de `case "escalated"`
 * (inbox-filters.ts): al escalar sin asesores disponibles, la IA manda un
 * mensaje de cortesía ("Dejé tu caso registrado… no hay asesores") que SÍ
 * cuenta como respuesta real —`lastReplySender` queda en `"ai"`,
 * `awaitingReply` se apaga— sin que ningún humano haya escrito nada. Los seis
 * casos de acá son los que pide el plan.
 */
describe("applyInboxFilters — 'escalated'", () => {
  function ids(todas: Conversation[]) {
    return applyInboxFilters(todas, {
      filter: "escalated",
      search: "",
      tagId: null,
      sort: "recent",
      viewer: ANA,
    }).map((c) => c.id);
  }

  it("escalada sin asesor: la IA se despidió con el mensaje de cortesía y ya no espera — aparece igual", () => {
    const escaladaSinAsesor = conversation({
      id: "escalada-sin-asesor",
      journeyStage: "assigned",
      aiEnabled: false,
      assignedAgent: null,
      lastCustomerMessageAt: "2026-09-04T10:00:00Z",
      lastReplyAt: "2026-09-04T10:05:00Z",
      lastReplySender: "ai",
    });

    expect(ids([escaladaSinAsesor])).toEqual(["escalada-sin-asesor"]);
  });

  it("con asesor, sin que nadie responda todavía: aparece", () => {
    const conAsesorSinResponder = conversation({
      id: "con-asesor-sin-responder",
      journeyStage: "assigned",
      aiEnabled: false,
      assignedAgent: ANA,
      lastCustomerMessageAt: "2026-09-04T10:00:00Z",
      lastReplyAt: null,
      lastReplySender: null,
    });

    expect(ids([conAsesorSinResponder])).toEqual(["con-asesor-sin-responder"]);
  });

  it("con asesor que ya respondió de verdad y el cliente no volvió: sale de la píldora", () => {
    const conAsesorQueRespondio = conversation({
      id: "con-asesor-que-respondio",
      journeyStage: "assigned",
      aiEnabled: false,
      assignedAgent: ANA,
      lastCustomerMessageAt: "2026-09-04T10:00:00Z",
      lastReplyAt: "2026-09-04T10:05:00Z",
      lastReplySender: "agent",
    });

    expect(ids([conAsesorQueRespondio])).toEqual([]);
  });

  it("el asesor respondió, pero el cliente volvió a escribir después: vuelve a aparecer", () => {
    const clienteVolvio = conversation({
      id: "cliente-volvio",
      journeyStage: "assigned",
      aiEnabled: false,
      assignedAgent: ANA,
      // El asesor contestó primero...
      lastReplyAt: "2026-09-04T10:05:00Z",
      lastReplySender: "agent",
      // ...pero el cliente escribió de nuevo DESPUÉS de esa respuesta:
      // `awaitingReply` (dashboard.ts) vuelve a `true` aunque `lastReplySender`
      // siga en "agent" — el `|| awaitingReply(c)` es justo lo que rescata
      // este caso.
      lastCustomerMessageAt: "2026-09-04T11:00:00Z",
    });

    expect(ids([clienteVolvio])).toEqual(["cliente-volvio"]);
  });

  it("cerrada: no aparece aunque el resto del estado siga calzando", () => {
    const cerrada = conversation({
      id: "escalada-cerrada",
      journeyStage: "assigned",
      aiEnabled: false,
      assignedAgent: null,
      status: "closed",
      lastCustomerMessageAt: "2026-09-04T10:00:00Z",
      lastReplyAt: null,
      lastReplySender: null,
    });

    expect(ids([cerrada])).toEqual([]);
  });

  it("con la IA todavía encendida: no es una escalación real, no aparece", () => {
    const iaEncendida = conversation({
      id: "ia-encendida",
      journeyStage: "assigned",
      aiEnabled: true,
      assignedAgent: null,
      lastCustomerMessageAt: "2026-09-04T10:00:00Z",
      lastReplyAt: null,
      lastReplySender: null,
    });

    expect(ids([iaEncendida])).toEqual([]);
  });
});

/**
 * T1.6 del plan "Ningún lead invisible": la píldora "Sin dueño" sobre la
 * bitácora de traspasos (`conversation_handoffs`). Esta regla en sí NO pasa
 * por `applyInboxFilters`/`matchesFilter` como pending/unread/mine/all —esos
 * cuatro se pueden recalcular sobre lo que ya tiene cargado
 * `ConversationSummary`; "sin dueño" depende de una tabla que ninguna fila de
 * la bandeja trae hoy— así que se prueba directo la regla pura que usa
 * `fetchUnassignedConversations` (data.ts) sobre lo que la base ya le
 * entrega acotado (`awaiting_reply` más el traspaso más reciente).
 *
 * Lo que SÍ pasa por `matchesFilter` desde la tanda 1 (5/9/2026, ver el
 * describe "applyInboxFilters — 'unassigned'" más abajo) es el RESULTADO ya
 * resuelto de esta regla: `fetchUnassignedConversations` decide con
 * `isUnassignedLead` qué ids son "sin dueño", y `matchesFilter` solo compara
 * la fila de la ventana local contra ese conjunto de ids — no vuelve a
 * evaluar la bitácora, que sigue sin llegar a `ConversationSummary`.
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

/**
 * C1 (tanda 1, 5/9/2026): la píldora "Sin dueño" pasa por `applyInboxFilters`
 * como cualquier otra desde que `matchesFilter` compara contra `unassignedIds`
 * en vez de devolver `true` a ciegas. Bug detectado en la verificación visual
 * del 5/9/2026: el conteo salía bien, pero la lista mostraba TODA la ventana
 * cargada en memoria, no solo lo que `fetchUnassignedConversations` había
 * resuelto de verdad — porque `searchableConversations` (inbox-sidebar.tsx)
 * mezcla la ventana local con las filas resueltas por esa consulta antes de
 * pasarlas a `applyInboxFilters`.
 */
describe("applyInboxFilters — 'unassigned'", () => {
  function ids(todas: Conversation[], unassignedIds?: ReadonlySet<string> | null) {
    return applyInboxFilters(todas, {
      filter: "unassigned",
      search: "",
      tagId: null,
      sort: "recent",
      viewer: ANA,
      unassignedIds,
    }).map((c) => c.id);
  }

  const sinDueño = conversation({ id: "sin-dueno" });
  const conDueño = conversation({ id: "con-dueno", assignedAgent: ANA });
  const todas = [sinDueño, conDueño];

  it("sin el set (consulta todavía en vuelo) no deja pasar nada: la lista no se adelanta a lo que la base confirmó", () => {
    expect(ids(todas)).toEqual([]);
  });

  it("con el set vacío tampoco deja pasar nada", () => {
    expect(ids(todas, new Set())).toEqual([]);
  });

  it("deja pasar SOLO los ids que trajo la consulta de 'sin dueño', aunque la ventana local traiga más filas", () => {
    expect(ids(todas, new Set(["sin-dueno"]))).toEqual(["sin-dueno"]);
  });

  it("un id del set que no está en la ventana local simplemente no aparece (no hay fila que pintar)", () => {
    expect(ids(todas, new Set(["sin-dueno", "fantasma"]))).toEqual(["sin-dueno"]);
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

/**
 * T2.2 del plan "La bandeja que no pierde" (5/9/2026): hasta tres chats
 * fijados por asesor (`conversation_pins`). `pinnedIds` no es un filtro más
 * —una conversación fijada que no calza con la píldora activa sigue sin
 * aparecer— es un segundo criterio de orden que se aplica DESPUÉS del `sort`
 * normal: los fijados suben como grupo, sin desordenar entre ellos ni entre
 * el resto de la lista.
 */
describe("applyInboxFilters — 'pinnedIds' pone los fijados primero", () => {
  const vieja = conversation({ id: "vieja", lastMessageAt: "2026-08-01T10:00:00Z" });
  const nueva = conversation({ id: "nueva", lastMessageAt: "2026-08-22T10:00:00Z" });
  const media = conversation({ id: "media", lastMessageAt: "2026-08-10T10:00:00Z" });
  const todas = [vieja, nueva, media];

  function ids(pinnedIds?: ReadonlySet<string>, sort: "recent" | "oldest" = "recent") {
    return applyInboxFilters(todas, {
      filter: "all",
      search: "",
      tagId: null,
      sort,
      viewer: ANA,
      pinnedIds,
    }).map((c) => c.id);
  }

  it("sin pinnedIds el orden no cambia respecto al de antes de esta tarea", () => {
    expect(ids()).toEqual(["nueva", "media", "vieja"]);
  });

  it("con un conjunto vacío tampoco cambia nada", () => {
    expect(ids(new Set())).toEqual(["nueva", "media", "vieja"]);
  });

  it("la fijada más vieja sube por encima de las dos no fijadas, aunque sean más nuevas", () => {
    expect(ids(new Set(["vieja"]))).toEqual(["vieja", "nueva", "media"]);
  });

  it("con dos fijadas, las dos van primero respetando entre ellas el orden por fecha", () => {
    expect(ids(new Set(["vieja", "media"]))).toEqual(["media", "vieja", "nueva"]);
  });

  it("respeta el orden interno también en 'oldest': entre fijadas, la más vieja primero", () => {
    expect(ids(new Set(["nueva", "vieja"]), "oldest")).toEqual(["vieja", "nueva", "media"]);
  });

  it("un id fijado que no está en la lista no rompe nada", () => {
    expect(ids(new Set(["fantasma"]))).toEqual(["nueva", "media", "vieja"]);
  });
});

/**
 * T1 del plan "Seis frentes del buzón" (8/9/2026): "habló hoy" es cualquier
 * mensaje de HOY —cliente, asesor o IA— en `America/Caracas`. La medianoche
 * de Caracas de acá abajo (UTC-4) es una hora fija cualquiera: `matchesDay`
 * es puro y no vuelve a calcular la zona horaria, solo compara el instante
 * que le llega contra el que ya trae calculado `useInboxDay`.
 */
describe("matchesDay", () => {
  const HOY_00_00_CARACAS = "2026-09-08T04:00:00.000Z";

  it("un mensaje de hoy pasa el corte", () => {
    const conv = conversation({ id: "hoy", lastMessageAt: "2026-09-08T10:00:00.000Z" });
    expect(matchesDay(conv, HOY_00_00_CARACAS)).toBe(true);
  });

  it("el último mensaje de ayer no pasa", () => {
    const conv = conversation({ id: "ayer", lastMessageAt: "2026-09-07T23:59:59.000Z" });
    expect(matchesDay(conv, HOY_00_00_CARACAS)).toBe(false);
  });

  it("exactamente la medianoche de Caracas cuenta como hoy (corte inclusivo, >=)", () => {
    const conv = conversation({ id: "medianoche", lastMessageAt: HOY_00_00_CARACAS });
    expect(matchesDay(conv, HOY_00_00_CARACAS)).toBe(true);
  });

  // Una conversación recién creada desde la bandeja (T6) no tiene
  // `lastMessageAt` todavía: sin este respaldo desaparecería de "hoy" antes
  // de que le llegue el primer mensaje.
  it("sin lastMessageAt, cae a createdAt: hoy pasa", () => {
    const conv = conversation({
      id: "recien-creada",
      lastMessageAt: null,
      createdAt: "2026-09-08T12:00:00.000Z",
    });
    expect(matchesDay(conv, HOY_00_00_CARACAS)).toBe(true);
  });

  it("sin lastMessageAt, cae a createdAt: ayer no pasa", () => {
    const conv = conversation({
      id: "recien-creada-ayer",
      lastMessageAt: null,
      createdAt: "2026-09-07T12:00:00.000Z",
    });
    expect(matchesDay(conv, HOY_00_00_CARACAS)).toBe(false);
  });

  it('con dayStart null ("Ver todo") deja pasar cualquier fecha', () => {
    const conv = conversation({ id: "viejisima", lastMessageAt: "2020-01-01T00:00:00.000Z" });
    expect(matchesDay(conv, null)).toBe(true);
  });
});

describe("applyInboxFilters — el corte de 'hoy' (T1, 8/9/2026)", () => {
  const HOY_00_00_CARACAS = "2026-09-08T04:00:00.000Z";
  const hoy = conversation({ id: "hoy", lastMessageAt: "2026-09-08T10:00:00.000Z" });
  const semanaAnterior = conversation({
    id: "semana-pasada",
    lastMessageAt: "2026-09-01T10:00:00.000Z",
  });

  it("sin búsqueda, deja fuera lo que no habló hoy", () => {
    const result = applyInboxFilters([hoy, semanaAnterior], {
      filter: "all",
      search: "",
      tagId: null,
      sort: "recent",
      viewer: ANA,
      dayStart: HOY_00_00_CARACAS,
    });
    expect(result.map((c) => c.id)).toEqual(["hoy"]);
  });

  // Decisión del operador: la búsqueda siempre mira todo el historial, sin
  // que haga falta tocar el interruptor "Ver todo".
  it("con búsqueda activa, ignora el corte y encuentra al cliente de la semana pasada", () => {
    const result = applyInboxFilters([hoy, semanaAnterior], {
      filter: "all",
      search: "semana",
      tagId: null,
      sort: "recent",
      viewer: ANA,
      dayStart: HOY_00_00_CARACAS,
    });
    expect(result.map((c) => c.id)).toEqual(["semana-pasada"]);
  });

  it("sin dayStart, no filtra por día (llamador que todavía no lo conoce)", () => {
    const result = applyInboxFilters([hoy, semanaAnterior], {
      filter: "all",
      search: "",
      tagId: null,
      sort: "recent",
      viewer: ANA,
    });
    expect(result.map((c) => c.id).sort()).toEqual(["hoy", "semana-pasada"]);
  });
});
