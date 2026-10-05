import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import { CanvasPage } from "../../../../../features/canvas/canvas-page";
import { getT } from "../../../../../i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT();
  return { title: t("canvas.metaTitle") };
}

const idSchema = z.uuid();

export default async function Page({
  params,
}: {
  params: Promise<{ id: string; cid: string }>;
}) {
  const { id, cid } = await params;
  const project = idSchema.safeParse(id);
  const canvas = idSchema.safeParse(cid);
  if (!project.success || !canvas.success) notFound();
  return <CanvasPage projectId={project.data} canvasId={canvas.data} />;
}
