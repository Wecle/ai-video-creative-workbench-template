import { describe, expect, it } from "vitest";
import {
  agentRequestSchema,
  canvasDocumentSchema,
  demoCanvasDocument,
} from "../src";

describe("contracts", () => {
  it("validates the demo canvas", () =>
    expect(canvasDocumentSchema.parse(demoCanvasDocument)).toEqual(
      demoCanvasDocument,
    ));
  it("rejects future document versions", () =>
    expect(
      canvasDocumentSchema.safeParse({
        ...demoCanvasDocument,
        schemaVersion: 2,
      }).success,
    ).toBe(false));
  it("rejects blank agent prompts", () =>
    expect(agentRequestSchema.safeParse({ prompt: "  " }).success).toBe(false));
});
