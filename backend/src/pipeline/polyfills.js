// pdfjs-dist uses a few APIs that Node 20 lacks (its legacy build polyfills the rest). Keeps Node 20 working.
// Must be imported before pdfjs (ES imports run in order).
if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function withResolvers() {
    let resolve;
    let reject;
    const promise = new this((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

// Node 21+. Used when pdfjs passes font data to the renderer: without it the text of a page is not drawn (or the render
// never finishes). A copy is enough here; the original buffer is not detached.
for (const name of ['transfer', 'transferToFixedLength']) {
  if (typeof ArrayBuffer.prototype[name] !== 'function') {
    Object.defineProperty(ArrayBuffer.prototype, name, {
      configurable: true,
      writable: true,
      value(length = this.byteLength) {
        const out = new ArrayBuffer(length);
        new Uint8Array(out).set(new Uint8Array(this, 0, Math.min(length, this.byteLength)));
        return out;
      },
    });
  }
}
