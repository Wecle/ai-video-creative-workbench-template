import { describe, expect, it } from "vitest";
import { resolveLocale } from "./resolve";

describe("resolveLocale", () => {
  it("prefers a valid cookie over Accept-Language", () => {
    expect(resolveLocale("zh-CN", "en-US,en;q=0.9")).toBe("zh-CN");
    expect(resolveLocale("en", "zh-CN,zh;q=0.9")).toBe("en");
  });
  it("ignores unknown cookie values", () => {
    expect(resolveLocale("fr", "zh-CN")).toBe("zh-CN");
    expect(resolveLocale("", null)).toBe("en");
    expect(resolveLocale("zh", null)).toBe("en");
  });
  it("maps Accept-Language tags", () => {
    expect(resolveLocale(undefined, "zh-CN")).toBe("zh-CN");
    expect(resolveLocale(undefined, "zh")).toBe("zh-CN");
    expect(resolveLocale(undefined, "zh-TW")).toBe("zh-CN");
    expect(resolveLocale(undefined, "zh-Hans-CN")).toBe("zh-CN");
    expect(resolveLocale(undefined, "en-US")).toBe("en");
    expect(resolveLocale(undefined, "EN")).toBe("en");
  });
  it("takes the first matching entry, honoring q values", () => {
    expect(resolveLocale(undefined, "fr-FR,zh-CN;q=0.8,en;q=0.5")).toBe(
      "zh-CN",
    );
    expect(resolveLocale(undefined, "en;q=0.4,zh-CN;q=0.9")).toBe("zh-CN");
    expect(resolveLocale(undefined, "en-US,zh-CN")).toBe("en");
    expect(resolveLocale(undefined, "zh-CN;q=0,en")).toBe("en");
  });
  it("falls back to English", () => {
    expect(resolveLocale(undefined, null)).toBe("en");
    expect(resolveLocale(undefined, "")).toBe("en");
    expect(resolveLocale(undefined, "fr-FR,de;q=0.8")).toBe("en");
    expect(resolveLocale(undefined, "*")).toBe("en");
  });
});
