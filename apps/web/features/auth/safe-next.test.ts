import { describe, expect, it } from "vitest";
import { safeNext } from "./safe-next";

describe("safeNext", () => {
  it.each(["/", "/projects", "/projects/1?tab=a#x", "/a/b%20c"])(
    "keeps the same-origin path %s",
    (value) => expect(safeNext(value)).toBe(value),
  );

  it.each([
    "https://evil.example",
    "http://evil.example/x",
    "//evil.example",
    "///evil.example",
    "/\\evil.example",
    "\\\\evil.example",
    "/%0d%0a" + "\r\n//evil.example",
    "/\t/evil.example",
    "javascript:alert(1)",
    "evil.example",
    "",
    "login",
  ])("falls back to / for %j", (value) => expect(safeNext(value)).toBe("/"));

  it.each([undefined, null, 42, ["/a"], {}])(
    "falls back to / for non-strings (%j)",
    (value) => expect(safeNext(value)).toBe("/"),
  );

  it.each(["/login", "/login?next=/", "/signup", "/login/x"])(
    "does not send the user back to %s",
    (value) => expect(safeNext(value)).toBe("/"),
  );

  it("rejects absurdly long values", () =>
    expect(safeNext("/" + "a".repeat(3000))).toBe("/"));
});
