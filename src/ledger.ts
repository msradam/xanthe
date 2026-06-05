import { appendFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hashEntry, hashAlgorithm } from "./canonical.js";
import type { LedgerEntry } from "./types.js";

/**
 * Append-only durable store for a session's hash-chained ledger. The engine
 * appends; verify and fork read. Keyed by (machineId, sessionId).
 */
export interface LedgerStore {
  append(machineId: string, sessionId: string, entry: LedgerEntry): void;
  read(machineId: string, sessionId: string): LedgerEntry[];
  listSessions(machineId: string): string[];
  /** Human-facing location label for the banner. */
  locate(machineId: string, sessionId: string): string;
}

export const DEFAULT_ROOT = join(homedir(), ".xanthe");

export class FileLedgerStore implements LedgerStore {
  constructor(private readonly root: string = DEFAULT_ROOT) {}

  private dir(machineId: string, sessionId: string): string {
    return join(this.root, machineId, sessionId);
  }

  private file(machineId: string, sessionId: string): string {
    return join(this.dir(machineId, sessionId), "ledger.jsonl");
  }

  append(machineId: string, sessionId: string, entry: LedgerEntry): void {
    mkdirSync(this.dir(machineId, sessionId), { recursive: true });
    appendFileSync(this.file(machineId, sessionId), JSON.stringify(entry) + "\n");
  }

  read(machineId: string, sessionId: string): LedgerEntry[] {
    const path = this.file(machineId, sessionId);
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as LedgerEntry);
  }

  listSessions(machineId: string): string[] {
    const base = join(this.root, machineId);
    if (!existsSync(base)) return [];
    return readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  }

  listMachines(): string[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  }

  locate(machineId: string, sessionId: string): string {
    return this.file(machineId, sessionId);
  }
}

/** In-memory store for the primer and tests. No disk writes. */
export class MemoryLedgerStore implements LedgerStore {
  private readonly data = new Map<string, LedgerEntry[]>();

  private key(machineId: string, sessionId: string): string {
    return `${machineId}/${sessionId}`;
  }

  append(machineId: string, sessionId: string, entry: LedgerEntry): void {
    const k = this.key(machineId, sessionId);
    const list = this.data.get(k) ?? [];
    list.push(entry);
    this.data.set(k, list);
  }

  read(machineId: string, sessionId: string): LedgerEntry[] {
    return [...(this.data.get(this.key(machineId, sessionId)) ?? [])];
  }

  listSessions(machineId: string): string[] {
    const prefix = `${machineId}/`;
    return [...this.data.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length))
      .sort();
  }

  locate(machineId: string, sessionId: string): string {
    return `memory://${machineId}/${sessionId}`;
  }
}

export interface VerifyResult {
  ok: boolean;
  count: number;
  sessionId?: string;
  /** Hash of the last entry: a portable commitment for external attestation. */
  headHash?: string;
  /** Whether the chain is sealed with an HMAC key. */
  keyed?: boolean;
  brokenSeq?: number;
  reason?: string;
}

export interface VerifyOptions {
  /** HMAC key for a keyed ledger (defaults to XANTHE_LEDGER_KEY at the call site). */
  key?: string;
  /** Fail if the chain is shorter than this (tail-drop / truncation defense). */
  minEntries?: number;
}

/**
 * Walk a session's chain recomputing every hash from Xanthe's own canonical
 * state. Catches edits (hash mismatch), reorders / gaps (seq), broken links
 * (prev_hash), cross-session copies (session_id bound in the payload and, when
 * expectedSessionId is given, checked against where the chain lives), truncation
 * (minEntries), and HMAC->SHA-256 downgrades. Returns headHash for attestation.
 */
export function verifyChain(
  entries: LedgerEntry[],
  expectedSessionId?: string,
  options: VerifyOptions = {},
): VerifyResult {
  const count = entries.length;
  const headHash = count > 0 ? entries[count - 1]!.hash : "";
  if (count === 0) return { ok: false, count, headHash, reason: "empty ledger" };

  const sessionId = entries[0]!.session_id;
  const keyed = hashAlgorithm(entries[0]!.hash) === "hmac-sha256";
  const base = { count, sessionId, headHash, keyed };

  if (expectedSessionId !== undefined && sessionId !== expectedSessionId) {
    return {
      ok: false,
      ...base,
      brokenSeq: 0,
      reason: `session_id '${sessionId}' does not match its location '${expectedSessionId}' (cross-session copy)`,
    };
  }
  if (options.minEntries !== undefined && count < options.minEntries) {
    return {
      ok: false,
      ...base,
      reason: `ledger truncated: expected at least ${options.minEntries} entries, found ${count}`,
    };
  }

  let prevHash = "";
  let expectedSeq = 0;
  for (const entry of entries) {
    const algo = hashAlgorithm(entry.hash);
    if (algo === null) {
      return {
        ok: false,
        ...base,
        brokenSeq: entry.seq,
        reason: "entry hash is missing its algorithm tag (corrupt or pre-tag entry)",
      };
    }
    if (algo === "hmac-sha256" && !options.key) {
      return { ok: false, ...base, brokenSeq: entry.seq, reason: "keyed ledger: set XANTHE_LEDGER_KEY to verify" };
    }
    if (algo === "sha256" && options.key) {
      return {
        ok: false,
        ...base,
        brokenSeq: entry.seq,
        reason: "algorithm downgrade: entry is unkeyed but a key was supplied",
      };
    }
    if (entry.seq !== expectedSeq) {
      return {
        ok: false,
        ...base,
        brokenSeq: entry.seq,
        reason: `expected seq ${expectedSeq}, found ${entry.seq} (reorder or gap)`,
      };
    }
    if (entry.session_id !== sessionId) {
      return {
        ok: false,
        ...base,
        brokenSeq: entry.seq,
        reason: `session_id changed mid-chain to '${entry.session_id}'`,
      };
    }
    if (entry.prev_hash !== prevHash) {
      return { ok: false, ...base, brokenSeq: entry.seq, reason: `prev_hash does not link to seq ${expectedSeq - 1}` };
    }
    const { hash, ...payload } = entry;
    if (hashEntry(payload, entry.prev_hash, algo === "hmac-sha256" ? { key: options.key } : {}) !== hash) {
      return { ok: false, ...base, brokenSeq: entry.seq, reason: "hash mismatch (entry tampered)" };
    }
    prevHash = entry.hash;
    expectedSeq += 1;
  }

  return { ok: true, ...base };
}
