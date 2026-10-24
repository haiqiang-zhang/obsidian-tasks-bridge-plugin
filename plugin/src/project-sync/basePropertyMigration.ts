import { load as loadYaml } from "js-yaml";

import { TASK_PROPERTY_NAMES, type TaskPropertyKey } from "./properties";

export type BasePropertyMigrationResult = {
  text: string;
  changed: boolean;
  issues: string[];
};

type YamlNode = {
  start: number;
  end: number;
  kind: string;
  value: unknown;
  children: YamlNode[];
};
type Patch = { start: number; end: number; text: string };
type Token = { start: number; end: number; value: string; kind: "word" | "string" | "other" };

const taskKeys = Object.keys(TASK_PROPERTY_NAMES) as TaskPropertyKey[];
const taskKeySet = new Set<string>(taskKeys);
const referenceRoots = ["note", "this", "file.properties", "this.file.properties"];
const fallbackExpression = (key: TaskPropertyKey, root = "note"): string => {
  const canonical = `${root}[${JSON.stringify(TASK_PROPERTY_NAMES[key])}]`;
  // Generic names such as status may already belong to unrelated/legacy notes. Only use the new
  // schema after its task identity has migrated, so an old Todoist filter cannot gain those notes.
  const identityGuard = key === "todoist_task_id" ? "" : `${root}["task id"] != null && `;
  return `if(${identityGuard}${canonical} != null, ${canonical}, ${root}.${key})`;
};

/**
 * Migrate only schema-defined expression/property slots, preserving YAML comments and user text.
 * Official syntax: https://help.obsidian.md/bases/syntax and /bases/functions. Native property
 * Group/sort selectors receive stable fallback formulas. Displayed columns remain real note
 * properties so native Table cells stay editable; deferred legacy notes may temporarily lack them.
 * Any uncertain syntax leaves the complete document unchanged for the caller to report/block.
 */
export const migrateBasePropertyReferences = (text: string): BasePropertyMigrationResult => {
  if (!text.includes("todoist_")) {
    return { text, changed: false, issues: [] };
  }
  try {
    const root = parseYamlTree(text);
    const rootFields = mapping(root);
    const formulas = rootFields.get("formulas")?.value;
    const formulaFields = formulas === undefined ? new Map() : mapping(formulas);
    const propertyFields = rootFields.get("properties")?.value;
    const configuredProperties = propertyFields === undefined ? new Map() : mapping(propertyFields);
    const patches: Patch[] = [];
    const aliases = new Map<TaskPropertyKey, string>();
    const addedFormulas = new Map<string, string>();

    const replaceScalar = (node: YamlNode, value: string): void => {
      if (node.value === value) {
        return;
      }
      const scalar = unwrap(node);
      const start = skipTrivia(text, scalar.start);
      const token = text[start];
      if (
        scalar.kind !== "scalar" ||
        token === "|" ||
        token === ">" ||
        /[&*!]/u.test(token ?? "")
      ) {
        throw new Error(
          "A task property reference uses a YAML block scalar, anchor, alias, or tag; migrate it manually.",
        );
      }
      let end = scalar.end;
      while (end > start && /\s/u.test(text[end - 1] ?? "")) {
        end--;
      }
      patches.push({ start, end, text: JSON.stringify(value) });
    };

    const aliasFor = (key: TaskPropertyKey): string => {
      const known = aliases.get(key);
      if (known !== undefined) {
        return known;
      }
      const expression = fallbackExpression(key);
      const baseName = `tasks bridge ${TASK_PROPERTY_NAMES[key]}`;
      let name = baseName;
      let suffix = 1;
      while (true) {
        const existing = formulaFields.get(name)?.value.value ?? addedFormulas.get(name);
        if (existing === expression) {
          break;
        }
        if (existing === undefined && !configuredProperties.has(`formula.${name}`)) {
          addedFormulas.set(name, expression);
          break;
        }
        suffix++;
        name = `${baseName} ${suffix}`;
      }
      const property = `formula.${name}`;
      aliases.set(key, property);
      return property;
    };

    const selector = (node: YamlNode, compatible = false): void => {
      if (typeof node.value !== "string") {
        throw new Error("A Base property selector is not a string.");
      }
      const key = node.value.startsWith("note.") ? node.value.slice("note.".length) : node.value;
      if (isTaskKey(key)) {
        replaceScalar(node, compatible ? aliasFor(key) : `note.${TASK_PROPERTY_NAMES[key]}`);
      }
    };
    const expression = (node: YamlNode): void => {
      if (typeof node.value !== "string") {
        throw new Error("A Base expression is not a string.");
      }
      replaceScalar(node, migrateExpression(node.value));
    };
    const filters = (node: YamlNode): void => {
      if (typeof node.value === "string") {
        expression(node);
        return;
      }
      const fields = mapping(node);
      if (fields.size !== 1) {
        throw new Error("Unsupported Base filter object; expected one and/or/not operator.");
      }
      for (const [operator, field] of fields) {
        if (!["and", "or", "not"].includes(operator)) {
          throw new Error(`Unsupported Base filter operator: ${operator}`);
        }
        for (const item of sequence(field.value)) {
          filters(item);
        }
      }
    };
    const propertyMap = (node: YamlNode): void => {
      for (const field of mapping(node).values()) {
        selector(field.key);
      }
    };
    const checkUnrecognizedField = (node: YamlNode, fieldName: string): void => {
      if (typeof node.value === "string") {
        if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(node.value)) {
          return;
        }
        if (migrateExpression(node.value) !== node.value) {
          throw new Error(
            `Custom Base setting "${fieldName}" contains a task reference that needs manual migration.`,
          );
        }
      } else if (node.kind === "sequence") {
        for (const item of sequence(node)) {
          checkUnrecognizedField(item, fieldName);
        }
      } else if (node.kind === "mapping") {
        for (const [name, field] of mapping(node)) {
          if (name !== "name" && name !== "displayName") {
            checkUnrecognizedField(field.value, `${fieldName}.${name}`);
          }
        }
      }
    };

    const rootFilters = rootFields.get("filters");
    if (rootFilters !== undefined) {
      filters(rootFilters.value);
    }
    for (const section of ["formulas", "summaries"]) {
      const field = rootFields.get(section);
      if (field !== undefined) {
        for (const value of mapping(field.value).values()) {
          expression(value.value);
        }
      }
    }
    if (propertyFields !== undefined) {
      propertyMap(propertyFields);
    }
    const views = rootFields.get("views");
    if (views !== undefined) {
      for (const view of sequence(views.value)) {
        const fields = mapping(view);
        const viewFilters = fields.get("filters");
        if (viewFilters !== undefined) {
          filters(viewFilters.value);
        }
        const order = fields.get("order");
        if (order !== undefined) {
          for (const item of sequence(order.value)) {
            selector(item);
          }
        }
        const group = fields.get("groupBy");
        if (group !== undefined && group.value.value !== null) {
          const property = mapping(group.value).get("property");
          if (property !== undefined) {
            selector(property.value, true);
          }
        }
        const sort = fields.get("sort");
        if (sort !== undefined) {
          for (const item of sequence(sort.value)) {
            const property = mapping(item).get("property");
            if (property !== undefined) {
              selector(property.value, true);
            }
          }
        }
        for (const section of ["summaries", "columnSize"]) {
          const field = fields.get(section);
          if (field !== undefined) {
            propertyMap(field.value);
          }
        }
        const recognized = new Set([
          "filters",
          "order",
          "groupBy",
          "sort",
          "summaries",
          "columnSize",
          "type",
          "name",
          "limit",
          "groupOrder",
        ]);
        for (const [name, field] of fields) {
          if (!recognized.has(name)) {
            checkUnrecognizedField(field.value, name);
          }
        }
      }
    }
    for (const [name, field] of rootFields) {
      if (!["filters", "formulas", "summaries", "properties", "views"].includes(name)) {
        checkUnrecognizedField(field.value, name);
      }
    }

    if (addedFormulas.size > 0) {
      if (formulas !== undefined) {
        patches.push(insertMappingEntries(text, formulas, addedFormulas));
      } else {
        const formulaText = `{${[...addedFormulas].map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(", ")}}`;
        patches.push(insertMappingEntries(text, root, new Map([["formulas", formulaText]]), true));
      }
    }
    if (patches.length === 0) {
      return { text, changed: false, issues: [] };
    }
    patches.sort((left, right) => right.start - left.start);
    let previousStart = text.length;
    let migrated = text;
    for (const patch of patches) {
      if (patch.end > previousStart) {
        throw new Error("Overlapping Base edits cannot be migrated safely.");
      }
      migrated = migrated.slice(0, patch.start) + patch.text + migrated.slice(patch.end);
      previousStart = patch.start;
    }
    // Reject malformed/duplicate YAML rather than saving a partially migrated configuration.
    loadYaml(migrated);
    return { text: migrated, changed: true, issues: [] };
  } catch (error: unknown) {
    return {
      text,
      changed: false,
      issues: [error instanceof Error ? error.message : String(error)],
    };
  }
};

const parseYamlTree = (text: string): YamlNode => {
  const stack: YamlNode[] = [];
  let root: YamlNode | undefined;
  loadYaml(text, {
    listener: (event, state) => {
      if (event === "open") {
        const node: YamlNode = {
          start: state.position,
          end: state.position,
          kind: "",
          value: undefined,
          children: [],
        };
        stack[stack.length - 1]?.children.push(node);
        stack.push(node);
      } else {
        const node = stack.pop();
        if (node === undefined) {
          throw new Error("Unexpected YAML parser state.");
        }
        node.end = state.position;
        node.kind = state.kind;
        node.value = state.result;
        root = node;
      }
    },
  });
  if (root === undefined) {
    throw new Error("The Base configuration is empty.");
  }
  return unwrap(root);
};

const unwrap = (node: YamlNode): YamlNode => {
  let current = node;
  while (current.children.length === 1 && current.children[0]?.value === current.value) {
    current = current.children[0];
  }
  return current;
};

const mapping = (node: YamlNode): Map<string, { key: YamlNode; value: YamlNode }> => {
  const current = unwrap(node);
  if (current.kind !== "mapping" || current.children.length % 2 !== 0) {
    throw new Error("Unsupported Base YAML mapping or alias.");
  }
  const fields = new Map<string, { key: YamlNode; value: YamlNode }>();
  for (let index = 0; index < current.children.length; index += 2) {
    const key = current.children[index];
    const value = current.children[index + 1];
    if (typeof key.value !== "string" || value === undefined || key.value === "<<") {
      throw new Error("Unsupported Base YAML key or merged mapping.");
    }
    fields.set(key.value, { key: unwrap(key), value: unwrap(value) });
  }
  return fields;
};

const sequence = (node: YamlNode): YamlNode[] => {
  const current = unwrap(node);
  if (current.kind !== "sequence") {
    throw new Error("Unsupported Base YAML sequence or alias.");
  }
  return current.children.map(unwrap);
};

const skipTrivia = (text: string, position: number): number => {
  let cursor = position;
  while (cursor < text.length) {
    if (/\s/u.test(text[cursor] ?? "")) {
      cursor++;
    } else if (text[cursor] === "#") {
      const newline = text.indexOf("\n", cursor);
      cursor = newline < 0 ? text.length : newline + 1;
    } else {
      break;
    }
  }
  return cursor;
};

const insertMappingEntries = (
  text: string,
  node: YamlNode,
  entries: ReadonlyMap<string, string>,
  rawValues = false,
): Patch => {
  const current = unwrap(node);
  const start = skipTrivia(text, current.start);
  const formatValue = (value: string) => (rawValues ? value : JSON.stringify(value));
  if (text[start] === "{") {
    let end = current.end;
    while (/\s/u.test(text[end - 1] ?? "")) {
      end--;
    }
    if (text[end - 1] !== "}") {
      throw new Error("Cannot locate the end of a flow-style Base mapping.");
    }
    const prefix = current.children.length > 0 ? ", " : "";
    return {
      start: end - 1,
      end: end - 1,
      text:
        prefix +
        [...entries]
          .map(([key, value]) => `${JSON.stringify(key)}: ${formatValue(value)}`)
          .join(", "),
    };
  }
  const firstKey = current.children[0];
  if (firstKey === undefined) {
    throw new Error("Cannot safely append to an empty block-style Base mapping.");
  }
  const keyStart = skipTrivia(text, firstKey.start);
  const lineStart = text.lastIndexOf("\n", keyStart - 1) + 1;
  const indentation = text.slice(lineStart, keyStart);
  if (!/^ *$/u.test(indentation)) {
    throw new Error("Cannot determine Base mapping indentation.");
  }
  const position = Math.min(current.end, text.length);
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const prefix = position > 0 && text[position - 1] !== "\n" ? newline : "";
  return {
    start: position,
    end: position,
    text:
      prefix +
      [...entries]
        .map(
          ([key, value]) => `${indentation}${JSON.stringify(key)}: ${formatValue(value)}${newline}`,
        )
        .join(""),
  };
};

const isTaskKey = (value: string): value is TaskPropertyKey => taskKeySet.has(value);

const tokenize = (source: string): Token[] => {
  const tokens: Token[] = [];
  let position = 0;
  while (position < source.length) {
    const character = source[position] ?? "";
    if (/\s/u.test(character)) {
      position++;
      continue;
    }
    const start = position;
    if (character === "'" || character === '"') {
      const quote = character;
      let value = "";
      position++;
      let closed = false;
      while (position < source.length) {
        const next = source[position++] ?? "";
        if (next === "\\") {
          // Escaped identifiers are intentionally not interpreted as property names.
          value += next + (source[position++] ?? "");
        } else if (next === quote) {
          closed = true;
          break;
        } else {
          value += next;
        }
      }
      if (!closed) {
        throw new Error("Unclosed string in a Base expression.");
      }
      tokens.push({ start, end: position, value, kind: "string" });
      continue;
    }
    if (/[A-Za-z_$]/u.test(character)) {
      position++;
      while (/[A-Za-z0-9_$]/u.test(source[position] ?? "")) {
        position++;
      }
      tokens.push({ start, end: position, value: source.slice(start, position), kind: "word" });
      continue;
    }
    const previous = tokens[tokens.length - 1]?.value;
    if (
      character === "/" &&
      (previous === undefined || ["(", "[", ",", "=", "!", "&", "|", "?", ":"].includes(previous))
    ) {
      position++;
      let inClass = false;
      let closed = false;
      while (position < source.length) {
        const next = source[position++] ?? "";
        if (next === "\\") {
          position++;
        } else if (next === "[") {
          inClass = true;
        } else if (next === "]") {
          inClass = false;
        } else if (next === "/" && !inClass) {
          closed = true;
          break;
        }
      }
      if (!closed) {
        throw new Error("Unclosed regular expression in a Base expression.");
      }
      while (/[a-z]/iu.test(source[position] ?? "")) {
        position++;
      }
      tokens.push({ start, end: position, value: source.slice(start, position), kind: "other" });
      continue;
    }
    if (!/[0-9()[\]{},.:?+*/%!=<>|&-]/u.test(character)) {
      throw new Error("Unsupported syntax in a Base expression containing a legacy task property.");
    }
    position++;
    tokens.push({ start, end: position, value: character, kind: "other" });
  }
  return tokens;
};

const protectedFallbacks = taskKeys.flatMap((key) =>
  referenceRoots.map((root) => tokenize(fallbackExpression(key, root))),
);

const migrateExpression = (source: string): string => {
  if (!source.includes("todoist_")) {
    return source;
  }
  const tokens = tokenize(source);
  const patches: Patch[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const protectedLength =
      token.value === "if"
        ? protectedFallbacks.find((pattern) =>
            pattern.every((expected, offset) => {
              const actual = tokens[index + offset];
              return actual?.value === expected.value && actual?.kind === expected.kind;
            }),
          )?.length
        : undefined;
    if (protectedLength !== undefined) {
      index += protectedLength - 1;
      continue;
    }
    if (token.kind === "string" && isTaskKey(token.value)) {
      const bracketLookup = tokens[index - 1]?.value === "[";
      const method = tokens[index - 2]?.value;
      if (
        bracketLookup ||
        (tokens[index - 1]?.value === "(" && (method === "get" || method === "hasProperty"))
      ) {
        throw new Error("An indirect Base task-property lookup needs manual migration.");
      }
    }
    if (token.kind !== "word") {
      continue;
    }
    let root = "note";
    let key: TaskPropertyKey | undefined;
    let endIndex = index;
    if (
      isTaskKey(token.value) &&
      tokens[index - 1]?.value !== "." &&
      tokens[index + 1]?.value !== "("
    ) {
      if (tokens[index + 1]?.value === ":") {
        continue;
      }
      key = token.value;
    } else if (tokens[index - 1]?.value !== ".") {
      for (const candidate of referenceRoots) {
        const rootTokens = candidate
          .split(".")
          .flatMap((part, partIndex) => (partIndex === 0 ? [part] : [".", part]));
        if (!rootTokens.every((value, offset) => tokens[index + offset]?.value === value)) {
          continue;
        }
        const next = index + rootTokens.length;
        const directAccess = tokens[next]?.value === ".";
        const bracketAccess = tokens[next]?.value === "[" && tokens[next + 2]?.value === "]";
        const property = directAccess || bracketAccess ? tokens[next + 1] : undefined;
        if (
          property !== undefined &&
          isTaskKey(property.value) &&
          (tokens[next]?.value === "." ? property.kind === "word" : property.kind === "string")
        ) {
          root = candidate;
          key = property.value;
          endIndex = next + (tokens[next]?.value === "." ? 1 : 2);
          break;
        }
        if (tokens[next]?.value === "[" && tokens[next + 2]?.value !== "]") {
          const closing = tokens.findIndex((item, offset) => offset > next && item.value === "]");
          if (source.slice(tokens[next]?.start, tokens[closing]?.end).includes("todoist_")) {
            throw new Error("A dynamic Base property lookup needs manual migration.");
          }
        }
      }
    }
    if (key !== undefined) {
      patches.push({
        start: token.start,
        end: tokens[endIndex].end,
        text: fallbackExpression(key, root),
      });
      index = endIndex;
    } else if (isTaskKey(token.value) && tokens[index - 2]?.value !== "formula") {
      throw new Error(`Unsupported task property reference in a Base expression: ${token.value}`);
    }
  }
  let migrated = source;
  for (const patch of patches.reverse()) {
    migrated = migrated.slice(0, patch.start) + patch.text + migrated.slice(patch.end);
  }
  return migrated;
};
