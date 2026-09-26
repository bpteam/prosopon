import { describe, expect, it } from 'vitest';
import { isStoredModelBlob } from '../../src/emotion/ModelStorage';

describe('isStoredModelBlob', () => {
  it('accepts a Blob deserialized from another extension-like realm', () => {
    const native = new Blob(['model bytes']);
    // IDB structured cloning can give the receiving context a different Blob
    // prototype. Mimic that valid Blob surface without this realm's prototype.
    const blob = {
      arrayBuffer: native.arrayBuffer.bind(native),
      slice: native.slice.bind(native),
      size: native.size,
      type: native.type,
    };

    // This is the situation across the service worker and offscreen document:
    // the Blob is valid, but it is not an instance of this realm's constructor.
    expect(blob).not.toBeInstanceOf(Blob);
    expect(isStoredModelBlob(blob)).toBe(true);
  });

  it('rejects non-Blob values left in the object store', () => {
    expect(isStoredModelBlob({ arrayBuffer() {}, slice() {}, size: 1 })).toBe(false);
  });
});
