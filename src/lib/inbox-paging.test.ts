import { describe, expect, it } from "vitest";
import { cursorAfterPage } from "@/lib/inbox-paging";
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
