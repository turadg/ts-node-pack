# Releasing ts-node-pack

ts-node-pack is a self-hosting package: its source is TypeScript with `.ts` import specifiers, which means `npm pack` on the source tree would ship an unusable tarball. The package must pack _itself_ first, and you publish that tarball directly.

## Prerequisites

- Logged into npm (`npm whoami`; if not, `npm login`).
- Publish rights on the `ts-node-pack` package (`npm owner ls ts-node-pack`).
- Working tree is clean (`git status`).
- All tests pass (`vp test` or `npm test`).
- You are on `main` with the latest pulled.

## Steps

1. **Bump the version.**

   ```sh
   # Pick one of: patch | minor | major
   npm version patch --no-git-tag-version
   ```

   The `--no-git-tag-version` flag keeps the commit and tag manual so you can include other changes in the same commit if needed.

2. **Self-pack.**

   ```sh
   node src/cli.ts .
   ```

   This produces `ts-node-pack-<version>.tgz` in the repo root. Equivalent to `npm run pack:self`.

3. **Inspect the tarball before publishing.**

   ```sh
   tar -tzf ts-node-pack-<version>.tgz | sort
   tar -xzf ts-node-pack-<version>.tgz -O package/package.json | jq .
   ```

   Verify:
   - Only `.js` and `.d.ts` under `src/` — **no `.ts` files.**
   - `package.json` has `main: ./src/index.js`, `bin.ts-node-pack: ./src/cli.js`, no `scripts`, no `devDependencies`.
   - `README.md` and `LICENSE` present.
   - Total size is sensible (tens of KB, not MB).

4. **Smoke-test the tarball in a scratch project.**

   ```sh
   TESTDIR=$(mktemp -d)
   cd "$TESTDIR"
   npm init -y > /dev/null
   npm install /path/to/ts-node-pack-<version>.tgz
   ./node_modules/.bin/ts-node-pack --help
   node -e "import('ts-node-pack').then(m => console.log(Object.keys(m)))"
   cd - && rm -rf "$TESTDIR"
   ```

   You should see the help text and the exported symbols (`rewriteTsSpecifiers`, `rewritePackageJson`, `tsNodePack`, …).

5. **Publish the tarball directly.**

   ```sh
   npm publish ts-node-pack-<version>.tgz
   ```

   `npm publish <path-to-tarball>` uploads the tarball as-is. **Do not** run `npm publish` without the tarball path — that would re-pack the source directory with `npm pack`, which ships the raw `.ts` source.

6. **Commit the version bump and tag.**

   ```sh
   git add package.json
   git commit -m "chore(release): ts-node-pack <version>"
   git tag "v<version>"
   git push origin main --tags
   ```

7. **Clean up the local tarball.**

   ```sh
   rm ts-node-pack-<version>.tgz
   ```

## What NOT to do

- **Don't add a `prepublishOnly` hook that runs ts-node-pack.** `npm publish` (without a tarball path) runs `prepublishOnly`, then re-packs the source directory, throwing away whatever the hook produced. The lifecycle assumes the source tree is already in publishable shape — which for a `.ts`-authored package it isn't. Always publish the tarball explicitly.
- **Don't use `npm pack --dry-run`** to preview. It runs npm's own packlist against the source tree and reports `.ts` files, which is misleading. Trust the tarball ts-node-pack produced in step 2.
- **Don't publish from a dirty working tree.** The tarball ts-node-pack produces is a faithful snapshot of whatever's on disk; uncommitted changes would ship.

## Troubleshooting

- **`403 Forbidden` on publish**: you don't have publish rights, or the version already exists. Check `npm owner ls ts-node-pack` and `npm view ts-node-pack versions`.
- **`ts-node-pack: command not found` during self-pack**: you need Node ≥ 22.6 for type stripping to run `node src/cli.ts` directly. On older Node, run via the local tsc first.
- **Self-pack fails with a TypeScript error**: the source has a type error. Fix it, re-run the test suite, and try again.
