"use client";

import dynamic from "next/dynamic";

const FlowCanvas = dynamic(
  () => import("./flow-canvas").then((mod) => mod.FlowCanvas),
  { ssr: false },
);

export function Canvas() {
  return <FlowCanvas />;
}
