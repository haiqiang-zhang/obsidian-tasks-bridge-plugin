import { describe, expect, it } from "vitest";

import { makeProject } from "@/factories/data";

import { makeProjectSegments, makeTaskFilename, sanitizePathSegment, truncateUtf8 } from "./paths";

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

  it("uses the task title with Obsidian-style collision suffixes", () => {
    expect(makeTaskFilename("Read RFC")).toBe("Read RFC.md");
    expect(makeTaskFilename("Read RFC", 2)).toBe("Read RFC (2).md");
    expect(makeTaskFilename("...")).toBe("Untitled task.md");
  });

  it("keeps the complete Unicode filename within its UTF-8 byte budget", () => {
    const canonical = makeTaskFilename("网络任务".repeat(100));
    const collision = makeTaskFilename("网络任务".repeat(100), 237);

    expect(new TextEncoder().encode(canonical).length).toBeLessThanOrEqual(200);
    expect(new TextEncoder().encode(collision).length).toBeLessThanOrEqual(200);
    expect(canonical.endsWith(".md")).toBe(true);
    expect(collision.endsWith(" (237).md")).toBe(true);
  });

  it("disambiguates equal sibling project names with project IDs", () => {
    const root = makeProject("root", { name: "Root" });
    const first = makeProject("one", { name: "Same", parentId: root.id });
    const second = makeProject("two", { name: "Same", parentId: root.id });
    const segments = makeProjectSegments([root, first, second]);

    expect(segments.get(first.id)).toBe("Same -- one");
    expect(segments.get(second.id)).toBe("Same -- two");
  });

  it("disambiguates sibling names that collide on case-insensitive file systems", () => {
    const root = makeProject("root", { name: "Root" });
    const upper = makeProject("upper", { name: "Work", parentId: root.id });
    const lower = makeProject("lower", { name: "work", parentId: root.id });
    const segments = makeProjectSegments([root, upper, lower]);

    expect(segments.get(upper.id)).toBe("Work -- upper");
    expect(segments.get(lower.id)).toBe("work -- lower");
  });
});
