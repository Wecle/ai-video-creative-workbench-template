import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import {
  demoCanvasDocument,
  type CanvasNode,
  type CanvasDocument,
  type NodeType,
} from "@creative/contracts";

export type StarterNode = Node<
  {
    title: string;
    kind: NodeType;
    status: CanvasNode["status"];
    config: CanvasNode["config"];
    description: string;
  },
  "starter"
>;
type CanvasState = {
  nodes: StarterNode[];
  edges: Edge[];
  selectedId: string | null;
  onNodesChange: (changes: NodeChange<StarterNode>[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  select: (id: string | null) => void;
  addNode: (kind: NodeType) => void;
  rename: (id: string, title: string) => void;
  reset: () => void;
};
function initial() {
  return {
    nodes: demoCanvasDocument.nodes.map((node): StarterNode => ({
      id: node.id,
      type: "starter",
      position: { ...node.position },
      data: {
        title: node.title,
        kind: node.type,
        status: node.status,
        config: structuredClone(node.config),
        description: "Template configuration placeholder",
      },
    })),
    edges: demoCanvasDocument.edges.map((edge): Edge => ({ ...edge })),
    selectedId: null,
  };
}
export function createCanvasStore() {
  return createStore<CanvasState>()((set) => ({
    ...initial(),
    onNodesChange: (changes) =>
      set((state) => {
        const nodes = applyNodeChanges(changes, state.nodes);
        const ids = new Set(nodes.map((node) => node.id));
        return {
          nodes,
          edges: state.edges.filter(
            (edge) => ids.has(edge.source) && ids.has(edge.target),
          ),
          selectedId:
            state.selectedId && ids.has(state.selectedId)
              ? state.selectedId
              : null,
        };
      }),
    onEdgesChange: (changes) =>
      set((state) => ({ edges: applyEdgeChanges(changes, state.edges) })),
    onConnect: (connection) =>
      set((state) =>
        connection.source === connection.target
          ? state
          : { edges: addEdge(connection, state.edges) },
      ),
    select: (selectedId) => set({ selectedId }),
    addNode: (kind) =>
      set((state) => ({
        nodes: [
          ...state.nodes,
          {
            id: crypto.randomUUID(),
            type: "starter",
            position: {
              x: 120 + state.nodes.length * 40,
              y: 120 + state.nodes.length * 30,
            },
            data: {
              title: "New " + kind + " node",
              kind,
              status: "draft",
              config: {},
              description: "Template configuration placeholder",
            },
          },
        ],
      })),
    rename: (id, title) =>
      set((state) => ({
        nodes: state.nodes.map((node) =>
          node.id === id ? { ...node, data: { ...node.data, title } } : node,
        ),
      })),
    reset: () => set(initial()),
  }));
}
export const canvasStore = createCanvasStore();
export function useCanvasStore<T>(selector: (state: CanvasState) => T) {
  return useStore(canvasStore, selector);
}
export function exportDocument(
  viewport: CanvasDocument["viewport"],
  store = canvasStore,
): CanvasDocument {
  const { nodes, edges } = store.getState();
  return {
    schemaVersion: 1,
    canvasId: "demo",
    viewport,
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.data.kind,
      title: node.data.title,
      status: node.data.status,
      position: { ...node.position },
      config: structuredClone(node.data.config),
    })),
    edges: edges.map(({ id, source, target, sourceHandle, targetHandle }) => ({
      id,
      source,
      target,
      sourceHandle: sourceHandle ?? undefined,
      targetHandle: targetHandle ?? undefined,
    })),
  };
}
