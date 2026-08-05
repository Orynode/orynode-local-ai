/**
 * Optional peer stub when @xenova/transformers is not installed.
 * Real package takes precedence via vite alias only-if-missing.
 */
export async function pipeline() {
  throw new Error(
    "@xenova/transformers is not installed (optional semantic search)",
  );
}

const xenovaTransformersStub = { pipeline };
export default xenovaTransformersStub;
