import { describe, expect, it } from "vitest";
import { describeServer } from "../src/index.js";

describe("worker app", () => {
  it("SET-04 — resolves workspace packages", () => {
    expect(describeServer()).toBe("engine 0.0.0, protocol v1");
  });
});
