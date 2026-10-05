import * as Y from "yjs";

/**
 * Y.Doc layout (SCHEMA_VERSION 1):
 *
 *   meta   Y.Map                 { schemaVersion }
 *   nodes  Y.Map<id, Y.Map>      each: type, version, title, position ({x, y}, replaced as a
 *                                whole), config (Y.Map<field, JSON value>: two people editing
 *                                different fields merge)
 *   edges  Y.Map<edgeId, plain>  { source, sourceHandle, target, targetHandle }; immutable,
 *                                "changing" a connection means delete + create
 *   groups reserved root key; nothing creates it yet
 *
 * Run-time status, viewport and selection are deliberately not part of the document.
 */
export const SCHEMA_VERSION = 1;

/**
 * Transaction origins. `user` and `agent` are the only origins operations may write with;
 * only `user` is tracked by the undo history, so undoing never reverts an agent's change.
 * `load` (initial state), `remote` (updates from elsewhere) and `repair` are internal.
 */
export const ORIGIN = {
  user: "user",
  agent: "agent",
  load: "load",
  remote: "remote",
  repair: "repair",
} as const;
export type WriteOrigin = typeof ORIGIN.user | typeof ORIGIN.agent;

/** The document type; the rest of the app imports this instead of depending on Yjs. */
export type CanvasDoc = Y.Doc;

/** Edge value as stored in the `edges` map. */
export type EdgeValue = {
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
};

export function nodesOf(doc: Y.Doc) {
  return doc.getMap<Y.Map<unknown>>("nodes");
}
export function edgesOf(doc: Y.Doc) {
  return doc.getMap<EdgeValue>("edges");
}
export function metaOf(doc: Y.Doc) {
  return doc.getMap<unknown>("meta");
}

/** Operations must say who is writing; a missing origin would silently escape the undo history. */
export function assertWriteOrigin(
  origin: unknown,
): asserts origin is WriteOrigin {
  if (origin !== ORIGIN.user && origin !== ORIGIN.agent)
    throw new TypeError('Write origin must be "user" or "agent"');
}

export function transact(doc: Y.Doc, origin: string, fn: () => void) {
  doc.transact(fn, origin);
}

/** A new, empty document. Created by the server; clients only load. */
export function createCanvasDoc(): Y.Doc {
  const doc = new Y.Doc();
  transact(doc, ORIGIN.load, () => {
    metaOf(doc).set("schemaVersion", SCHEMA_VERSION);
    nodesOf(doc);
    edgesOf(doc);
  });
  return doc;
}
