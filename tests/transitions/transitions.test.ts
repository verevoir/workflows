import { describe, it, expect, vi } from 'vitest';
import {
  moveStoryTo,
  checkEntry,
  entryHolds,
  requirementsFor,
  refusalReason,
  describe as describeCondition,
} from '../../src/transitions.js';
import type { ConditionChecker, EntryCondition, TransitionPolicy } from '../../src/transitions.js';

const env = { token: '' };
const BOARD = 'board-1';

const DEPLOYED: EntryCondition = {
  kind: 'http-ok',
  url: 'https://preview.example/health',
  describes: 'the preview environment answers',
};
const SMOKED: EntryCondition = { kind: 'command', argv: ['npm', 'run', 'smoke'] };

const policy = (requires: readonly EntryCondition[]): TransitionPolicy => ({
  columns: [{ columnId: 'in preview', requires }],
});

/** An adapter that records whether the board was touched. The central claim of
 * a refusal is that it was not. */
function spyAdapter() {
  const moveCard = vi.fn(async () => {});
  return { adapter: { moveCard }, moveCard };
}

const always =
  (status: 'held' | 'failed'): ConditionChecker =>
  async (condition) =>
    status === 'held'
      ? { status, condition, evidence: 'observed' }
      : { status, condition, evidence: 'observed the opposite' };

describe('a column with no conditions is freely enterable', () => {
  it('moves a card into a column the policy says nothing about', async () => {
    const { adapter, moveCard } = spyAdapter();
    const outcome = await moveStoryTo(adapter, env, BOARD, 'c1', 'backlog', {
      policy: policy([DEPLOYED]),
    });
    expect(outcome.outcome).toBe('moved');
    expect(moveCard).toHaveBeenCalledWith(env, BOARD, 'c1', 'backlog');
  });

  it('moves when there is no policy at all, and never asks a checker', async () => {
    const { adapter, moveCard } = spyAdapter();
    const check = vi.fn(always('failed'));
    const outcome = await moveStoryTo(adapter, env, BOARD, 'c1', 'in preview', { check });
    expect(outcome.outcome).toBe('moved');
    expect(check, 'nothing to check, so nothing is checked').not.toHaveBeenCalled();
    expect(moveCard).toHaveBeenCalled();
  });
});

describe('a guarded column is entered only when its conditions hold', () => {
  it('moves the card when every condition holds', async () => {
    const { adapter, moveCard } = spyAdapter();
    const outcome = await moveStoryTo(adapter, env, BOARD, 'c1', 'in preview', {
      policy: policy([DEPLOYED, SMOKED]),
      check: always('held'),
    });
    expect(outcome.outcome).toBe('moved');
    expect(moveCard).toHaveBeenCalledWith(env, BOARD, 'c1', 'in preview');
  });

  it('refuses, and leaves the board untouched, when a condition fails', async () => {
    // The board not moving is the whole guarantee: a refused transition has to
    // be indistinguishable from one that was never attempted, or the card ends
    // up claiming something the check just denied.
    const { adapter, moveCard } = spyAdapter();
    const outcome = await moveStoryTo(adapter, env, BOARD, 'c1', 'in preview', {
      policy: policy([DEPLOYED]),
      check: always('failed'),
    });
    expect(outcome.outcome).toBe('refused');
    expect(moveCard, 'the card was not moved').not.toHaveBeenCalled();
  });

  it('names every condition that did not hold, not just the first', async () => {
    // A deploy check is slow. Reporting one problem at a time turns one fix
    // into a sequence of round trips.
    const outcome = await moveStoryTo(spyAdapter().adapter, env, BOARD, 'c1', 'in preview', {
      policy: policy([DEPLOYED, SMOKED]),
      check: always('failed'),
    });
    if (outcome.outcome !== 'refused') throw new Error('expected a refusal');
    expect(outcome.results).toHaveLength(2);
    expect(outcome.reason).toContain('the preview environment answers');
    expect(outcome.reason).toContain('npm run smoke');
  });

  it('evaluates the later conditions even after an earlier one has failed', async () => {
    const seen: string[] = [];
    const check: ConditionChecker = async (condition) => {
      seen.push(condition.kind);
      return { status: 'failed', condition, evidence: 'no' };
    };
    await moveStoryTo(spyAdapter().adapter, env, BOARD, 'c1', 'in preview', {
      policy: policy([DEPLOYED, SMOKED]),
      check,
    });
    expect(seen).toEqual(['http-ok', 'command']);
  });
});

describe('a check that could not run refuses the move', () => {
  // The fail-open cases, gathered: each one is a route by which the board could
  // come to assert something nothing verified, which is worse than having no
  // guard at all because it carries the appearance of having been checked.

  it('refuses on an unknown verdict rather than treating it as a pass', async () => {
    const { adapter, moveCard } = spyAdapter();
    const outcome = await moveStoryTo(adapter, env, BOARD, 'c1', 'in preview', {
      policy: policy([DEPLOYED]),
      check: async (condition) => ({ status: 'unknown', condition, reason: 'DNS failed' }),
    });
    expect(outcome.outcome).toBe('refused');
    expect(moveCard).not.toHaveBeenCalled();
  });

  it('says plainly that an unchecked condition is not a pass', async () => {
    const outcome = await moveStoryTo(spyAdapter().adapter, env, BOARD, 'c1', 'in preview', {
      policy: policy([DEPLOYED]),
      check: async (condition) => ({ status: 'unknown', condition, reason: 'DNS failed' }),
    });
    if (outcome.outcome !== 'refused') throw new Error('expected a refusal');
    expect(outcome.reason).toContain('COULD NOT BE CHECKED');
    expect(outcome.reason).toContain('DNS failed');
    expect(outcome.reason).toContain('That is not a pass');
  });

  it('refuses when a guarded column is moved to with NO checker supplied', async () => {
    // The caller forgot. The conditions still exist and still went unevaluated,
    // so the answer is the same as any other unchecked condition.
    const { adapter, moveCard } = spyAdapter();
    const outcome = await moveStoryTo(adapter, env, BOARD, 'c1', 'in preview', {
      policy: policy([DEPLOYED]),
    });
    expect(outcome.outcome).toBe('refused');
    expect(moveCard).not.toHaveBeenCalled();
    if (outcome.outcome !== 'refused') throw new Error('expected a refusal');
    expect(outcome.reason).toContain('no condition checker was supplied');
  });

  it('refuses when the checker throws, instead of the throw escaping', async () => {
    // A buggy checker must not be able to take down the transition — nor to
    // pass it. It degrades to the same refusal as any other unchecked
    // condition, carrying the fault as the reason.
    const { adapter, moveCard } = spyAdapter();
    const outcome = await moveStoryTo(adapter, env, BOARD, 'c1', 'in preview', {
      policy: policy([DEPLOYED]),
      check: async () => {
        throw new Error('checker exploded');
      },
    });
    expect(outcome.outcome).toBe('refused');
    expect(moveCard).not.toHaveBeenCalled();
    if (outcome.outcome !== 'refused') throw new Error('expected a refusal');
    expect(outcome.reason).toContain('checker exploded');
  });

  it('refuses a condition kind no checker recognises', async () => {
    // The open-set case: a policy written against a newer vocabulary than the
    // checker understands must not be skipped past.
    const future = { kind: 'attestation-signed', by: 'release-bot' } as unknown as EntryCondition;
    const outcome = await moveStoryTo(spyAdapter().adapter, env, BOARD, 'c1', 'in preview', {
      policy: policy([future]),
      check: async (condition) =>
        condition.kind === 'http-ok'
          ? { status: 'held', condition, evidence: 'ok' }
          : { status: 'unknown', condition, reason: `no checker for "${condition.kind}"` },
    });
    expect(outcome.outcome).toBe('refused');
  });

  it('never passes a manual condition on its own', async () => {
    // "A human has confirmed this" cannot be true because no human was asked.
    const outcome = await moveStoryTo(spyAdapter().adapter, env, BOARD, 'c1', 'in preview', {
      policy: policy([{ kind: 'manual', prompt: 'a reviewer has signed off' }]),
      check: async (condition) =>
        condition.kind === 'manual'
          ? { status: 'unknown', condition, reason: 'no human checker wired in' }
          : { status: 'held', condition, evidence: 'ok' },
    });
    expect(outcome.outcome).toBe('refused');
    if (outcome.outcome !== 'refused') throw new Error('expected a refusal');
    expect(outcome.reason).toContain('a reviewer has signed off');
  });
});

describe('entryHolds', () => {
  it('holds for no conditions at all', () => {
    expect(entryHolds([])).toBe(true);
  });

  it('does not hold when one result is unknown among passes', () => {
    expect(
      entryHolds([
        { status: 'held', condition: DEPLOYED, evidence: 'ok' },
        { status: 'unknown', condition: SMOKED, reason: 'no checker' },
      ])
    ).toBe(false);
  });
});

describe('requirementsFor', () => {
  it('is empty for a column the policy does not mention', () => {
    expect(requirementsFor(policy([DEPLOYED]), 'done')).toEqual([]);
  });

  it('takes the first entry rather than merging a duplicated column', () => {
    // Merging would enforce a rule set nobody wrote; taking the first keeps the
    // config mistake visible as the behaviour that was configured.
    const duplicated: TransitionPolicy = {
      columns: [
        { columnId: 'done', requires: [DEPLOYED] },
        { columnId: 'done', requires: [SMOKED] },
      ],
    };
    expect(requirementsFor(duplicated, 'done')).toEqual([DEPLOYED]);
  });
});

describe('checkEntry', () => {
  it('returns one result per declared condition, in order', async () => {
    const results = await checkEntry(policy([DEPLOYED, SMOKED]), 'in preview', always('held'));
    expect(results.map((r) => r.condition.kind)).toEqual(['http-ok', 'command']);
  });
});

describe('describing a condition for a person to read', () => {
  it('prefers the policy author’s own words', () => {
    expect(describeCondition(DEPLOYED)).toBe('the preview environment answers');
  });

  it('falls back to the URL and expected status', () => {
    expect(describeCondition({ kind: 'http-ok', url: 'https://x.test', expectStatus: 204 })).toBe(
      'https://x.test answers 204'
    );
  });

  it('still names a condition kind it does not recognise', () => {
    // It is about to appear in the refusal it caused, so it has to be nameable.
    const future = { kind: 'attestation-signed' } as unknown as EntryCondition;
    expect(describeCondition(future)).toContain('attestation-signed');
  });
});

describe('refusalReason', () => {
  it('counts the blocking conditions against the total', () => {
    const reason = refusalReason('done', [
      { status: 'held', condition: DEPLOYED, evidence: 'ok' },
      { status: 'failed', condition: SMOKED, evidence: 'exit 1' },
    ]);
    expect(reason).toContain('1 of its 2 entry conditions');
  });

  it('omits the unchecked note when everything blocking genuinely failed', () => {
    // The note exists to stop an unknown reading as a failure. Printing it when
    // the checks did run would tell the reader to distrust a real answer.
    const reason = refusalReason('done', [
      { status: 'failed', condition: SMOKED, evidence: 'exit 1' },
    ]);
    expect(reason).not.toContain('That is not a pass');
  });
});
