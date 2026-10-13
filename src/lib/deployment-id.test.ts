import { describe, expect, it } from "vitest";
import { deploymentIdDesde } from "./deployment-id";

const AHORA = new Date("2026-10-13T08:05:09.000Z");

describe("deploymentIdDesde", () => {
  it("NEXT_DEPLOYMENT_ID manda sobre cualquier commit", () => {
    expect(
      deploymentIdDesde(
        { NEXT_DEPLOYMENT_ID: "prueba123", SOURCE_COMMIT: "abcdef0123456789" },
        AHORA,
      ),
    ).toBe("prueba123");
  });

  it("sin NEXT_DEPLOYMENT_ID usa el commit recortado a 12 caracteres", () => {
    expect(
      deploymentIdDesde({ SOURCE_COMMIT: "0123456789abcdef0123456789abcdef01234567" }, AHORA),
    ).toBe("0123456789ab");
  });

  it("respeta el orden SOURCE_COMMIT, GIT_COMMIT_SHA, COMMIT_SHA", () => {
    expect(
      deploymentIdDesde(
        { COMMIT_SHA: "ccc", GIT_COMMIT_SHA: "bbb", SOURCE_COMMIT: "aaa" },
        AHORA,
      ),
    ).toBe("aaa");
    expect(deploymentIdDesde({ COMMIT_SHA: "ccc", GIT_COMMIT_SHA: "bbb" }, AHORA)).toBe("bbb");
    expect(deploymentIdDesde({ COMMIT_SHA: "ccc" }, AHORA)).toBe("ccc");
  });

  it("un commit corto no se rellena", () => {
    expect(deploymentIdDesde({ SOURCE_COMMIT: "abc1234" }, AHORA)).toBe("abc1234");
  });

  it("sin nada cae a build-YYYYMMDDHHmmss en UTC", () => {
    expect(deploymentIdDesde({}, AHORA)).toBe("build-20261013080509");
  });

  it("vacío o con espacios cuenta como ausente y pasa a la siguiente fuente", () => {
    expect(
      deploymentIdDesde(
        { NEXT_DEPLOYMENT_ID: "", SOURCE_COMMIT: "   ", GIT_COMMIT_SHA: "bad id", COMMIT_SHA: "ok1" },
        AHORA,
      ),
    ).toBe("ok1");
    expect(deploymentIdDesde({ NEXT_DEPLOYMENT_ID: " " }, AHORA)).toBe("build-20261013080509");
  });

  it("caracteres fuera de [A-Za-z0-9_-] descartan la fuente", () => {
    expect(deploymentIdDesde({ NEXT_DEPLOYMENT_ID: "a/b?c=1" }, AHORA)).toBe(
      "build-20261013080509",
    );
    expect(deploymentIdDesde({ NEXT_DEPLOYMENT_ID: "ok_id-1" }, AHORA)).toBe("ok_id-1");
  });

  it("el recorte se hace antes de validar, y un commit inválido se descarta", () => {
    expect(deploymentIdDesde({ SOURCE_COMMIT: "abcdefghijkl/mnop" }, AHORA)).toBe("abcdefghijkl");
    expect(deploymentIdDesde({ SOURCE_COMMIT: "abc/def" }, AHORA)).toBe("build-20261013080509");
  });
});
