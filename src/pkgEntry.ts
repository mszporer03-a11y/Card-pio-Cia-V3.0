// Polyfill TextDecoder for pkg environments (sync require — no top-level await needed)
if (typeof globalThis.TextDecoder === "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { TextDecoder, TextEncoder } = require("node:util") as typeof import("node:util");
  Object.assign(globalThis, { TextDecoder, TextEncoder });
}

// Polyfill DOMMatrix for pdfjs-dist v5 in pkg/CJS environments.
// pdfjs uses DOMMatrix for affine coordinate transforms (2D matrix ops).
// In ESM context pdfjs sets it up internally; when bundled to CJS by esbuild
// import.meta.url becomes undefined and pdfjs's own polyfill setup fails.
if (typeof (globalThis as any).DOMMatrix === "undefined") {
  (globalThis as any).DOMMatrix = class DOMMatrix {
    a: number; b: number; c: number; d: number; e: number; f: number;
    m11: number; m12: number; m13: number; m14: number;
    m21: number; m22: number; m23: number; m24: number;
    m31: number; m32: number; m33: number; m34: number;
    m41: number; m42: number; m43: number; m44: number;
    is2D: boolean; isIdentity: boolean;

    constructor(init?: number[] | string | DOMMatrix) {
      // Identity matrix
      this.a = 1;  this.b = 0;  this.c = 0;  this.d = 1;  this.e = 0;  this.f = 0;
      this.m11 = 1; this.m12 = 0; this.m13 = 0; this.m14 = 0;
      this.m21 = 0; this.m22 = 1; this.m23 = 0; this.m24 = 0;
      this.m31 = 0; this.m32 = 0; this.m33 = 1; this.m34 = 0;
      this.m41 = 0; this.m42 = 0; this.m43 = 0; this.m44 = 1;
      this.is2D = true; this.isIdentity = true;
      if (Array.isArray(init) && init.length >= 6) {
        [this.a, this.b, this.c, this.d, this.e, this.f] = init;
        this.m11 = this.a;  this.m12 = this.b;
        this.m21 = this.c;  this.m22 = this.d;
        this.m41 = this.e;  this.m42 = this.f;
        this.isIdentity = (this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0);
      }
    }

    private _mul2d(o: DOMMatrix): [number, number, number, number, number, number] {
      return [
        this.a * o.a + this.c * o.b,
        this.b * o.a + this.d * o.b,
        this.a * o.c + this.c * o.d,
        this.b * o.c + this.d * o.d,
        this.a * o.e + this.c * o.f + this.e,
        this.b * o.e + this.d * o.f + this.f,
      ];
    }

    multiplySelf(other: DOMMatrix): this {
      [this.a, this.b, this.c, this.d, this.e, this.f] = this._mul2d(other);
      this.m11 = this.a; this.m12 = this.b; this.m21 = this.c; this.m22 = this.d; this.m41 = this.e; this.m42 = this.f;
      this.isIdentity = false;
      return this;
    }

    preMultiplySelf(other: DOMMatrix): this {
      // this = other * this
      const o = other as DOMMatrix;
      const a = o.a * this.a + o.c * this.b;
      const b = o.b * this.a + o.d * this.b;
      const c = o.a * this.c + o.c * this.d;
      const d = o.b * this.c + o.d * this.d;
      const e = o.a * this.e + o.c * this.f + o.e;
      const f = o.b * this.e + o.d * this.f + o.f;
      this.a = a; this.b = b; this.c = c; this.d = d; this.e = e; this.f = f;
      this.m11 = a; this.m12 = b; this.m21 = c; this.m22 = d; this.m41 = e; this.m42 = f;
      this.isIdentity = false;
      return this;
    }

    invertSelf(): this {
      const det = this.a * this.d - this.b * this.c;
      if (det !== 0) {
        const idet = 1 / det;
        const a = this.d * idet;
        const b = -this.b * idet;
        const c = -this.c * idet;
        const d = this.a * idet;
        const e = (this.c * this.f - this.d * this.e) * idet;
        const f = (this.b * this.e - this.a * this.f) * idet;
        this.a = a; this.b = b; this.c = c; this.d = d; this.e = e; this.f = f;
        this.m11 = a; this.m12 = b; this.m21 = c; this.m22 = d; this.m41 = e; this.m42 = f;
      }
      return this;
    }

    translate(tx = 0, ty = 0, _tz = 0): DOMMatrix {
      const m = new (globalThis as any).DOMMatrix([this.a, this.b, this.c, this.d, this.e, this.f]);
      m.a = this.a; m.b = this.b; m.c = this.c; m.d = this.d;
      m.e = this.a * tx + this.c * ty + this.e;
      m.f = this.b * tx + this.d * ty + this.f;
      m.m11 = m.a; m.m12 = m.b; m.m21 = m.c; m.m22 = m.d; m.m41 = m.e; m.m42 = m.f;
      return m;
    }

    scale(sx = 1, sy?: number, _sz = 1, _ox = 0, _oy = 0, _oz = 0): DOMMatrix {
      const sY = sy ?? sx;
      const m = new (globalThis as any).DOMMatrix([this.a, this.b, this.c, this.d, this.e, this.f]);
      m.a = this.a * sx; m.b = this.b * sx; m.c = this.c * sY; m.d = this.d * sY; m.e = this.e; m.f = this.f;
      m.m11 = m.a; m.m12 = m.b; m.m21 = m.c; m.m22 = m.d; m.m41 = m.e; m.m42 = m.f;
      return m;
    }

    multiply(other: DOMMatrix): DOMMatrix {
      const m = new (globalThis as any).DOMMatrix([this.a, this.b, this.c, this.d, this.e, this.f]);
      return m.multiplySelf(other);
    }

    inverse(): DOMMatrix {
      const m = new (globalThis as any).DOMMatrix([this.a, this.b, this.c, this.d, this.e, this.f]);
      return m.invertSelf();
    }

    transformPoint(p: { x?: number; y?: number } = {}): { x: number; y: number; z: number; w: number } {
      const x = p.x ?? 0;
      const y = p.y ?? 0;
      return { x: this.a * x + this.c * y + this.e, y: this.b * x + this.d * y + this.f, z: 0, w: 1 };
    }

    toFloat32Array(): Float32Array {
      return new Float32Array([this.m11, this.m12, this.m13, this.m14, this.m21, this.m22, this.m23, this.m24, this.m31, this.m32, this.m33, this.m34, this.m41, this.m42, this.m43, this.m44]);
    }

    toString(): string {
      return `matrix(${this.a}, ${this.b}, ${this.c}, ${this.d}, ${this.e}, ${this.f})`;
    }
  };
}

process.on("uncaughtException", (err) => {
  console.error("[server] uncaughtException:", err?.stack ?? String(err));
});
process.on("unhandledRejection", (reason) => {
  console.error("[server] unhandledRejection:", (reason as any)?.stack ?? String(reason));
});

void import("./server.js");
