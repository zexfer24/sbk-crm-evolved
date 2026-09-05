import { describe, expect, it } from "vitest";
import { nextRealtimeAction } from "@/lib/realtime-status";

describe("nextRealtimeAction", () => {
  it("la conexión inicial (sin estado previo) no dispara nada", () => {
    expect(nextRealtimeAction(null, "SUBSCRIBED")).toBe("none");
  });

  it("caer por primera vez, con cualquiera de los tres estados de caída, avisa", () => {
    expect(nextRealtimeAction("SUBSCRIBED", "CHANNEL_ERROR")).toBe("log_down");
    expect(nextRealtimeAction("SUBSCRIBED", "TIMED_OUT")).toBe("log_down");
    expect(nextRealtimeAction("SUBSCRIBED", "CLOSED")).toBe("log_down");
  });

  it("sin estado previo (recién montado) y ya cae, también avisa", () => {
    expect(nextRealtimeAction(null, "CHANNEL_ERROR")).toBe("log_down");
  });

  it("seguir caído con otro estado de caída no repite el aviso", () => {
    expect(nextRealtimeAction("CHANNEL_ERROR", "TIMED_OUT")).toBe("none");
    expect(nextRealtimeAction("TIMED_OUT", "CLOSED")).toBe("none");
    expect(nextRealtimeAction("CLOSED", "CLOSED")).toBe("none");
  });

  it("volver a SUBSCRIBED después de una caída pide resincronizar", () => {
    expect(nextRealtimeAction("CHANNEL_ERROR", "SUBSCRIBED")).toBe("resync");
    expect(nextRealtimeAction("TIMED_OUT", "SUBSCRIBED")).toBe("resync");
    expect(nextRealtimeAction("CLOSED", "SUBSCRIBED")).toBe("resync");
  });

  it("un SUBSCRIBED repetido sin caída de por medio no hace nada", () => {
    expect(nextRealtimeAction("SUBSCRIBED", "SUBSCRIBED")).toBe("none");
  });
});
