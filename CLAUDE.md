# CLAUDE.md

Last verified: 2026-03-07

## Monorepo Structure

Three npm workspaces:

- **`plugin/`** - Obsidian plugin source code (TypeScript, React, Vite)
- **`docs/`** - Documentation site (Rspress)
- **`scripts/`** - Release tooling

Each workspace has its own `package.json` and commands. See workspace-specific `CLAUDE.md` files for details.

## Top-Level Commands

- `npm run build` - Build the plugin into the repository-level `dist/` directory
- `npm run release -- <version|patch|minor|major>` - Prepare, verify, push, and publish a release

## Shared Tooling

- **Biome** (`biome.json` at root) - Linting and formatting for all TypeScript/React code
- **TypeScript** - Shared at root, workspace-specific `tsconfig.json` files
- **Vite** - Build tooling shared at root, configured per workspace

## Project-Wide Conventions

- No default exports (enforced by Biome `noDefaultExport` rule)
- Keep all user-facing plugin copy in the single English-only `uiText` catalog (see `plugin/CLAUDE.md`).
- Run lint/format checks from the workspace directory: `npm run lint:check` / `npm run lint:fix`
