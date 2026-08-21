import { describe, expect, it } from "vitest";
import {
  AVAILABILITY_INSTRUCTIONS,
  COMPLAINT_INSTRUCTIONS,
  IDENTITY_PROMPT,
  OTHER_INSTRUCTIONS,
  RETURN_INSTRUCTIONS,
} from "@/lib/ai/prompt";

const ALL_INSTRUCTION_PROMPTS = {
  IDENTITY_PROMPT,
  AVAILABILITY_INSTRUCTIONS,
  RETURN_INSTRUCTIONS,
  COMPLAINT_INSTRUCTIONS,
  OTHER_INSTRUCTIONS,
};

describe("prompts del agente IA usan el formato real de WhatsApp", () => {
  it("instruye explícitamente a no usar doble asterisco (Markdown)", () => {
    expect(IDENTITY_PROMPT).toMatch(/un solo asterisco/);
  });

  it.each(Object.entries(ALL_INSTRUCTION_PROMPTS))(
    "%s no contiene el propio prompt literal `**` (Markdown en vez de WhatsApp)",
    (_name, prompt) => {
      expect(prompt).not.toContain("**");
    }
  );
});
