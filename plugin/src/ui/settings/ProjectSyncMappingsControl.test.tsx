import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type React from "react";
import { describe, expect, it, vi } from "vitest";

import { makeProject } from "@/factories/data";
import type TodoistPlugin from "@/index";
import { PluginContext } from "@/ui/context";
import {
  ProjectSyncMappingsControl,
  type ProjectSyncMappingValue,
  validateProjectSyncMappings,
} from "@/ui/settings/ProjectSyncMappingsControl";

const mapping = (
  projectId: string | null,
  folder: string,
  includeSubprojects = false,
): ProjectSyncMappingValue => ({
  id: `mapping-${projectId ?? "empty"}-${folder}`,
  project:
    projectId === null
      ? null
      : {
          projectId,
          projectName: projectId,
        },
  folder,
  includeSubprojects,
  previousFolders: [],
});

describe("validateProjectSyncMappings", () => {
  it("reports incomplete rows, unavailable projects, and missing folders inline", () => {
    const project = makeProject("available");
    const result = validateProjectSyncMappings(
      [mapping(null, ""), mapping("deleted", "Missing")],
      [project],
      ["Todoist/Available"],
    );

    expect(result.valid).toBe(false);
    expect(result.issues[0]).toEqual(["projectRequired", "folderRequired"]);
    expect(result.issues[1]).toEqual(["projectUnavailable", "folderMissing"]);
  });

  it("rejects duplicate Todoist projects and overlapping Vault folders", () => {
    const project = makeProject("work");
    const result = validateProjectSyncMappings(
      [mapping(project.id, "Todoist/Work"), mapping(project.id, "Todoist/Work/Archive")],
      [project],
      ["Todoist/Work", "Todoist/Work/Archive"],
    );

    expect(result.issues[0]).toEqual(["duplicateProject", "folderOverlap"]);
    expect(result.issues[1]).toEqual(["duplicateProject", "folderOverlap"]);
  });

  it("detects portable folder overlap across case and Unicode normalization", () => {
    const first = makeProject("first");
    const second = makeProject("second");
    const composed = "Todoist/Caf\u00e9";
    const decomposedChild = "todoist/cafe\u0301/Archive";
    const result = validateProjectSyncMappings(
      [mapping(first.id, composed), mapping(second.id, decomposedChild)],
      [first, second],
      [composed, decomposedChild],
    );

    expect(result.issues[0]).toContain("folderOverlap");
    expect(result.issues[1]).toContain("folderOverlap");
  });

  it("rejects another mapping that reuses a registered previous projection root", () => {
    const first = makeProject("first");
    const second = makeProject("second");
    const migrated = {
      ...mapping(first.id, "Todoist/New"),
      previousFolders: ["Todoist/Old"],
    };
    const result = validateProjectSyncMappings(
      [migrated, mapping(second.id, "Todoist/Old/Second")],
      [first, second],
      ["Todoist/New", "Todoist/Old", "Todoist/Old/Second"],
    );

    expect(result.issues[0]).toContain("folderOverlap");
    expect(result.issues[1]).toContain("folderOverlap");
  });

  it("requires the configured folder to match an existing Vault path exactly", () => {
    const project = makeProject("work");
    const result = validateProjectSyncMappings(
      [mapping(project.id, "todoist/work")],
      [project],
      ["Todoist/Work"],
    );

    expect(result.issues[0]).toContain("folderMissing");
    expect(result.valid).toBe(false);
  });

  it("does not treat a Unicode-normalization variant as the existing Vault folder", () => {
    const project = makeProject("work");
    const result = validateProjectSyncMappings(
      [mapping(project.id, "Todoist/Café")],
      [project],
      ["Todoist/Café"],
    );

    expect(result.issues[0]).toContain("folderMissing");
    expect(result.valid).toBe(false);
  });

  it("rejects a descendant mapping already covered by an included hierarchy", () => {
    const root = makeProject("work");
    const child = makeProject("planning", { parentId: root.id });
    const result = validateProjectSyncMappings(
      [mapping(root.id, "Todoist/Work", true), mapping(child.id, "Todoist/Planning")],
      [root, child],
      ["Todoist/Work", "Todoist/Planning"],
    );

    expect(result.issues[0]).toContain("hierarchyOverlap");
    expect(result.issues[1]).toContain("hierarchyOverlap");
  });

  it("accepts multiple disjoint mappings and a separately mapped child", () => {
    const root = makeProject("work");
    const child = makeProject("planning", { parentId: root.id });
    const personal = makeProject("personal");
    const result = validateProjectSyncMappings(
      [
        mapping(root.id, "Todoist/Work"),
        mapping(child.id, "Todoist/Planning"),
        mapping(personal.id, "Todoist/Personal", true),
      ],
      [root, child, personal],
      ["Todoist/Work", "Todoist/Planning", "Todoist/Personal"],
    );

    expect(result).toEqual({ issues: [[], [], []], valid: true });
  });

  it("keeps an empty list or loading project metadata invalid", () => {
    const project = makeProject("work");

    expect(validateProjectSyncMappings([], [project], ["Todoist/Work"]).valid).toBe(false);
    expect(
      validateProjectSyncMappings(
        [mapping(project.id, "Todoist/Work")],
        [project],
        ["Todoist/Work"],
        false,
      ).valid,
    ).toBe(false);
  });
});

describe("ProjectSyncMappingsControl", () => {
  const renderControl = (mappings: ProjectSyncMappingValue[]) => {
    const project = makeProject("work", { name: "Work" });
    const onChange = vi.fn(async () => undefined);
    const onValidityChange = vi.fn();
    const plugin = {
      app: {
        vault: {
          getAllFolders: () => [{ path: "Todoist/Work" }],
        },
      },
      services: {
        todoist: {
          isReady: () => true,
          listActiveProjects: () => [project],
        },
      },
    } as unknown as TodoistPlugin;
    const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
      <PluginContext.Provider value={plugin}>{children}</PluginContext.Provider>
    );

    return {
      ...render(
        <ProjectSyncMappingsControl
          mappings={mappings}
          onChange={onChange}
          onValidityChange={onValidityChange}
        />,
        { wrapper: Wrapper },
      ),
      onChange,
      onValidityChange,
      project,
    };
  };

  it("renders native mapping cards with exact-root guidance and inline validation", async () => {
    const view = renderControl([mapping(null, "Missing")]);

    expect(screen.getByText("Project mapping 1")).toBeInTheDocument();
    expect(
      screen.getByText("This is the selected project's root folder, not its parent."),
    ).toBeInTheDocument();
    expect(screen.getByText("Select a Todoist project.")).toBeInTheDocument();
    expect(screen.getByText("This Vault folder does not exist.")).toBeInTheDocument();
    const projectControl = screen.getByRole("combobox", {
      name: "Todoist project, Project mapping 1",
    });
    const folderControl = screen.getByLabelText("Vault folder, Project mapping 1");
    expect(projectControl).toHaveAccessibleDescription("Select a Todoist project.");
    expect(folderControl).toHaveAccessibleDescription(
      "This is the selected project's root folder, not its parent. This Vault folder does not exist.",
    );
    await waitFor(() => expect(view.onValidityChange).toHaveBeenLastCalledWith(false, true));
  });

  it("shows the registered source folders while a root move is still pending", () => {
    const pending = {
      ...mapping("work", "Todoist/Work"),
      previousFolders: ["Todoist/Old Work"],
    };

    renderControl([pending]);

    expect(screen.getByText("Historical Sync roots")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Monitoring for late Obsidian Sync files and migrating managed notes from: Todoist/Old Work",
      ),
    ).toBeInTheDocument();
  });

  it("adds mappings through an explicit control", async () => {
    const initial = mapping("work", "Todoist/Work");
    const view = renderControl([initial]);

    fireEvent.click(screen.getByRole("button", { name: "Add project mapping" }));
    await waitFor(() =>
      expect(view.onChange).toHaveBeenCalledWith(
        [
          initial,
          expect.objectContaining({
            id: expect.any(String),
            project: null,
            folder: "",
            includeSubprojects: false,
            previousFolders: [],
          }),
        ],
        false,
      ),
    );
  });

  it("removes mappings through an explicit control", async () => {
    const initial = mapping("work", "Todoist/Work");
    const view = renderControl([initial]);

    fireEvent.click(screen.getByRole("button", { name: "Remove project mapping 1" }));
    await waitFor(() => expect(view.onChange).toHaveBeenCalledWith([], false));
  });

  it("does not lose mappings when add is activated twice before the parent rerenders", async () => {
    const view = renderControl([]);
    const add = screen.getByRole("button", { name: "Add project mapping" });

    fireEvent.click(add);
    fireEvent.click(add);

    await waitFor(() => expect(view.onChange).toHaveBeenCalledTimes(2));
    const calls = view.onChange.mock.calls as unknown as [ProjectSyncMappingValue[], boolean][];
    const latestMappings = calls[1]?.[0] ?? [];
    expect(latestMappings).toHaveLength(2);
    expect(new Set(latestMappings.map((candidate) => candidate.id)).size).toBe(2);
  });
});
