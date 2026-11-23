import { describe, expect, it } from "vitest";
import { withRetry } from "../src/retry.js";

/** A call failing `failures` times with `error`, then returning "ok". */
function flaky(failures: number, error: Error) {
  let calls = 0;
  const call = () => {
    calls += 1;
    return calls <= failures ? Promise.reject(error) : Promise.resolve("ok");
  };
  return { call, count: () => calls };
}

describe("SRV-10 — nouvelle tentative des appels entre objets", () => {
  it("réessaie une erreur passagère (retryable, ou « Please retry »)", async () => {
    const marked = flaky(2, Object.assign(new Error("overloaded"), { retryable: true }));
    expect(await withRetry(marked.call)).toBe("ok");
    expect(marked.count()).toBe(3);
    const asked = flaky(1, new Error("invalidating this Durable Object. Please retry the call."));
    expect(await withRetry(asked.call)).toBe("ok");
  });

  it("ne réessaie pas une autre erreur, et abandonne après 3 tentatives", async () => {
    const other = flaky(1, new Error("Room already initialized"));
    await expect(withRetry(other.call)).rejects.toThrow("already initialized");
    expect(other.count()).toBe(1);
    const always = flaky(10, Object.assign(new Error("down"), { retryable: true }));
    await expect(withRetry(always.call)).rejects.toThrow("down");
    expect(always.count()).toBe(3);
  });
});
