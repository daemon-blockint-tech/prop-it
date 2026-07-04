/**
 * Utility to build a Merkle root (and proofs) over TxLINE match stats
 * using keccak256 + sort-pair hashing so proofs are directionless.
 * Mirrors the on-chain `txline_mock::validate_stat` verifier.
 */

import { keccak_256 } from "@noble/hashes/sha3";

export interface StatLeaf {
  statType: string; // ASCII, ≤16 bytes
  statValue: bigint;
}

function encodeLeaf(l: StatLeaf): Uint8Array {
  const st = new Uint8Array(16);
  const bytes = new TextEncoder().encode(l.statType);
  st.set(bytes.subarray(0, Math.min(16, bytes.length)), 0);
  const v = new Uint8Array(8);
  const dv = new DataView(v.buffer);
  dv.setBigUint64(0, l.statValue, true); // little-endian
  const buf = new Uint8Array(16 + 8);
  buf.set(st, 0);
  buf.set(v, 16);
  return buf;
}

function h(a: Uint8Array): Uint8Array {
  return keccak_256(a);
}

function sortPair(a: Uint8Array, b: Uint8Array): Uint8Array {
  const cmp = Buffer.compare(Buffer.from(a), Buffer.from(b));
  const buf = new Uint8Array(64);
  if (cmp <= 0) { buf.set(a, 0); buf.set(b, 32); }
  else          { buf.set(b, 0); buf.set(a, 32); }
  return buf;
}

export function buildTree(leaves: StatLeaf[]): { root: Uint8Array; leaves: Uint8Array[] } {
  if (leaves.length === 0) throw new Error("no leaves");
  const hashed = leaves.map((l) => h(encodeLeaf(l)));
  let level = hashed.slice();
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(h(sortPair(a, b)));
    }
    level = next;
  }
  return { root: level[0], leaves: hashed };
}

export function buildProof(leaves: StatLeaf[], targetIndex: number): Uint8Array[] {
  let level = leaves.map((l) => h(encodeLeaf(l)));
  let idx = targetIndex;
  const proof: Uint8Array[] = [];
  while (level.length > 1) {
    const sibIdx = idx % 2 === 0 ? Math.min(idx + 1, level.length - 1) : idx - 1;
    proof.push(level[sibIdx]);
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(h(sortPair(a, b)));
    }
    idx = Math.floor(idx / 2);
    level = next;
  }
  return proof;
}
