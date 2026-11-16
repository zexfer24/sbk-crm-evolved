import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { lecturaDeMediaActiva } from "./media-reading-switch";

describe("lecturaDeMediaActiva", () => {
  let previo: string | undefined;

  beforeEach(() => {
    previo = process.env.AI_MEDIA_READING;
  });

  afterEach(() => {
    if (previo === undefined) delete process.env.AI_MEDIA_READING;
    else process.env.AI_MEDIA_READING = previo;
  });

  it("está encendida cuando la variable no existe", () => {
    delete process.env.AI_MEDIA_READING;
    expect(lecturaDeMediaActiva()).toBe(true);
  });

  it("se apaga solo con off, sin importar mayúsculas ni espacios", () => {
    process.env.AI_MEDIA_READING = "off";
    expect(lecturaDeMediaActiva()).toBe(false);
    process.env.AI_MEDIA_READING = "  OFF ";
    expect(lecturaDeMediaActiva()).toBe(false);
  });

  it("cualquier otro valor la deja encendida", () => {
    process.env.AI_MEDIA_READING = "on";
    expect(lecturaDeMediaActiva()).toBe(true);
    process.env.AI_MEDIA_READING = "";
    expect(lecturaDeMediaActiva()).toBe(true);
    process.env.AI_MEDIA_READING = "apagado";
    expect(lecturaDeMediaActiva()).toBe(true);
  });
});
