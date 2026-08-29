import { describe, expect, it } from "vitest";
import { cursorAfterPage, mergeById } from "@/lib/inbox-paging";
import type { ConversationSummary } from "@/lib/types";

function row(id: string, lastMessageAt: string | null): ConversationSummary {
  return {
    id,
    contact: {
      id: `contact-${id}`,
      phoneNumber: "5840000000",
      displayName: null,
      profileName: null,
      avatarUrl: null,
      tags: [],
    },
    status: "open",
    unreadCount: 0,
    manuallyUnread: false,
    assignedAgent: null,
    aiEnabled: true,
    dealStatus: "none",
    dealVerified: false,
    lastCustomerMessageAt: null,
    lastMessageAt,
    hasReply: false,
    createdAt: "2024-01-01T00:00:00.000Z",
    journeyStage: null,
    intent: null,
    activeTool: null,
    welcomeSentAt: null,
    lastMessagePreview: null,
    lastMessageDirection: null,
    lastMessageStatus: null,
  };
}

describe("cursorAfterPage", () => {
  it("toma la última fila de la página como cursor para la siguiente", () => {
    const page = [row("conv-1", "2026-08-29T10:00:00.000Z"), row("conv-2", "2026-08-29T09:00:00.000Z")];

    expect(cursorAfterPage(page)).toEqual({ lastMessageAt: "2026-08-29T09:00:00.000Z", id: "conv-2" });
  });

  it("con la última fila en la zona nula, el cursor viaja con lastMessageAt null", () => {
    const page = [row("conv-1", "2026-08-29T10:00:00.000Z"), row("conv-2", null)];

    expect(cursorAfterPage(page)).toEqual({ lastMessageAt: null, id: "conv-2" });
  });

  it("con la página vacía no hay cursor: no queda página siguiente que pedir", () => {
    expect(cursorAfterPage([])).toBeNull();
  });
});

describe("mergeById", () => {
  it("la primera fila gana cuando el mismo id aparece en los dos tramos", () => {
    const primero = [row("conv-1", "2026-08-29T10:00:00.000Z")];
    const segundo = [row("conv-1", "2026-08-29T09:00:00.000Z")];

    const [única] = mergeById(primero, segundo);
    expect(única.lastMessageAt).toBe("2026-08-29T10:00:00.000Z");
  });

  it("no repite ids: una fila que aparece en los dos tramos queda una sola vez", () => {
    const primero = [row("conv-1", null), row("conv-2", null)];
    const segundo = [row("conv-2", null), row("conv-3", null)];

    expect(mergeById(primero, segundo).map((c) => c.id)).toEqual(["conv-1", "conv-2", "conv-3"]);
  });

  it("conserva el orden: primero entero, luego lo nuevo del segundo tramo", () => {
    const primero = [row("conv-2", null), row("conv-1", null)];
    const segundo = [row("conv-1", null), row("conv-3", null), row("conv-4", null)];

    expect(mergeById(primero, segundo).map((c) => c.id)).toEqual([
      "conv-2",
      "conv-1",
      "conv-3",
      "conv-4",
    ]);
  });

  it("con el segundo tramo vacío, devuelve el primero tal cual", () => {
    const primero = [row("conv-1", null), row("conv-2", null)];

    expect(mergeById(primero, [])).toEqual(primero);
  });
});
