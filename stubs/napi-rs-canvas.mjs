/**
 * Stub for @napi-rs/canvas under vinext/Workers.
 * pdfjs-dist optionally imports this for DOMMatrix; we polyfill globals instead.
 * Native canvas is not available (and not needed) for text-only PDF parsing.
 */

export function createCanvas() {
  throw new Error("@napi-rs/canvas is unavailable in the vinext Workers runtime");
}

export class DOMMatrix {
  constructor(_init) {}
  invertSelf() {
    return this;
  }
  multiplySelf() {
    return this;
  }
  preMultiplySelf() {
    return this;
  }
  translate() {
    return this;
  }
  scale() {
    return this;
  }
}

export default { createCanvas, DOMMatrix };
