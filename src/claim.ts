// Claiming — taking a resource so nobody else can.
//
// The CRUD half cannot express it. "List the ready ones, pick one, set the
// assignee, write it back" is four calls with three gaps, and two runners
// racing through those gaps both observe an unclaimed resource and both believe
// they won. Claiming has to be ONE operation the backend settles.
//
// With state on the resource (ADR: everything is a typed resource), that
// operation is a single compare-and-swap on a single record: `state: ready` and
// unheld, to `state: in progress` and held-by, conditional on the revision that
// was read. The platform's claim_story needs a run record to arbitrate first
// precisely because its board.md cannot — a shared index has no per-story
// contention point. Here the problem does not arise rather than being solved.

import type { WorkflowEnv } from './index.js';
import type { Resource, ResourceClaim, ResourceRef } from './resource.js';

export interface ClaimRequest {
  /** Who is claiming — a runner id or principal. Required: a claim with no
   * holder cannot be arbitrated, released, or reported against. */
  holder: string;
  /** The type to claim from. Required — "the next work item" is meaningless
   * across types. */
  type: string;
  /** Claim this specific resource. Omit to take the first claimable one in
   * rank order, which is what a runner pulling work wants. */
  id?: string;
  /** Restrict to this state. Omit to use the type's `claimableStates`; an
   * adapter with none declared MUST require this rather than guess. */
  state?: string;
  /** Requested lease duration. Advisory — backends without leases ignore it,
   * and `ResourceClaim.expiresAt` says what actually happened. */
  ttlMs?: number;
}

/** Why a claim did not happen. Kept distinct because they call for different
 * responses: retry shortly, ask for different work, or stop because this holder
 * is already busy. One collapsed failure would leave a runner unable to tell
 * "try again" from "there is nothing here". */
export type ClaimOutcome =
  | { outcome: 'claimed'; claim: ResourceClaim; resource: Resource }
  /** Someone else got there first. `holder` is theirs. */
  | { outcome: 'already-claimed'; ref: ResourceRef; holder: string }
  /** Nothing available — no resource in a claimable state, or all held. */
  | { outcome: 'nothing-claimable'; reason: string }
  /** The named resource exists but is not in a claimable state. */
  | { outcome: 'not-claimable'; ref: ResourceRef; state: string | undefined; reason: string }
  /** This holder already has a live claim. A second would mean one identity
   * working two resources, and nothing could then say which run a result
   * belonged to. */
  | { outcome: 'holder-already-claiming'; claim: ResourceClaim };

/** The claiming half, separate because most backends cannot honour it.
 *
 * Implement ONLY where the backend can settle contention itself — a conditional
 * write, a lease, a transaction. **Do not emulate it** with read-then-write:
 * that reintroduces the exact race the operation exists to remove while looking
 * from outside as though it had been solved, which is worse than not offering
 * it. An adapter that cannot claim leaves these absent and `canClaim` says so. */
export interface ClaimingResourceAdapter {
  claimResource(env: WorkflowEnv, sourceUrl: string, request: ClaimRequest): Promise<ClaimOutcome>;
  /** Give the claim up. Idempotent: releasing one already released, or since
   * taken by someone else, is not an error — a runner cleaning up after a crash
   * cannot know which it is doing and must not be made to care. */
  releaseClaim(env: WorkflowEnv, sourceUrl: string, claimId: string): Promise<void>;
}

/** Whether this adapter can genuinely claim. Branch on it rather than assuming:
 * the alternative to a real claim is refusing the work, never a hand-rolled
 * read-modify-write. */
export function canClaim<T extends object>(adapter: T): adapter is T & ClaimingResourceAdapter {
  const a = adapter as Partial<ClaimingResourceAdapter>;
  return typeof a.claimResource === 'function' && typeof a.releaseClaim === 'function';
}
