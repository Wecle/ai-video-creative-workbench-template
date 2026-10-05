"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { createHistory, fromBase64, loadCanvasDoc } from "@creative/canvas-doc";
import { registry } from "@creative/node-registry";
import { useT } from "../../i18n/client";
import {
  createPersistence,
  type Persistence,
  type SaveFn,
} from "./persistence";
import { createCanvasStore, type CanvasState, type CanvasStore } from "./store";

type CanvasContextValue = { store: CanvasStore; persistence: Persistence };
const CanvasContext = createContext<CanvasContextValue | null>(null);

function useCanvasContext() {
  const value = useContext(CanvasContext);
  if (!value)
    throw new Error("Canvas hooks must be used inside <CanvasProvider>");
  return value;
}

/** Reads from the store of the canvas being shown. */
export function useCanvasStore<T>(selector: (state: CanvasState) => T): T {
  return useStore(useCanvasContext().store, selector);
}
export function useCanvasPersistence(): Persistence {
  return useCanvasContext().persistence;
}

/**
 * Owns one canvas session: loads the document, creates its store, history and persistence,
 * and tears them all down on unmount (pending changes are saved first). Created in an
 * effect rather than during render so that React's dev-mode double mount cannot leave
 * the app holding a destroyed instance.
 */
export function CanvasProvider({
  state,
  version,
  save,
  children,
}: {
  /** Base64 Yjs state as returned by the API. */
  state: string;
  /** The version `state` belongs to. */
  version: number;
  save: SaveFn;
  children: React.ReactNode;
}) {
  const t = useT();
  const [value, setValue] = useState<CanvasContextValue | null>(null);
  const [failed, setFailed] = useState(false);
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });

  useEffect(() => {
    let doc;
    try {
      doc = loadCanvasDoc(fromBase64(state));
    } catch {
      setFailed(true);
      return;
    }
    const history = createHistory(doc, { registry });
    const store = createCanvasStore({ doc, registry, history });
    const persistence = createPersistence({
      doc,
      baseVersion: version,
      save: (input) => saveRef.current(input),
      onStatus: (status) => store.getState().setSaveStatus(status),
      onError: (error) => console.error("Saving the canvas failed", error),
    });
    setValue({ store, persistence });
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      if (!persistence.hasUnsavedChanges()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => {
      window.removeEventListener("beforeunload", warnBeforeLeaving);
      // Starts the final save synchronously (it encodes the state before its first await).
      void persistence.dispose({ flush: true });
      store.getState().destroy();
      history.destroy();
    };
  }, [state, version]);

  if (failed)
    return (
      <p role="alert" className="p-6 text-sm text-red-400">
        {t("canvas.loadError")}
      </p>
    );
  if (!value)
    return (
      <p className="p-6 text-sm text-neutral-400">{t("canvas.loading")}</p>
    );
  return (
    <CanvasContext.Provider value={value}>{children}</CanvasContext.Provider>
  );
}
