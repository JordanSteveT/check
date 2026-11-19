import { describe, expect, it } from "vitest";
import { describeClient } from "../src/index.js";

describe("web app", () => {
  it("SET-04 — resolves the engine package", () => {
    expect(describeClient()).toBe("web client using engine 0.0.0");
  });
});
