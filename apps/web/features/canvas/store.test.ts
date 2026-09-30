import { describe, expect, it } from "vitest";
import { createCanvasStore, exportDocument } from "./store";
import { canvasDocumentSchema, demoCanvasDocument } from "@creative/contracts";

describe("canvas state", () => {
  it("exports a faithful initial document snapshot", () => {
    const store = createCanvasStore();
    const document = exportDocument(demoCanvasDocument.viewport, store);
    expect(canvasDocumentSchema.parse(document)).toEqual(demoCanvasDocument);
  });
  it("moves and renames nodes", () => {
    const store = createCanvasStore();
    store
      .getState()
      .onNodesChange([
        { type: "position", id: "text-1", position: { x: 20, y: 30 } },
      ]);
    store.getState().rename("text-1", "Updated");
    expect(store.getState().nodes[0]).toMatchObject({
      position: { x: 20, y: 30 },
      data: { title: "Updated" },
    });
  });
  it("connects nodes without self-edges", () => {
    const store = createCanvasStore();
    store.getState().onConnect({
      source: "text-1",
      target: "video-1",
      sourceHandle: null,
      targetHandle: null,
    });
    store.getState().onConnect({
      source: "text-1",
      target: "text-1",
      sourceHandle: null,
      targetHandle: null,
    });
    expect(store.getState().edges).toHaveLength(3);
  });
  it("removes dangling edges and selection", () => {
    const store = createCanvasStore();
    store.getState().select("image-1");
    store.getState().onNodesChange([{ type: "remove", id: "image-1" }]);
    expect(store.getState().edges).toHaveLength(0);
    expect(store.getState().selectedId).toBeNull();
  });
});
