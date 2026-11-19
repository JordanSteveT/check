import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../src/index.js";

describe("protocol package", () => {
  it("SET-04 — protocol version is 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
