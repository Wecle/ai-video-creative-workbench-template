import { describe, expect, it } from "vitest";
import {
  addNode,
  connect,
  createCanvasDoc,
  readGraph,
  validateConnection,
  type CanvasDoc,
} from "../src";
import { at, testRegistry } from "./helpers";

function chain(): CanvasDoc {
  const doc = createCanvasDoc();
  for (const id of ["a", "b", "c"])
    addNode(
      doc,
      "user",
      { id, type: "text.transform", position: at() },
      testRegistry,
    );
  addNode(doc, "user", { id: "t", type: "text", position: at() }, testRegistry);
  addNode(
    doc,
    "user",
    { id: "img", type: "image.generate", position: at() },
    testRegistry,
  );
  return doc;
}
const link = (source: string, target: string) => ({
  source,
  sourceHandle: source === "t" ? "text" : "out",
  target,
  targetHandle: "in",
});

describe("connection validation", () => {
  it("accepts a valid connection", () => {
    const doc = chain();
    expect(
      validateConnection(readGraph(doc), testRegistry, link("a", "b")).ok,
    ).toBe(true);
    expect(connect(doc, "user", link("a", "b"), testRegistry).ok).toBe(true);
    expect(connect(doc, "user", link("t", "a"), testRegistry).ok).toBe(true);
  });

  it("rejects unknown nodes and ports", () => {
    const doc = chain();
    const code = (c: Parameters<typeof connect>[2]) => {
      const r = validateConnection(readGraph(doc), testRegistry, c);
      return r.ok ? "ok" : r.code;
    };
    expect(code(link("a", "ghost"))).toBe("unknown-node");
    expect(code(link("ghost", "a"))).toBe("unknown-node");
    expect(
      code({
        source: "a",
        sourceHandle: "nope",
        target: "b",
        targetHandle: "in",
      }),
    ).toBe("unknown-port");
    expect(
      code({
        source: "a",
        sourceHandle: "out",
        target: "b",
        targetHandle: "nope",
      }),
    ).toBe("unknown-port");
    expect(
      code({
        source: "a",
        sourceHandle: null,
        target: "b",
        targetHandle: "in",
      }),
    ).toBe("unknown-port");
    // text has no inputs at all
    expect(
      code({
        source: "a",
        sourceHandle: "out",
        target: "t",
        targetHandle: "in",
      }),
    ).toBe("unknown-port");
  });

  it("rejects incompatible port types", () => {
    const doc = chain();
    // image.generate outputs an image; transform's input is text
    const r = connect(
      doc,
      "user",
      { source: "img", sourceHandle: "image", target: "a", targetHandle: "in" },
      testRegistry,
    );
    expect(r).toEqual({ ok: false, code: "port-type-mismatch" });
    // text output into an image-typed input does not exist: image.generate only takes text
    expect(
      connect(
        doc,
        "user",
        {
          source: "a",
          sourceHandle: "out",
          target: "img",
          targetHandle: "prompt",
        },
        testRegistry,
      ).ok,
    ).toBe(true);
    expect(
      connect(
        doc,
        "user",
        {
          source: "img",
          sourceHandle: "image",
          target: "img",
          targetHandle: "prompt",
        },
        testRegistry,
      ),
    ).toEqual({ ok: false, code: "self-loop" });
  });

  it("rejects self-loops", () => {
    const doc = chain();
    expect(connect(doc, "user", link("a", "a"), testRegistry)).toEqual({
      ok: false,
      code: "self-loop",
    });
  });

  it("rejects duplicate edges", () => {
    const doc = chain();
    expect(connect(doc, "user", link("a", "b"), testRegistry).ok).toBe(true);
    expect(connect(doc, "user", link("a", "b"), testRegistry)).toEqual({
      ok: false,
      code: "duplicate-edge",
    });
    expect(readGraph(doc).edges).toHaveLength(1);
  });

  it("rejects cycles, direct and indirect", () => {
    const doc = chain();
    expect(connect(doc, "user", link("a", "b"), testRegistry).ok).toBe(true);
    expect(connect(doc, "user", link("b", "a"), testRegistry)).toEqual({
      ok: false,
      code: "cycle",
    });
    expect(connect(doc, "user", link("b", "c"), testRegistry).ok).toBe(true);
    expect(connect(doc, "user", link("c", "a"), testRegistry)).toEqual({
      ok: false,
      code: "cycle",
    });
    // a diamond is fine
    expect(connect(doc, "user", link("a", "c"), testRegistry).ok).toBe(true);
    expect(readGraph(doc).edges).toHaveLength(3);
  });

  it("works on a plain-data graph, as the UI store provides", () => {
    const graph = {
      nodes: [
        { id: "a", type: "text.transform", version: 1 },
        { id: "b", type: "text.transform", version: 1 },
      ],
      edges: [
        { source: "a", sourceHandle: "out", target: "b", targetHandle: "in" },
      ],
    };
    expect(validateConnection(graph, testRegistry, link("b", "a"))).toEqual({
      ok: false,
      code: "cycle",
    });
  });
});
