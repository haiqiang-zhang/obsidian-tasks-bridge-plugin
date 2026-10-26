import type { TFile } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { preserveTaskRelationshipLink } from "./taskRelationshipLinks";

const target = { path: "Tasks/Parent/Read notes.task.md" } as TFile;
const sourcePath = "Tasks/Parent/Parent.task.md";

describe("stable task relationship links", () => {
  it.each([
    ["[[Tasks/Parent/Read notes.task|Read notes]]", "Tasks/Parent/Read notes.task"],
    ["[[Read notes.task|Read notes]]", "Read notes.task"],
    ["[[Read notes]]", "Read notes"],
    ["[Read notes](Read%20notes.task.md)", "Read notes.task.md"],
    ["[Read notes](../Parent/Read%20notes.task.md)", "../Parent/Read notes.task.md"],
    ["[Read notes](Tasks/Parent/Read%20notes.task.md)", "Tasks/Parent/Read notes.task.md"],
  ])("preserves the existing representation %s when its destination and label match", (current, path) => {
    const generate = vi.fn(() => "a different native link representation");
    const resolve = vi.fn(() => target);

    expect(
      preserveTaskRelationshipLink(current, target, sourcePath, "Read notes", generate, resolve),
    ).toBe(current);
    expect(resolve).toHaveBeenCalledExactlyOnceWith(path, sourcePath);
    expect(generate).not.toHaveBeenCalled();
  });

  it.each([
    "[[Read notes.task|Old title]]",
    "[[Read notes.task#Heading|Read notes]]",
    "[Read notes](Read%20notes.task.md#Heading)",
    "[Read notes](https://example.com/Read%20notes.task.md)",
    "[Read notes](Read%ZZnotes.task.md)",
    "![[Read notes.task|Read notes]]",
    "ordinary text",
  ])("regenerates a link that is not an equivalent file relationship: %s", (current) => {
    const generate = vi.fn(() => "[[Tasks/Parent/Read notes.task|Read notes]]");

    expect(
      preserveTaskRelationshipLink(
        current,
        target,
        sourcePath,
        "Read notes",
        generate,
        () => target,
      ),
    ).toBe("[[Tasks/Parent/Read notes.task|Read notes]]");
    expect(generate).toHaveBeenCalledOnce();
  });

  it.each([
    null,
    { path: "Other/Read notes.task.md" } as TFile,
  ])("regenerates unresolved or differently resolved links", (resolved) => {
    const generate = vi.fn(() => "[[Tasks/Parent/Read notes.task|Read notes]]");
    preserveTaskRelationshipLink(
      "[[Read notes.task|Read notes]]",
      target,
      sourcePath,
      "Read notes",
      generate,
      () => resolved,
    );
    expect(generate).toHaveBeenCalledOnce();
  });
});
