"use client";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  Handle,
  Position,
  type NodeProps,
} from "@xyflow/react";
import { memo } from "react";
import { Button } from "@creative/ui";
import { useCanvasStore, type StarterNode } from "./store";

const StarterNodeView = memo(function StarterNodeView({
  id,
  data,
  selected,
}: NodeProps<StarterNode>) {
  const select = useCanvasStore((state) => state.select);
  return (
    <div
      className={
        "w-[230px] overflow-hidden rounded-xl border bg-[#151515] shadow-xl " +
        (selected ? "border-violet-400" : "border-white/15")
      }
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!size-3 !bg-violet-300"
      />
      <div className="border-b border-white/10 px-3 py-3">
        <div className="truncate text-sm font-semibold">{data.title}</div>
        <div className="mt-1 text-xs text-neutral-400">
          {data.kind} · {data.status}
        </div>
      </div>
      <div className="p-3">
        <p className="rounded-lg bg-white/5 p-3 text-xs leading-5 text-neutral-400">
          {data.description}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="nodrag nopan mt-3 w-full"
          onClick={() => select(id)}
        >
          Configure
        </Button>
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className="!size-3 !bg-violet-300"
      />
    </div>
  );
});
const nodeTypes = { starter: StarterNodeView };

export function FlowCanvas() {
  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const onNodesChange = useCanvasStore((state) => state.onNodesChange);
  const onEdgesChange = useCanvasStore((state) => state.onEdgesChange);
  const onConnect = useCanvasStore((state) => state.onConnect);
  const select = useCanvasStore((state) => state.select);
  return (
    <div className="h-full w-full bg-[#101010]">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={(_, node) => select(node.id)}
        onPaneClick={() => select(null)}
        fitView
        minZoom={0.25}
        maxZoom={2}
        defaultEdgeOptions={{ style: { stroke: "#a78bfa", strokeWidth: 1.5 } }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={24}
          size={1}
          color="#333"
        />
        <Controls />
        <MiniMap nodeColor="#a78bfa" maskColor="rgba(0,0,0,.6)" />
      </ReactFlow>
    </div>
  );
}
