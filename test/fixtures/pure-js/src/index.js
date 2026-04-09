// Pure JS package — no tsconfig at all. ts-node-pack should pack it
// without invoking tsc, mirroring what `npm pack` would do.

/** @returns {string} */
export function greet() {
  return "hello from pure-js";
}
