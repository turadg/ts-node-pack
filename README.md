# ts-node-pack

Pack a TypeScript package into a Node-compatible npm tarball — without modifying the source tree, without bundling, and without changing module resolution semantics.

Given a TypeScript package whose sources use `.ts` files and `.ts` in relative import specifiers, `ts-node-pack` produces a `.tgz` whose contents are plain `.js` + `.d.ts` with correct `.js` specifiers, ready to `npm install` into any Node ESM project.

## Why

TypeScript 5.7 introduced [`rewriteRelativeImportExtensions`](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-7.html#path-rewriting-for-relative-paths), which lets you author `import './foo.ts'` and have `tsc` emit `import './foo.js'` in the compiled `.js`. But:

- `tsc` does **not** rewrite `.ts` specifiers inside emitted `.d.ts` files.
- Your `package.json` (`main`, `module`, `exports`, `types`) still points at `.ts`.
- You probably don't want the `.ts` sources in the published tarball at all.

`ts-node-pack` wraps `tsc` + `npm pack` and fills in exactly those gaps.

## Install

```sh
npm install --save-dev ts-node-pack
```

Requires Node ≥ 20 and TypeScript ≥ 5.7 available in the package being packed (resolved via `npx tsc`).

## Usage

```sh
ts-node-pack <packageDir> [--tsconfig <path>] [--stage-to <dir>] [--skip-pack] [--force] [--verbose]
```

| Flag                | Description                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `--tsconfig <path>` | tsconfig to extend. Defaults to `tsconfig.build.json` if present, otherwise `tsconfig.json`. |
| `--stage-to <dir>`  | Stage into `<dir>` instead of an auto-created temp dir. Caller owns its lifecycle.           |
| `--skip-pack`       | Skip the final `npm pack` step. Requires `--stage-to`.                                       |
| `--force`           | With `--stage-to`, clear `<dir>` if it already has contents.                                 |
| `-v`, `--verbose`   | Log each pipeline phase to stderr.                                                           |
| `-h`, `--help`      | Show help.                                                                                   |

The resulting `<name>-<version>.tgz` is written to the current working directory (unless `--skip-pack` is set).

### Example

```sh
cd my-project
ts-node-pack ./packages/core --verbose
npm install ./my-core-1.2.3.tgz
```

### `--stage-to` and `--skip-pack`

By default `ts-node-pack` stages into an auto-created `mkdtemp()` directory, runs `npm pack` against it, copies the resulting `.tgz` to the current working directory, and removes the temp dir.

Pass `--stage-to <dir>` when you want to keep the staged contents — for example, to let another tool pack from that directory instead (`lerna publish --contents <dir>`, an alternate tarball builder, etc.). `<dir>` must either not exist, be empty, or be opted-in for clearing via `--force`.

Combine with `--skip-pack` to stop after staging and never run `npm pack` at all. `--skip-pack` is only valid with `--stage-to` (otherwise the staged contents would have no accessible location).

| Invocation                                        | Behavior                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------- |
| `ts-node-pack <pkg>`                              | Stage to temp dir, pack, copy `.tgz` to CWD, delete temp dir.       |
| `ts-node-pack <pkg> --stage-to <dir>`             | Stage to `<dir>`, pack, copy `.tgz` to CWD, leave `<dir>` in place. |
| `ts-node-pack <pkg> --stage-to <dir> --skip-pack` | Stage to `<dir>`, skip pack, leave `<dir>` in place.                |
| `ts-node-pack <pkg> --skip-pack`                  | Error: `skipPack requires stageTo`.                                 |

## Pipeline

1. **Resolve package** — read `package.json`, pick tsconfig.
2. **Stage** — use `--stage-to <dir>` if given, otherwise create `mkdtemp()/package/`. A small separate `mkdtemp()` work dir always holds auxiliary files (e.g. the derived tsconfig) so they never land in the packed contents.
3. **Derived tsconfig** — write `tsconfig.emit.json` _inside the work dir_ that `extends` the chosen tsconfig (by absolute path) and forces `outDir`, `declaration`, `rewriteRelativeImportExtensions: true`, `noEmit: false`. If the base tsconfig enables `sourceMap`, `inlineSourceMap`, or `declarationMap`, `inlineSources: true` is also set so debuggers get full source-level fidelity without any `.ts` files in the tarball.
4. **Emit** — run `tsc -p` against the derived config.
5. **Rewrite `.d.ts`** — for each emitted `.d.ts`, rewrite `./foo.ts` → `./foo.js` in `import` / `export from` / dynamic `import()` specifiers. Non-relative specifiers are left alone.
6. **Rewrite `package.json`** — rewrite `.ts` → `.js` (and → `.d.ts` under `types` conditions) in `main`, `module`, `types`, `typings`, `bin`, `exports`, and the `files` array. Strip `devDependencies` and `scripts`.
7. **Copy assets** — `README*`, `LICENSE*`, `CHANGELOG*`, `NOTICE*`. Source `.ts` files are never copied.
8. **Validate** — fail if any `.ts` specifier remains in emitted `.js` / `.d.ts` / `package.json`, or if a referenced entry point does not exist.
9. **Pack** — unless `--skip-pack`: `npm pack` in the staging directory and move the tarball to the original CWD.
10. **Cleanup** — always remove the work dir. In default mode this also removes the staging dir (which is nested inside). In `--stage-to` mode the staging dir is the caller's, and survives.

The source tree is never mutated.

### Sourcemaps

If your tsconfig has `sourceMap` (or `inlineSourceMap` / `declarationMap`) enabled, `ts-node-pack` automatically forces `inlineSources: true` so each emitted `.map` embeds its source text via `sourcesContent`. This gives full source-level debugging and "Go to Definition" without shipping `.ts` files — sidestepping dual-resolution hazards where a downstream bundler or TS project might pick `./foo.ts` over `./foo.js`. Detection is a shallow read of the chosen tsconfig; if you inherit `sourceMap` from a base config via `extends`, set it explicitly at the leaf.

## Non-goals

- No bundling.
- No AST transforms.
- No custom module resolution.
- No `npm publish` logic.

## License

MIT
