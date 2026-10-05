import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  addNode,
  connect,
  createHistory,
  moveNodes,
  readSnapshot,
  type CanvasDoc,
} from "@creative/canvas-doc";
import { buildDemoDoc } from "@creative/canvas-doc/fixtures";
import {
  createRegistry,
  defineNode,
  nodeDefinitions,
} from "@creative/node-registry";
import { createCanvasStore } from "./store";

const transformNode = defineNode({
  type: "text.transform",
  version: 1,
  inputs: [{ id: "in", type: "text" }],
  outputs: [{ id: "out", type: "text" }],
  config: z.strictObject({}),
});
const registry = createRegistry([...nodeDefinitions, transformNode]);

function setup(doc: CanvasDoc = buildDemoDoc()) {
  const history = createHistory(doc, { captureTimeout: 0, registry });
  let n = 0;
  const store = createCanvasStore({
    doc,
    registry,
    history,
    createId: () => `new-${++n}`,
  });
  const updates = { count: 0 };
  doc.on("update", () => updates.count++);
  const position = (id: string) =>
    store.getState().nodes.find((node) => node.id === id)!.position;
  const docPosition = (id: string) =>
    readSnapshot(doc).nodes.find((node) => node.id === id)!.position;
  return { doc, history, store, updates, position, docPosition };
}
const drag = (id: string, x: number, y = 0, dragging = true) =>
  ({ type: "position", id, position: { x, y }, dragging }) as const;

describe("canvas store", () => {
  it("derives nodes and edges from the document", () => {
    const { store } = setup();
    const { nodes, edges } = store.getState();
    expect(nodes.map((n) => [n.id, n.type])).toEqual([
      ["image-1", "image.generate"],
      ["text-1", "text"],
    ]);
    expect(nodes[1]!.data).toEqual({
      title: "Creative brief",
      version: 1,
      config: { text: "A calm morning in a seaside town" },
    });
    expect(edges).toEqual([
      {
        id: "text-1:text->image-1:prompt",
        source: "text-1",
        sourceHandle: "text",
        target: "image-1",
        targetHandle: "prompt",
      },
    ]);
    expect(store.getState().runtime).toEqual({});
    expect(store.getState().saveStatus).toBe("saved");
  });

  it("keeps two stores independent", () => {
    const a = setup();
    const b = setup();
    a.store.getState().addNode("text");
    a.store.getState().select("text-1");
    expect(a.store.getState().nodes).toHaveLength(3);
    expect(b.store.getState().nodes).toHaveLength(2);
    expect(b.store.getState().selectedId).toBeNull();
    expect(readSnapshot(b.doc).nodes).toHaveLength(2);
  });

  describe("dragging", () => {
    it("writes nothing to the document during a drag, and exactly once on commit", () => {
      const { store, updates, position, docPosition, history } = setup();
      for (let i = 1; i <= 100; i++)
        store.getState().onNodesChange([drag("text-1", 80 + i, 140 + i)]);
      expect(updates.count).toBe(0);
      expect(position("text-1")).toEqual({ x: 180, y: 240 });
      expect(docPosition("text-1")).toEqual({ x: 80, y: 140 });
      expect(store.getState().draggingIds.has("text-1")).toBe(true);
      expect(history.canUndo()).toBe(false);

      store
        .getState()
        .commitPositions([{ id: "text-1", position: { x: 180, y: 240 } }]);
      expect(updates.count).toBe(1);
      expect(docPosition("text-1")).toEqual({ x: 180, y: 240 });
      expect(store.getState().draggingIds.size).toBe(0);

      // One undo step brings it all the way back.
      expect(history.undo()).toBe(true);
      expect(docPosition("text-1")).toEqual({ x: 80, y: 140 });
      expect(position("text-1")).toEqual({ x: 80, y: 140 });
      expect(history.canUndo()).toBe(false);
    });

    it("commits several dragged nodes in one transaction", () => {
      const { store, updates, history } = setup();
      store.getState().commitPositions([
        { id: "text-1", position: { x: 1, y: 1 } },
        { id: "image-1", position: { x: 2, y: 2 } },
      ]);
      expect(updates.count).toBe(1);
      history.undo();
      expect(history.canUndo()).toBe(false);
    });

    it("is idempotent: a drag-end change followed by drag stop writes once", () => {
      const { store, updates } = setup();
      store.getState().onNodesChange([drag("text-1", 300, 300, true)]);
      // React Flow reports the end of the drag, then onNodeDragStop fires.
      store.getState().onNodesChange([drag("text-1", 300, 300, false)]);
      store
        .getState()
        .commitPositions([{ id: "text-1", position: { x: 300, y: 300 } }]);
      expect(updates.count).toBe(1);
    });

    it("commits keyboard moves (position change without dragging)", () => {
      const { store, updates, docPosition } = setup();
      store.getState().onNodesChange([drag("text-1", 90, 140, false)]);
      expect(updates.count).toBe(1);
      expect(docPosition("text-1")).toEqual({ x: 90, y: 140 });
    });

    it("ignores unknown ids when committing", () => {
      const { store, updates } = setup();
      store
        .getState()
        .commitPositions([{ id: "ghost", position: { x: 1, y: 1 } }]);
      expect(updates.count).toBe(0);
    });

    it("selection and measurements stay local", () => {
      const { store, updates } = setup();
      store.getState().onNodesChange([
        { type: "select", id: "text-1", selected: true },
        {
          type: "dimensions",
          id: "text-1",
          dimensions: { width: 200, height: 80 },
        },
      ]);
      expect(updates.count).toBe(0);
      expect(store.getState().selectedId).toBe("text-1");
      expect(store.getState().nodes[1]!.measured).toEqual({
        width: 200,
        height: 80,
      });
    });
  });

  describe("other writers", () => {
    it("reflects agent transactions without touching the user's undo history", () => {
      const { store, doc, history } = setup();
      addNode(
        doc,
        "agent",
        { id: "agent-1", type: "text", position: { x: 0, y: 0 } },
        registry,
      );
      expect(store.getState().nodes.map((n) => n.id)).toContain("agent-1");
      expect(store.getState().canUndo).toBe(false);
      expect(history.canUndo()).toBe(false);
    });

    it("does not overwrite the local position of a node being dragged", () => {
      const { store, doc, position } = setup();
      store.getState().onNodesChange([drag("text-1", 500, 500)]);
      moveNodes(doc, "agent", [
        { id: "text-1", position: { x: 10, y: 10 } },
        { id: "image-1", position: { x: 20, y: 20 } },
      ]);
      expect(position("text-1")).toEqual({ x: 500, y: 500 });
      expect(position("image-1")).toEqual({ x: 20, y: 20 });
      store
        .getState()
        .commitPositions([{ id: "text-1", position: { x: 500, y: 500 } }]);
      expect(position("text-1")).toEqual({ x: 500, y: 500 });
    });

    it("keeps object identity of nodes that did not change", () => {
      const { store, doc } = setup();
      const before = store.getState().nodes;
      moveNodes(doc, "agent", [{ id: "image-1", position: { x: 1, y: 1 } }]);
      const after = store.getState().nodes;
      expect(after[0]).not.toBe(before[0]);
      expect(after[1]).toBe(before[1]);
      expect(store.getState().edges).toBe(store.getState().edges);
    });
  });

  describe("connections", () => {
    function withTransforms() {
      const doc = buildDemoDoc();
      for (const id of ["a", "b"])
        addNode(
          doc,
          "agent",
          { id, type: "text.transform", position: { x: 0, y: 0 } },
          registry,
        );
      connect(
        doc,
        "agent",
        { source: "a", sourceHandle: "out", target: "b", targetHandle: "in" },
        registry,
      );
      return setup(doc);
    }
    const cases = [
      [
        "valid",
        {
          source: "text-1",
          sourceHandle: "text",
          target: "a",
          targetHandle: "in",
        },
      ],
      [
        "valid, other direction",
        {
          source: "b",
          sourceHandle: "out",
          target: "image-1",
          targetHandle: "prompt",
        },
      ],
      [
        "port type mismatch",
        {
          source: "image-1",
          sourceHandle: "image",
          target: "a",
          targetHandle: "in",
        },
      ],
      [
        "unknown port",
        { source: "a", sourceHandle: "nope", target: "b", targetHandle: "in" },
      ],
      [
        "missing handle",
        { source: "a", sourceHandle: null, target: "b", targetHandle: "in" },
      ],
      [
        "self loop",
        { source: "a", sourceHandle: "out", target: "a", targetHandle: "in" },
      ],
      [
        "duplicate",
        { source: "a", sourceHandle: "out", target: "b", targetHandle: "in" },
      ],
      [
        "cycle",
        { source: "b", sourceHandle: "out", target: "a", targetHandle: "in" },
      ],
      [
        "unknown node",
        {
          source: "a",
          sourceHandle: "out",
          target: "ghost",
          targetHandle: "in",
        },
      ],
    ] as const;

    it.each(cases)(
      "isValidConnection agrees with onConnect: %s",
      (_name, connection) => {
        const { store } = withTransforms();
        const edgesBefore = store.getState().edges.length;
        const valid = store.getState().isValidConnection(connection);
        store.getState().onConnect(connection);
        const added = store.getState().edges.length - edgesBefore;
        expect(added).toBe(valid ? 1 : 0);
        expect(store.getState().notice === null).toBe(valid);
      },
    );

    it("reports why a connection was refused", () => {
      const { store } = withTransforms();
      store.getState().onConnect({
        source: "b",
        sourceHandle: "out",
        target: "a",
        targetHandle: "in",
      });
      expect(store.getState().notice).toEqual({
        kind: "connection",
        code: "cycle",
      });
      store.getState().dismissNotice();
      expect(store.getState().notice).toBeNull();
    });
  });

  describe("editing", () => {
    it("adds, renames and configures nodes as user operations", () => {
      const { store, doc } = setup();
      const added = store
        .getState()
        .addNode("image.generate", { title: "Visual" });
      expect(added).toEqual({ ok: true, value: { id: "new-1" } });
      expect(store.getState().selectedId).toBe("new-1");
      expect(store.getState().renameNode("new-1", "Hero").ok).toBe(true);
      expect(
        store.getState().updateConfig("new-1", { aspectRatio: "9:16" }).ok,
      ).toBe(true);
      expect(
        store.getState().updateConfig("new-1", { aspectRatio: "4:3" }),
      ).toEqual({
        ok: false,
        code: "invalid-config",
      });
      expect(store.getState().renameNode("new-1", "  ")).toEqual({
        ok: false,
        code: "invalid-title",
      });
      expect(store.getState().addNode("nope").ok).toBe(false);
      const node = readSnapshot(doc).nodes.find((n) => n.id === "new-1")!;
      expect(node).toMatchObject({
        title: "Hero",
        config: { aspectRatio: "9:16" },
      });
      expect(
        store.getState().nodes.find((n) => n.id === "new-1")!.data.title,
      ).toBe("Hero");
    });

    it("removing a node removes its edges in one transaction and clears the selection", () => {
      const { store, updates } = setup();
      store.getState().select("image-1");
      store.getState().onNodesChange([{ type: "remove", id: "image-1" }]);
      expect(updates.count).toBe(1);
      expect(store.getState().nodes.map((n) => n.id)).toEqual(["text-1"]);
      expect(store.getState().edges).toEqual([]);
      expect(store.getState().selectedId).toBeNull();
    });

    it("removes edges", () => {
      const { store } = setup();
      store
        .getState()
        .onEdgesChange([{ type: "remove", id: "text-1:text->image-1:prompt" }]);
      expect(store.getState().edges).toEqual([]);
    });

    it("tracks undo and redo availability", () => {
      const { store, history } = setup();
      expect(store.getState()).toMatchObject({
        canUndo: false,
        canRedo: false,
      });
      store.getState().addNode("text");
      expect(store.getState()).toMatchObject({ canUndo: true, canRedo: false });
      store.getState().undo();
      expect(store.getState().nodes).toHaveLength(2);
      expect(store.getState()).toMatchObject({ canUndo: false, canRedo: true });
      store.getState().redo();
      expect(store.getState().nodes).toHaveLength(3);
      expect(store.getState()).toMatchObject({ canUndo: true, canRedo: false });
      expect(history.canUndo()).toBe(true);
    });

    it("undoing the user's node leaves an agent's edge repaired away", () => {
      const doc = buildDemoDoc();
      const { store } = setup(doc);
      store.getState().addNode("image.generate");
      const id = store.getState().selectedId!;
      connect(
        doc,
        "agent",
        {
          source: "text-1",
          sourceHandle: "text",
          target: id,
          targetHandle: "prompt",
        },
        registry,
      );
      expect(store.getState().edges).toHaveLength(2);
      store.getState().undo();
      expect(store.getState().nodes.map((n) => n.id)).not.toContain(id);
      expect(store.getState().edges).toHaveLength(1);
    });

    it("exports a snapshot without runtime state", () => {
      const { store } = setup();
      const json = JSON.stringify(store.getState().exportSnapshot());
      expect(json).not.toMatch(/"status"|"viewport"/);
    });

    it("destroy stops listening to the document", () => {
      const { store, doc } = setup();
      store.getState().destroy();
      addNode(
        doc,
        "agent",
        { id: "late", type: "text", position: { x: 0, y: 0 } },
        registry,
      );
      expect(store.getState().nodes.map((n) => n.id)).not.toContain("late");
    });
  });
});
