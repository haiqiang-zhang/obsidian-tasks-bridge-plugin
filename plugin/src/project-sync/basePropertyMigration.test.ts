import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";

import { migrateBasePropertyReferences } from "./basePropertyMigration";

const fallback = (canonical: string, legacy: string): string =>
  `if(${legacy === "todoist_task_id" ? "" : 'note["task id"] != null && '}note["${canonical}"] != null, note["${canonical}"], note.${legacy})`;

describe("Base task property migration", () => {
  it("migrates nested global/view filters and formulas without altering strings, URLs, regex, or comments", () => {
    const input = `# Keep this comment mentioning todoist_status
filters:
  and:
    - 'note.todoist_status == "active"' # retain inline comment
    - not:
        - 'todoist_completed == true'
formulas:
  label: '"todoist_content" + note["todoist_content"]'
  url: 'link("https://example.com/todoist_status")'
  matcher: '/todoist_status/.matches(note.todoist_content)'
views:
  - type: table
    name: todoist_status
    filters: "note.todoist_priority == 'P1'"
`;
    const result = migrateBasePropertyReferences(input);
    expect(result.issues).toEqual([]);
    expect(result.changed).toBe(true);
    const parsed = loadYaml(result.text) as {
      filters: { and: [string, { not: string[] }] };
      formulas: Record<string, string>;
      views: { name: string; filters: string }[];
    };
    expect(parsed.filters.and[0]).toBe(`${fallback("status", "todoist_status")} == "active"`);
    expect(parsed.filters.and[1].not[0]).toBe(
      `${fallback("completed", "todoist_completed")} == true`,
    );
    expect(parsed.formulas.label).toBe(
      `"todoist_content" + ${fallback("content", "todoist_content")}`,
    );
    expect(parsed.formulas.url).toBe('link("https://example.com/todoist_status")');
    expect(parsed.formulas.matcher).toBe(
      `/todoist_status/.matches(${fallback("content", "todoist_content")})`,
    );
    expect(parsed.views[0]?.name).toBe("todoist_status");
    expect(result.text).toContain("# Keep this comment mentioning todoist_status");
    expect(result.text).toContain("# retain inline comment");
    expect(migrateBasePropertyReferences(result.text)).toEqual({
      text: result.text,
      changed: false,
      issues: [],
    });
  });

  it("keeps native columns editable and uses compatible formulas only for grouping and sorting", () => {
    const input = `properties:
  note.todoist_status:
    displayName: todoist_status
views:
  - type: table
    order: [file.name, note.todoist_status, todoist_due_date]
    groupBy: {property: todoist_status, direction: ASC}
    sort: [{property: note.todoist_due_date, direction: DESC}]
    summaries: {todoist_due_date: Latest}
    columnSize: {note.todoist_status: 180}
    groupOrder: [active, completed]
`;
    const result = migrateBasePropertyReferences(input);
    expect(result.issues).toEqual([]);
    const parsed = loadYaml(result.text) as Record<string, unknown>;
    expect(parsed.formulas).toEqual({
      "tasks bridge status": fallback("status", "todoist_status"),
      "tasks bridge due date": fallback("due date", "todoist_due_date"),
    });
    expect(parsed.properties).toEqual({ "note.status": { displayName: "todoist_status" } });
    expect(parsed.views).toEqual([
      {
        type: "table",
        order: ["file.name", "note.status", "note.due date"],
        groupBy: { property: "formula.tasks bridge status", direction: "ASC" },
        sort: [{ property: "formula.tasks bridge due date", direction: "DESC" }],
        summaries: { "note.due date": "Latest" },
        columnSize: { "note.status": 180 },
        groupOrder: ["active", "completed"],
      },
    ]);
    expect(migrateBasePropertyReferences(result.text).changed).toBe(false);
  });

  it("adds formulas safely to flow and block mappings without overwriting existing formulas", () => {
    for (const input of [
      'formulas:\n  "tasks bridge status": "42" # personal formula\nviews: [{groupBy: {property: todoist_status}}]\n',
      '{formulas: {"tasks bridge status": "42"}, views: [{groupBy: {property: todoist_status}}]}',
      "formulas: {}\nviews: [{groupBy: {property: todoist_status}}]\n",
      "{views: [{groupBy: {property: todoist_status}}]}",
    ]) {
      const result = migrateBasePropertyReferences(input);
      expect(result.issues, input).toEqual([]);
      expect(result.changed).toBe(true);
      const parsed = loadYaml(result.text) as {
        formulas: Record<string, string>;
        views: { groupBy: { property: string } }[];
      };
      const property = parsed.views[0]?.groupBy.property ?? "";
      expect(parsed.formulas[property.slice("formula.".length)]).toBe(
        fallback("status", "todoist_status"),
      );
      if (input.includes('"42"')) {
        expect(parsed.formulas["tasks bridge status"]).toBe("42");
        expect(property).toBe("formula.tasks bridge status 2");
      }
      expect(migrateBasePropertyReferences(result.text).changed).toBe(false);
    }
  });

  it("keeps already-generated fallbacks stable, including empty strings, false and zero values", () => {
    const input = `filters: '${fallback("status", "todoist_status")} == "active" && note.todoist_completed == false && todoist_duration == 0'\n`;
    const result = migrateBasePropertyReferences(input);
    expect(result.issues).toEqual([]);
    expect(loadYaml(result.text)).toEqual({
      filters: `${fallback("status", "todoist_status")} == "active" && ${fallback("completed", "todoist_completed")} == false && ${fallback("duration", "todoist_duration")} == 0`,
    });
    expect(migrateBasePropertyReferences(result.text)).toEqual({
      text: result.text,
      changed: false,
      issues: [],
    });
  });

  it("supports this and file.properties references but preserves similarly named formula references", () => {
    const input = `formulas:\n  result: 'this.todoist_status == file.properties["todoist_status"] && formula.todoist_status == "todoist_status"'\n`;
    const result = migrateBasePropertyReferences(input);
    expect(result.issues).toEqual([]);
    expect(loadYaml(result.text)).toEqual({
      formulas: {
        result:
          'if(this["task id"] != null && this["status"] != null, this["status"], this.todoist_status) == if(file.properties["task id"] != null && file.properties["status"] != null, file.properties["status"], file.properties.todoist_status) && formula.todoist_status == "todoist_status"',
      },
    });
  });

  it.each([
    `filters: 'note["todoist_" + "status"] == "active"'\n`,
    `filters: 'value["todoist_status"] == "active"'\n`,
    `filters: 'file.hasProperty("todoist_status")'\n`,
    "views: [{type: custom, customProperty: note.todoist_status}]\n",
    'filters: \'note["todoist_" + "status"] == "active" && todoist_content != ""\'\n',
    "filters: 'value.todoist_status == \"active\"'\n",
    'filters: |\n  note.todoist_status == "active"\n',
    "filters: &condition 'note.todoist_status == \"active\"'\nviews: [{filters: *condition}]\n",
    'filters: "todoist_status == true"\nfilters: "todoist_completed"\n',
    'filters: {unexpected: "todoist_status"}\n',
  ])("preserves the entire original on ambiguous or unsupported input: %s", (input) => {
    const result = migrateBasePropertyReferences(input);
    expect(result.text).toBe(input);
    expect(result.changed).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("leaves literal-only references and legacy implementation fields unchanged", () => {
    const input =
      "filters: 'todoist_sync_managed && file.inFolder(\"todoist_status\")'\nviews: [{name: todoist_content}]\n";
    expect(migrateBasePropertyReferences(input)).toEqual({
      text: input,
      changed: false,
      issues: [],
    });
  });
});
