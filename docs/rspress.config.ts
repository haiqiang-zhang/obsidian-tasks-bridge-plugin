import { defineConfig } from "@rspress/core";
import { resolve } from "node:path";

const repository = "https://github.com/haiqiang-zhang/obsidian-tasks-bridge-plugin";

export default defineConfig({
  title: "Tasks Bridge",
  description: "Documentation for Tasks Bridge",
  base: "/obsidian-tasks-bridge-plugin/",
  root: "docs",
  outDir: "build",
  logo: "/img/logo.svg",
  logoText: "Tasks Bridge",
  icon: "/img/logo.svg",
  globalStyles: resolve(import.meta.dirname, "styles.css"),
  markdown: {
    showLineNumbers: true,
  },
  search: {
    mode: "local",
  },
  themeConfig: {
    nav: [
      { text: "Docs", link: "/overview" },
      { text: "GitHub", link: repository },
    ],
    sidebar: {
      "/": [
        { text: "Overview", link: "/overview" },
        { text: "Setup", link: "/setup" },
        { text: "Query blocks", link: "/query-blocks" },
        { text: "Project sync", link: "/project-mode" },
        { text: "Configuration", link: "/configuration" },
        {
          text: "Commands",
          items: [
            { text: "Add task", link: "/commands/add-task" },
            { text: "Insert blocks", link: "/commands/insert-blocks" },
            { text: "Sync", link: "/commands/sync" },
          ],
        },
        { text: "Changelog", link: "/changelog" },
        {
          text: "Contributing",
          items: [
            { text: "General", link: "/contributing/general" },
            { text: "Release process", link: "/contributing/release-process" },
          ],
        },
      ],
    },
    editLink: {
      docRepoBaseUrl: `${repository}/edit/master/docs/docs`,
    },
    lastUpdated: true,
    search: true,
    socialLinks: [{ icon: "github", mode: "link", content: repository }],
    footer: {
      message: "Tasks Bridge documentation",
    },
  },
});
