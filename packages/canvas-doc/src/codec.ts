import * as Y from "yjs";
import {
  ORIGIN,
  SCHEMA_VERSION,
  edgesOf,
  metaOf,
  nodesOf,
  transact,
} from "./doc";
import { MIGRATIONS } from "./migrate";

/** The state was written by a newer version of this package than the one loading it. */
export class UnsupportedSchemaError extends Error {
  constructor(readonly schemaVersion: number) {
    super(`Unsupported canvas schema version ${schemaVersion}`);
    this.name = "UnsupportedSchemaError";
  }
}
/** The bytes are not a valid canvas document state. */
export class InvalidStateError extends Error {
  constructor(message = "Invalid canvas state") {
    super(message);
    this.name = "InvalidStateError";
  }
}

/**
 * The full document state (not an incremental update). Saving overwrites the stored state
 * with this; an update log and compaction are future work.
 */
export function encodeState(doc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(doc);
}

const ROOT_KEYS = new Set(["meta", "nodes", "edges", "groups"]);

export function loadCanvasDoc(bytes: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  let version: unknown;
  try {
    Y.applyUpdate(doc, bytes, ORIGIN.load);
    // Throws when a root key was written with another type...
    const roots = [nodesOf(doc), edgesOf(doc), metaOf(doc)];
    // ...but a root written as a list or text reads back as an empty map: its items sit in
    // `_start` (a map's own entries never do). Unknown roots would hide data the same way.
    if (roots.some((root) => (root as unknown as { _start: unknown })._start))
      throw new InvalidStateError();
    for (const key of doc.share.keys())
      if (!ROOT_KEYS.has(key)) throw new InvalidStateError();
    version = metaOf(doc).get("schemaVersion");
  } catch {
    doc.destroy();
    throw new InvalidStateError();
  }
  if (
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version < 1
  ) {
    doc.destroy();
    throw new InvalidStateError("Missing schema version");
  }
  if (version > SCHEMA_VERSION) {
    doc.destroy();
    throw new UnsupportedSchemaError(version);
  }
  for (let from = version; from < SCHEMA_VERSION; from++) {
    const migrate = MIGRATIONS[from];
    if (!migrate) {
      doc.destroy();
      throw new InvalidStateError(`No migration from schema version ${from}`);
    }
    transact(doc, ORIGIN.load, () => {
      migrate(doc);
      metaOf(doc).set("schemaVersion", from + 1);
    });
  }
  return doc;
}

const CHUNK = 0x8000;
/** btoa/atob exist in browsers and Node; Buffer would tie this package to Node. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK)
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}
export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
