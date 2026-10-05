import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import {
  addNode,
  connect,
  createCanvasDoc,
  createHistory,
  encodeState,
  loadCanvasDoc,
  moveNodes,
  readGraph,
  readSnapshot,
  repairDocument,
  validateSnapshot,
  type CanvasDoc,
} from "../src";
import { at, testRegistry } from "./helpers";

const ids = (doc: CanvasDoc) =>
  readGraph(doc)
    .nodes.map((n) => n.id)
    .sort();
const options = { captureTimeout: 0, registry: testRegistry };

describe("history", () => {
  it("undoes and redoes the user's operations", () => {
    const doc = createCanvasDoc();
    const history = createHistory(doc, options);
    expect(history.canUndo()).toBe(false);
    addNode(doc, "user", { id: "a", type: "text", position: at() });
    addNode(doc, "user", { id: "b", type: "text", position: at() });
    expect(history.canUndo()).toBe(true);
    expect(history.undo()).toBe(true);
    expect(ids(doc)).toEqual(["a"]);
    expect(history.canRedo()).toBe(true);
    expect(history.redo()).toBe(true);
    expect(ids(doc)).toEqual(["a", "b"]);
    expect(history.undo() && history.undo()).toBe(true);
    expect(ids(doc)).toEqual([]);
    expect(history.undo()).toBe(false);
    history.destroy();
  });

  it("notifies subscribers when the stacks change", () => {
    const doc = createCanvasDoc();
    const history = createHistory(doc, options);
    let calls = 0;
    const off = history.subscribe(() => calls++);
    addNode(doc, "user", { id: "a", type: "text", position: at() });
    history.undo();
    expect(calls).toBeGreaterThanOrEqual(2);
    off();
    const before = calls;
    history.redo();
    expect(calls).toBe(before);
  });

  it("never undoes agent operations", () => {
    const doc = createCanvasDoc();
    const history = createHistory(doc, options);
    addNode(doc, "user", { id: "mine", type: "text", position: at() });
    addNode(doc, "agent", { id: "theirs", type: "text", position: at() });
    moveNodes(doc, "agent", [{ id: "theirs", position: at(50, 50) }]);
    expect(history.undo()).toBe(true);
    expect(ids(doc)).toEqual(["theirs"]);
    expect(readSnapshot(doc).nodes[0]!.position).toEqual({ x: 50, y: 50 });
    // The agent's work alone leaves nothing to undo.
    expect(history.undo()).toBe(false);
    expect(ids(doc)).toEqual(["theirs"]);
  });

  it("merges quick edits into one step and stopCapturing splits them", () => {
    const doc = createCanvasDoc();
    const history = createHistory(doc, { ...options, captureTimeout: 60_000 });
    addNode(doc, "user", { id: "a", type: "text", position: at() });
    addNode(doc, "user", { id: "b", type: "text", position: at() });
    history.stopCapturing();
    addNode(doc, "user", { id: "c", type: "text", position: at() });
    history.undo();
    expect(ids(doc)).toEqual(["a", "b"]);
    history.undo();
    expect(ids(doc)).toEqual([]);
  });

  it("repairs an agent's edge left dangling by undoing the user's node", () => {
    const doc = createCanvasDoc();
    const history = createHistory(doc, options);
    addNode(doc, "user", { id: "img", type: "image.generate", position: at() });
    addNode(doc, "agent", { id: "txt", type: "text", position: at() });
    expect(
      connect(doc, "agent", {
        source: "txt",
        sourceHandle: "text",
        target: "img",
        targetHandle: "prompt",
      }).ok,
    ).toBe(true);
    expect(readGraph(doc).edges).toHaveLength(1);

    history.undo();
    expect(ids(doc)).toEqual(["txt"]);
    expect(readGraph(doc).edges).toEqual([]);
    expect(validateSnapshot(readSnapshot(doc), testRegistry)).toEqual([]);

    // Documented limit: a repaired-away edge is not restored by redo.
    history.redo();
    expect(ids(doc)).toEqual(["img", "txt"]);
    expect(readGraph(doc).edges).toEqual([]);
    expect(validateSnapshot(readSnapshot(doc), testRegistry)).toEqual([]);
  });
});

describe("repairDocument", () => {
  it("is a no-op on a valid document", () => {
    const doc = createCanvasDoc();
    addNode(doc, "user", { id: "t", type: "text", position: at() });
    addNode(doc, "user", { id: "i", type: "image.generate", position: at() });
    connect(doc, "user", {
      source: "t",
      sourceHandle: "text",
      target: "i",
      targetHandle: "prompt",
    });
    let updates = 0;
    doc.on("update", () => updates++);
    expect(repairDocument(doc, testRegistry)).toBe(0);
    expect(updates).toBe(0);
  });

  it("removes a cycle created by two replicas editing concurrently, identically on both", () => {
    const base = createCanvasDoc();
    for (const id of ["a", "b"])
      addNode(
        base,
        "agent",
        { id, type: "text.transform", position: at() },
        testRegistry,
      );
    const a = loadCanvasDoc(encodeState(base));
    const b = loadCanvasDoc(encodeState(base));
    connect(
      a,
      "user",
      { source: "a", sourceHandle: "out", target: "b", targetHandle: "in" },
      testRegistry,
    );
    connect(
      b,
      "user",
      { source: "b", sourceHandle: "out", target: "a", targetHandle: "in" },
      testRegistry,
    );
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b), "remote");
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a), "remote");
    for (const doc of [a, b]) {
      expect(readGraph(doc).edges).toHaveLength(2);
      expect(
        validateSnapshot(readSnapshot(doc), testRegistry).map((i) => i.code),
      ).toEqual(["cycle"]);
    }
    expect(repairDocument(a, testRegistry)).toBe(1);
    expect(repairDocument(b, testRegistry)).toBe(1);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b), "remote");
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a), "remote");
    expect(readSnapshot(a)).toEqual(readSnapshot(b));
    expect(readSnapshot(a).edges.map((e) => e.id)).toEqual(["a:out->b:in"]);
    expect(validateSnapshot(readSnapshot(a), testRegistry)).toEqual([]);
  });
});
