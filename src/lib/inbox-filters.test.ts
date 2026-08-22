import { describe, expect, it } from "vitest";
import type { Agent, Conversation, Tag } from "@/lib/types";
import { applyInboxFilters, filtersForRole, INBOX_FILTER_LABELS } from "@/lib/inbox-filters";

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
  assignedAgent?: Agent | null;
  lastMessageAt?: string | null;
  tags?: Tag[];
}): Conversation {
  return {
    id: over.id,
    unreadCount: over.unreadCount ?? 0,
    assignedAgent: over.assignedAgent ?? null,
    // Ojo: `?? default` convertiría un null explícito en fecha. Acá null
    // significa "esta conversación nunca tuvo un mensaje".
    lastMessageAt: "lastMessageAt" in over ? over.lastMessageAt : "2026-08-22T10:00:00Z",
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
  it("le da al administrador los filtros de toda la bandeja", () => {
    expect(filtersForRole("admin")).toEqual(["all", "unread", "unassigned", "assigned"]);
  });

  it("trata al supervisor como administrador", () => {
    expect(filtersForRole("supervisor")).toEqual(filtersForRole("admin"));
  });

  it("al asesor solo le ofrece lo suyo", () => {
    expect(filtersForRole("agent")).toEqual(["all", "mine", "mine-unread"]);
  });

  it("cada filtro tiene etiqueta", () => {
    for (const role of ["admin", "supervisor", "agent"] as const) {
      for (const filter of filtersForRole(role)) {
        expect(INBOX_FILTER_LABELS[filter]).toBeTruthy();
      }
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

  it("'unread' deja solo las que tienen mensajes sin leer, de quien sean", () => {
    expect(ids("unread")).toEqual(["sin-asignar", "de-ana-no-leida", "de-beto"]);
  });

  it("'unassigned' deja solo las que no tienen dueño", () => {
    expect(ids("unassigned")).toEqual(["sin-asignar"]);
  });

  it("'assigned' deja las de cualquier asesor, pero ninguna huérfana", () => {
    expect(ids("assigned")).toEqual(["de-ana-leida", "de-ana-no-leida", "de-beto"]);
  });

  it("'mine' deja las del asesor que mira, leídas y no leídas", () => {
    expect(ids("mine")).toEqual(["de-ana-leida", "de-ana-no-leida"]);
  });

  it("'mine' cambia según quién mira", () => {
    expect(ids("mine", BETO)).toEqual(["de-beto"]);
  });

  it("'mine-unread' cruza dueño y no leídas", () => {
    expect(ids("mine-unread")).toEqual(["de-ana-no-leida"]);
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
      filter: "mine-unread",
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
});
