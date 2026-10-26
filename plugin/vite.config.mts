import replace from "@rollup/plugin-replace";
import react from "@vitejs/plugin-react";
import { loadEnv, type PluginOption } from "vite";
import { analyzer } from "vite-bundle-analyzer";
import { viteStaticCopy } from "vite-plugin-static-copy";
import tsConfigPaths from "vite-tsconfig-paths";
import { configDefaults, defineConfig } from "vitest/config";

import { execFileSync } from "node:child_process";
import path, { resolve } from "node:path";

const { version } = require("./package.json");
const { id: pluginId } = require("../manifest.json");
const BUILD_TIMESTAMP_START = 2;
const BUILD_TIMESTAMP_END = 16;

function getOutDir(): string | undefined {
  const env = loadEnv("prod", process.cwd());
  if (env?.VITE_ENV !== "dev") {
    return undefined;
  }

  const vaultDir = env?.VITE_OBSIDIAN_VAULT;
  if (vaultDir === undefined) {
    return vaultDir;
  }

  return path.join(vaultDir, ".obsidian", "plugins", pluginId);
}

function getBuildStamp(): string {
  if (loadEnv("prod", process.cwd()).VITE_ENV !== "dev") {
    return `v${version}`;
  }

  const commitSha = getDevelopmentCommitSha();
  const timestamp = new Date()
    .toISOString()
    .slice(BUILD_TIMESTAMP_START, BUILD_TIMESTAMP_END)
    .replace(/[-:]/g, "");
  return `v${version}-${commitSha}-${timestamp}`;
}

function getDevelopmentCommitSha(): string {
  try {
    return (
      execFileSync("git", ["rev-parse", "--short", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || "nogit"
    );
  } catch {
    return "nogit";
  }
}

function getShouldMinify(): boolean {
  const env = loadEnv("prod", process.cwd());
  return env?.VITE_ENV !== "dev";
}

function bundleAnalyzerPlugin(): PluginOption {
  const mode = process.env.VITE_BUNDLE_ANALYZER_MODE;
  if (mode === "server" || mode === "static" || mode === "json") {
    return analyzer({ analyzerMode: mode });
  }

  if (mode !== undefined) {
    throw new Error(`Invalid VITE_BUNDLE_ANALYZER_MODE: ${mode}`);
  }

  return undefined;
}

function rejectDynamicScriptElements(): PluginOption {
  return {
    name: "reject-dynamic-script-elements",
    enforce: "post",
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (
          output.type !== "chunk" ||
          !/\.createElement\(\s*["']script["']\s*\)/.test(output.code)
        ) {
          continue;
        }

        this.error(
          `Dynamic <script> element creation found in ${output.fileName}. ` +
            "Community plugins must not inject executable scripts at runtime.",
        );
      }
    },
  };
}

function motionBuiltinPropFilter(): PluginOption {
  const modulePath = "/framer-motion/dist/es/render/dom/utils/filter-props.mjs";
  const optionalImport = `    const emotionPkg = "@emotion/is-prop-" + "valid";
    loadExternalIsValidProp(require(emotionPkg).default);`;
  let transformed = false;

  return {
    name: "motion-mobile-prop-filter",
    apply: "build",
    enforce: "pre",
    buildStart() {
      transformed = false;
    },
    shouldTransformCachedModule({ id }) {
      return id.replaceAll("\\", "/").endsWith(modulePath);
    },
    transform(code, id) {
      if (!id.replaceAll("\\", "/").endsWith(modulePath)) {
        return;
      }
      if (
        !code.includes(optionalImport) ||
        code.indexOf(optionalImport) !== code.lastIndexOf(optionalImport)
      ) {
        this.error("Motion's optional prop-filter import changed; review mobile compatibility.");
      }
      transformed = true;
      return {
        // Keep the same built-in fallback used when Emotion is absent on desktop, without
        // attempting a Node package lookup that Obsidian Mobile reports as a warning.
        code: code.replace(optionalImport, ""),
        map: null,
      };
    },
    buildEnd(error) {
      if (!error && !transformed) {
        this.error("Motion's prop-filter module was not found; review mobile compatibility.");
      }
    },
  };
}

export default defineConfig({
  plugins: [
    motionBuiltinPropFilter(),
    react(),
    tsConfigPaths(),
    viteStaticCopy({
      targets: [
        {
          src: "../manifest.json",
          dest: "",
        },
      ],
    }),
    replace({
      preventAssignment: true,
      "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV),
      SYNC_WITH_TODOIST_BUILD_STAMP: getBuildStamp(),
    }),
    rejectDynamicScriptElements(),
    bundleAnalyzerPlugin(),
  ],
  resolve: {
    alias: {
      "react-dom/client": "preact/compat/client",
      "react-dom/test-utils": "preact/test-utils",
      "react-dom": "preact/compat",
      "react/jsx-dev-runtime": "preact/jsx-dev-runtime",
      "react/jsx-runtime": "preact/jsx-runtime",
      react: "preact/compat",
    },
    dedupe: ["preact", "@codemirror/state", "@codemirror/view"],
  },
  build: {
    // The output directory may be symlinked into a live Vault. Preserve Obsidian's data.json.
    emptyOutDir: false,
    // We aren't building a website, so we build in library mode
    // and bundle the output using our index.ts as the entrypoint.
    minify: getShouldMinify(),
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      fileName: "main",
      formats: ["cjs"],
    },
    rollupOptions: {
      external: ["obsidian", "@codemirror/state", "@codemirror/view"],
      output: {
        assetFileNames: (assetInfo) => {
          if (assetInfo.name === "main.css") {
            return "styles.css";
          }

          return assetInfo.name as string;
        },
      },
    },
    outDir: getOutDir(),
  },
  test: {
    watch: false,
    // The startup guard executes inline CSS before Obsidian loads the plugin stylesheet.
    css: { include: [/taskDocumentStartup\.scss/] },
    exclude: [...configDefaults.exclude, ".direnv/**/*"],
    globals: true,
    environment: "jsdom",
    alias: {
      obsidian: resolve(__dirname, "src/mocks/obsidian.ts"),
      "react-dom/client": "react-dom/client",
      "react-dom/test-utils": "react-dom/test-utils",
      "react-dom": "react-dom",
      "react/jsx-dev-runtime": "react/jsx-dev-runtime",
      "react/jsx-runtime": "react/jsx-runtime",
      react: "react",
    },
    setupFiles: ["./vitest-setup.ts"],
  },
});
