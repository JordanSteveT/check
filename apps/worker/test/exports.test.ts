import { describe, expect, it } from "vitest";
import * as entry from "../src/index.js";

describe("SRV-02 — module d'entrée du Worker", () => {
  it("n'exporte que le gestionnaire par défaut et des classes (exigence de workerd)", () => {
    // workerd refuses to start if the entry module exports anything else (e.g. a constant).
    for (const [name, value] of Object.entries(entry)) {
      const ok =
        typeof value === "function" ||
        (name === "default" && typeof (value as { fetch?: unknown }).fetch === "function");
      expect({ name, ok }).toEqual({ name, ok: true });
    }
    expect(Object.keys(entry).sort()).toEqual(["LobbyDO", "RoomDO", "UserDO", "default"]);
  });
});
