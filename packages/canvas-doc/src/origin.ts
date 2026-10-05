import { ORIGIN } from "./doc";

/**
 * Whether a transaction with this origin changed the document in a way that should be
 * saved: everything except the initial load and updates that came from the server/peers.
 * Undo/redo (origin: the undo manager), `user`, `agent` and `repair` all count.
 */
export function isPersistableOrigin(origin: unknown) {
  return origin !== ORIGIN.load && origin !== ORIGIN.remote;
}
