import { createHash, createHmac } from "node:crypto";

export type HashAlgorithm = "sha256" | "hmac-sha256";

export interface HashOptions {
  /** When set, entries are sealed with HMAC-SHA256 instead of bare SHA-256. */
  key?: string;
}

/**
 * Deterministic JSON: object keys sorted recursively so semantically equal
 * values serialize byte-for-byte identically regardless of insertion order.
 * This is what the ledger hashes, so a reordered entry cannot forge a match.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * hash = ALGO:H(canonical(entry-without-hash) + prev_hash). prev_hash is also a
 * field of the payload, so the chain is bound twice: tampering with content or with
 * the link both break the recomputed digest. The digest is algorithm-tagged so verify
 * knows whether a key is required and can detect an HMAC->SHA-256 downgrade.
 */
export function hashEntry(payloadWithoutHash: unknown, prevHash: string, options: HashOptions = {}): string {
  const input = canonicalize(payloadWithoutHash) + prevHash;
  if (options.key) {
    return "hmac-sha256:" + createHmac("sha256", options.key).update(input).digest("hex");
  }
  return "sha256:" + createHash("sha256").update(input).digest("hex");
}

/** The algorithm tag on a stored hash, or null if it is untagged/unknown. */
export function hashAlgorithm(taggedHash: string): HashAlgorithm | null {
  if (taggedHash.startsWith("hmac-sha256:")) return "hmac-sha256";
  if (taggedHash.startsWith("sha256:")) return "sha256";
  return null;
}
