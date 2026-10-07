import { describe, expect, it } from "vitest";
import { resolveWorkspaceIdForProject } from "./workbench";

describe("resolveWorkspaceIdForProject", () => {
  it("resolves the correct workspaceId for the given projectId", () => {
    const cachedData = {
      projects: [
        {
          id: "proj-1",
          workspaceId: "ws-primary",
        },
        {
          id: "proj-2",
          workspaceId: "ws-secondary",
        },
      ],
    };

    expect(resolveWorkspaceIdForProject(cachedData, "proj-1")).toBe("ws-primary");
    expect(resolveWorkspaceIdForProject(cachedData, "proj-2")).toBe("ws-secondary");
  });

  it("returns undefined when project is not found", () => {
    const cachedData = {
      projects: [
        {
          id: "proj-1",
          workspaceId: "ws-primary",
        },
      ],
    };

    expect(resolveWorkspaceIdForProject(cachedData, "proj-nonexistent")).toBeUndefined();
  });

  it("returns undefined when cache data is undefined", () => {
    expect(resolveWorkspaceIdForProject(undefined, "proj-1")).toBeUndefined();
  });
});
