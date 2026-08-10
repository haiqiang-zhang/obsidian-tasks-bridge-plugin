import { describe, expect, it } from "vitest";

import { Maybe } from "./maybe";

describe("Maybe", () => {
  it("clears an installed value and can be reused", () => {
    const maybe = Maybe.Some("old-account");

    maybe.clear();

    expect(maybe.hasValue()).toBe(false);
    expect(() => maybe.inner()).toThrow("tried to access inner value of empty Maybe");

    maybe.insert("new-account");
    expect(maybe.inner()).toBe("new-account");
  });
});
