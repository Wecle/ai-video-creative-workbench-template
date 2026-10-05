import type { Metadata } from "next";
import { ProjectsPage } from "../../features/projects/projects-page";
import { getT } from "../../i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT();
  return { title: t("projects.metaTitle") };
}

export default function Page() {
  return <ProjectsPage />;
}
