if (typeof Uint8Array !== "undefined" && !Uint8Array.prototype.toHex) {
  Object.defineProperty(Uint8Array.prototype, "toHex", {
    value() {
      return Array.from(this, (byte) => byte.toString(16).padStart(2, "0")).join("");
    },
    writable: true,
    configurable: true
  });
}

if (typeof Map !== "undefined" && !Map.prototype.getOrInsertComputed) {
  Object.defineProperty(Map.prototype, "getOrInsertComputed", {
    value(key, compute) {
      if (this.has(key)) {
        return this.get(key);
      }
      const value = compute(key);
      this.set(key, value);
      return value;
    },
    writable: true,
    configurable: true
  });
}

await import("../../node_modules/pdfjs-dist/build/pdf.worker.mjs");
