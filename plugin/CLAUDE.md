# Plugin CLAUDE.md

Last verified: 2026-03-07

## Commands

All commands run from this `plugin/` directory:

- `npm run dev` - Development build with type checking
- `npm run build` - Production build
- `npm run check` - TypeScript type checking only
- `npm run test` - Run all tests (Vitest)
- `npm run test ./src/utils` - Run tests for specific directory/file
- `npm run lint:check` - Check formatting and linting (BiomeJS)
- `npm run lint:fix` - Auto-fix formatting and linting issues

## Project Structure

- `src/index.ts` - Plugin entry point; initializes services, registers commands
- `src/api/` - Todoist REST API client and domain models
- `src/data/` - Repository pattern for caching API data with sync
- `src/query/` - Custom query language parser and `todoist` code block renderer
- `src/ui/` - React components (React 18 + React Aria Components + Framer Motion)
- `src/services/` - Business logic (token management, modal orchestration)
- `src/commands/` - Obsidian command definitions
- `src/uiText.ts` - Typed English-only catalog for user-facing plugin copy
- `src/utils/` - Shared utilities

## Key Design Decisions

- **Repository pattern** (`src/data/repository.ts`): Generic caching layer that decouples UI from API fetch timing. All Todoist data flows through repositories.
- **Zustand for settings** (`src/settings.ts`): Reactive state management for plugin configuration, avoids prop drilling.
- **React Aria Components**: Accessibility-first UI primitives. Prefer these over custom interactive elements.
- **SCSS with component-scoped styles**: Each component has co-located `.scss`; supports Obsidian light/dark themes.

## UI Text

- Keep user-facing copy in `src/uiText.ts`; do not hardcode it across UI components.
- English is the only maintained UI language.
- Import the catalog with `import { uiText } from "@/uiText"` and select the relevant section locally.
- Store simple copy as strings and interpolated copy as typed functions.
- Example with interpolation:

  ```typescript
  // uiText.ts
  projectSyncFailed: (message: string) => `Project sync failed: ${message}`,

  // component.tsx
  new Notice(uiText.notices.projectSyncFailed(error.message));
  ```

### Testing

- Vitest with jsdom environment for React component testing
- Mocked Obsidian API (`src/mocks/obsidian.ts`)
