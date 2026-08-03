// The resource contract — one shape for every addressable thing.
//
// WHY THIS REPLACES A NOUN-PER-TOOL SURFACE. Tool budget is a hard limit, and
// eight tools spent on `card` leaves nothing for `story`, `page`, `doc` or the
// objective tree. Typed resources spend those eight once: a new type costs zero
// tools. Comments stop being a special case too — a comment is a resource with
// a parent.
//
// The cost is discoverability, and it is paid deliberately. `list_cards` tells
// a reader what it does; `listResources(type)` does not. So the affordances
// move out of names and into DATA — `listResourceTypes` says which types exist,
// what states each has, and what each supports. A small model reads that and
// narrows, instead of holding forty tool descriptions.

import type { WorkflowEnv } from './index.js';

/** Where a resource lives: its type and its id within that type. */
export interface ResourceRef {
  type: string;
  id: string;
}

/**
 * Any addressable thing — a story, a page, a comment, an objective.
 *
 * `state` is the workflow state and it lives HERE, on the resource, never in a
 * shared board index. In a file-backed source that is YAML frontmatter; in
 * Notion it is the row's status property. One place, so a state change is one
 * write and two runners moving two different resources cannot collide.
 */
export interface Resource {
  type: string;
  id: string;
  title: string;
  /** Markdown body. Empty string when there is none. */
  body: string;
  /** The workflow state. Absent for types that have no lifecycle — a page is
   * not in a column. Only `transitionResource` may change it. */
  state?: string;
  /** Parent resource id, for comments, sub-tasks, nested pages. */
  parentId?: string;
  assigneeIds: string[];
  labels: string[];
  /** Explicit priority. A board file made list ORDER the priority; a resource
   * model has nowhere to put that, so it is declared. Lower sorts first, and
   * resources without one sort after those with one — see `byRank`. */
  rank?: number;
  /** Who holds this resource, when it is claimed. Written only by
   * `claimResource` / `releaseClaim`. */
  claim?: ResourceClaim;
  /** Type-specific extras the contract does not name. */
  fields?: Record<string, unknown>;
  /** Opaque change handle for conditional writes — a file sha, an etag, a
   * Notion `last_edited_time`. Passing a stale one is how a claim or a
   * transition loses a race instead of silently overwriting the winner. */
  revision?: string;
  url?: string;
  lastActivity?: string;
}

export interface ResourceClaim {
  /** The claim's own identity — passed back to `releaseClaim`. */
  id: string;
  holder: string;
  /** ISO8601. */
  claimedAt: string;
  /** ISO8601. Absent when claims here do not expire. */
  expiresAt?: string;
  /** Whatever else the backend hands over at claim time — a story path, a
   * repository list. Consumers must tolerate it being absent. */
  extra?: Record<string, unknown>;
}

/** What a type is and what may be done to it.
 *
 * This is the discoverability surface: with generic tools, a caller learns what
 * is possible by reading this rather than by reading tool names. It must
 * therefore be honest — a type that lists `claim` and then refuses every claim
 * is worse than one that never offered it. */
export interface ResourceTypeDescriptor {
  type: string;
  /** Every state this type may be in, in workflow order. Empty for types with
   * no lifecycle. This is what `list_columns` used to be. */
  states: readonly string[];
  /** The state a newly created resource starts in. */
  defaultState?: string;
  /** Which states are claimable — where a runner picks up work. Empty means
   * this type is not claimed even if `supports` includes it for a named id. */
  claimableStates?: readonly string[];
  supports: readonly ResourceCapability[];
  /** States that carry entry conditions, so a caller knows a transition into
   * them can be refused before it tries. Advisory: the policy itself is the
   * authority, and a state absent here is not a promise of no guard. */
  guardedStates?: readonly string[];
  /** Named fields beyond the standard ones, for callers building a create. */
  fields?: readonly ResourceFieldDef[];
}

export type ResourceCapability =
  | 'create'
  | 'update'
  | 'transition'
  | 'claim'
  | 'comment'
  | 'delete';

export interface ResourceFieldDef {
  name: string;
  type: 'text' | 'number' | 'date' | 'boolean' | 'select' | 'multiselect' | 'user' | 'url';
  required?: boolean;
  options?: readonly string[];
}

export interface ResourceFilter {
  type?: string;
  state?: string;
  parentId?: string;
  assigneeId?: string;
  label?: string;
  /** Only resources nobody holds. How a runner asks for available work. */
  unclaimed?: boolean;
  /** Include bodies. Default true; set false for list views, where fetching
   * every body can be one call per resource. */
  includeBody?: boolean;
  limit?: number;
}

/** Patch for `updateResource`. Absent keys are left alone.
 *
 * `state` is deliberately NOT here. A state change asserts something about the
 * world — "deployed to preview", "live in production" — and must go through
 * `transitionResource`, which verifies that assertion before writing it. If
 * this patch could carry `state`, every guard would be one convenience call
 * away from being bypassed. */
export interface ResourcePatch {
  title?: string;
  body?: string;
  parentId?: string;
  assigneeIds?: string[];
  labels?: string[];
  rank?: number;
  fields?: Record<string, unknown>;
  /** The revision the caller believes it is editing. Supplied where the
   * backend supports conditional writes; a mismatch is a `conflict` rather
   * than a silent overwrite. */
  expectRevision?: string;
}

export type ResourceCreate = Omit<ResourcePatch, 'expectRevision'> & { title: string };

/** The reason `updateResource` refuses a state change, so the refusal teaches
 * rather than merely blocks. Exported because adapters share the wording. */
export const STATE_IS_NOT_A_FIELD =
  'state cannot be set through updateResource — it asserts something about the world, ' +
  'so it moves through transitionResource, which verifies that assertion first.';

/** Sort by declared rank, then by id so the order is total and stable.
 *
 * Resources with no rank sort AFTER those with one: an unranked resource has
 * not been prioritised, and putting it first would let anything unranked jump
 * the queue that ranking exists to impose. */
export function byRank(a: Resource, b: Resource): number {
  const ar = a.rank ?? Number.POSITIVE_INFINITY;
  const br = b.rank ?? Number.POSITIVE_INFINITY;
  if (ar !== br) return ar - br;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The read + write half every resource source implements.
 *
 * Claiming and transitioning are NOT here — they need a backend that can settle
 * contention, and most cannot. See `ClaimingResourceAdapter` and
 * `TransitioningResourceAdapter`, and the `canClaim` / `canTransition` guards. */
export interface ResourceAdapter {
  /** What types this source has, and what each supports. The entry point: a
   * caller that has not read this is guessing. */
  listResourceTypes(env: WorkflowEnv, sourceUrl: string): Promise<ResourceTypeDescriptor[]>;

  /** The board, as a query rather than a document. */
  listResources(env: WorkflowEnv, sourceUrl: string, filter?: ResourceFilter): Promise<Resource[]>;

  /** Throws WorkflowApiError(404) when it does not exist. */
  getResource(env: WorkflowEnv, sourceUrl: string, ref: ResourceRef): Promise<Resource>;

  createResource(
    env: WorkflowEnv,
    sourceUrl: string,
    type: string,
    fields: ResourceCreate
  ): Promise<Resource>;

  /** Apply a patch. MUST throw `WorkflowApiError(400, STATE_IS_NOT_A_FIELD)` if
   * asked to change state by any route — the guard is only structural if every
   * adapter refuses. */
  updateResource(
    env: WorkflowEnv,
    sourceUrl: string,
    ref: ResourceRef,
    patch: ResourcePatch
  ): Promise<void>;
}
