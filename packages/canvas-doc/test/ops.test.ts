import { describe, expect, it } from "vitest";
import {
  addNode,
  connect,
  createCanvasDoc,
  moveNodes,
  readGraph,
  readSnapshot,
  removeEdges,
  removeNodes,
  renameNode,
  updateConfig,
  type CanvasDoc,
} from "../src";
import { at, testRegistry } from "./helpers";

const nodeOf = (doc: CanvasDoc, id: string) =>
  readSnapshot(doc).nodes.find((node) => node.id === id)!;

function seeded(): CanvasDoc {
  const doc = createCanvasDoc();
  addNode(doc, "user", { id: "t1", type: "text", position: at() });
  addNode(doc, "user", { id: "i1", type: "image.generate", position: at(300) });
  return doc;
}

describe("operations", () => {
  it("adds nodes with validated, defaulted config", () => {
    const doc = createCanvasDoc();
    expect(
      addNode(doc, "user", {
        id: "i1",
        type: "image.generate",
        title: "  Visual ",
        position: at(1, 2),
        config: { prompt: "a cat" },
      }),
    ).toEqual({ ok: true, value: { id: "i1" } });
    expect(readSnapshot(doc).nodes).toEqual([
      {
        id: "i1",
        type: "image.generate",
        version: 1,
        title: "Visual",
        position: { x: 1, y: 2 },
        config: { prompt: "a cat", aspectRatio: "1:1" },
      },
    ]);
  });

  it("rejects bad input without writing anything", () => {
    const doc = createCanvasDoc();
    const code = (r: { ok: boolean; code?: string }) => (r.ok ? "ok" : r.code);
    expect(
      code(addNode(doc, "user", { id: "a b", type: "text", position: at() })),
    ).toBe("invalid-id");
    expect(
      code(addNode(doc, "user", { id: "a", type: "nope", position: at() })),
    ).toBe("unknown-node-type");
    expect(
      code(
        addNode(doc, "user", {
          id: "a",
          type: "text",
          version: 9,
          position: at(),
        }),
      ),
    ).toBe("unknown-node-type");
    expect(
      code(addNode(doc, "user", { id: "a", type: "text", position: at(NaN) })),
    ).toBe("invalid-position");
    expect(
      code(
        addNode(doc, "user", {
          id: "a",
          type: "text",
          title: "  ",
          position: at(),
        }),
      ),
    ).toBe("invalid-title");
    expect(
      code(
        addNode(doc, "user", {
          id: "a",
          type: "text",
          position: at(),
          config: { text: 5 },
        }),
      ),
    ).toBe("invalid-config");
    expect(
      code(
        addNode(doc, "user", {
          id: "a",
          type: "text",
          position: at(),
          config: { extra: 1 },
        }),
      ),
    ).toBe("invalid-config");
    expect(readSnapshot(doc).nodes).toEqual([]);
    addNode(doc, "user", { id: "a", type: "text", position: at() });
    expect(
      code(addNode(doc, "user", { id: "a", type: "text", position: at() })),
    ).toBe("duplicate-node");
  });

  it("updates config: merged, validated as a whole, only changed fields written", () => {
    const doc = seeded();
    expect(updateConfig(doc, "user", "i1", { prompt: "p" }).ok).toBe(true);
    expect(nodeOf(doc, "i1").config).toEqual({
      prompt: "p",
      aspectRatio: "1:1",
    });
    expect(updateConfig(doc, "user", "i1", { aspectRatio: "4:3" })).toEqual({
      ok: false,
      code: "invalid-config",
    });
    expect(updateConfig(doc, "user", "i1", { nope: 1 })).toEqual({
      ok: false,
      code: "invalid-config",
    });
    expect(updateConfig(doc, "user", "zz", {})).toEqual({
      ok: false,
      code: "unknown-node",
    });
    expect(nodeOf(doc, "i1").config).toEqual({
      prompt: "p",
      aspectRatio: "1:1",
    });
    // An unchanged value produces no transaction at all.
    let updates = 0;
    doc.on("update", () => updates++);
    updateConfig(doc, "user", "i1", { prompt: "p" });
    expect(updates).toBe(0);
  });

  it("renames and moves nodes", () => {
    const doc = seeded();
    expect(renameNode(doc, "user", "t1", "Intro").ok).toBe(true);
    expect(renameNode(doc, "user", "t1", "")).toEqual({
      ok: false,
      code: "invalid-title",
    });
    expect(renameNode(doc, "user", "zz", "x")).toEqual({
      ok: false,
      code: "unknown-node",
    });
    expect(
      moveNodes(doc, "user", [
        { id: "t1", position: at(5, 6) },
        { id: "i1", position: at(7, 8) },
      ]).ok,
    ).toBe(true);
    expect(moveNodes(doc, "user", [{ id: "zz", position: at() }])).toEqual({
      ok: false,
      code: "unknown-node",
    });
    expect(
      moveNodes(doc, "user", [{ id: "t1", position: at(Infinity) }]),
    ).toEqual({ ok: false, code: "invalid-position" });
    const [t1, i1] = readSnapshot(doc)
      .nodes.sort((a, b) => a.id.localeCompare(b.id))
      .reverse();
    expect(i1).toMatchObject({ id: "i1", position: { x: 7, y: 8 } });
    expect(t1).toMatchObject({
      id: "t1",
      title: "Intro",
      position: { x: 5, y: 6 },
    });
  });

  it("moveNodes is a single transaction, and a no-op writes nothing", () => {
    const doc = seeded();
    const updates: number[] = [];
    doc.on("update", () => updates.push(1));
    moveNodes(doc, "user", [
      { id: "t1", position: at(1, 1) },
      { id: "i1", position: at(2, 2) },
    ]);
    expect(updates).toHaveLength(1);
    moveNodes(doc, "user", [{ id: "t1", position: at(1, 1) }]);
    expect(updates).toHaveLength(1);
  });

  it("removes nodes together with their edges in one transaction", () => {
    const doc = seeded();
    expect(
      connect(doc, "user", {
        source: "t1",
        sourceHandle: "text",
        target: "i1",
        targetHandle: "prompt",
      }).ok,
    ).toBe(true);
    const updates: number[] = [];
    doc.on("update", () => updates.push(1));
    expect(removeNodes(doc, "user", ["t1"]).ok).toBe(true);
    expect(updates).toHaveLength(1);
    expect(readGraph(doc).edges).toEqual([]);
    expect(readGraph(doc).nodes.map((n) => n.id)).toEqual(["i1"]);
    expect(removeNodes(doc, "user", ["t1"])).toEqual({
      ok: false,
      code: "unknown-node",
    });
  });

  it("connects and disconnects edges", () => {
    const doc = seeded();
    const result = connect(doc, "user", {
      source: "t1",
      sourceHandle: "text",
      target: "i1",
      targetHandle: "prompt",
    });
    expect(result).toEqual({ ok: true, value: { id: "t1:text->i1:prompt" } });
    expect(removeEdges(doc, "user", ["nope"])).toEqual({
      ok: false,
      code: "unknown-edge",
    });
    expect(removeEdges(doc, "user", ["t1:text->i1:prompt"]).ok).toBe(true);
    expect(readGraph(doc).edges).toEqual([]);
  });

  it("every operation writes with an explicit origin, and refuses a missing one", () => {
    const doc = createCanvasDoc();
    const origins: unknown[] = [];
    doc.on("beforeTransaction", (tr) => origins.push(tr.origin));
    const origin = "agent" as const;
    addNode(
      doc,
      origin,
      { id: "t1", type: "text", position: at() },
      testRegistry,
    );
    addNode(
      doc,
      origin,
      { id: "i1", type: "image.generate", position: at() },
      testRegistry,
    );
    updateConfig(doc, origin, "i1", { prompt: "x" }, testRegistry);
    renameNode(doc, origin, "i1", "Renamed");
    moveNodes(doc, origin, [{ id: "i1", position: at(9, 9) }]);
    connect(
      doc,
      origin,
      {
        source: "t1",
        sourceHandle: "text",
        target: "i1",
        targetHandle: "prompt",
      },
      testRegistry,
    );
    removeEdges(doc, origin, ["t1:text->i1:prompt"]);
    removeNodes(doc, origin, ["t1"]);
    expect(origins).toHaveLength(8);
    expect(new Set(origins)).toEqual(new Set(["agent"]));

    const before = JSON.stringify(readSnapshot(doc));
    const noOrigin = undefined as never;
    expect(() =>
      addNode(doc, noOrigin, { id: "x", type: "text", position: at() }),
    ).toThrow(TypeError);
    expect(() => moveNodes(doc, noOrigin, [])).toThrow(TypeError);
    expect(() => renameNode(doc, noOrigin, "i1", "y")).toThrow(TypeError);
    expect(() => updateConfig(doc, noOrigin, "i1", {})).toThrow(TypeError);
    expect(() => removeNodes(doc, noOrigin, [])).toThrow(TypeError);
    expect(() =>
      connect(doc, noOrigin, {
        source: "a",
        sourceHandle: "a",
        target: "b",
        targetHandle: "b",
      }),
    ).toThrow(TypeError);
    expect(() => removeEdges(doc, noOrigin, [])).toThrow(TypeError);
    expect(() =>
      addNode(doc, "load" as never, { id: "x", type: "text", position: at() }),
    ).toThrow(TypeError);
    expect(JSON.stringify(readSnapshot(doc))).toBe(before);
  });
});
