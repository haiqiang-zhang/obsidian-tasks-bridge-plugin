import { registry } from "@tasks-bridge/plugin/src/i18n";

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STATUS_START = "<!-- translation-status:start -->";
const STATUS_END = "<!-- translation-status:end -->";
const FULL_PERCENT = 100;

const countKeys = (obj: Record<string, unknown>): number => {
  let count = 0;

  for (const key in obj) {
    count++;
    const value = obj[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      count += countKeys(value as Record<string, unknown>);
    }
  }

  return count;
};

type TranslationStatus = {
  name: string;
  code: string;
  completed: number;
};

const tabulateTranslations = (reg: typeof registry): TranslationStatus[] => {
  const result: TranslationStatus[] = [];

  for (const definition of Object.values(reg)) {
    const completed = countKeys(definition.translations);

    result.push({
      name: definition.name,
      code: definition.code,
      completed,
    });
  }

  return result;
};

type Output = {
  total: number;
  statuses: TranslationStatus[];
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const renderStatusTable = ({ total, statuses }: Output): string => {
  const rows = statuses.map(({ name, code, completed }) => {
    const missing = Math.max(0, total - completed);
    const percentage = total === 0 ? FULL_PERCENT : Math.round((completed / total) * FULL_PERCENT);

    return [
      "    <tr>",
      `      <td>${escapeHtml(name)} (${escapeHtml(code)})</td>`,
      `      <td>${completed}</td>`,
      `      <td>${missing}</td>`,
      `      <td><span class="translation-progress"><span>${percentage}%</span><progress value="${completed}" max="${total}"></progress></span></td>`,
      "    </tr>",
    ].join("\n");
  });

  return [
    STATUS_START,
    '<table class="translation-status">',
    "  <thead>",
    "    <tr>",
    "      <th>Language</th>",
    "      <th>Completed</th>",
    "      <th>Missing</th>",
    "      <th>Percent complete</th>",
    "    </tr>",
    "  </thead>",
    "  <tbody>",
    ...rows,
    "  </tbody>",
    "</table>",
    STATUS_END,
  ].join("\n");
};

const updateStatusPage = (output: Output): void => {
  const pagePath = join(__dirname, "..", "..", "docs", "docs", "contributing", "translation.md");
  const page = readFileSync(pagePath, "utf8");
  const startIndex = page.indexOf(STATUS_START);
  const endIndex = page.indexOf(STATUS_END);

  if (startIndex < 0 || endIndex < startIndex) {
    throw new Error(`Translation status markers are missing from ${pagePath}`);
  }

  const before = page.slice(0, startIndex);
  const after = page.slice(endIndex + STATUS_END.length);
  writeFileSync(pagePath, `${before}${renderStatusTable(output)}${after}`);
};

const generateOutput = () => {
  const total = countKeys(registry.en.translations);
  const statuses = tabulateTranslations(registry);

  const result: Output = {
    total,
    statuses,
  };

  const outputFilePath = join(__dirname, "..", "..", "docs", "docs", "translation-status.json");
  writeFileSync(outputFilePath, `${JSON.stringify(result, null, 2)}\n`);
  updateStatusPage(result);
};

generateOutput();
