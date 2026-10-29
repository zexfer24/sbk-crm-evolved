/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUDIO_SPEED_KEY,
  AUDIO_SPEEDS,
  formatAudioSpeed,
  nextAudioSpeed,
  readAudioSpeed,
  saveAudioSpeed,
} from "@/lib/audio-speed";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("nextAudioSpeed", () => {
  it("cicla 1 → 1.5 → 2 → 2.5 → 3 → 1", () => {
    expect(nextAudioSpeed(1)).toBe(1.5);
    expect(nextAudioSpeed(1.5)).toBe(2);
    expect(nextAudioSpeed(2)).toBe(2.5);
    expect(nextAudioSpeed(2.5)).toBe(3);
    expect(nextAudioSpeed(3)).toBe(1);
  });

  it("un valor que no está en la lista vuelve a 1", () => {
    expect(nextAudioSpeed(1.25)).toBe(1);
    expect(nextAudioSpeed(0)).toBe(1);
    expect(nextAudioSpeed(Number.NaN)).toBe(1);
  });
});

describe("formatAudioSpeed", () => {
  it("escribe la etiqueta con punto y el signo × (U+00D7), como WhatsApp", () => {
    expect(AUDIO_SPEEDS.map(formatAudioSpeed)).toEqual(["1×", "1.5×", "2×", "2.5×", "3×"]);
    expect(formatAudioSpeed(1)).toBe("1×");
  });
});

describe("readAudioSpeed", () => {
  it("sin valor guardado devuelve 1", () => {
    expect(readAudioSpeed()).toBe(1);
  });

  it("lee un valor válido guardado", () => {
    localStorage.setItem(AUDIO_SPEED_KEY, "2.5");
    expect(readAudioSpeed()).toBe(2.5);
  });

  it("un valor fuera de la lista o no numérico cae a 1", () => {
    localStorage.setItem(AUDIO_SPEED_KEY, "7");
    expect(readAudioSpeed()).toBe(1);
    localStorage.setItem(AUDIO_SPEED_KEY, "abc");
    expect(readAudioSpeed()).toBe(1);
    localStorage.setItem(AUDIO_SPEED_KEY, "1.25");
    expect(readAudioSpeed()).toBe(1);
  });

  it("si localStorage lanza, devuelve 1", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    expect(readAudioSpeed()).toBe(1);
  });
});

describe("saveAudioSpeed", () => {
  it("guarda el valor como texto en la clave", () => {
    saveAudioSpeed(2);
    expect(localStorage.getItem(AUDIO_SPEED_KEY)).toBe("2");
  });

  it("nunca lanza, aunque localStorage falle", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("cuota llena");
    });
    expect(() => saveAudioSpeed(3)).not.toThrow();
  });
});
