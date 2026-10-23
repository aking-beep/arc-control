/**
 * Deterministic stand-in digests and ids for the prototype only. The real
 * values are SHA-256 over canonical JSON (packages/evidence, packages/audit)
 * and `newId()` random hex (packages/schemas/src/ids.ts). These only need to
 * look the same shape and stay stable between renders.
 */
function hex(seed: string, length: number): string {
  let out = '';
  let h = 2166136261;
  let i = 0;
  while (out.length < length) {
    h ^= seed.charCodeAt(i % seed.length) + i;
    h = Math.imul(h, 16777619) >>> 0;
    out += (h % 16).toString(16);
    i += 1;
  }
  return out;
}

export function fakeDigest(seed: string): string {
  return `sha256:${hex(seed, 64)}`;
}

export function fakeId(prefix: string, seed: string): string {
  return `${prefix}_${hex(seed, 32)}`;
}

export const GENESIS = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
