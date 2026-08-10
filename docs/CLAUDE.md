# Docs CLAUDE.md

Last verified: 2026-03-07

## Commands

All commands run from this `docs/` directory:

- `npm start` - Start local development server
- `npm run build` - Build documentation site for production
- `npm run serve` - Serve built site locally
- `npm run clear` - Clear Docusaurus cache
- `npm run write-translations` - Extract translatable strings
- `npm run write-heading-ids` - Add heading IDs to markdown files
- `npm run typecheck` - TypeScript type checking

## Documentation Structure

- `docs/` - Current documentation (markdown/MDX)
- `docs/commands/` - Command-specific docs
- `docs/contributing/` - Developer and contributor guides
- `sidebars.ts` - Navigation structure (update when adding new pages)

## Documentation Publishing

The site publishes `docs/` as its single current documentation set. Do not create Docusaurus version snapshots or add `versioned_docs`, `versioned_sidebars`, or a docs-level `versions.json`.

## Site Configuration

### Docusaurus Config (`docusaurus.config.ts`)

- Site metadata and URL configuration
- GitHub Pages deployment settings
- Theme and navigation configuration
- Versioning setup

### Customization

- `src/css/custom.css` - Site-wide styling overrides
- `src/components/` - Custom React components
- `src/pages/` - Custom pages (like the homepage)
- `static/img/` - Static assets and images

## Development Notes

### Adding New Documentation

1. Create markdown files in the `docs/` directory
2. Update `sidebars.ts` to include new pages in navigation
3. Use MDX format for pages requiring React components

### Managing Releases

- Keep the documentation current in place.
- Record released versions in `docs/changelog.md`; do not create frozen documentation snapshots.

### Translation Support

- Site is configured for internationalization but currently English-only
- Translation status tracking in `translation-status.json`
- Custom `TranslationStatus` component for displaying translation progress
