// A hand-authored .d.ts with no .ts/.js twin. Inspired by agoric's
// packages/internal/src/tagged.d.ts (a branded-type helper vendored
// from type-fest). Must be copied to the tarball via `files: ["src"]`
// even though tsc would not emit it from any source.
declare const tagSymbol: unique symbol;
export type Branded = number & { readonly [tagSymbol]: "Branded" };
