import { describe, expect, it, vi, afterEach } from "vitest";

describe("POST /api/dev/simulate-message en producción", () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    vi.stubEnv("NODE_ENV", originalEnv ?? "test");
    vi.resetModules();
  });

  it("responde 404 sin tocar ninguna dependencia cuando NODE_ENV=production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();

    const { POST } = await import("@/app/api/dev/simulate-message/route");
    const response = await POST(new Request("http://localhost/api/dev/simulate-message", { method: "POST" }));

    expect(response.status).toBe(404);
  });
});
