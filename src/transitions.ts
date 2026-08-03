// Guarded transitions — a column you may only enter once its claim is true.
//
// A plain `moveCard` writes a state; it does not check the state is warranted.
// So "in preview" comes to mean "somebody moved the card", and the board says
// a thing is deployed when nothing looked. The column names a claim about the
// world — deployed to preview, live in production — and the move should be
// refused until that claim holds.
//
// What each column requires differs per project and is nobody's business here,
// so conditions are DECLARED AS DATA rather than written as functions. A policy
// can then be read from project config, handed to a model, shown to a person,
// or diffed in review — none of which a closure allows.
//
// The rule that gives the guard its value: a condition that could NOT be
// evaluated refuses the move. Treating "I could not check" as "it passed"
// would make the guard fail open, which is the one behaviour worse than not
// having it — the board would carry the same unearned claim, now with the
// appearance of having been verified.

import type { WorkflowAdapter, WorkflowEnv } from './index.js';

/** A condition that must hold before a card may enter a column.
 *
 * Open by construction: an unrecognised `kind` evaluates to `unknown` and so
 * refuses the move, rather than being skipped. A checker that does not know a
 * condition must never be able to wave it through. */
export type EntryCondition =
  /** The deployment answers. The common shape of "is it actually there?". */
  | {
      kind: 'http-ok';
      url: string;
      /** Default 200. */
      expectStatus?: number;
      /** Default 10_000. */
      timeoutMs?: number;
      /** Human-readable statement of what this proves, used in the refusal. */
      describes?: string;
    }
  /** An arbitrary check the consumer runs — a smoke test, a CLI query. The
   * contract does not execute these; a Node consumer supplies the checker. */
  | {
      kind: 'command';
      argv: readonly string[];
      cwd?: string;
      timeoutMs?: number;
      describes?: string;
    }
  /** Requires a person. Never passes automatically — with no human checker
   * wired in it evaluates to `unknown`, and the move is refused, which is the
   * correct answer for "a human has not confirmed this". */
  | { kind: 'manual'; prompt: string };

/** What a column demands of anything entering it. */
export interface ColumnPolicy {
  columnId: string;
  /** ALL must hold. Empty means the column is freely enterable — which is the
   * right default for the early columns of most boards. */
  requires: readonly EntryCondition[];
}

/** A board's transition rules. Columns absent from `columns` are freely
 * enterable, so a policy only has to state the columns that guard something. */
export interface TransitionPolicy {
  columns: readonly ColumnPolicy[];
}

export type ConditionResult =
  | { status: 'held'; condition: EntryCondition; evidence: string }
  | { status: 'failed'; condition: EntryCondition; evidence: string }
  /** Could not be determined — unreachable, timed out, no checker for the
   * kind, a checker that threw. NOT a pass. */
  | { status: 'unknown'; condition: EntryCondition; reason: string };

/** Evaluates one condition. Consumers supply this, because what it takes to
 * prove a deploy is project knowledge, not contract knowledge.
 *
 * It should not throw — but `checkEntry` treats a throw as `unknown` anyway,
 * so a checker with a bug refuses the transition instead of crashing it. */
export type ConditionChecker = (condition: EntryCondition) => Promise<ConditionResult>;

export type TransitionOutcome =
  | { outcome: 'moved'; toColumnId: string; results: readonly ConditionResult[] }
  | { outcome: 'refused'; toColumnId: string; results: readonly ConditionResult[]; reason: string };

/** The conditions a column imposes. Empty for an unguarded column. */
export function requirementsFor(
  policy: TransitionPolicy | undefined,
  columnId: string
): readonly EntryCondition[] {
  if (!policy) return [];
  // First match wins, and duplicates are not merged: a policy listing a column
  // twice is a config mistake, and silently unioning the two would enforce a
  // rule set nobody wrote.
  return policy.columns.find((c) => c.columnId === columnId)?.requires ?? [];
}

/** Evaluate every condition guarding `columnId`.
 *
 * ALL of them run, including after one has already failed. A caller told only
 * about the first problem fixes it, re-runs, and is told about the next —
 * whereas a deploy check is slow and the full list is what makes one more
 * attempt sufficient. */
export async function checkEntry(
  policy: TransitionPolicy | undefined,
  columnId: string,
  check: ConditionChecker
): Promise<readonly ConditionResult[]> {
  const required = requirementsFor(policy, columnId);
  return Promise.all(
    required.map(async (condition) => {
      try {
        return await check(condition);
      } catch (err) {
        return {
          status: 'unknown' as const,
          condition,
          reason: `the checker threw: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    })
  );
}

/** True only when every condition positively held. An empty list is true — an
 * unguarded column — but an `unknown` is not, and that asymmetry is the point. */
export function entryHolds(results: readonly ConditionResult[]): boolean {
  return results.every((r) => r.status === 'held');
}

/** Why the move was refused, naming each condition that did not hold and what
 * was observed — so the reader can act without re-running anything. */
export function refusalReason(columnId: string, results: readonly ConditionResult[]): string {
  const blocking = results.filter((r) => r.status !== 'held');
  const lines = blocking.map((r) =>
    r.status === 'failed'
      ? `  - ${describe(r.condition)}: FAILED — ${r.evidence}`
      : `  - ${describe(r.condition)}: COULD NOT BE CHECKED — ${r.reason}`
  );
  const unknowns = blocking.filter((r) => r.status === 'unknown').length;
  const note = unknowns
    ? `\n${unknowns} of these could not be checked. That is not a pass: the column would be claiming something nothing verified.`
    : '';
  return `"${columnId}" was not entered — ${blocking.length} of its ${results.length} entry conditions did not hold:\n${lines.join('\n')}${note}`;
}

/** A condition in words, for a message a person or a model reads. */
export function describe(condition: EntryCondition): string {
  switch (condition.kind) {
    case 'http-ok':
      return condition.describes ?? `${condition.url} answers ${condition.expectStatus ?? 200}`;
    case 'command':
      return condition.describes ?? `\`${condition.argv.join(' ')}\` succeeds`;
    case 'manual':
      return condition.prompt;
    default:
      // An unrecognised kind still has to be nameable, because it is about to
      // appear in the refusal it caused.
      return `unrecognised condition ${JSON.stringify((condition as { kind?: unknown }).kind)}`;
  }
}

/**
 * Move a card into a column, but only once that column's entry conditions hold.
 *
 * A free function over the adapter rather than a method on it: the guard is
 * identical for every backend, and five adapters implementing it separately is
 * five chances to get the fail-open case wrong.
 *
 * The adapter's `moveCard` is not called at all on a refusal — the board is
 * left exactly as it was, so a refused transition is indistinguishable from one
 * never attempted.
 */
export async function moveStoryTo(
  adapter: Pick<WorkflowAdapter, 'moveCard'>,
  env: WorkflowEnv,
  boardUrl: string,
  cardId: string,
  toColumnId: string,
  options: { policy?: TransitionPolicy; check?: ConditionChecker } = {}
): Promise<TransitionOutcome> {
  const required = requirementsFor(options.policy, toColumnId);

  // A guarded column with no checker supplied is a caller mistake, and the safe
  // reading of it is refusal: the conditions exist and nothing evaluated them.
  const check: ConditionChecker =
    options.check ??
    (async (condition) => ({
      status: 'unknown',
      condition,
      reason: 'no condition checker was supplied to moveStoryTo',
    }));

  const results = required.length ? await checkEntry(options.policy, toColumnId, check) : [];

  if (!entryHolds(results)) {
    return { outcome: 'refused', toColumnId, results, reason: refusalReason(toColumnId, results) };
  }

  await adapter.moveCard(env, boardUrl, cardId, toColumnId);
  return { outcome: 'moved', toColumnId, results };
}
