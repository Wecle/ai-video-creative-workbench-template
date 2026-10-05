import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  canConnect,
  createRegistry,
  defaultConfig,
  defineNode,
  imageGenerateNode,
  nodeDefinitions,
  registry,
  textNode,
  toJsonSchemas,
} from "../src";
import committed from "../schemas/nodes.json";

describe("example nodes", () => {
  it("every default config parses from {}", () => {
    for (const def of registry.list())
      expect(() => def.config.parse({}), def.type).not.toThrow();
    expect(defaultConfig(textNode)).toEqual({ text: "" });
    expect(defaultConfig(imageGenerateNode)).toEqual({
      prompt: "",
      aspectRatio: "1:1",
    });
  });
  it("rejects invalid config", () => {
    expect(textNode.config.safeParse({ text: 1 }).success).toBe(false);
    expect(textNode.config.safeParse({ text: "x".repeat(20001) }).success).toBe(
      false,
    );
    expect(
      imageGenerateNode.config.safeParse({ aspectRatio: "4:3" }).success,
    ).toBe(false);
    expect(textNode.config.safeParse({ unknown: true }).success).toBe(false);
  });
  it("estimates cost", () => {
    expect(
      imageGenerateNode.estimateCost!({ prompt: "", aspectRatio: "1:1" }),
    ).toEqual({ credits: 4 });
    expect(textNode.estimateCost).toBeUndefined();
  });
  it("exposes typed ports", () => {
    expect(textNode.inputs).toEqual([]);
    expect(textNode.outputs).toEqual([{ id: "text", type: "text" }]);
    expect(imageGenerateNode.inputs).toEqual([{ id: "prompt", type: "text" }]);
  });
});

describe("registry", () => {
  it("looks up by type, defaulting to the latest version", () => {
    const v2 = defineNode({
      type: "text",
      version: 2,
      inputs: [],
      outputs: [{ id: "text", type: "text" }],
      config: z.strictObject({ body: z.string().default("") }),
    });
    const reg = createRegistry([v2, textNode, imageGenerateNode]);
    expect(reg.get("text")?.version).toBe(2);
    expect(reg.get("text", 1)).toBe(textNode);
    expect(reg.get("text", 3)).toBeUndefined();
    expect(reg.get("nope")).toBeUndefined();
    expect(reg.list().map((d) => `${d.type}@${d.version}`)).toEqual([
      "image.generate@1",
      "text@1",
      "text@2",
    ]);
    expect(reg.latest().map((d) => `${d.type}@${d.version}`)).toEqual([
      "image.generate@1",
      "text@2",
    ]);
  });
  it("throws on duplicate (type, version)", () => {
    expect(() => createRegistry([textNode, textNode])).toThrow(/Duplicate/);
  });
  it("throws on a non-positive version", () => {
    expect(() => createRegistry([{ ...textNode, version: 0 }])).toThrow(
      /version/,
    );
  });
  it("exports every example node in the default registry", () => {
    expect(registry.list()).toHaveLength(nodeDefinitions.length);
  });
});

describe("canConnect", () => {
  it("only allows identical port types", () => {
    expect(canConnect("text", "text")).toBe(true);
    expect(canConnect("image", "image")).toBe(true);
    expect(canConnect("text", "image")).toBe(false);
    expect(canConnect("image", "video")).toBe(false);
  });
});

describe("json schema", () => {
  it("converts every config", () => {
    const schemas = toJsonSchemas(registry);
    expect(Object.keys(schemas)).toEqual(["image.generate@1", "text@1"]);
    for (const schema of Object.values(schemas))
      expect(schema.config).toMatchObject({ type: "object" });
  });
  it("matches the committed schemas/nodes.json (run `pnpm --filter @creative/node-registry generate`)", () => {
    expect(JSON.parse(JSON.stringify(toJsonSchemas(registry)))).toEqual(
      committed,
    );
  });
});
