#!/usr/bin/env node

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { rewriteTsSpecifiers } from "../src/rewrite-specifiers.ts";

// ── from specifiers ─────────────────────────────────────────────────────────

describe("rewriteTsSpecifiers — from specifiers", () => {
  it("rewrites named import", () => {
    assert.equal(
      rewriteTsSpecifiers(`import { foo } from './foo.ts';`),
      `import { foo } from './foo.js';`,
    );
  });

  it("rewrites default import", () => {
    assert.equal(rewriteTsSpecifiers(`import foo from './foo.ts';`), `import foo from './foo.js';`);
  });

  it("rewrites namespace import", () => {
    assert.equal(
      rewriteTsSpecifiers(`import * as foo from './foo.ts';`),
      `import * as foo from './foo.js';`,
    );
  });

  it("rewrites type import", () => {
    assert.equal(
      rewriteTsSpecifiers(`import type { Foo } from './types.ts';`),
      `import type { Foo } from './types.js';`,
    );
  });

  it("rewrites named export from", () => {
    assert.equal(
      rewriteTsSpecifiers(`export { foo } from './foo.ts';`),
      `export { foo } from './foo.js';`,
    );
  });

  it("rewrites star re-export", () => {
    assert.equal(rewriteTsSpecifiers(`export * from './mod.ts';`), `export * from './mod.js';`);
  });

  it("rewrites export type from", () => {
    assert.equal(
      rewriteTsSpecifiers(`export type { Foo } from './types.ts';`),
      `export type { Foo } from './types.js';`,
    );
  });

  it("rewrites star-as re-export", () => {
    assert.equal(
      rewriteTsSpecifiers(`export * as ns from './mod.ts';`),
      `export * as ns from './mod.js';`,
    );
  });

  it("rewrites double-quoted specifiers", () => {
    assert.equal(
      rewriteTsSpecifiers(`import { foo } from "./foo.ts";`),
      `import { foo } from "./foo.js";`,
    );
  });

  it("rewrites parent-relative paths (../)", () => {
    assert.equal(
      rewriteTsSpecifiers(`import { bar } from '../bar.ts';`),
      `import { bar } from '../bar.js';`,
    );
  });

  it("rewrites deeply nested relative paths", () => {
    assert.equal(
      rewriteTsSpecifiers(`import { x } from '../../lib/utils/helper.ts';`),
      `import { x } from '../../lib/utils/helper.js';`,
    );
  });

  it("rewrites .tsx to .js", () => {
    assert.equal(
      rewriteTsSpecifiers(`import { Comp } from './Component.tsx';`),
      `import { Comp } from './Component.js';`,
    );
  });
});

// ── side-effect imports ─────────────────────────────────────────────────────

describe("rewriteTsSpecifiers — side-effect imports", () => {
  it("rewrites side-effect import with single quotes", () => {
    assert.equal(rewriteTsSpecifiers(`import './polyfill.ts';`), `import './polyfill.js';`);
  });

  it("rewrites side-effect import with double quotes", () => {
    assert.equal(rewriteTsSpecifiers(`import "./setup.ts";`), `import "./setup.js";`);
  });

  it("rewrites side-effect import with parent-relative path", () => {
    assert.equal(rewriteTsSpecifiers(`import '../augment.ts';`), `import '../augment.js';`);
  });

  it("rewrites side-effect import of .tsx", () => {
    assert.equal(rewriteTsSpecifiers(`import './globals.tsx';`), `import './globals.js';`);
  });

  it("does not touch side-effect import of non-relative path", () => {
    assert.equal(rewriteTsSpecifiers(`import 'some-package';`), `import 'some-package';`);
  });

  it("does not touch side-effect import of bare .ts (non-relative)", () => {
    assert.equal(rewriteTsSpecifiers(`import 'global-types.ts';`), `import 'global-types.ts';`);
  });
});

// ── dynamic imports ─────────────────────────────────────────────────────────

describe("rewriteTsSpecifiers — dynamic imports", () => {
  it("rewrites basic dynamic import", () => {
    assert.equal(
      rewriteTsSpecifiers(`const m = import('./mod.ts');`),
      `const m = import('./mod.js');`,
    );
  });

  it("rewrites dynamic import with double quotes", () => {
    assert.equal(
      rewriteTsSpecifiers(`const m = import("./mod.ts");`),
      `const m = import("./mod.js");`,
    );
  });

  it("rewrites dynamic import with spaces inside parens", () => {
    assert.equal(
      rewriteTsSpecifiers(`const m = import( './mod.ts' );`),
      `const m = import( './mod.js' );`,
    );
  });

  it("rewrites dynamic import with parent-relative path", () => {
    assert.equal(
      rewriteTsSpecifiers(`const m = import('../lib/util.ts');`),
      `const m = import('../lib/util.js');`,
    );
  });

  it("rewrites dynamic import of .tsx", () => {
    assert.equal(
      rewriteTsSpecifiers(`const m = import('./Component.tsx');`),
      `const m = import('./Component.js');`,
    );
  });

  it("rewrites typeof import() in .d.ts context", () => {
    assert.equal(
      rewriteTsSpecifiers(`type X = typeof import('./mod.ts').default;`),
      `type X = typeof import('./mod.js').default;`,
    );
  });

  it("rewrites import() in conditional types", () => {
    const input = `type Mod = import('./types.ts').MyType;`;
    const expected = `type Mod = import('./types.js').MyType;`;
    assert.equal(rewriteTsSpecifiers(input), expected);
  });

  it("does not touch dynamic import of non-relative path", () => {
    assert.equal(
      rewriteTsSpecifiers(`const m = import('some-package');`),
      `const m = import('some-package');`,
    );
  });
});

// ── no-rewrite cases ────────────────────────────────────────────────────────

describe("rewriteTsSpecifiers — should NOT rewrite", () => {
  it("does not rewrite non-relative from specifiers", () => {
    assert.equal(
      rewriteTsSpecifiers(`import { foo } from 'lodash';`),
      `import { foo } from 'lodash';`,
    );
  });

  it("does not rewrite node: protocol imports", () => {
    assert.equal(
      rewriteTsSpecifiers(`import { readFile } from 'node:fs';`),
      `import { readFile } from 'node:fs';`,
    );
  });

  it("does not rewrite specifiers without .ts extension", () => {
    assert.equal(
      rewriteTsSpecifiers(`import { foo } from './foo';`),
      `import { foo } from './foo';`,
    );
  });

  it("does not rewrite .js specifiers", () => {
    assert.equal(
      rewriteTsSpecifiers(`import { foo } from './foo.js';`),
      `import { foo } from './foo.js';`,
    );
  });

  it("does not rewrite .json specifiers", () => {
    assert.equal(
      rewriteTsSpecifiers(`import data from './data.json';`),
      `import data from './data.json';`,
    );
  });

  it("does not rewrite .d.ts in package names", () => {
    assert.equal(
      rewriteTsSpecifiers(`import { foo } from '@types/foo.ts';`),
      `import { foo } from '@types/foo.ts';`,
    );
  });

  it("does not rewrite string literals in code that look like paths", () => {
    assert.equal(rewriteTsSpecifiers(`const path = './foo.ts';`), `const path = './foo.ts';`);
  });

  it("does not rewrite import.meta.url", () => {
    assert.equal(
      rewriteTsSpecifiers(`const url = import.meta.url;`),
      `const url = import.meta.url;`,
    );
  });

  it("does not rewrite import.meta.resolve with relative .ts path", () => {
    assert.equal(
      rewriteTsSpecifiers(`const resolved = import.meta.resolve('./foo.ts');`),
      `const resolved = import.meta.resolve('./foo.ts');`,
    );
  });

  it("does not rewrite import.meta.dirname", () => {
    assert.equal(
      rewriteTsSpecifiers(`const dir = import.meta.dirname;`),
      `const dir = import.meta.dirname;`,
    );
  });

  it("does not rewrite import.meta.filename", () => {
    assert.equal(
      rewriteTsSpecifiers(`const file = import.meta.filename;`),
      `const file = import.meta.filename;`,
    );
  });

  it("does not rewrite new URL with import.meta.url", () => {
    assert.equal(
      rewriteTsSpecifiers(`const u = new URL('./data.ts', import.meta.url);`),
      `const u = new URL('./data.ts', import.meta.url);`,
    );
  });
});

// ── multi-line / multi-specifier ────────────────────────────────────────────

describe("rewriteTsSpecifiers — multi-line content", () => {
  it("rewrites multiple specifiers in one file", () => {
    const input = [
      `import './setup.ts';`,
      `import { foo } from './foo.ts';`,
      `import type { Bar } from '../types.ts';`,
      `export * from './mod.ts';`,
      `export { baz } from './baz.tsx';`,
      `const lazy = import('./lazy.ts');`,
      `import 'external-pkg';`,
      `import { readFile } from 'node:fs';`,
    ].join("\n");

    const expected = [
      `import './setup.js';`,
      `import { foo } from './foo.js';`,
      `import type { Bar } from '../types.js';`,
      `export * from './mod.js';`,
      `export { baz } from './baz.js';`,
      `const lazy = import('./lazy.js');`,
      `import 'external-pkg';`,
      `import { readFile } from 'node:fs';`,
    ].join("\n");

    assert.equal(rewriteTsSpecifiers(input), expected);
  });

  it("handles multi-line import statement", () => {
    const input = `import {\n  foo,\n  bar,\n} from './utils.ts';`;
    const expected = `import {\n  foo,\n  bar,\n} from './utils.js';`;
    assert.equal(rewriteTsSpecifiers(input), expected);
  });

  it("handles mixed rewrite and no-rewrite in one file", () => {
    const input = [
      `import { join } from 'node:path';`,
      `import './polyfill.ts';`,
      `import { helper } from './helper.ts';`,
      `import data from './data.json';`,
      `export type { Config } from './config.ts';`,
    ].join("\n");

    const expected = [
      `import { join } from 'node:path';`,
      `import './polyfill.js';`,
      `import { helper } from './helper.js';`,
      `import data from './data.json';`,
      `export type { Config } from './config.js';`,
    ].join("\n");

    assert.equal(rewriteTsSpecifiers(input), expected);
  });
});

// ── edge cases ──────────────────────────────────────────────────────────────

describe("rewriteTsSpecifiers — edge cases", () => {
  it("handles file named with .ts in the middle", () => {
    // e.g., ./my.ts.util.ts → ./my.ts.util.js
    assert.equal(
      rewriteTsSpecifiers(`import { x } from './my.ts.util.ts';`),
      `import { x } from './my.ts.util.js';`,
    );
  });

  it("handles index.ts", () => {
    assert.equal(
      rewriteTsSpecifiers(`import { x } from './lib/index.ts';`),
      `import { x } from './lib/index.js';`,
    );
  });

  it("preserves empty content", () => {
    assert.equal(rewriteTsSpecifiers(""), "");
  });

  it("preserves content with no imports", () => {
    const content = `export const x = 42;\nexport function hello() { return 'hi'; }\n`;
    assert.equal(rewriteTsSpecifiers(content), content);
  });

  it("handles await import()", () => {
    assert.equal(
      rewriteTsSpecifiers(`const m = await import('./lazy.ts');`),
      `const m = await import('./lazy.js');`,
    );
  });

  it("handles import() in ternary", () => {
    assert.equal(
      rewriteTsSpecifiers(`const m = cond ? import('./a.ts') : import('./b.ts');`),
      `const m = cond ? import('./a.js') : import('./b.js');`,
    );
  });
});

// ── .mts specifiers ────────────────────────────────────────────────────────
//
// Regression coverage for a bug found during agoric-sdk validation:
// the TS_SPECIFIER_PATTERNS used to match only `.ts`/`.tsx`, so any
// package that imported `./foo.mts` would silently pass the specifier
// through unchanged into the published `.mjs` output. `.mts` must
// rewrite to `.mjs` (not `.js`), matching what ts-blank-space emits.

describe("rewriteTsSpecifiers — .mts specifiers", () => {
  it("rewrites .mts import to .mjs", () => {
    assert.equal(
      rewriteTsSpecifiers(`import { foo } from './foo.mts';`),
      `import { foo } from './foo.mjs';`,
    );
  });

  it("rewrites .mts re-export to .mjs", () => {
    assert.equal(
      rewriteTsSpecifiers(`export { foo } from './foo.mts';`),
      `export { foo } from './foo.mjs';`,
    );
  });

  it("rewrites .mts side-effect import to .mjs", () => {
    assert.equal(rewriteTsSpecifiers(`import './init.mts';`), `import './init.mjs';`);
  });

  it("rewrites .mts dynamic import to .mjs", () => {
    assert.equal(
      rewriteTsSpecifiers(`const m = await import('./lazy.mts');`),
      `const m = await import('./lazy.mjs');`,
    );
  });

  it("rewrites mixed .ts, .tsx, and .mts in one file", () => {
    const input = `
import a from './a.ts';
import b from './b.tsx';
import c from './c.mts';
`;
    const expected = `
import a from './a.js';
import b from './b.js';
import c from './c.mjs';
`;
    assert.equal(rewriteTsSpecifiers(input), expected);
  });

  it("does not rewrite .mts inside a bare string literal", () => {
    assert.equal(rewriteTsSpecifiers(`const p = './foo.mts';`), `const p = './foo.mts';`);
  });
});

// ── require() — CommonJS specifiers ────────────────────────────────────────
//
// Coverage parity with the agoric-sdk rewrite-ts-import-specifiers.mjs
// script that the migration replaced. agoric never had `require('./x.ts')`
// in the wild, but the script defended against it; we should too, since
// any `.cjs` consumer of a TS-authored package would otherwise ship a
// broken require.

describe("rewriteTsSpecifiers — require() calls", () => {
  it("rewrites require('./foo.ts')", () => {
    assert.equal(
      rewriteTsSpecifiers(`const m = require('./foo.ts');`),
      `const m = require('./foo.js');`,
    );
  });

  it("rewrites require with double quotes", () => {
    assert.equal(
      rewriteTsSpecifiers(`const m = require("./foo.ts");`),
      `const m = require("./foo.js");`,
    );
  });

  it("rewrites require('./foo.tsx')", () => {
    assert.equal(
      rewriteTsSpecifiers(`const m = require('./component.tsx');`),
      `const m = require('./component.js');`,
    );
  });

  it("rewrites require('./foo.mts') to .mjs", () => {
    assert.equal(
      rewriteTsSpecifiers(`const m = require('./foo.mts');`),
      `const m = require('./foo.mjs');`,
    );
  });

  it("rewrites require with whitespace inside the parens", () => {
    assert.equal(
      rewriteTsSpecifiers(`const m = require( './foo.ts' );`),
      `const m = require( './foo.js' );`,
    );
  });

  it("does not rewrite non-relative require", () => {
    assert.equal(
      rewriteTsSpecifiers(`const lodash = require('lodash');`),
      `const lodash = require('lodash');`,
    );
  });

  it("does not rewrite require for .json or .cjs", () => {
    const input = `const a = require('./data.json');\nconst b = require('./helper.cjs');`;
    assert.equal(rewriteTsSpecifiers(input), input);
  });

  it("does not rewrite require of .d.ts (declaration file)", () => {
    assert.equal(
      rewriteTsSpecifiers(`const t = require('./types.d.ts');`),
      `const t = require('./types.d.ts');`,
    );
  });

  it("does not rewrite a custom function whose name ends in 'require'", () => {
    // Word-boundary anchor on \brequire\b prevents this false positive.
    assert.equal(
      rewriteTsSpecifiers(`const m = customrequire('./foo.ts');`),
      `const m = customrequire('./foo.ts');`,
    );
  });
});

// ── declare module — TypeScript ambient module declarations ────────────────

describe("rewriteTsSpecifiers — declare module", () => {
  it("rewrites declare module './foo.ts'", () => {
    assert.equal(
      rewriteTsSpecifiers(`declare module './foo.ts' { export const x: number; }`),
      `declare module './foo.js' { export const x: number; }`,
    );
  });

  it("rewrites declare module with double quotes", () => {
    assert.equal(
      rewriteTsSpecifiers(`declare module "./foo.ts" {}`),
      `declare module "./foo.js" {}`,
    );
  });

  it("rewrites declare module './foo.mts' to .mjs", () => {
    assert.equal(
      rewriteTsSpecifiers(`declare module './foo.mts' {}`),
      `declare module './foo.mjs' {}`,
    );
  });

  it("does not rewrite declare module 'global-name' (non-relative)", () => {
    assert.equal(
      rewriteTsSpecifiers(`declare module '*.svg' { const url: string; export default url; }`),
      `declare module '*.svg' { const url: string; export default url; }`,
    );
  });
});

// ── triple-slash reference path directives ─────────────────────────────────

describe("rewriteTsSpecifiers — triple-slash reference path", () => {
  it('rewrites /// <reference path="./foo.ts" />', () => {
    assert.equal(
      rewriteTsSpecifiers(`/// <reference path="./foo.ts" />`),
      `/// <reference path="./foo.js" />`,
    );
  });

  it("rewrites with single quotes", () => {
    assert.equal(
      rewriteTsSpecifiers(`/// <reference path='./foo.ts' />`),
      `/// <reference path='./foo.js' />`,
    );
  });

  it("rewrites with no whitespace around the equals", () => {
    assert.equal(
      rewriteTsSpecifiers(`/// <reference path="./foo.ts"/>`),
      `/// <reference path="./foo.js"/>`,
    );
  });

  it("does not rewrite reference of .d.ts (declaration file)", () => {
    assert.equal(
      rewriteTsSpecifiers(`/// <reference path="./types.d.ts" />`),
      `/// <reference path="./types.d.ts" />`,
    );
  });

  it("does not rewrite <reference types=...> (different attribute)", () => {
    assert.equal(
      rewriteTsSpecifiers(`/// <reference types="node" />`),
      `/// <reference types="node" />`,
    );
  });

  it("does not rewrite <reference lib=...>", () => {
    assert.equal(
      rewriteTsSpecifiers(`/// <reference lib="es2022" />`),
      `/// <reference lib="es2022" />`,
    );
  });
});

// ── word-boundary false-positive prevention ────────────────────────────────
//
// Without `\b` anchors, our regex would match the `from` substring
// inside identifiers like `myfrom` or `customFrom`. Lock the contract.

describe("rewriteTsSpecifiers — word-boundary anchors", () => {
  it("does not rewrite a function call whose name ends in 'from'", () => {
    assert.equal(
      rewriteTsSpecifiers(`const x = customfrom('./foo.ts');`),
      `const x = customfrom('./foo.ts');`,
    );
  });

  it("does not rewrite a function call whose name ends in 'import'", () => {
    assert.equal(
      rewriteTsSpecifiers(`const x = lazyimport './foo.ts';`),
      `const x = lazyimport './foo.ts';`,
    );
  });

  it("still rewrites 'from' after a closing brace and space", () => {
    // Common case: `import { foo } from './bar.ts'`
    assert.equal(
      rewriteTsSpecifiers(`import { foo } from './bar.ts';`),
      `import { foo } from './bar.js';`,
    );
  });

  it("still rewrites 'from' at the start of a line", () => {
    assert.equal(rewriteTsSpecifiers(`from './bar.ts'`), `from './bar.js'`);
  });
});
