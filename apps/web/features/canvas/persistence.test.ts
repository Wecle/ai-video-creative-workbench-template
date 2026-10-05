import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addNode,
  createCanvasDoc,
  createHistory,
  loadCanvasDoc,
  fromBase64,
  moveNodes,
  type CanvasDoc,
} from "@creative/canvas-doc";
import { createPersistence } from "./persistence";
import type { SaveStatus } from "./store";

const at = (x = 0) => ({ x, y: 0 });

describe("persistence", () => {
  let doc: CanvasDoc;
  let statuses: SaveStatus[];
  let save: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    doc = createCanvasDoc();
    statuses = [];
    save = vi.fn(async ({ baseVersion }: { baseVersion: number }) => ({
      version: baseVersion + 1,
    }));
  });
  afterEach(() => vi.useRealTimers());

  const make = (extra = {}) =>
    createPersistence({
      doc,
      baseVersion: 0,
      save: save as never,
      onStatus: (s) => statuses.push(s),
      debounceMs: 2000,
      ...extra,
    });

  it("saves once for a burst of edits and advances baseVersion", async () => {
    const persistence = make();
    for (let i = 0; i < 5; i++) {
      addNode(doc, "user", { id: `n${i}`, type: "text", position: at(i) });
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(save).not.toHaveBeenCalled();
    expect(persistence.hasUnsavedChanges()).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0].baseVersion).toBe(0);
    expect(persistence.baseVersion()).toBe(1);
    expect(persistence.hasUnsavedChanges()).toBe(false);
    expect(statuses.at(-1)).toBe("saved");
    // The payload is the full document state.
    const saved = loadCanvasDoc(fromBase64(save.mock.calls[0]![0].state));
    expect(saved.getMap("nodes").size).toBe(5);

    addNode(doc, "user", { id: "later", type: "text", position: at() });
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]![0].baseVersion).toBe(1);
    expect(persistence.baseVersion()).toBe(2);
  });

  it("ignores the initial load and remote updates", async () => {
    make();
    doc.transact(() => doc.getMap("meta").set("x", 1), "load");
    doc.transact(() => doc.getMap("meta").set("y", 1), "remote");
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).not.toHaveBeenCalled();
    expect(statuses).toEqual([]);
  });

  it("saves agent changes and undo/redo too", async () => {
    make();
    const history = createHistory(doc, { captureTimeout: 0 });
    addNode(doc, "agent", { id: "a", type: "text", position: at() });
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).toHaveBeenCalledTimes(1);
    addNode(doc, "user", { id: "u", type: "text", position: at() });
    await vi.advanceTimersByTimeAsync(2000);
    history.undo();
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).toHaveBeenCalledTimes(3);
    const last = loadCanvasDoc(fromBase64(save.mock.calls[2]![0].state));
    expect([...last.getMap("nodes").keys()]).toEqual(["a"]);
  });

  it("goes to conflict on 409 and stops saving automatically", async () => {
    const persistence = make();
    save.mockRejectedValueOnce(Object.assign(new Error("x"), { status: 409 }));
    addNode(doc, "user", { id: "a", type: "text", position: at() });
    await vi.advanceTimersByTimeAsync(2000);
    expect(statuses.at(-1)).toBe("conflict");
    expect(persistence.baseVersion()).toBe(0);
    addNode(doc, "user", { id: "b", type: "text", position: at() });
    await vi.advanceTimersByTimeAsync(10_000);
    await persistence.flush();
    expect(save).toHaveBeenCalledTimes(1);
    expect(statuses.at(-1)).toBe("conflict");
    expect(persistence.hasUnsavedChanges()).toBe(false);
  });

  it("reports other failures, keeps the changes and retries on the next edit", async () => {
    const onError = vi.fn();
    const persistence = make({ onError });
    save.mockRejectedValueOnce(new Error("offline"));
    addNode(doc, "user", { id: "a", type: "text", position: at() });
    await vi.advanceTimersByTimeAsync(2000);
    expect(statuses.at(-1)).toBe("error");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(persistence.hasUnsavedChanges()).toBe(true);
    await persistence.flush(); // manual retry
    expect(statuses.at(-1)).toBe("saved");
    expect(persistence.baseVersion()).toBe(1);
  });

  it("saves edits made while a save is in flight afterwards", async () => {
    let release!: () => void;
    save.mockImplementationOnce(
      ({ baseVersion }: { baseVersion: number }) =>
        new Promise((resolve) => {
          release = () => resolve({ version: baseVersion + 1 });
        }),
    );
    const persistence = make();
    addNode(doc, "user", { id: "a", type: "text", position: at() });
    await vi.advanceTimersByTimeAsync(2000);
    expect(statuses.at(-1)).toBe("saving");
    addNode(doc, "user", { id: "b", type: "text", position: at() });
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)).toBe("unsaved");
    expect(persistence.hasUnsavedChanges()).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]![0].baseVersion).toBe(1);
    expect(statuses.at(-1)).toBe("saved");
  });

  it("flush saves immediately, and dispose can flush pending changes", async () => {
    const persistence = make();
    addNode(doc, "user", { id: "a", type: "text", position: at() });
    await persistence.flush();
    expect(save).toHaveBeenCalledTimes(1);
    moveNodes(doc, "user", [{ id: "a", position: at(9) }]);
    await persistence.dispose({ flush: true });
    expect(save).toHaveBeenCalledTimes(2);
    // After dispose nothing is observed any more.
    addNode(doc, "user", { id: "b", type: "text", position: at() });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("dispose without flush drops the pending timer", async () => {
    const persistence = make();
    addNode(doc, "user", { id: "a", type: "text", position: at() });
    await persistence.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(save).not.toHaveBeenCalled();
  });
});
