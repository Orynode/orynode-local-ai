/**
 * Minimal DOM shims for pdfjs-dist text extraction under vinext/Workers.
 *
 * pdfjs-dist evaluates `new DOMMatrix()` at module load. Real Node can pull
 * these from @napi-rs/canvas; Workers cannot. Text extraction does not need a
 * real canvas — only enough globals to let the module initialize.
 *
 * Import this module for its side effect (polyfills applied on load).
 */

type GlobalWithPdfShims = typeof globalThis & {
  DOMMatrix?: new (...args: unknown[]) => unknown;
  Path2D?: new (...args: unknown[]) => unknown;
};

const g = globalThis as GlobalWithPdfShims;

if (!g.DOMMatrix) {
  // Minimal stub — not a full DOMMatrix implementation.
  g.DOMMatrix = class DOMMatrix {
    constructor(_init?: unknown) {}
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
  } as unknown as GlobalWithPdfShims["DOMMatrix"];
}

if (!g.Path2D) {
  // Text extraction only needs the ctor to exist. Node OCR render overwrites
  // these globals with @napi-rs/canvas Path2D (see pdf-render.ts).
  g.Path2D = class Path2D {
    addPath() {}
    moveTo() {}
    lineTo() {}
    closePath() {}
    bezierCurveTo() {}
    quadraticCurveTo() {}
    arc() {}
    arcTo() {}
    ellipse() {}
    rect() {}
  } as unknown as GlobalWithPdfShims["Path2D"];
}
