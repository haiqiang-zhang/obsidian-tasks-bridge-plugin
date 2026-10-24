import { act } from "@testing-library/react";
import { dump } from "js-yaml";
import type {
  CachedMetadata,
  EventRef,
  MarkdownPostProcessorContext,
  MarkdownRenderChild,
  TFile,
} from "obsidian";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type TodoistPlugin from "@/index";
import type { ProjectTaskCardActions, ProjectTaskCardModel } from "@/ui/projectTaskCard";

import { MANAGED_BODY_END, MANAGED_BODY_START, makeManagedTaskIdentityMarker } from "./document";
import { TaskDocumentEmbeds } from "./taskDocumentEmbeds";

type FakeEventRef = EventRef & { dispose(): void };
const rendered = vi.hoisted(() => ({
  props: [] as { task: ProjectTaskCardModel; actions: ProjectTaskCardActions }[],
}));

vi.mock("obsidian", async (importOriginal) => {
  const original = await importOriginal<typeof import("obsidian")>();
  return {
    ...original,
    parseLinktext: (source: string) => {
      const hash = source.indexOf("#");
      return hash < 0
        ? { path: source, subpath: "" }
        : { path: source.slice(0, hash), subpath: source.slice(hash) };
    },
    MarkdownRenderChild: class extends original.MarkdownRenderChild {
      private events: FakeEventRef[] = [];
      load(): void {
        this.onload();
      }
      unload(): void {
        this.onunload();
        for (const event of this.events.splice(0)) {
          event.dispose();
        }
      }
      onload(): void {}
      onunload(): void {}
      registerEvent(event: EventRef): void {
        this.events.push(event as FakeEventRef);
      }
    },
  };
});

vi.mock("@/ui/projectTaskCard", () => ({
  ProjectTaskCard: (props: { task: ProjectTaskCardModel; actions: ProjectTaskCardActions }) => {
    rendered.props.push(props);
    return createElement("div", { className: "tasks-bridge-note-card" }, props.task.content);
  },
}));

const properties = (id = "task-1", content = "Embedded task") => ({
  "task id": id,
  content,
  status: "active",
  completed: false,
  "project path": ["Study"],
  url: `https://app.todoist.com/app/task/${id}`,
});
const sourceText = (frontmatter: Record<string, unknown>, region?: string) =>
  `---\n${dump(frontmatter)}---\n\n${MANAGED_BODY_START}\n${region ?? makeManagedTaskIdentityMarker(String(frontmatter["task id"]))}\n${MANAGED_BODY_END}\n\nUser body.\n`;

const makeHarness = () => {
  const listeners = new Map<string, Set<() => void>>();
  const register = (scope: string) => (event: string, listener: () => void) => {
    const key = `${scope}:${event}`;
    const group = listeners.get(key) ?? new Set();
    group.add(listener);
    listeners.set(key, group);
    return { dispose: () => group.delete(listener) } as unknown as FakeEventRef;
  };
  const files: TFile[] = [];
  const caches = new Map<string, CachedMetadata>();
  const contents = new Map<string, string>();
  const cachedRead = vi.fn(async (file: TFile) => contents.get(file.path) ?? "");
  const getFirstLinkpathDest = vi.fn((path: string, source: string) => {
    const relative = `${source.slice(0, source.lastIndexOf("/") + 1)}${path}`;
    return (
      files.find((file) => [path, `${path}.md`, relative, `${relative}.md`].includes(file.path)) ??
      null
    );
  });
  const services = {
    projectTasks: {
      setCompleted: vi.fn(async () => ({ projection: Promise.resolve() })),
      loadEditableTask: vi.fn(async () => ({ id: "task-1" })),
      updateTask: vi.fn(async () => undefined),
    },
    modals: { taskEdit: vi.fn() },
  };
  const openLinkText = vi.fn(async () => undefined);
  const plugin = {
    app: {
      vault: {
        cachedRead,
        getMarkdownFiles: () => files,
        getFileByPath: (path: string) => files.find((file) => file.path === path) ?? null,
        on: register("vault"),
      },
      metadataCache: {
        getFileCache: (file: TFile) => caches.get(file.path),
        getFirstLinkpathDest,
        on: register("metadata"),
      },
      workspace: { openLinkText },
    },
    services,
  } as unknown as TodoistPlugin;
  const embeds = new TaskDocumentEmbeds(plugin);
  const children: MarkdownRenderChild[] = [];
  const context = (sourcePath = "Dashboard.md") =>
    ({
      sourcePath,
      addChild: (child: MarkdownRenderChild) => {
        children.push(child);
        child.load();
      },
    }) as unknown as MarkdownPostProcessorContext;
  const addFile = (
    path = "Projects/Example.task.md",
    frontmatter = properties(),
    region?: string,
  ) => {
    const file = { path } as TFile;
    files.push(file);
    caches.set(path, { frontmatter } as CachedMetadata);
    contents.set(path, sourceText(frontmatter, region));
    return file;
  };
  return {
    addFile,
    cachedRead,
    caches,
    children,
    contents,
    context,
    embeds,
    files,
    getFirstLinkpathDest,
    listeners,
    openLinkText,
    services,
    emit: (scope: string, event: string) => {
      for (const listener of listeners.get(`${scope}:${event}`) ?? []) {
        listener();
      }
    },
  };
};

const makeEmbed = (src = "Projects/Example.task.md", ready = true, doc = document) => {
  const embed = doc.createElement("div");
  embed.className = "internal-embed markdown-embed";
  embed.setAttribute("src", src);
  const title = doc.createElement("div");
  title.className = "markdown-embed-title";
  title.textContent = "Example.task";
  const content = doc.createElement("div");
  content.className = "markdown-embed-content";
  const preview = doc.createElement("div");
  preview.className = "markdown-preview-view";
  preview.innerHTML =
    '<div class="markdown-preview-sizer"><div class="mod-header"><div class="metadata-container">Properties</div></div><p>User body.</p></div>';
  embed.append(title, content);
  if (ready) {
    content.append(preview);
  }
  return { embed, title, content, preview };
};

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(100);
  });
};

describe("native task document embeds", () => {
  const active: TaskDocumentEmbeds[] = [];
  const setup = () => {
    const harness = makeHarness();
    active.push(harness.embeds);
    return harness;
  };
  beforeEach(() => {
    vi.useFakeTimers();
    rendered.props.length = 0;
  });
  afterEach(async () => {
    await act(async () => {
      for (const embeds of active.splice(0)) {
        embeds.dispose();
      }
    });
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("adds one card to a detached full-file embed while preserving the native body and preview", async () => {
    const harness = setup();
    harness.addFile();
    const native = makeEmbed();
    const originalHtml = native.preview.innerHTML;
    harness.embeds.onPostProcessor(native.embed, harness.context());
    harness.embeds.onPostProcessor(native.embed, harness.context());
    await flush();

    expect(native.content.firstElementChild).toHaveClass("tasks-bridge-task-embed-card");
    expect(native.content.querySelectorAll(".tasks-bridge-note-card")).toHaveLength(1);
    expect(native.content.firstElementChild).toHaveTextContent("Embedded task");
    expect(native.preview.innerHTML).toBe(originalHtml);
    expect(native.content.lastElementChild).toBe(native.preview);
    expect(native.embed).toHaveClass("tasks-bridge-task-embed");
    expect(harness.children).toHaveLength(1);
  });

  it("waits for asynchronous native embed rendering and restores its card after a native rebuild", async () => {
    const harness = setup();
    harness.addFile();
    const native = makeEmbed(undefined, false);
    harness.embeds.onPostProcessor(native.embed, harness.context());
    await flush();
    expect(native.content.querySelector(".tasks-bridge-note-card")).toBeNull();
    native.content.append(native.preview);
    await flush();
    expect(native.content.querySelectorAll(".tasks-bridge-note-card")).toHaveLength(1);

    native.content.replaceChildren(native.preview);
    await flush();
    expect(native.content.querySelectorAll(".tasks-bridge-note-card")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves heading/block embeds and ordinary files entirely native", async () => {
    const harness = setup();
    harness.addFile();
    harness.addFile("Projects/Ordinary.md", properties("ordinary"));
    const section = document.createElement("div");
    const nativeEmbeds = [
      makeEmbed("Projects/Example.task.md#Notes"),
      makeEmbed("Projects/Example.task.md#^paragraph"),
      makeEmbed("Projects/Ordinary.md"),
      makeEmbed("Projects/Example.task.md"),
    ];
    nativeEmbeds[3].embed.dataset.type = "heading";
    for (const native of nativeEmbeds) {
      section.append(native.embed);
    }
    const originalHtml = section.innerHTML;
    harness.embeds.onPostProcessor(section, harness.context());
    await flush();

    expect(section.innerHTML).toBe(originalHtml);
    expect(harness.children).toHaveLength(0);
    expect(harness.cachedRead).not.toHaveBeenCalled();
  });

  it("does not add a duplicate card to historical generated blocks or invalid protocols", async () => {
    const harness = setup();
    const file = harness.addFile(
      undefined,
      properties(),
      "```tasks-bridge-project-task\ntask_id: task-1\n```",
    );
    const native = makeEmbed();
    harness.embeds.onPostProcessor(native.embed, harness.context());
    await flush();
    expect(native.embed.querySelector(".tasks-bridge-note-card")).toBeNull();
    harness.contents.set(
      file.path,
      sourceText(properties(), makeManagedTaskIdentityMarker("different")),
    );
    harness.emit("metadata", "changed");
    await flush();
    expect(native.embed.querySelector(".tasks-bridge-note-card")).toBeNull();
    expect(native.embed).not.toHaveClass("tasks-bridge-task-embed");
  });

  it("rerenders metadata and removes ambiguous or invalid task models", async () => {
    const harness = setup();
    const file = harness.addFile();
    const native = makeEmbed();
    harness.embeds.onPostProcessor(native.embed, harness.context());
    await flush();
    const host = native.content.firstElementChild;
    harness.caches.set(file.path, {
      frontmatter: properties("task-1", "New title"),
    } as CachedMetadata);
    harness.emit("metadata", "changed");
    await flush();
    expect(native.content.firstElementChild).toBe(host);
    expect(host).toHaveTextContent("New title");

    const duplicate = harness.addFile("Elsewhere/Duplicate.md");
    harness.emit("metadata", "resolved");
    await flush();
    expect(native.embed.querySelector(".tasks-bridge-note-card")).toBeNull();
    harness.files.splice(harness.files.indexOf(duplicate), 1);
    harness.emit("vault", "delete");
    await flush();
    expect(native.embed.querySelector(".tasks-bridge-note-card")).toHaveTextContent("New title");

    harness.caches.delete(file.path);
    harness.emit("metadata", "changed");
    await flush();
    expect(native.embed.querySelector(".tasks-bridge-note-card")).toBeNull();
  });

  it("uses each nested embed's source context for relative links", async () => {
    const harness = setup();
    harness.addFile("Projects/Parent.task.md", properties("parent"));
    harness.addFile("Projects/Child.task.md", properties("child"));
    const outer = makeEmbed("Projects/Parent.task.md");
    const inner = makeEmbed("Child.task.md");
    const innerSection = document.createElement("div");
    innerSection.append(inner.embed);
    outer.preview.append(innerSection);

    harness.embeds.onPostProcessor(outer.embed, harness.context("Dashboard.md"));
    expect(harness.children).toHaveLength(1);
    harness.embeds.onPostProcessor(innerSection, harness.context("Projects/Parent.task.md"));
    await flush();
    expect(harness.children).toHaveLength(2);
    expect(inner.embed.querySelector(".tasks-bridge-note-card")).toHaveTextContent("Embedded task");
    expect(harness.getFirstLinkpathDest).toHaveBeenCalledWith(
      "Child.task.md",
      "Projects/Parent.task.md",
    );
  });

  it("removes task styling and controls if the same wrapper changes to a partial embed", async () => {
    const harness = setup();
    harness.addFile();
    const native = makeEmbed();
    harness.embeds.onPostProcessor(native.embed, harness.context());
    await flush();
    native.embed.setAttribute("src", "Projects/Example.task.md#Notes");
    native.embed.dataset.type = "heading";
    await flush();
    expect(native.embed.querySelector(".tasks-bridge-note-card")).toBeNull();
    expect(native.embed).not.toHaveClass("tasks-bridge-task-embed");
    expect(native.preview).toHaveTextContent("User body.");
  });

  it("never remounts the previous task while a recycled embed waits for its new source", async () => {
    const harness = setup();
    harness.addFile();
    const next = harness.addFile("Projects/Next.task.md", properties("task-2", "Next task"));
    const native = makeEmbed();
    harness.embeds.onPostProcessor(native.embed, harness.context());
    await flush();
    expect(native.embed.querySelector(".tasks-bridge-note-card")).toHaveTextContent(
      "Embedded task",
    );

    let finishRead: ((content: string) => void) | undefined;
    harness.cachedRead.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    native.embed.setAttribute("src", next.path);
    await flush();
    expect(native.embed.querySelector(".tasks-bridge-note-card")).toBeNull();
    // A new native source section arrives while the new file read is still pending.
    native.preview.append(document.createElement("p"));
    await flush();
    expect(native.embed.querySelector(".tasks-bridge-note-card")).toBeNull();

    finishRead?.(harness.contents.get(next.path) ?? "");
    await flush();
    expect(native.embed.querySelector(".tasks-bridge-note-card")).toHaveTextContent("Next task");
    expect(native.embed.querySelectorAll(".tasks-bridge-note-card")).toHaveLength(1);
  });

  it("cleans renderer events and ignores a read that finishes after plugin unload", async () => {
    const harness = setup();
    const file = harness.addFile();
    const native = makeEmbed();
    let finishRead: ((value: string) => void) | undefined;
    harness.cachedRead.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    harness.embeds.onPostProcessor(native.embed, harness.context());
    await flush();
    await act(async () => harness.embeds.dispose());
    finishRead?.(harness.contents.get(file.path) ?? "");
    await flush();

    expect(native.embed.querySelector(".tasks-bridge-note-card")).toBeNull();
    expect([...harness.listeners.values()].every((group) => group.size === 0)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("removes only its own card and styling when the native Markdown child unloads", async () => {
    const harness = setup();
    harness.addFile();
    const native = makeEmbed();
    harness.embeds.onPostProcessor(native.embed, harness.context());
    await flush();
    await act(async () => harness.children[0].unload());
    expect(native.content.children).toHaveLength(1);
    expect(native.content.firstElementChild).toBe(native.preview);
    expect(native.embed).not.toHaveClass("tasks-bridge-task-embed");
    native.content.replaceChildren(native.preview);
    await flush();
    expect(native.embed.querySelector(".tasks-bridge-note-card")).toBeNull();
  });
});
