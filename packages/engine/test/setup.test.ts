import { describe, expect, it } from "vitest";
import { ENGINE_VERSION } from "../src/index.js";

describe("engine package", () => {
  it("SET-04 — the package is importable", () => {
    expect(ENGINE_VERSION).toBe("0.0.0");
  });
});
