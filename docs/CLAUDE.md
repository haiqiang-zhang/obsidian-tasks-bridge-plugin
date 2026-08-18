# Docs CLAUDE.md

Last verified: 2026-03-07

## Commands

All commands run from this `docs/` directory:

- `npm start` - Start local development server
- `npm run build` - Build documentation site for production
- `npm run serve` - Serve built site locally
- `npm run typecheck` - TypeScript type checking

Run releases from the repository root with `npm run release -- <version|patch|minor|major>`.

## Documentation Structure

- `docs/` - Current documentation (markdown/MDX)
- `docs/commands/` - Command-specific docs
- `docs/contributing/` - Developer and contributor guides
- `rspress.config.ts` - Site metadata, navigation, and sidebar structure
- `styles.css` - Site-wide styling overrides
- `docs/public/` - Static assets copied into the built site

## Documentation Publishing

The site publishes `docs/` as its single current documentation set. Do not create version snapshots or add parallel versioned documentation trees.

## Site Configuration

### Rspress Config (`rspress.config.ts`)

- Site metadata and URL configuration
- GitHub Pages deployment settings
- Theme and navigation configuration

### Customization

- `styles.css` - Site-wide styling overrides
- `docs/public/` - Static assets and images

## Development Notes

### Adding New Documentation

1. Create markdown files in the `docs/` directory
2. Update `rspress.config.ts` to include new pages in navigation
3. Use MDX only for pages that require components

### Managing Releases

- Keep the documentation current in place.
- Record released versions in `docs/changelog.md`; do not create frozen documentation snapshots.

### Language

- Write and maintain the documentation in English only.
