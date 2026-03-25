function installRuntimePolyfills() {
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
}

installRuntimePolyfills();

import * as pdfjsLib from "../../node_modules/pdfjs-dist/build/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("./pdfjs-worker-wrapper.mjs", import.meta.url).toString();

export { pdfjsLib };
