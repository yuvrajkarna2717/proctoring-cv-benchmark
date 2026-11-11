import { describe, expect, it } from "vitest";
import { createSerialQueue } from "../../src/utils/serialQueue.js";
import { deferred } from "../helpers/fakes.js";

describe("createSerialQueue", () => {
  it("starts each task after the previous one settles, in call order", async () => {
    const enqueue = createSerialQueue();
    const events = [];
    const first = deferred();
    const a = enqueue(async () => {
      events.push("a start");
      await first.promise;
      events.push("a end");
      return "a";
    });
    const b = enqueue(() => {
      events.push("b");
      return "b";
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["a start"]);
    first.resolve();
    await expect(Promise.all([a, b])).resolves.toEqual(["a", "b"]);
    expect(events).toEqual(["a start", "a end", "b"]);
  });

  it("passes a failure to its caller and keeps running later tasks", async () => {
    const enqueue = createSerialQueue();
    const failed = enqueue(async () => {
      throw new Error("boom");
    });
    const next = enqueue(() => 42);
    await expect(failed).rejects.toThrow("boom");
    await expect(next).resolves.toBe(42);
  });
});
