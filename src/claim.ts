// Claiming — taking ownership of a card so no one else can.
//
// The CRUD half of this contract cannot express it. "Read the ready column,
// pick one, set the assignee, move it" is four calls with three gaps, and two
// runners racing through those gaps both observe an unclaimed card and both
// believe they won. Claiming has to be ONE operation the backend settles.
//
// Adopted from the agentic-product-platform's `claim_story`, including the
// ordering that makes it safe: establish the claim in the store that can
// arbitrate (a run record, a lease, a conditional write), and only then move
// the card. The reverse order — move first, record after — is the racy one,
// because the move is not the thing anyone contends on.

import type { Card, WorkflowEnv } from './index.js';

/** A card claim: who holds it, and until when if the backend expires them. */
export interface Claim {
  /** The claim's own identity — a run id, a lease id. Passed back to
   * `release`, and the handle a caller quotes when reporting what it did. */
  id: string;
  cardId: string;
  /** The claimant, as `ClaimRequest.holder` supplied it. */
  holder: string;
  /** ISO8601. */
  claimedAt: string;
  /** ISO8601. Absent when the backend's claims do not expire — then only an
   * explicit `release` (or backend-side intervention) frees the card. */
  expiresAt?: string;
  /** Whatever else the backend hands over at claim time. The platform returns
   * the story path, the Context Repository URL and the space's code
   * repositories — a runner needs all three and none of them fit `Card`.
   * Consumers must tolerate this being empty. */
  extra?: Record<string, unknown>;
}

export interface ClaimRequest {
  /** Who is claiming — a runner id or principal. Required: a claim with no
   * holder cannot be arbitrated, released, or reported on. */
  holder: string;
  /** Claim this specific card. Omit to take the first claimable one, which is
   * the common case for a runner pulling work. */
  cardId?: string;
  /** Where claimable work lives. Omit to use the backend's own notion of it
   * (the platform's "ready"); adapters without one MUST require it rather than
   * guess a column. */
  columnId?: string;
  /** Requested lease duration. Advisory — backends without leases ignore it,
   * and `Claim.expiresAt` is what actually happened. */
  ttlMs?: number;
}

/** Why a claim did not happen. Distinct cases because they call for different
 * responses: back off and retry, ask for different work, or stop and report a
 * caller that is already busy. Collapsing them into one failure would leave a
 * runner unable to tell "try again shortly" from "there is nothing here". */
export type ClaimOutcome =
  | { outcome: 'claimed'; claim: Claim; card: Card }
  /** Someone else holds it. `holder` is theirs, not yours. */
  | { outcome: 'already-claimed'; cardId: string; holder: string }
  /** Nothing to claim — an empty column, or every card in it already held. */
  | { outcome: 'nothing-claimable'; reason: string }
  /** The requested card exists but is not in a claimable column. */
  | { outcome: 'not-claimable'; cardId: string; columnId: string; reason: string }
  /** This holder already has a live claim. Claiming a second would mean a
   * runner working two cards with one identity, and nothing could then say
   * which run a result belonged to. */
  | { outcome: 'holder-already-claiming'; claim: Claim };

/** The claiming half of the adapter contract, kept separate because most
 * backends cannot honour it.
 *
 * An adapter implements this ONLY when the backend can settle contention
 * itself — a conditional write, a lease, a transaction. **Do not emulate it**
 * with list-then-update: that reintroduces exactly the race the operation
 * exists to remove, while looking from the outside as though it had been
 * solved, which is worse than not offering it. An adapter that cannot claim
 * leaves these absent, and `canClaim` reports false. */
export interface ClaimingAdapter {
  claim(env: WorkflowEnv, boardUrl: string, request: ClaimRequest): Promise<ClaimOutcome>;
  /** Give the claim up. Idempotent: releasing a claim already released, or
   * since taken by someone else, is not an error — a runner cleaning up after
   * a crash cannot know which it is doing, and must not be made to care. */
  release(env: WorkflowEnv, boardUrl: string, claimId: string): Promise<void>;
}

/** Whether this adapter can genuinely claim. Consumers branch on it rather
 * than assuming — the alternative to a real claim is refusing the work, never
 * a hand-rolled read-modify-write. */
export function canClaim<T extends object>(adapter: T): adapter is T & ClaimingAdapter {
  const a = adapter as Partial<ClaimingAdapter>;
  return typeof a.claim === 'function' && typeof a.release === 'function';
}
