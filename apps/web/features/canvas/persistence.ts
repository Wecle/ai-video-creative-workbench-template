import {
  encodeState,
  isPersistableOrigin,
  repairDocument,
  toBase64,
  type CanvasDoc,
} from "@creative/canvas-doc";
import type { SaveStatus } from "./store";

export type SaveFn = (input: {
  baseVersion: number;
  state: string;
}) => Promise<{ version: number }>;

export type PersistenceOptions = {
  doc: CanvasDoc;
  /** The version the loaded state came from. */
  baseVersion: number;
  save: SaveFn;
  onStatus: (status: SaveStatus) => void;
  debounceMs?: number;
  /** Default: the error has `status === 409`. */
  isConflict?: (error: unknown) => boolean;
  /** Called on a failed save, e.g. to log it. */
  onError?: (error: unknown) => void;
};

export type Persistence = {
  /** Saves now (manual save button, leaving the page). Resolves when the save settled. */
  flush: () => Promise<void>;
  hasUnsavedChanges: () => boolean;
  baseVersion: () => number;
  /** Stops listening and timers; `flush: true` first saves pending changes. */
  dispose: (options?: { flush?: boolean }) => Promise<void>;
};

const defaultIsConflict = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  (error as { status?: unknown }).status === 409;

/**
 * Debounced saving of the whole document state with optimistic locking.
 *  - Every persistable transaction (user, agent, undo/redo, repair; not the initial load
 *    or remote updates) marks the document dirty and restarts the debounce timer.
 *  - A save repairs the document (undo may have left dangling edges), encodes the full
 *    state and sends it with `baseVersion`; success advances `baseVersion`.
 *  - 409 means somebody else saved first: status `conflict`, automatic saving stops for
 *    good (the user reloads; changes are deliberately not merged).
 *  - Edits made while a save is in flight are saved afterwards.
 */
export function createPersistence({
  doc,
  baseVersion: initialVersion,
  save,
  onStatus,
  debounceMs = 2000,
  isConflict = defaultIsConflict,
  onError,
}: PersistenceOptions): Persistence {
  let version = initialVersion;
  let edits = 0; // counts persistable transactions
  let savedEdits = 0; // `edits` as of the last successful save
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inflight: Promise<void> | undefined;
  let conflicted = false;
  let disposed = false;
  let ignoring = false; // set while we change the document ourselves (repair)

  const dirty = () => edits !== savedEdits;
  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const onUpdate = (_update: Uint8Array, origin: unknown) => {
    if (ignoring || disposed || !isPersistableOrigin(origin)) return;
    edits++;
    if (conflicted) return;
    onStatus("unsaved");
    clearTimer();
    timer = setTimeout(() => void run(), debounceMs);
  };
  doc.on("update", onUpdate);

  async function attempt() {
    ignoring = true;
    let state: string;
    try {
      repairDocument(doc);
      state = toBase64(encodeState(doc));
    } finally {
      ignoring = false;
    }
    const snapshotEdits = edits;
    onStatus("saving");
    try {
      const result = await save({ baseVersion: version, state });
      version = result.version;
      savedEdits = snapshotEdits;
      if (dirty() && !conflicted) {
        // Edited while saving: another round.
        onStatus("unsaved");
        clearTimer();
        timer = setTimeout(() => void run(), debounceMs);
      } else onStatus("saved");
    } catch (error) {
      if (isConflict(error)) {
        conflicted = true;
        clearTimer();
        onStatus("conflict");
      } else {
        onError?.(error);
        onStatus("error");
      }
    }
  }

  async function run() {
    clearTimer();
    if (conflicted) return;
    if (inflight) {
      // One save at a time; the edits that arrived meanwhile are picked up afterwards.
      await inflight;
      if (dirty() && !conflicted && !disposed) return run();
      return;
    }
    if (!dirty()) return;
    inflight = attempt().finally(() => {
      inflight = undefined;
    });
    await inflight;
  }

  return {
    flush: run,
    hasUnsavedChanges: () => !conflicted && (dirty() || inflight !== undefined),
    baseVersion: () => version,
    async dispose({ flush = false } = {}) {
      if (disposed) return;
      clearTimer();
      if (flush && dirty() && !conflicted) await run();
      disposed = true;
      doc.off("update", onUpdate);
      clearTimer();
    },
  };
}
