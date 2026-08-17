import { describe, expect, it } from "vitest";

import {
  makeProjectFolderSegment,
  makeTaskFilename,
  makeTaskFolderSegment,
  sanitizePathSegment,
  truncateUtf8,
} from "./paths";

describe("project sync paths", () => {
  it("sanitizes cross-platform path characters and reserved names", () => {
    expect(sanitizePathSegment('  A/B\\C:*?"<>|  ', "Fallback")).toBe("A-B-C-");
    expect(sanitizePathSegment("CON", "Fallback")).toBe("CON-item");
    expect(sanitizePathSegment("...", "Fallback")).toBe("Fallback");
  });

  it("truncates Unicode by UTF-8 bytes without splitting code points", () => {
    const value = truncateUtf8("网络任务", 7);
    expect(value).toBe("网络");
    expect(new TextEncoder().encode(value).length).toBeLessThanOrEqual(7);
  });

  it("uses only the canonical sanitized task title", () => {
    expect(makeTaskFilename("Read RFC")).toBe("Read RFC.md");
    expect(makeTaskFilename("...")).toBe("Untitled task.md");
    expect(makeTaskFilename("Hadoop")).toBe("Hadoop.md");
    expect(makeTaskFolderSegment("Hadoop")).toBe("Hadoop");
  });

  it("keeps unmarked names canonical so the namespace allocator can detect collisions", () => {
    expect(makeTaskFilename("Café")).toBe(makeTaskFilename("Cafe\u0301"));
    expect(makeTaskFilename("A/B")).toBe(makeTaskFilename("A:B"));
    expect(makeTaskFilename(`${"x".repeat(250)}A`)).toBe(makeTaskFilename(`${"x".repeat(250)}B`));
    expect(makeTaskFilename("Same title")).toBe("Same title.md");
    expect(makeTaskFilename("Same title")).not.toContain(" (2)");
  });

  it("uses typed identity markers without ordinal suffixes", () => {
    expect(makeProjectFolderSegment("Algorithms", "p-6fwjvM")).toBe("Algorithms · p-6fwjvM");
    expect(makeTaskFolderSegment("Problem set", "t-6g7v4J")).toBe("Problem set · t-6g7v4J");
    expect(makeTaskFilename("Problem set", "t-6g7v4J")).toBe("Problem set · t-6g7v4J.md");
    expect(makeTaskFilename("Problem set", "t-6g7v4J")).not.toMatch(/ \(\d+\)\.md$/u);
  });

  it("uses matching portable names for parent-task folders and their notes", () => {
    expect(makeTaskFolderSegment("Parent task")).toBe("Parent task");
    expect(makeTaskFilename(makeTaskFolderSegment("Parent task"))).toBe("Parent task.md");
    expect(
      new TextEncoder().encode(makeTaskFolderSegment("网络任务".repeat(100))).length,
    ).toBeLessThanOrEqual(96);
  });

  it("keeps the complete Unicode filename within its UTF-8 byte budget", () => {
    const canonical = makeTaskFilename("网络任务".repeat(100), "t-6g7v4J39V9jhMw2Q");

    expect(new TextEncoder().encode(canonical).length).toBeLessThanOrEqual(200);
    expect(canonical.endsWith(".md")).toBe(true);
    expect(canonical).toContain(" · t-6g7v4J39V9jhMw2Q.md");
  });
});
