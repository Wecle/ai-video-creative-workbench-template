import * as Y from "yjs";
import {
  registry as defaultRegistry,
  type Registry,
} from "@creative/node-registry";
import { ORIGIN, edgesOf, nodesOf } from "./doc";
import { repairDocument } from "./repair";

export type History = {
  undo(): boolean;
  redo(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  /** Ends the current undo step: the next edit starts a new one. */
  stopCapturing(): void;
  /** Called whenever the stacks change; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  destroy(): void;
};

/**
 * Undo/redo of the user's own edits. Only transactions with origin `user` are tracked, so
 * an agent's changes are never undone (and an undo never touches them). Edits less than
 * `captureTimeout` ms apart merge into one step. After every undo/redo the document is
 * repaired, because undoing can leave an agent's edge pointing at a node that is gone.
 */
export function createHistory(
  doc: Y.Doc,
  {
    captureTimeout = 500,
    registry = defaultRegistry,
  }: { captureTimeout?: number; registry?: Registry } = {},
): History {
  const manager = new Y.UndoManager([nodesOf(doc), edgesOf(doc)], {
    trackedOrigins: new Set([ORIGIN.user]),
    captureTimeout,
  });
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const repair = () => {
    repairDocument(doc, registry);
    notify();
  };
  manager.on("stack-item-added", notify);
  manager.on("stack-item-popped", repair);
  manager.on("stack-cleared", notify);
  return {
    undo: () => manager.undo() !== null,
    redo: () => manager.redo() !== null,
    canUndo: () => manager.canUndo(),
    canRedo: () => manager.canRedo(),
    stopCapturing: () => manager.stopCapturing(),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      listeners.clear();
      manager.destroy();
    },
  };
}
