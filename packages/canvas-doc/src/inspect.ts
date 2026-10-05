import type * as Y from "yjs";
import type { CanvasSnapshot } from "@creative/contracts";
import type { Registry } from "@creative/node-registry";
import {
  InvalidStateError,
  UnsupportedSchemaError,
  loadCanvasDoc,
} from "./codec";
import { readSnapshot, validateSnapshot, type Issue } from "./snapshot";

export type StateInspection =
  | { ok: true; doc: Y.Doc; snapshot: CanvasSnapshot }
  | { ok: false; issues: Issue[] };

/**
 * Untrusted bytes in, verdict out: decode, read the snapshot and validate it, without
 * ever throwing for bad input. This is what the server runs before storing a canvas.
 */
export function inspectState(
  bytes: Uint8Array,
  registry: Registry,
): StateInspection {
  let doc: Y.Doc;
  try {
    doc = loadCanvasDoc(bytes);
  } catch (error) {
    if (error instanceof UnsupportedSchemaError)
      return { ok: false, issues: [{ code: "unsupported-schema", path: [] }] };
    if (error instanceof InvalidStateError)
      return { ok: false, issues: [{ code: "invalid-state", path: [] }] };
    throw error;
  }
  try {
    const snapshot = readSnapshot(doc);
    const issues = validateSnapshot(snapshot, registry);
    return issues.length > 0
      ? { ok: false, issues }
      : { ok: true, doc, snapshot };
  } catch {
    return { ok: false, issues: [{ code: "invalid-state", path: [] }] };
  }
}
