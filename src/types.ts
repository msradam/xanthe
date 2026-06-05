/**
 * Xanthe's own canonical state for a session: what Xanthe tracks per beat.
 * The ledger and the hash chain are over THIS, never over XState's internal
 * persisted-snapshot blob (which is an unstable, disposable cache).
 */
export interface CanonicalState {
  value: unknown;
  context: Record<string, unknown>;
}

export type Outcome = "allowed" | "refused";

export interface LedgerEntry {
  ts: number;
  seq: number;
  /** Event type for a step, or "init" / "fork" for a session's genesis entry. */
  action: string;
  /** State value before the beat (null for genesis). */
  from: unknown | null;
  /** State value after the beat (null when refused). */
  to: unknown | null;
  reason: string;
  outcome: Outcome;
  /** Canonical state AFTER this entry. For a refusal, the unchanged current state. */
  state: CanonicalState;
  session_id: string;
  prev_hash: string;
  hash: string;
}

/** Result of a step(), returned over the MCP surface. */
export interface StepResult {
  outcome: Outcome;
  attempted: string;
  /** Present and true on a refusal, so a weak model self-corrects. */
  refused?: boolean;
  from: unknown | null;
  to: unknown | null;
  reason: string;
  /** Legal next moves from the resulting state. */
  legal: string[];
  state: CanonicalState;
  seq: number;
  session_id: string;
}

export interface StateView {
  session_id: string;
  value: unknown;
  context: Record<string, unknown>;
  legal: string[];
  terminal: boolean;
}
