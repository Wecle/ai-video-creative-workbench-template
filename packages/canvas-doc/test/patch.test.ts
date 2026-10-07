import { describe, expect, it } from "vitest";
import type { CanvasPatch } from "@creative/contracts";
import {
  applyPatch,
  createCanvasDoc,
  createHistory,
  docFromSnapshot,
  encodeState,
  nodesOf,
  readSnapshot,
} from "../src";
import { addNode, connect } from "../src/ops";
import { testRegistry } from "./helpers";

describe("applyPatch", () => {
  it("applies addNode, updateConfig and connect successfully in a single transaction", () => {
    const doc = createCanvasDoc();
    let updateCount = 0;
    let lastOrigin: unknown = null;
    doc.on("update", (_update, origin) => {
      updateCount++;
      lastOrigin = origin;
    });

    const patch: CanvasPatch = {
      summary: "Add two nodes and connect them",
      ops: [
        {
          op: "addNode",
          id: "t1",
          type: "text",
          position: { x: 0, y: 0 },
          config: { text: "hello" },
        },
        {
          op: "addNode",
          id: "img1",
          type: "image.generate",
          position: { x: 300, y: 100 },
          config: { prompt: "", aspectRatio: "16:9" },
        },
        {
          op: "updateConfig",
          id: "t1",
          patch: { text: "updated text" },
        },
        {
          op: "connect",
          source: "t1",
          sourceHandle: "text",
          target: "img1",
          targetHandle: "prompt",
        },
      ],
    };

    const res = applyPatch(doc, "agent", patch);
    expect(res).toEqual({ ok: true });

    // Single transaction and agent origin
    expect(updateCount).toBe(1);
    expect(lastOrigin).toBe("agent");

    const snapshot = readSnapshot(doc);
    expect(snapshot.nodes).toHaveLength(2);
    expect(snapshot.edges).toHaveLength(1);
    const t1 = snapshot.nodes.find((n) => n.id === "t1");
    expect(t1?.config).toEqual({ text: "updated text" });
  });

  it("leaves document byte-for-byte identical when operation N is invalid", () => {
    const doc = createCanvasDoc();
    addNode(doc, "user", {
      id: "existing-1",
      type: "text",
      position: { x: 0, y: 0 },
      config: { text: "initial" },
    });

    const beforeState = encodeState(doc);

    // 1. Duplicate node ID
    const dupPatch: CanvasPatch = {
      summary: "Add duplicate node",
      ops: [
        {
          op: "addNode",
          id: "node-2",
          type: "text",
          position: { x: 10, y: 10 },
        },
        {
          op: "addNode",
          id: "existing-1", // duplicate
          type: "text",
          position: { x: 20, y: 20 },
        },
      ],
    };
    const resDup = applyPatch(doc, "agent", dupPatch);
    expect(resDup.ok).toBe(false);
    expect(encodeState(doc)).toEqual(beforeState);

    // 2. Unknown node type
    const unknownTypePatch: CanvasPatch = {
      summary: "Add unknown node type",
      ops: [
        {
          op: "addNode",
          id: "node-unknown",
          type: "not.real.type",
          position: { x: 10, y: 10 },
        },
      ],
    };
    const resType = applyPatch(doc, "agent", unknownTypePatch);
    expect(resType.ok).toBe(false);
    expect(encodeState(doc)).toEqual(beforeState);

    // 3. Invalid config
    const badConfigPatch: CanvasPatch = {
      summary: "Invalid config",
      ops: [
        {
          op: "updateConfig",
          id: "existing-1",
          patch: { text: 12345 }, // text expects string
        },
      ],
    };
    const resConfig = applyPatch(doc, "agent", badConfigPatch);
    expect(resConfig.ok).toBe(false);
    expect(encodeState(doc)).toEqual(beforeState);

    // 4. True cycle creation using testRegistry
    addNode(
      doc,
      "user",
      { id: "trans-1", type: "text.transform", position: { x: 0, y: 0 } },
      testRegistry,
    );
    addNode(
      doc,
      "user",
      { id: "trans-2", type: "text.transform", position: { x: 100, y: 0 } },
      testRegistry,
    );
    connect(
      doc,
      "user",
      {
        source: "trans-1",
        sourceHandle: "out",
        target: "trans-2",
        targetHandle: "in",
      },
      testRegistry,
    );
    const beforeTrueCycle = encodeState(doc);
    const trueCyclePatch: CanvasPatch = {
      summary: "Create true cycle",
      ops: [
        {
          op: "connect",
          source: "trans-2",
          sourceHandle: "out",
          target: "trans-1",
          targetHandle: "in",
        },
      ],
    };
    const resTrueCycle = applyPatch(doc, "agent", trueCyclePatch, testRegistry);
    expect(resTrueCycle).toEqual({ ok: false, code: "cycle", index: 0 });
    expect(encodeState(doc)).toEqual(beforeTrueCycle);
  });

  it("safely rejects malformed patches and ops without throwing", () => {
    const doc = createCanvasDoc();
    const beforeState = encodeState(doc);

    // Missing position on addNode
    const badOpPatch = {
      summary: "Bad op missing position",
      ops: [{ op: "addNode", id: "n-bad", type: "text" }],
    } as unknown as CanvasPatch;
    const resBadOp = applyPatch(doc, "agent", badOpPatch);
    expect(resBadOp.ok).toBe(false);
    expect(resBadOp.code).toBe("invalid-position");
    expect(resBadOp.index).toBe(0);
    expect(encodeState(doc)).toEqual(beforeState);

    // Unknown op
    const unknownOpPatch = {
      summary: "Unknown op",
      ops: [{ op: "notAnOp", id: "x" }],
    } as unknown as CanvasPatch;
    const resUnknownOp = applyPatch(doc, "agent", unknownOpPatch);
    expect(resUnknownOp.ok).toBe(false);
    expect(resUnknownOp.code).toBe("unknown-op");
    expect(resUnknownOp.index).toBe(0);

    // Invalid patch structure (not an object with ops array)
    const notPatch = null as unknown as CanvasPatch;
    const resNull = applyPatch(doc, "agent", notPatch);
    expect(resNull).toEqual({ ok: false, code: "invalid-patch" });
  });

  it("ensures agent origin patch is not undone by createHistory and preserves user undo stack", () => {
    const doc = createCanvasDoc();
    const history = createHistory(doc);

    // 1. User performs an action
    addNode(doc, "user", {
      id: "user-1",
      type: "text",
      position: { x: 0, y: 0 },
      config: { text: "user created" },
    });
    expect(history.canUndo()).toBe(true);

    // 2. Agent applies patch
    const patch: CanvasPatch = {
      summary: "Agent note",
      ops: [
        {
          op: "addNode",
          id: "agent-1",
          type: "text",
          position: { x: 100, y: 100 },
          config: { text: "agent created" },
        },
      ],
    };
    const res = applyPatch(doc, "agent", patch);
    expect(res.ok).toBe(true);

    // 3. Undo undoes the USER action, not the AGENT action
    expect(history.canUndo()).toBe(true);
    history.undo();

    // user-1 is gone, but agent-1 remains!
    expect(nodesOf(doc).has("user-1")).toBe(false);
    expect(nodesOf(doc).has("agent-1")).toBe(true);
  });

  it("throws TypeError for invalid origin", () => {
    const doc = createCanvasDoc();
    const patch: CanvasPatch = {
      summary: "test",
      ops: [
        {
          op: "addNode",
          id: "n1",
          type: "text",
          position: { x: 0, y: 0 },
        },
      ],
    };
    // @ts-expect-error test invalid origin runtime check
    expect(() => applyPatch(doc, "invalid", patch)).toThrow(TypeError);
  });

  it("docFromSnapshot builds document accurately", () => {
    const snapshot = {
      schemaVersion: 1 as const,
      nodes: [
        {
          id: "s1",
          type: "text",
          version: 1,
          title: "S1",
          position: { x: 50, y: 50 },
          config: { text: "from snapshot" },
        },
      ],
      edges: [],
    };
    const doc = docFromSnapshot(snapshot);
    const read = readSnapshot(doc);
    expect(read.nodes).toHaveLength(1);
    expect(read.nodes[0]?.id).toBe("s1");
    expect(read.nodes[0]?.config).toEqual({ text: "from snapshot" });
  });
});
