// Polyfill TextDecoder for pkg environments (sync require — no top-level await needed)
if (typeof globalThis.TextDecoder === "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { TextDecoder, TextEncoder } = require("node:util") as typeof import("node:util");
  Object.assign(globalThis, { TextDecoder, TextEncoder });
}

void import("./server.js");
