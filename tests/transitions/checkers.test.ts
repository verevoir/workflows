import { describe, it, expect, vi, afterEach } from 'vitest';
import { httpConditionChecker, firstCheckerToAnswer } from '../../src/checkers.js';
import type { ConditionChecker, EntryCondition } from '../../src/transitions.js';

const HEALTH: EntryCondition = { kind: 'http-ok', url: 'https://preview.example/health' };

/** Replace global fetch for one test. Returned so the call can be asserted. */
function stubFetch(impl: (url: URL, init: RequestInit) => Promise<Response> | Response) {
  const fetchSpy = vi.fn(impl as never);
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

afterEach(() => vi.unstubAllGlobals());

describe('http-ok holds when the environment answers as expected', () => {
  it('holds on the default 200', async () => {
    stubFetch(() => new Response('', { status: 200 }));
    const result = await httpConditionChecker(HEALTH);
    expect(result.status).toBe('held');
  });

  it('holds on an explicitly expected non-200', async () => {
    // `null`, not `''` — a 204 carries no body and constructing one with a
    // body throws, which the checker would (correctly) report as unknown.
    stubFetch(() => new Response(null, { status: 204 }));
    const result = await httpConditionChecker({ ...HEALTH, expectStatus: 204 } as EntryCondition);
    expect(result.status).toBe('held');
  });

  it('fails on a status that is not the expected one, and says both', async () => {
    stubFetch(() => new Response('', { status: 503 }));
    const result = await httpConditionChecker(HEALTH);
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected a failure');
    expect(result.evidence).toContain('503');
    expect(result.evidence, 'and what it should have been').toContain('200');
  });
});

describe('unreachable is UNKNOWN, not failed', () => {
  it('reports unknown when the request throws', async () => {
    // A DNS blip and a torn-down environment are the same event from here, and
    // only one of them means "not deployed". Both refuse the move — but calling
    // a network fault a failed deploy sends the reader to the wrong system.
    stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    const result = await httpConditionChecker(HEALTH);
    expect(result.status).toBe('unknown');
  });

  it('carries the underlying cause, not just "fetch failed"', async () => {
    const err = new TypeError('fetch failed');
    (err as { cause?: unknown }).cause = new Error('ENOTFOUND preview.example');
    stubFetch(() => {
      throw err;
    });
    const result = await httpConditionChecker(HEALTH);
    if (result.status !== 'unknown') throw new Error('expected unknown');
    expect(result.reason, 'the layer that noticed is not the fault').toContain(
      'ENOTFOUND preview.example'
    );
  });

  it('reports unknown, naming the deadline, when the request times out', async () => {
    stubFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          (init.signal as AbortSignal).addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          );
        })
    );
    const result = await httpConditionChecker({ ...HEALTH, timeoutMs: 5 } as EntryCondition);
    expect(result.status).toBe('unknown');
    if (result.status !== 'unknown') throw new Error('expected unknown');
    expect(result.reason).toContain('5ms');
  });
});

describe('a condition may only reach http(s)', () => {
  it.each([
    ['file:///etc/passwd', 'file:'],
    ['data:text/plain,ok', 'data:'],
  ])('refuses to check %s', async (url) => {
    // The policy is project config, which is not the same as trusted. A file:
    // URL would have this read the local disk on behalf of whoever edited the
    // policy — and report the result as evidence of a deployment.
    const fetchSpy = stubFetch(() => new Response('', { status: 200 }));
    const result = await httpConditionChecker({ kind: 'http-ok', url });
    expect(result.status).toBe('unknown');
    expect(fetchSpy, 'and nothing was requested').not.toHaveBeenCalled();
  });

  it('reports unknown for a string that is not a URL at all', async () => {
    const result = await httpConditionChecker({ kind: 'http-ok', url: 'not a url' });
    expect(result.status).toBe('unknown');
  });
});

describe('http-ok declines conditions that are not its own', () => {
  it('returns unknown for another kind rather than answering for it', async () => {
    const result = await httpConditionChecker({ kind: 'command', argv: ['true'] });
    expect(result.status).toBe('unknown');
    if (result.status !== 'unknown') throw new Error('expected unknown');
    expect(result.reason).toContain('command');
  });
});

describe('firstCheckerToAnswer', () => {
  const held: ConditionChecker = async (condition) => ({
    status: 'held',
    condition,
    evidence: 'yes',
  });
  const unknown =
    (reason: string): ConditionChecker =>
    async (condition) => ({
      status: 'unknown',
      condition,
      reason,
    });

  it('passes an unanswered condition along the chain', async () => {
    const result = await firstCheckerToAnswer(unknown('not mine'), held)(HEALTH);
    expect(result.status).toBe('held');
  });

  it('stops at the first checker that reaches a verdict', async () => {
    const later = vi.fn(held);
    await firstCheckerToAnswer(held, later)(HEALTH);
    expect(later, 'a verdict ends the chain').not.toHaveBeenCalled();
  });

  it('stops on a FAILED verdict too, not only on a pass', async () => {
    // Otherwise a later checker could overturn a genuine failure into a pass.
    const later = vi.fn(held);
    const failing: ConditionChecker = async (condition) => ({
      status: 'failed',
      condition,
      evidence: 'no',
    });
    const result = await firstCheckerToAnswer(failing, later)(HEALTH);
    expect(result.status).toBe('failed');
    expect(later).not.toHaveBeenCalled();
  });

  it('returns the LAST reason when nobody could answer', async () => {
    // The most specific thing anyone managed to say beats a generic shrug.
    const result = await firstCheckerToAnswer(
      unknown('not mine'),
      unknown('unreachable host')
    )(HEALTH);
    if (result.status !== 'unknown') throw new Error('expected unknown');
    expect(result.reason).toBe('unreachable host');
  });

  it('is unknown, not a pass, when offered no checkers at all', async () => {
    const result = await firstCheckerToAnswer()(HEALTH);
    expect(result.status).toBe('unknown');
  });
});
