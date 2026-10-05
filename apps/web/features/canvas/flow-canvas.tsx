"use client";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  type FinalConnectionState,
} from "@xyflow/react";
import { useCanvasStore } from "./provider";
import { nodeTypes } from "./node-ui";

export function FlowCanvas() {
  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const onNodesChange = useCanvasStore((state) => state.onNodesChange);
  const onEdgesChange = useCanvasStore((state) => state.onEdgesChange);
  const onConnect = useCanvasStore((state) => state.onConnect);
  const isValidConnection = useCanvasStore((state) => state.isValidConnection);
  const commitPositions = useCanvasStore((state) => state.commitPositions);
  const explainConnection = useCanvasStore((state) => state.explainConnection);
  const select = useCanvasStore((state) => state.select);

  // React Flow silently drops a connection that fails `isValidConnection`; tell the user why.
  function onConnectEnd(_event: unknown, state: FinalConnectionState) {
    const { isValid, fromHandle, toHandle } = state;
    if (isValid !== false || !fromHandle || !toHandle) return;
    const fromIsSource = fromHandle.type === "source";
    const from = { id: fromHandle.nodeId, handle: fromHandle.id };
    const to = { id: toHandle.nodeId, handle: toHandle.id };
    const [source, target] = fromIsSource ? [from, to] : [to, from];
    explainConnection({
      source: source.id,
      sourceHandle: source.handle,
      target: target.id,
      targetHandle: target.handle,
    });
  }

  return (
    <div className="h-full w-full bg-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        isValidConnection={isValidConnection}
        // The only write of a drag: one document transaction when the drag ends.
        onNodeDragStop={(_event, _node, dragged) =>
          commitPositions(
            dragged.map((node) => ({ id: node.id, position: node.position })),
          )
        }
        onNodeClick={(_, node) => select(node.id)}
        onPaneClick={() => select(null)}
        fitView
        minZoom={0.25}
        maxZoom={2}
        defaultEdgeOptions={{
          style: { stroke: "var(--brand)", strokeWidth: 1.5 },
        }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={24}
          size={1}
          color="var(--grid)"
        />
        <Controls />
        <MiniMap nodeColor="var(--brand)" maskColor="rgba(0,0,0,.6)" />
      </ReactFlow>
    </div>
  );
}
