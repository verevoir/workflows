// The one checker the contract ships.
//
// `http-ok` is here because it is the check the guarded columns actually want:
// "in preview" means the preview URL answers, "done" means production does.
// It needs only `fetch`, so it runs wherever this package does.
//
// `command` is deliberately NOT here. Executing a process needs Node APIs and
// hands whatever wrote the policy the ability to run it — a decision that
// belongs to the consumer, who knows where the policy came from. Without a
// command checker wired in, a `command` condition evaluates to `unknown` and
// refuses the move, which is the correct answer for a check that did not run.

import type { ConditionChecker, ConditionResult, EntryCondition } from './transitions.js';

const DEFAULT_TIMEOUT_MS = 10_000;

/** Answers `http-ok` conditions; everything else is `unknown` so another
 * checker in the chain can take it, or the move is refused. */
export const httpConditionChecker: ConditionChecker = async (condition) => {
  if (condition.kind !== 'http-ok') {
    return {
      status: 'unknown',
      condition,
      reason: `no checker for condition kind "${condition.kind}"`,
    };
  }

  // The URL comes from project config, which is not the same as trusted. A
  // `file:` or `data:` URL here would have this reach the local filesystem on
  // behalf of whoever edited the policy, and the answer would still be dressed
  // up as "deployed".
  let url: URL;
  try {
    url = new URL(condition.url);
  } catch {
    return { status: 'unknown', condition, reason: `"${condition.url}" is not a URL` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      status: 'unknown',
      condition,
      reason: `refusing to check a ${url.protocol} URL — an entry condition may only reach http(s)`,
    };
  }

  const expect = condition.expectStatus ?? 200;
  const timeoutMs = condition.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);

  try {
    const res = await fetch(url, { method: 'GET', signal: abort.signal, redirect: 'follow' });
    return res.status === expect
      ? { status: 'held', condition, evidence: `${url.href} answered ${res.status}` }
      : {
          status: 'failed',
          condition,
          evidence: `${url.href} answered ${res.status}, expected ${expect}`,
        };
  } catch (err) {
    // Unreachable is NOT "not deployed" — a DNS blip and a torn-down
    // environment look identical from here, and only one of them means the
    // claim is false. Reporting `unknown` still refuses the move; it just does
    // not assert something this cannot know.
    const why = abort.signal.aborted ? `no answer within ${timeoutMs}ms` : messageOf(err);
    return { status: 'unknown', condition, reason: `could not reach ${url.href}: ${why}` };
  } finally {
    clearTimeout(timer);
  }
};

/** Try each checker in turn, taking the first that reaches a verdict.
 *
 * `unknown` means "not mine, or I could not tell", so it falls through to the
 * next checker; `held` and `failed` are verdicts and stop the chain. When every
 * checker passes, the last `unknown` is returned — the move is refused and the
 * reason is the most specific one available. */
export function firstCheckerToAnswer(...checkers: readonly ConditionChecker[]): ConditionChecker {
  return async (condition: EntryCondition) => {
    let last: ConditionResult = {
      status: 'unknown',
      condition,
      reason: 'no checker was offered this condition',
    };
    for (const checker of checkers) {
      last = await checker(condition);
      if (last.status !== 'unknown') return last;
    }
    return last;
  };
}

function messageOf(err: unknown): string {
  if (err instanceof Error) {
    // fetch wraps the real cause; without it every network failure reads
    // "fetch failed", which names the layer that noticed rather than the fault.
    const cause = (err as { cause?: unknown }).cause;
    const causeMsg = cause instanceof Error ? cause.message : undefined;
    return causeMsg ? `${err.message} (${causeMsg})` : err.message;
  }
  return String(err);
}
