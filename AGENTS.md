# Repository Instructions

## Collaboration Rules

- Do not commit or push changes unless the user explicitly asks for it.
- Do not add or rewrite tests unless the user explicitly asks for tests, coverage,
  or verification changes.
- Keep changes scoped to this package. Do not mix unrelated cleanup into feature
  or release work.
- Do not hardcode runtime behavior to satisfy a single fixture. Use AST,
  semantic data, or documented Garfish/runtime APIs for behavior changes.

## Project Shape

- This package exports a Garfish plugin that rewrites browser-loaded ESM through
  a Zig/Yuku WebAssembly transformer.
- Zig source lives in `src/transformer.zig`; TypeScript runtime/plugin code lives
  in `src/*.ts`; browser bindings live in `wasm/`.
- `pkg/`, `dist/`, `coverage/`, `.zig-cache/`, `zig-out/`, `zig-pkg/`,
  `node_modules/`, `examples/vite/dist/`, and `log/` are generated output and
  should not be committed.

## Implementation Rules

- Prefer Yuku AST and semantic APIs for import/export/module analysis.
- Avoid hand-parsing JavaScript source text. Span-based replacements are
  acceptable only for minimal code patching after the AST/semantic layer has
  identified the exact node or reference.
- Preserve ESM live binding semantics. Imported binding reads must stay linked
  to the backing module value instead of capturing stale local snapshots.
- Garfish external prefix matching follows import map semantics:
  - `pkg` matches only the exact module id `pkg`;
  - `pkg/` matches subpaths such as `pkg/foo.js`;
  - longest matching prefix wins.
- Browser wasm initialization should preserve opaque option identities such as
  wasm bytes, custom compile caches, Garfish externals, and callbacks.

## Verification

- Use `pnpm test` for Vitest behavior tests.
- Use `pnpm test:coverage` to generate Vitest coverage output for Codecov.
- Use `pnpm benchmark` for transform benchmarks.
- Use `pnpm benchmark:parse` for parser benchmarks.
- Use `pnpm typecheck` for TypeScript validation.
- Use `pnpm build` before release or publish-related changes.
- Use `pnpm example:build` when changes may affect the Vite/Garfish example.

## Release And CI

- Changesets are required for user-facing package changes.
- PR beta publishing is restricted by the release workflow to the configured
  release user.
- PR quality reporting is handled by GitHub Actions:
  - coverage is uploaded to Codecov;
  - Codecov owns the coverage badge and coverage PR comment/status;
  - the repository workflow comments benchmark results and Codecov report links
    on same-repository PRs.
- Do not reintroduce generated local coverage badges; use Codecov badges.
