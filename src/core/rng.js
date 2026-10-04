/** Deterministic PRNG utilities (no DOM dependency — unit testable in Node). */

export function mulberry32(seed) {
  let a = (seed | 0) >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  constructor(seed = 1) {
    this.seed = seed >>> 0 || 1;
    this.next = mulberry32(this.seed);
  }
  /** [0,1) */
  unit() { return this.next(); }
  /** [a,b) */
  range(a, b) { return a + (b - a) * this.next(); }
  /** integer in [a,b] */
  int(a, b) { return Math.floor(a + (b - a + 1) * this.next()); }
  bool(p = 0.5) { return this.next() < p; }
  sign() { return this.next() < 0.5 ? -1 : 1; }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  /** approx. normal via sum of uniforms */
  gauss(mean = 0, sd = 1) {
    let s = 0;
    for (let i = 0; i < 4; i++) s += this.next();
    return mean + (s - 2) * 0.8660254 * sd;
  }
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
}

export function randomSeed() {
  return (Math.floor(Math.random() * 0xffffffff) >>> 0) || 1;
}
