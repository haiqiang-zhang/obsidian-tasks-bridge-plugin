# Release Process

Keep user-visible changes under **Unreleased** in the changelog during development. Then release from a clean, up-to-date `master` branch with one command from the repository root:

```bash
npm run release -- 2.9.0
```

You can also request a semantic increment:

```bash
npm run release -- patch
npm run release -- minor
npm run release -- major
```

The command validates the repository and GitHub authentication, updates the changelog and version files, regenerates derived files, runs all release checks, commits and pushes `master`, creates and pushes the matching annotated tag, waits for the official GitHub Actions build, and publishes the generated draft with the matching changelog notes. Workflow status and elapsed time remain visible while GitHub builds the release.

No release PR or interactive confirmation is required. If the command is interrupted, rerun the same command: its internal recovery state safely restarts pre-commit preparation or resumes the existing commit, tag, workflow, or draft. The documentation remains current-only; the release command does not create Docusaurus version snapshots.
