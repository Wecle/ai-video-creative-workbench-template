import type * as Y from "yjs";
import type { CanvasPatch, CanvasPatchOp } from "@creative/contracts";
import {
  registry as defaultRegistry,
  type Registry,
} from "@creative/node-registry";
import { encodeState, loadCanvasDoc } from "./codec";
import { assertWriteOrigin, transact, type WriteOrigin } from "./doc";
import { addNode, connect, updateConfig } from "./ops";
import { fail, type OpErrorCode, type Result } from "./result";

export type PatchResult =
  | { ok: true }
  | { ok: false; code: OpErrorCode; index?: number };

function executeOp(
  doc: Y.Doc,
  origin: WriteOrigin,
  op: CanvasPatchOp,
  reg: Registry,
): Result<unknown> {
  if (!op || typeof op !== "object" || !("op" in op)) {
    return fail("invalid-op");
  }
  switch (op.op) {
    case "addNode":
      if (!op.position || typeof op.position !== "object") {
        return fail("invalid-position");
      }
      return addNode(
        doc,
        origin,
        {
          id: op.id,
          type: op.type,
          version: op.version,
          title: op.title,
          position: op.position,
          config: op.config,
        },
        reg,
      );
    case "updateConfig":
      return updateConfig(doc, origin, op.id, op.patch, reg);
    case "connect":
      return connect(
        doc,
        origin,
        {
          source: op.source,
          sourceHandle: op.sourceHandle,
          target: op.target,
          targetHandle: op.targetHandle,
        },
        reg,
      );
    default:
      return fail("unknown-op");
  }
}

/**
 * Atomically applies an Agent or User patch to the document.
 * Dry-runs all operations against a clone first (all-or-nothing);
 * if any operation fails, the original document remains byte-for-byte unchanged.
 * If all operations succeed, they are executed on the real document inside a single transaction.
 */
export function applyPatch(
  doc: Y.Doc,
  origin: WriteOrigin,
  patch: CanvasPatch,
  reg: Registry = defaultRegistry,
): PatchResult {
  assertWriteOrigin(origin);

  if (!patch || typeof patch !== "object" || !Array.isArray(patch.ops)) {
    return { ok: false, code: "invalid-patch" };
  }

  // 1. Dry-run on a cloned document to guarantee all-or-nothing
  const clone = loadCanvasDoc(encodeState(doc));
  try {
    for (let i = 0; i < patch.ops.length; i++) {
      const op = patch.ops[i]!;
      const res = executeOp(clone, origin, op, reg);
      if (!res.ok) {
        return { ok: false, code: res.code, index: i };
      }
    }
  } finally {
    clone.destroy();
  }

  // 2. Replay all operations inside a single transaction on the real document
  transact(doc, origin, () => {
    for (const op of patch.ops) {
      const res = executeOp(doc, origin, op, reg);
      if (!res.ok) {
        throw new Error(`Unexpected patch operation failure: ${res.code}`);
      }
    }
  });

  return { ok: true };
}
