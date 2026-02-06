# Repository Guidelines
 
Before making changes, agents should always review:
- `REVIEW.md` (current priorities and critical follow‑ups)
- `README.md` (user‑facing behavior and commands)
- `package.json` (activation, commands, settings)

## Project Structure & Module Organization
- `src/extension.ts`: Main VS Code extension (custom editor `csv.editor`, commands under `csv.*`).
- `src/test/*.test.ts`: Unit tests (compiled to `out/test`).
- `src/types/`: Type shims (e.g., `font-list.d.ts`).
- `out/`: Transpiled JavaScript output.
- `images/`: Marketplace icon and screenshots.
- `package.json`: Activation events, commands, settings, and scripts.

## Build, Test, and Development Commands
- `npm install`: Install dependencies.
- `npm ci`: Clean, reproducible install (preferred in CI/local verification).
- `npm run compile`: TypeScript → `out/` via `tsc`.
- `npm run lint`: ESLint over `**/*.ts` using `eslint.config.mjs`.
- `npm test`: Compile, then run Node’s test runner on `out/test`.
- `npm run package`: Create a `.vsix` using `vsce` (publish/build).

Example local loop:
```
npm install
npm run lint && npm run compile
npm test
```

## Toolchain
- Use a modern Node runtime (recommended: Node 20 LTS).
- If using `nvm`, run `nvm use 20` before install/build/test commands.
- Prefer `npm ci` over `npm install` for deterministic dependency resolution when validating changes.

## Mandatory Verification
- After any code change, run `npm run compile` before sending the final response.
- If compile fails, report the error and do not mark the task complete.
- Skip this only for docs-only changes or when the user explicitly asks to skip compile.
- Run `npm test` when behavior changes (commands, settings, parsing, rendering, webview interactions, or data mutations).
- If tests are skipped, state why and call out residual risk.

## Dependency & Lockfile Policy
- Keep `package-lock.json` tracked in git; do not gitignore it.
- Commit lockfile updates when dependencies or dependency metadata change.
- Avoid unrelated lockfile churn; if lockfile changes are incidental, regenerate with the project’s standard Node/npm toolchain.

## User-Facing Change Sync
- When adding/changing commands or settings, update both `package.json` contributions and `README.md` in the same change.
- For any user-visible behavior update, include a concise note in PR/test plan describing how it was validated.

## Webview Change Policy
- Changes to `media/main.js`, webview message contracts, or rendered table HTML should include/update tests in `src/test`.
- Prefer tests that verify invariants and edge cases (selection/edit interactions, chunking behavior, escaping/linkification safety).

## Coding Style & Naming Conventions
- Language: TypeScript with `strict` mode (see `tsconfig.json`).
- Indentation: 2 spaces; include semicolons.
- ESLint: prefer `===`, require curly braces, no throwing literals; import names camelCase/PascalCase.
- Structure: keep functions small and pure where feasible; utilities that don’t touch VS Code APIs are easier to test.
- Filenames: `kebab-case` for new files; tests end with `.test.ts`.

## Testing Guidelines
- Framework: `node:test` with `assert`.
- Location/pattern: `src/test/**/*.test.ts` → compiled to `out/test`.
- Run: `npm test` (ensures a fresh compile).
- Conventions: target pure utilities (parsing, type inference, color mapping, HTML escaping). Add tests when changing command behavior or settings logic. No formal coverage threshold; aim for meaningful cases.

## Commit & Pull Request Guidelines
- Commits: imperative mood, concise. Optional prefixes like `fix:`/`chore:` to match history (e.g., “Add TSV support”, “chore: widen vscode engine compatibility”). Reference issues/PRs: `(#42)`.
- PRs: clear description, linked issues, test plan, and screenshots/GIFs for UI changes. Note any new settings/commands and update `README.md` when user-facing.

## Security & Configuration Tips
- Webview: escape all user data before injecting HTML; avoid `eval`/inline scripts. Be mindful of content security.
- Settings: use `csv.*` keys declared in `package.json` and respect `csv.enabled`.
- Compatibility: keep within engines in `package.json` (`vscode` and Node). Validate both `.csv` and `.tsv` flows.
