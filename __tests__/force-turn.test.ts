import { describe, expect, it } from "vitest";
import { readForceTurn } from "@/lib/roomLink";

describe("readForceTurn", () => {
  it("true only for forceTurn=1", () => {
    expect(readForceTurn("?forceTurn=1")).toBe(true);
    expect(readForceTurn("?other=x&forceTurn=1")).toBe(true);
  });

  it("false otherwise", () => {
    expect(readForceTurn("")).toBe(false);
    expect(readForceTurn("?forceTurn=0")).toBe(false);
    expect(readForceTurn("?forceturn=1")).toBe(false); // exact, case-sensitive
  });
});
