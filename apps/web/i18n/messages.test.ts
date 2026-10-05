import { describe, expect, it } from "vitest";
import {
  englishMessages,
  flatten,
  getMessages,
  localeCatalog,
} from "./messages";
import { createTranslator, interpolate } from "./translate";

const placeholders = (text: string) =>
  [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("message catalogs", () => {
  it("zh-CN only contains keys that exist in English, with the same placeholders", () => {
    const zh = localeCatalog("zh-CN");
    expect(Object.keys(zh).length).toBeGreaterThanOrEqual(15);
    for (const [key, text] of Object.entries(zh)) {
      expect(englishMessages, key).toHaveProperty([key]);
      expect(placeholders(text), key).toEqual(
        placeholders(englishMessages[key]!),
      );
    }
  });
  it("falls back to English for keys a locale does not translate", () => {
    const zh = getMessages("zh-CN");
    expect(Object.keys(zh).sort()).toEqual(Object.keys(englishMessages).sort());
    expect(zh["auth.login.submit"]).toBe("登录");
    expect(zh["auth.signup.title"]).toBe(englishMessages["auth.signup.title"]);
    expect(getMessages("en")).toEqual(englishMessages);
  });
  it("flattens keys that contain dots without ambiguity", () => {
    expect(flatten({ nodes: { "image.generate": { title: "x" } } })).toEqual({
      "nodes.image.generate.title": "x",
    });
    expect(englishMessages["nodes.image.generate.title"]).toBeDefined();
  });
});

describe("translator", () => {
  it("interpolates placeholders", () => {
    expect(interpolate("Add {name} ({n})", { name: "Text", n: 2 })).toBe(
      "Add Text (2)",
    );
    expect(interpolate("Hi {who}", {})).toBe("Hi {who}");
    expect(interpolate("plain")).toBe("plain");
  });
  it("returns the key for a message missing from the catalog", () => {
    const t = createTranslator({ "common.appName": "App" });
    expect(t("common.appName")).toBe("App");
    expect(t("projects.title")).toBe("projects.title");
  });
  it("translates with the merged catalog", () => {
    const t = createTranslator(getMessages("zh-CN"));
    expect(t("canvas.add", { name: "Text" })).toBe("Add Text");
    expect(t("projects.title")).toBe("项目");
  });
});
