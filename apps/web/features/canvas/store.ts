import { createStore, type StoreApi } from "zustand/vanilla";
import {
  applyEdgeChanges,
  applyNodeChanges,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import {
  addNode as addDocNode,
  connect,
  moveNodes,
  readSnapshot,
  removeEdges,
  removeNodes,
  renameNode as renameDocNode,
  updateConfig as updateDocConfig,
  validateConnection,
  type CanvasDoc,
  type ConnectionErrorCode,
  type Connection,
  type EdgeValue,
  type Graph,
  type History,
  type Position,
  type Result,
} from "@creative/canvas-doc";
import type {
  CanvasRuntime,
  CanvasSnapshot,
  NodeRuntime,
} from "@creative/contracts";
import type { Registry } from "@creative/node-registry";

/**
 * Three layers of canvas state, each in its own place:
 *  - Document (Y.Doc, persisted): nodes, edges, titles, positions, configs. The store below
 *    is a read-only derivation of it: every document transaction rebuilds `nodes`/`edges`.
 *  - Runtime (`runtime`): execution status per node. Empty until execution exists; never
 *    stored in the document.
 *  - UI (everything else here: selection, drag in progress, save status, notices).
 *    React Flow itself owns the viewport.
 * One store per open canvas (see provider.tsx): there is no module-level singleton.
 */

export type CanvasNodeData = {
  title: string;
  version: number;
  config: Record<string, unknown>;
};
/** React Flow node whose `type` is the registry node type. */
export type CanvasFlowNode = Node<CanvasNodeData>;

export type SaveStatus = "saved" | "unsaved" | "saving" | "conflict" | "error";
export type Notice = { kind: "connection"; code: ConnectionErrorCode } | null;

export type CanvasState = {
  nodes: CanvasFlowNode[];
  edges: Edge[];
  // UI layer
  selectedId: string | null;
  /** Nodes being dragged right now: their local position wins over the document's. */
  draggingIds: ReadonlySet<string>;
  saveStatus: SaveStatus;
  notice: Notice;
  canUndo: boolean;
  canRedo: boolean;
  // Runtime layer
  runtime: CanvasRuntime;
  // React Flow callbacks
  onNodesChange: (changes: NodeChange<CanvasFlowNode>[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  isValidConnection: (connection: Connection | Edge) => boolean;
  /** Writes final positions to the document in one transaction (drag stop, keyboard move). */
  commitPositions: (
    moves: readonly { id: string; position: Position }[],
  ) => void;
  // UI actions
  select: (id: string | null) => void;
  setSaveStatus: (status: SaveStatus) => void;
  setCanvasRuntime: (runtime: CanvasRuntime) => void;
  updateNodeRuntime: (nodeId: string, runtime: Partial<NodeRuntime>) => void;
  reportConnectionError: (code: ConnectionErrorCode) => void;
  /** Sets a notice for a connection the user tried to make but React Flow refused. */
  explainConnection: (connection: Connection) => void;
  dismissNotice: () => void;
  // Document actions (always origin "user")
  addNode: (
    type: string,
    options?: { title?: string; position?: Position },
  ) => Result<{ id: string }>;
  renameNode: (id: string, title: string) => Result;
  updateConfig: (id: string, patch: Record<string, unknown>) => Result;
  undo: () => void;
  redo: () => void;
  exportSnapshot: () => CanvasSnapshot;
  destroy: () => void;
};
export type CanvasStore = StoreApi<CanvasState>;

export type CreateCanvasStoreOptions = {
  doc: CanvasDoc;
  registry: Registry;
  history: History;
  /** Node ids; tests inject a counter. */
  createId?: () => string;
};

const samePosition = (a: Position, b: Position) => a.x === b.x && a.y === b.y;
const sameJson = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/** The plain graph `validateConnection` works on, from what the UI currently shows. */
export function graphOf(
  nodes: readonly CanvasFlowNode[],
  edges: readonly Edge[],
): Graph {
  return {
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.type ?? "",
      version: node.data.version,
    })),
    edges: edges.map((edge): EdgeValue => ({
      source: edge.source,
      sourceHandle: edge.sourceHandle ?? "",
      target: edge.target,
      targetHandle: edge.targetHandle ?? "",
    })),
  };
}

export function createCanvasStore({
  doc,
  registry,
  history,
  createId = () => crypto.randomUUID(),
}: CreateCanvasStoreOptions): CanvasStore {
  const cleanups: (() => void)[] = [];
  const get = () => store.getState();
  const set: CanvasStore["setState"] = (partial) => store.setState(partial);

  /** Runs a user operation as its own undo step. */
  function userOp<T>(operation: () => T): T {
    history.stopCapturing();
    return operation();
  }

  /** Derives `nodes` and `edges` from the document, keeping unchanged objects as they were. */
  function rebuild() {
    const snapshot = readSnapshot(doc);
    const state = get();
    const previousNodes = new Map(state.nodes.map((n) => [n.id, n]));
    const nodes = snapshot.nodes.map((node): CanvasFlowNode => {
      const previous = previousNodes.get(node.id);
      const position =
        previous && state.draggingIds.has(node.id)
          ? previous.position
          : node.position;
      if (
        previous &&
        previous.type === node.type &&
        samePosition(previous.position, position) &&
        previous.data.title === node.title &&
        previous.data.version === node.version &&
        sameJson(previous.data.config, node.config)
      )
        return previous;
      return {
        ...previous,
        id: node.id,
        type: node.type,
        position,
        data: { title: node.title, version: node.version, config: node.config },
      };
    });
    const previousEdges = new Map(state.edges.map((e) => [e.id, e]));
    const edges = snapshot.edges.map((edge): Edge => {
      const previous = previousEdges.get(edge.id);
      if (
        previous &&
        previous.source === edge.source &&
        previous.target === edge.target &&
        previous.sourceHandle === edge.sourceHandle &&
        previous.targetHandle === edge.targetHandle
      )
        return previous;
      return {
        ...previous,
        id: edge.id,
        source: edge.source,
        sourceHandle: edge.sourceHandle,
        target: edge.target,
        targetHandle: edge.targetHandle,
      };
    });
    const sameNodes =
      nodes.length === state.nodes.length &&
      nodes.every((node, index) => node === state.nodes[index]);
    const sameEdges =
      edges.length === state.edges.length &&
      edges.every((edge, index) => edge === state.edges[index]);
    const selectedId =
      state.selectedId && nodes.some((n) => n.id === state.selectedId)
        ? state.selectedId
        : null;
    set({
      ...(sameNodes ? {} : { nodes }),
      ...(sameEdges ? {} : { edges }),
      selectedId,
      canUndo: history.canUndo(),
      canRedo: history.canRedo(),
    });
  }

  const onTransaction = (transaction: { changed: Map<unknown, unknown> }) => {
    if (transaction.changed.size > 0) rebuild();
  };

  const store: CanvasStore = createStore<CanvasState>()(() => {
    const actions: Pick<
      CanvasState,
      | "onNodesChange"
      | "onEdgesChange"
      | "onConnect"
      | "isValidConnection"
      | "commitPositions"
      | "select"
      | "setSaveStatus"
      | "setCanvasRuntime"
      | "updateNodeRuntime"
      | "reportConnectionError"
      | "explainConnection"
      | "dismissNotice"
      | "addNode"
      | "renameNode"
      | "updateConfig"
      | "undo"
      | "redo"
      | "exportSnapshot"
      | "destroy"
    > = {
      onNodesChange: (changes) => {
        const local: NodeChange<CanvasFlowNode>[] = [];
        const removed: string[] = [];
        const commits = new Map<string, Position>();
        const dragging = new Set(get().draggingIds);
        let selectedId = get().selectedId;
        for (const change of changes) {
          switch (change.type) {
            case "remove":
              removed.push(change.id);
              break;
            case "position":
              if (change.dragging) {
                // Mid-drag: the position lives in the UI layer only. Writing every frame
                // to the document would flood undo history, persistence and (later) peers.
                dragging.add(change.id);
                local.push(change);
              } else if (change.position) {
                // Drag end or a keyboard move: this is the position to keep.
                commits.set(change.id, change.position);
                local.push(change);
              } else {
                local.push(change);
              }
              break;
            case "select":
              local.push(change);
              if (change.selected) selectedId = change.id;
              else if (selectedId === change.id) selectedId = null;
              break;
            case "dimensions":
              local.push(change);
              break;
            default:
              // "add" / "replace": the document is the only source of nodes.
              break;
          }
        }
        if (local.length > 0 || selectedId !== get().selectedId)
          set((state) => ({
            nodes: local.length
              ? applyNodeChanges(local, state.nodes)
              : state.nodes,
            draggingIds: dragging,
            selectedId,
          }));
        if (commits.size > 0)
          actions.commitPositions(
            [...commits].map(([id, position]) => ({ id, position })),
          );
        if (removed.length > 0)
          userOp(() =>
            removeNodes(
              doc,
              "user",
              removed.filter((id) => get().nodes.some((n) => n.id === id)),
            ),
          );
      },

      onEdgesChange: (changes) => {
        const local: EdgeChange[] = [];
        const removed: string[] = [];
        for (const change of changes) {
          if (change.type === "remove") removed.push(change.id);
          else if (change.type === "select") local.push(change);
        }
        if (local.length > 0)
          set((state) => ({ edges: applyEdgeChanges(local, state.edges) }));
        if (removed.length > 0)
          userOp(() =>
            removeEdges(
              doc,
              "user",
              removed.filter((id) => get().edges.some((e) => e.id === id)),
            ),
          );
      },

      isValidConnection: (connection) =>
        validateConnection(graphOf(get().nodes, get().edges), registry, {
          source: connection.source,
          sourceHandle: connection.sourceHandle,
          target: connection.target,
          targetHandle: connection.targetHandle,
        }).ok,

      onConnect: (connection) => {
        const result = userOp(() => connect(doc, "user", connection, registry));
        if (!result.ok) actions.reportConnectionError(result.code);
      },

      commitPositions: (moves) => {
        const known = moves.filter((move) =>
          get().nodes.some((node) => node.id === move.id),
        );
        const ids = new Set(known.map((move) => move.id));
        set((state) => ({
          draggingIds: new Set(
            [...state.draggingIds].filter((id) => !ids.has(id)),
          ),
        }));
        if (known.length === 0) return;
        // One transaction for any number of nodes: one update, one undo step. Positions
        // equal to the document's are skipped, so calling this twice is harmless.
        userOp(() => moveNodes(doc, "user", known));
        rebuild();
      },

      select: (id) =>
        set((state) => ({
          selectedId: id,
          nodes: state.nodes.map((node) =>
            Boolean(node.selected) === (node.id === id)
              ? node
              : { ...node, selected: node.id === id },
          ),
        })),
      setSaveStatus: (saveStatus) => set({ saveStatus }),
      setCanvasRuntime: (runtime) => set({ runtime }),
      updateNodeRuntime: (nodeId, nodeRuntime) =>
        set((state) => ({
          runtime: {
            ...state.runtime,
            [nodeId]: {
              ...state.runtime[nodeId],
              ...nodeRuntime,
              status:
                nodeRuntime.status ?? state.runtime[nodeId]?.status ?? "idle",
            },
          },
        })),
      reportConnectionError: (code) =>
        set({ notice: { kind: "connection", code } }),
      explainConnection: (connection) => {
        const result = validateConnection(
          graphOf(get().nodes, get().edges),
          registry,
          connection,
        );
        if (!result.ok) actions.reportConnectionError(result.code);
      },
      dismissNotice: () => set({ notice: null }),

      addNode: (type, options = {}) => {
        const nodes = get().nodes;
        const result = userOp(() =>
          addDocNode(
            doc,
            "user",
            {
              id: createId(),
              type,
              title: options.title,
              position: options.position ?? {
                // A grid, three nodes per row, so new nodes do not pile up.
                x: 80 + (nodes.length % 3) * 300,
                y: 80 + Math.floor(nodes.length / 3) * 260,
              },
            },
            registry,
          ),
        );
        if (result.ok) actions.select(result.value.id);
        return result;
      },
      renameNode: (id, title) =>
        userOp(() => renameDocNode(doc, "user", id, title)),
      updateConfig: (id, patch) =>
        userOp(() => updateDocConfig(doc, "user", id, patch, registry)),
      undo: () => {
        history.undo();
      },
      redo: () => {
        history.redo();
      },
      exportSnapshot: () => readSnapshot(doc),
      destroy: () => {
        doc.off("afterTransaction", onTransaction);
        cleanups.forEach((cleanup) => cleanup());
      },
    };

    return {
      nodes: [],
      edges: [],
      selectedId: null,
      draggingIds: new Set<string>(),
      saveStatus: "saved",
      notice: null,
      canUndo: false,
      canRedo: false,
      runtime: {},
      ...actions,
    };
  });

  doc.on("afterTransaction", onTransaction);
  cleanups.push(
    history.subscribe(() =>
      set({ canUndo: history.canUndo(), canRedo: history.canRedo() }),
    ),
  );
  // The store is created around an already loaded document.
  rebuild();
  return store;
}
