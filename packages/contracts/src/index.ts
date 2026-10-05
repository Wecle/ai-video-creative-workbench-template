import { z } from "zod";
export type * from "./events";
export type * from "./tasks";

export const healthSchema = z.object({
  status: z.literal("ok"),
  service: z.string(),
});
export const meResponseSchema = z.object({
  user: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    image: z.string().nullable(),
  }),
  workspaces: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      slug: z.string(),
      role: z.string(),
    }),
  ),
});
export type MeResponse = z.infer<typeof meResponseSchema>;
export const agentRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(10000),
  projectId: z.string().max(200).optional(),
  canvasId: z.string().max(200).optional(),
});

export const nodeTypeSchema = z.enum([
  "text",
  "image.generate",
  "video.generate",
]);
export const nodeStatusSchema = z.enum([
  "draft",
  "ready",
  "running",
  "succeeded",
  "failed",
]);
export const canvasNodeSchema = z.object({
  id: z.string().min(1),
  type: nodeTypeSchema,
  title: z.string().trim().min(1).max(120),
  position: z.object({ x: z.number(), y: z.number() }),
  status: nodeStatusSchema,
  config: z.record(z.string(), z.unknown()).default({}),
});

export const canvasEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  sourceHandle: z.string().optional(),
  targetHandle: z.string().optional(),
});

export const canvasDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  canvasId: z.string(),
  nodes: z.array(canvasNodeSchema),
  edges: z.array(canvasEdgeSchema),
  viewport: z.object({
    x: z.number(),
    y: z.number(),
    zoom: z.number().positive(),
  }),
});

export type NodeType = z.infer<typeof nodeTypeSchema>;
export type CanvasNode = z.infer<typeof canvasNodeSchema>;
export type CanvasEdge = z.infer<typeof canvasEdgeSchema>;
export type CanvasDocument = z.infer<typeof canvasDocumentSchema>;

export const demoCanvasDocument: CanvasDocument = {
  schemaVersion: 1,
  canvasId: "demo",
  nodes: [
    {
      id: "text-1",
      type: "text",
      title: "创意说明",
      position: { x: 80, y: 140 },
      status: "ready",
      config: { text: "这里放置你的创意、旁白或镜头说明" },
    },
    {
      id: "image-1",
      type: "image.generate",
      title: "图片生成",
      position: { x: 440, y: 90 },
      status: "draft",
      config: { prompt: "" },
    },
    {
      id: "video-1",
      type: "video.generate",
      title: "视频生成",
      position: { x: 820, y: 90 },
      status: "draft",
      config: { prompt: "" },
    },
  ],
  edges: [
    { id: "edge-1", source: "text-1", target: "image-1" },
    { id: "edge-2", source: "image-1", target: "video-1" },
  ],
  viewport: { x: 0, y: 0, zoom: 0.9 },
};
