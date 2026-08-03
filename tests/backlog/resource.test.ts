import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backlogResources } from '../../src/backlog/resource.js';

const env = { token: '' };

let projectRoot: string;
let backlogDir: string;
let tasksDir: string;

/** Write a task file `<id> - sample.md` with the given frontmatter + body. */
function writeTask(id: string, frontmatter: string, body = ''): void {
  writeFileSync(join(tasksDir, `${id} - sample.md`), `---\n${frontmatter}\n---\n${body}`);
}

function readTaskFile(id: string): string {
  return readFileSync(join(tasksDir, `${id} - sample.md`), 'utf8');
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'backlog-res-'));
  backlogDir = join(projectRoot, 'backlog');
  tasksDir = join(backlogDir, 'tasks');
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(
    join(backlogDir, 'config.yml'),
    'project_name: Test\nstatuses:\n  - To Do\n  - In Progress\n  - Done\ndefault_status: To Do\n'
  );
});

afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// listResourceTypes
// ---------------------------------------------------------------------------

describe('listResourceTypes', () => {
  it('returns one descriptor for type "task" with states from config.yml', async () => {
    const [desc] = await backlogResources.listResourceTypes(env, projectRoot);
    expect(desc.type).toBe('task');
    expect(desc.states).toEqual(['To Do', 'In Progress', 'Done']);
    expect(desc.defaultState).toBe('To Do');
    expect(desc.supports).toContain('create');
    expect(desc.supports).toContain('claim');
    expect(desc.supports).toContain('transition');
  });

  it('sets claimableStates to [statuses[0]] by default', async () => {
    const [desc] = await backlogResources.listResourceTypes(env, projectRoot);
    expect(desc.claimableStates).toEqual(['To Do']);
  });

  it('uses claimable_statuses from config when present', async () => {
    writeFileSync(
      join(backlogDir, 'config.yml'),
      'statuses:\n  - Backlog\n  - Ready\n  - Doing\nclaimable_statuses:\n  - Backlog\n  - Ready\n'
    );
    const [desc] = await backlogResources.listResourceTypes(env, projectRoot);
    expect(desc.claimableStates).toEqual(['Backlog', 'Ready']);
  });
});

// ---------------------------------------------------------------------------
// listResources / getResource
// ---------------------------------------------------------------------------

describe('listResources', () => {
  beforeEach(() => {
    writeTask(
      'task-1',
      'id: task-1\ntitle: Alpha\nstatus: To Do\nlabels:\n  - bug\nrank: 2',
      'body text'
    );
    writeTask(
      'task-2',
      'id: task-2\ntitle: Beta\nstatus: In Progress\nassignee:\n  - "@alice"\nparent_task_id: task-1\nrank: 1'
    );
  });

  it('maps frontmatter fields to Resource properties', async () => {
    const resources = await backlogResources.listResources(env, projectRoot);
    const byId = Object.fromEntries(resources.map((r) => [r.id, r]));

    expect(byId['task-1'].title).toBe('Alpha');
    expect(byId['task-1'].state).toBe('To Do');
    expect(byId['task-1'].labels).toEqual(['bug']);
    expect(byId['task-1'].body).toBe('body text');
    expect(byId['task-1'].rank).toBe(2);
    expect(byId['task-2'].assigneeIds).toEqual(['alice']);
    expect(byId['task-2'].parentId).toBe('task-1');
    expect(byId['task-2'].rank).toBe(1);
  });

  it('exposes a non-empty revision on each resource', async () => {
    const resources = await backlogResources.listResources(env, projectRoot);
    expect(resources.every((r) => typeof r.revision === 'string' && r.revision.length > 0)).toBe(
      true
    );
  });

  it('filters by state', async () => {
    const resources = await backlogResources.listResources(env, projectRoot, {
      state: 'In Progress',
    });
    expect(resources.map((r) => r.id)).toEqual(['task-2']);
  });

  it('filters by label', async () => {
    const resources = await backlogResources.listResources(env, projectRoot, { label: 'bug' });
    expect(resources.map((r) => r.id)).toEqual(['task-1']);
  });

  it('filters by assigneeId', async () => {
    const resources = await backlogResources.listResources(env, projectRoot, {
      assigneeId: 'alice',
    });
    expect(resources.map((r) => r.id)).toEqual(['task-2']);
  });

  it('filters by parentId', async () => {
    const resources = await backlogResources.listResources(env, projectRoot, {
      parentId: 'task-1',
    });
    expect(resources.map((r) => r.id)).toEqual(['task-2']);
  });

  it('omits body when includeBody is false', async () => {
    const resources = await backlogResources.listResources(env, projectRoot, {
      includeBody: false,
    });
    expect(resources.every((r) => r.body === '')).toBe(true);
  });

  it('returns empty list for an unknown type filter', async () => {
    const resources = await backlogResources.listResources(env, projectRoot, { type: 'epic' });
    expect(resources).toEqual([]);
  });
});

describe('getResource', () => {
  it('returns the resource by id', async () => {
    writeTask('task-5', 'id: task-5\ntitle: Lucky\nstatus: Done');
    const r = await backlogResources.getResource(env, projectRoot, { type: 'task', id: 'task-5' });
    expect(r.title).toBe('Lucky');
    expect(r.state).toBe('Done');
    expect(r.type).toBe('task');
  });

  it('throws 404 for a missing resource', async () => {
    await expect(
      backlogResources.getResource(env, projectRoot, { type: 'task', id: 'task-99' })
    ).rejects.toMatchObject({ status: 404 });
  });
});

// ---------------------------------------------------------------------------
// createResource
// ---------------------------------------------------------------------------

describe('createResource', () => {
  it('refuses to create a resource that arrives already claimed', async () => {
    // Same route, same reason as on update — and worse here, because a
    // pre-claimed resource would be held by someone who never contended.
    await expect(
      backlogResources.createResource(env, projectRoot, 'task', {
        title: 'sneaky',
        fields: { claim: { id: 'forged', holder: 'mallory', claimedAt: '2026-01-01T00:00:00Z' } },
      })
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('claimResource') });
  });

  it('refuses a create that dictates its own id, which the filename is derived from', async () => {
    await expect(
      backlogResources.createResource(env, projectRoot, 'task', {
        title: 'sneaky',
        fields: { id: 'task-999' },
      })
    ).rejects.toMatchObject({ status: 400 });
  });

  it('still allows an initial state on create — starting in a state is not a transition', async () => {
    // The exemption that keeps the reserved-key rule from over-reaching: no
    // claim about the world is being made by creating something in a column.
    const created = await backlogResources.createResource(env, projectRoot, 'task', {
      title: 'starts in progress',
      fields: { status: 'In Progress' },
    });
    expect(created.state).toBe('In Progress');
  });

  it('writes a new task and returns it with the default state', async () => {
    writeTask('task-3', 'id: task-3\ntitle: Existing\nstatus: To Do');
    const r = await backlogResources.createResource(env, projectRoot, 'task', {
      title: 'New task',
      body: 'detail',
    });
    expect(r.id).toBe('task-4');
    expect(r.state).toBe('To Do');
    expect(r.title).toBe('New task');
    expect(r.body).toBe('detail');
    expect(typeof r.revision).toBe('string');
  });

  it('persists the task so getResource can retrieve it', async () => {
    const created = await backlogResources.createResource(env, projectRoot, 'task', {
      title: 'Persisted',
    });
    const fetched = await backlogResources.getResource(env, projectRoot, {
      type: 'task',
      id: created.id,
    });
    expect(fetched.title).toBe('Persisted');
  });

  it('throws 404 for an unknown resource type', async () => {
    await expect(
      backlogResources.createResource(env, projectRoot, 'epic', { title: 'x' })
    ).rejects.toMatchObject({ status: 404 });
  });
});

// ---------------------------------------------------------------------------
// updateResource — CRITICAL: state must be refused (rule 1)
// ---------------------------------------------------------------------------

describe('updateResource', () => {
  beforeEach(() => {
    writeTask('task-1', 'id: task-1\ntitle: Original\nstatus: To Do\ncreated_date: "2025-01-01"');
  });

  it('updates title and body without touching state', async () => {
    await backlogResources.updateResource(
      env,
      projectRoot,
      { type: 'task', id: 'task-1' },
      { title: 'Renamed', body: 'new body' }
    );
    const r = await backlogResources.getResource(env, projectRoot, { type: 'task', id: 'task-1' });
    expect(r.title).toBe('Renamed');
    expect(r.body).toBe('new body');
    expect(r.state).toBe('To Do');
  });

  it('throws 400 STATE_IS_NOT_A_FIELD when fields.status is supplied', async () => {
    // This is the critical guard: updateResource MUST refuse state changes via
    // any route, including through fields. The deploy guard is only structural
    // if every adapter refuses.
    await expect(
      backlogResources.updateResource(
        env,
        projectRoot,
        { type: 'task', id: 'task-1' },
        { fields: { status: 'Done' } }
      )
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('transitionResource'),
    });
  });

  it('throws 400 STATE_IS_NOT_A_FIELD when fields.state is supplied', async () => {
    await expect(
      backlogResources.updateResource(
        env,
        projectRoot,
        { type: 'task', id: 'task-1' },
        { fields: { state: 'Done' } }
      )
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('transitionResource'),
    });
  });

  it('refuses to write a claim through fields, so arbitration cannot be walked around', async () => {
    // `fields` preserves a project's own frontmatter, which makes it a route to
    // every key in the file — including the ones the contract owns. Writing
    // `claim` here would let a caller name itself the holder without ever
    // contending for it, and let it drop a claim someone else holds.
    await expect(
      backlogResources.updateResource(
        env,
        projectRoot,
        { type: 'task', id: 'task-1' },
        {
          fields: { claim: { id: 'forged', holder: 'mallory', claimedAt: '2026-01-01T00:00:00Z' } },
        }
      )
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('claimResource') });

    const after = await backlogResources.getResource(env, projectRoot, {
      type: 'task',
      id: 'task-1',
    });
    expect(after.claim, 'and nothing was written').toBeUndefined();
  });

  it('refuses to repoint identity through fields', async () => {
    // The file is addressed by its id; rewriting it in frontmatter leaves a
    // record whose filename no longer matches what it claims to be.
    await expect(
      backlogResources.updateResource(
        env,
        projectRoot,
        { type: 'task', id: 'task-1' },
        { fields: { id: 'task-999' } }
      )
    ).rejects.toMatchObject({ status: 400 });

    const after = await backlogResources.getResource(env, projectRoot, {
      type: 'task',
      id: 'task-1',
    });
    expect(after.id).toBe('task-1');
  });

  it('preserves unrecognised frontmatter keys on update (rule 7)', async () => {
    await backlogResources.updateResource(
      env,
      projectRoot,
      { type: 'task', id: 'task-1' },
      { title: 'Updated' }
    );
    expect(readTaskFile('task-1')).toContain('created_date');
  });

  it('throws 409 when expectRevision is supplied and does not match', async () => {
    await expect(
      backlogResources.updateResource(
        env,
        projectRoot,
        { type: 'task', id: 'task-1' },
        { title: 'Conflict', expectRevision: 'stale-hash' }
      )
    ).rejects.toMatchObject({ status: 409 });
  });

  it('succeeds when expectRevision matches the current revision', async () => {
    const r = await backlogResources.getResource(env, projectRoot, {
      type: 'task',
      id: 'task-1',
    });
    await expect(
      backlogResources.updateResource(
        env,
        projectRoot,
        { type: 'task', id: 'task-1' },
        { title: 'CAS update', expectRevision: r.revision }
      )
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// setState — compare-and-swap (rule 2)
// ---------------------------------------------------------------------------

describe('setState', () => {
  beforeEach(() => {
    writeTask('task-1', 'id: task-1\ntitle: Mover\nstatus: To Do\ncreated_date: "2025-06-01"');
  });

  it('transitions state and returns ok:true with updated resource', async () => {
    const result = await backlogResources.setState(
      env,
      projectRoot,
      { type: 'task', id: 'task-1' },
      'In Progress'
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resource.state).toBe('In Progress');
      expect(typeof result.resource.revision).toBe('string');
    }
  });

  it('returns ok:false conflict when expectRevision is stale, without writing (rule 2)', async () => {
    const result = await backlogResources.setState(
      env,
      projectRoot,
      { type: 'task', id: 'task-1' },
      'Done',
      { expectRevision: 'old-hash' }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.conflict).toMatch(/revision mismatch/);

    // The file must NOT have been written.
    const r = await backlogResources.getResource(env, projectRoot, { type: 'task', id: 'task-1' });
    expect(r.state).toBe('To Do');
  });

  it('succeeds when expectRevision matches the current sha', async () => {
    const r = await backlogResources.getResource(env, projectRoot, {
      type: 'task',
      id: 'task-1',
    });
    const result = await backlogResources.setState(
      env,
      projectRoot,
      { type: 'task', id: 'task-1' },
      'Done',
      { expectRevision: r.revision }
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resource.state).toBe('Done');
  });

  it('returns a new revision after a successful write', async () => {
    const before = await backlogResources.getResource(env, projectRoot, {
      type: 'task',
      id: 'task-1',
    });
    const result = await backlogResources.setState(
      env,
      projectRoot,
      { type: 'task', id: 'task-1' },
      'In Progress'
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resource.revision).not.toBe(before.revision);
  });

  it('preserves unrecognised frontmatter keys through setState (rule 7)', async () => {
    await backlogResources.setState(env, projectRoot, { type: 'task', id: 'task-1' }, 'Done');
    expect(readTaskFile('task-1')).toContain('created_date');
  });
});

// ---------------------------------------------------------------------------
// claimResource (rules 3, 4, 5)
// ---------------------------------------------------------------------------

describe('claimResource', () => {
  beforeEach(() => {
    writeTask('task-1', 'id: task-1\ntitle: Task One\nstatus: To Do\nrank: 2');
    writeTask('task-2', 'id: task-2\ntitle: Task Two\nstatus: To Do\nrank: 1');
    writeTask('task-3', 'id: task-3\ntitle: Task Three\nstatus: In Progress');
  });

  it('auto-selects the lowest-rank claimable task (byRank order, rule 4)', async () => {
    const outcome = await backlogResources.claimResource(env, projectRoot, {
      holder: 'runner-a',
      type: 'task',
    });
    expect(outcome.outcome).toBe('claimed');
    if (outcome.outcome === 'claimed') {
      // task-2 has rank 1, task-1 has rank 2 — task-2 should be selected.
      expect(outcome.resource.id).toBe('task-2');
    }
  });

  it('claims a specific resource by id', async () => {
    const outcome = await backlogResources.claimResource(env, projectRoot, {
      holder: 'runner-a',
      type: 'task',
      id: 'task-1',
    });
    expect(outcome.outcome).toBe('claimed');
    if (outcome.outcome === 'claimed') {
      expect(outcome.resource.id).toBe('task-1');
      expect(outcome.claim.holder).toBe('runner-a');
    }
  });

  it('transitions state to the next state after claiming', async () => {
    const outcome = await backlogResources.claimResource(env, projectRoot, {
      holder: 'runner-a',
      type: 'task',
      id: 'task-1',
    });
    expect(outcome.outcome).toBe('claimed');
    if (outcome.outcome === 'claimed') {
      // "To Do" → next is "In Progress"
      expect(outcome.resource.state).toBe('In Progress');
    }
  });

  it('writes the claim into the resource, retrievable via getResource', async () => {
    await backlogResources.claimResource(env, projectRoot, {
      holder: 'runner-x',
      type: 'task',
      id: 'task-1',
    });
    const r = await backlogResources.getResource(env, projectRoot, { type: 'task', id: 'task-1' });
    expect(r.claim).toBeDefined();
    expect(r.claim?.holder).toBe('runner-x');
  });

  it('returns already-claimed when a named resource is already held (rule 3)', async () => {
    await backlogResources.claimResource(env, projectRoot, {
      holder: 'runner-a',
      type: 'task',
      id: 'task-1',
    });
    const outcome = await backlogResources.claimResource(env, projectRoot, {
      holder: 'runner-b',
      type: 'task',
      id: 'task-1',
    });
    expect(outcome.outcome).toBe('already-claimed');
    if (outcome.outcome === 'already-claimed') expect(outcome.holder).toBe('runner-a');
  });

  it('returns not-claimable for a resource in a non-claimable state', async () => {
    const outcome = await backlogResources.claimResource(env, projectRoot, {
      holder: 'runner-a',
      type: 'task',
      id: 'task-3', // In Progress is not claimable by default
    });
    expect(outcome.outcome).toBe('not-claimable');
  });

  it('returns nothing-claimable when all candidates are taken', async () => {
    await backlogResources.claimResource(env, projectRoot, {
      holder: 'r1',
      type: 'task',
      id: 'task-1',
    });
    await backlogResources.claimResource(env, projectRoot, {
      holder: 'r2',
      type: 'task',
      id: 'task-2',
    });
    const outcome = await backlogResources.claimResource(env, projectRoot, {
      holder: 'r3',
      type: 'task',
    });
    expect(outcome.outcome).toBe('nothing-claimable');
  });

  it('returns holder-already-claiming when holder already holds a live claim (rule 5)', async () => {
    await backlogResources.claimResource(env, projectRoot, {
      holder: 'runner-a',
      type: 'task',
      id: 'task-1',
    });
    const outcome = await backlogResources.claimResource(env, projectRoot, {
      holder: 'runner-a',
      type: 'task',
      id: 'task-2',
    });
    expect(outcome.outcome).toBe('holder-already-claiming');
  });

  it('hides claimed tasks from unclaimed filter after claiming', async () => {
    await backlogResources.claimResource(env, projectRoot, {
      holder: 'runner-a',
      type: 'task',
      id: 'task-1',
    });
    const unclaimed = await backlogResources.listResources(env, projectRoot, { unclaimed: true });
    expect(unclaimed.map((r) => r.id)).not.toContain('task-1');
  });

  it('preserves unrecognised frontmatter keys through claimResource (rule 7)', async () => {
    writeTask('task-4', 'id: task-4\ntitle: Extra\nstatus: To Do\ncreated_date: "2025-05-01"');
    await backlogResources.claimResource(env, projectRoot, {
      holder: 'runner-a',
      type: 'task',
      id: 'task-4',
    });
    expect(readTaskFile('task-4')).toContain('created_date');
  });

  it('lets an EXPIRED claim be reclaimed, so a dead holder does not strand the work', async () => {
    // The consequence of a TTL, and the only reason to have one. Stamping
    // expiresAt is bookkeeping; expiring is the point — a runner that dies
    // holding a claim must not keep the work out of reach forever. Nothing
    // covered this: treating every expired claim as live passed the whole
    // suite, which is exactly the shape of a lease that silently never expires.
    writeTask(
      'task-9',
      [
        'id: task-9',
        'title: abandoned',
        'status: To Do',
        'claim:',
        '  id: claim-dead',
        '  holder: runner-that-died',
        '  claimedAt: 2020-01-01T00:00:00.000Z',
        '  expiresAt: 2020-01-01T00:01:00.000Z',
      ].join('\n')
    );

    const outcome = await backlogResources.claimResource(env, projectRoot, {
      holder: 'runner-b',
      type: 'task',
      id: 'task-9',
    });

    expect(outcome.outcome, 'the lapsed claim does not block a new one').toBe('claimed');
    if (outcome.outcome !== 'claimed') throw new Error('expected a claim');
    expect(outcome.claim.holder).toBe('runner-b');
    expect(outcome.claim.id, 'and it is a new claim, not the dead one revived').not.toBe(
      'claim-dead'
    );
  });

  it('keeps an UNEXPIRED claim held, so expiry does not become a free-for-all', async () => {
    // The other side of the same predicate. Without this, "always expired"
    // passes just as quietly as "never expired" did.
    writeTask(
      'task-10',
      [
        'id: task-10',
        'title: held',
        'status: To Do',
        'claim:',
        '  id: claim-live',
        '  holder: runner-a',
        '  claimedAt: 2026-01-01T00:00:00.000Z',
        `  expiresAt: ${new Date(Date.now() + 3_600_000).toISOString()}`,
      ].join('\n')
    );

    const outcome = await backlogResources.claimResource(env, projectRoot, {
      holder: 'runner-b',
      type: 'task',
      id: 'task-10',
    });

    expect(outcome.outcome).toBe('already-claimed');
    if (outcome.outcome === 'already-claimed') expect(outcome.holder).toBe('runner-a');
  });

  it('sets expiresAt when ttlMs is supplied', async () => {
    const before = Date.now();
    const outcome = await backlogResources.claimResource(env, projectRoot, {
      holder: 'runner-a',
      type: 'task',
      id: 'task-1',
      ttlMs: 60_000,
    });
    expect(outcome.outcome).toBe('claimed');
    if (outcome.outcome === 'claimed') {
      expect(outcome.claim.expiresAt).toBeDefined();
      const expires = new Date(outcome.claim.expiresAt!).getTime();
      expect(expires).toBeGreaterThan(before + 59_000);
    }
  });
});

// ---------------------------------------------------------------------------
// releaseClaim (rule 6)
// ---------------------------------------------------------------------------

describe('releaseClaim', () => {
  it('removes the claim from the resource', async () => {
    writeTask('task-1', 'id: task-1\ntitle: Releasable\nstatus: To Do');
    const outcome = await backlogResources.claimResource(env, projectRoot, {
      holder: 'runner-a',
      type: 'task',
      id: 'task-1',
    });
    expect(outcome.outcome).toBe('claimed');
    if (outcome.outcome === 'claimed') {
      await backlogResources.releaseClaim(env, projectRoot, outcome.claim.id);
      const r = await backlogResources.getResource(env, projectRoot, {
        type: 'task',
        id: 'task-1',
      });
      expect(r.claim).toBeUndefined();
    }
  });

  it('is idempotent — releasing an unknown claim id does not throw (rule 6)', async () => {
    await expect(
      backlogResources.releaseClaim(env, projectRoot, 'claim-that-does-not-exist')
    ).resolves.toBeUndefined();
  });

  it('allows the same holder to claim again after release', async () => {
    writeTask('task-1', 'id: task-1\ntitle: Reclaim\nstatus: To Do');
    const first = await backlogResources.claimResource(env, projectRoot, {
      holder: 'runner-a',
      type: 'task',
      id: 'task-1',
    });
    expect(first.outcome).toBe('claimed');
    if (first.outcome === 'claimed') {
      await backlogResources.releaseClaim(env, projectRoot, first.claim.id);
    }

    // After release, holder-already-claiming should no longer fire.
    const second = await backlogResources.claimResource(env, projectRoot, {
      holder: 'runner-a',
      type: 'task',
    });
    expect(second.outcome).not.toBe('holder-already-claiming');
  });

  it('preserves unrecognised frontmatter keys through releaseClaim (rule 7)', async () => {
    writeTask('task-1', 'id: task-1\ntitle: Rel\nstatus: To Do\ncreated_date: "2025-03-01"');
    const outcome = await backlogResources.claimResource(env, projectRoot, {
      holder: 'runner-a',
      type: 'task',
      id: 'task-1',
    });
    if (outcome.outcome === 'claimed') {
      await backlogResources.releaseClaim(env, projectRoot, outcome.claim.id);
    }
    expect(readTaskFile('task-1')).toContain('created_date');
  });
});
