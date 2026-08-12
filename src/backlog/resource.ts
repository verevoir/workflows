// Backlog.md ResourceAdapter — ResourceAdapter + ClaimingResourceAdapter +
// TransitioningResourceAdapter over a Backlog.md project directory.
//
// Reuses the parsing/serialising helpers and parseBacklogBoardPath from
// ./index.ts (the existing WorkflowAdapter). Does not duplicate or modify them.
//
// File access goes through the @verevoir/sources fs SourceAdapter (ADR 019:
// no direct node:fs in src/).

import { parse as parseYaml, parseDocument, Document } from 'yaml';
import { fs as fsSource } from '@verevoir/sources/fs';
import type { SourceEnv } from '@verevoir/sources';
import { parseBacklogBoardPath } from './index.js';
import {
  WorkflowApiError,
  STATE_IS_NOT_A_FIELD,
  byRank,
  type WorkflowEnv,
  type Resource,
  type ResourceRef,
  type ResourceCreate,
  type ResourceFilter,
  type ResourcePatch,
  type ResourceTypeDescriptor,
  type ResourceAdapter,
  type ResourceClaim,
} from '../index.js';
import type { ClaimRequest, ClaimOutcome, ClaimingResourceAdapter } from '../claim.js';
import type { TransitioningResourceAdapter } from '../transitions.js';

const SOURCE_ENV: SourceEnv = { token: '', forkOrg: '' };
const TASKS_DIR = 'tasks';
const CONFIG_FILE = 'config.yml';
const RESOURCE_TYPE = 'task';

/** Frontmatter keys the contract owns, and why a general field write must not
 * reach them.
 *
 * `fields` exists so a project's own frontmatter survives a round trip, which
 * makes it a route to every key in the file — including the ones whose rules
 * are enforced somewhere else entirely. `status` walks past the transition
 * guard. `claim` walks past arbitration, letting a caller name itself the
 * holder or drop a claim someone else holds. `id` re-points identity at a
 * record whose filename no longer matches it.
 *
 * Refused by name and with a reason, NOT silently dropped. A silent drop
 * returns success for a write that did not happen, so a caller believes it
 * holds a claim it never took — which is the failure this guard exists to
 * prevent, arrived at by a politer route. */
const RESERVED_FIELDS: Readonly<Record<string, string>> = {
  status: STATE_IS_NOT_A_FIELD,
  state: STATE_IS_NOT_A_FIELD,
  claim:
    'claim cannot be set through create or update — it is written only by claimResource and ' +
    'releaseClaim, which arbitrate. Setting it here would let a caller name itself the holder, ' +
    'or drop a claim someone else holds, without ever contending for it.',
  id: 'id cannot be set through create or update — it is the identity the resource is addressed by.',
};

/** Throws on any reserved key present in `fields`. `allow` exempts the ones a
 * particular operation may legitimately set — creating a resource IN a state is
 * not a transition, so create permits `status`. */
function refuseReservedFields(
  fields: Record<string, unknown> | undefined,
  allow: readonly string[] = []
): void {
  for (const key of Object.keys(fields ?? {})) {
    const why = RESERVED_FIELDS[key];
    if (why !== undefined && !allow.includes(key)) throw new WorkflowApiError(why, 400);
  }
}

// ---------------------------------------------------------------------------
// Config I/O
// ---------------------------------------------------------------------------

interface BacklogConfig {
  statuses: string[];
  defaultStatus: string;
  claimableStatuses: string[];
}

async function readConfig(backlogDir: string): Promise<BacklogConfig> {
  let raw: string | null = null;
  try {
    raw = (await fsSource.readFile(SOURCE_ENV, backlogDir, CONFIG_FILE)).content;
  } catch (err) {
    if ((err as { status?: number }).status !== 404) throw err;
  }

  const cfg = raw ? ((parseYaml(raw) ?? {}) as Record<string, unknown>) : {};
  const rawStatuses = cfg['statuses'];
  const statuses =
    Array.isArray(rawStatuses) && rawStatuses.length > 0
      ? rawStatuses.map((s) => String(s).trim()).filter(Boolean)
      : ['To Do', 'In Progress', 'Done'];

  const defaultStatus =
    typeof cfg['default_status'] === 'string' && cfg['default_status'].trim()
      ? cfg['default_status'].trim()
      : statuses[0];

  // claimable_statuses in config overrides the default of [statuses[0]]
  const rawClaimable = cfg['claimable_statuses'];
  const claimableStatuses =
    Array.isArray(rawClaimable) && rawClaimable.length > 0
      ? rawClaimable.map((s) => String(s).trim()).filter(Boolean)
      : [statuses[0]];

  return { statuses, defaultStatus, claimableStatuses };
}

// ---------------------------------------------------------------------------
// Task file I/O
// ---------------------------------------------------------------------------

interface TaskFile {
  fileName: string;
  raw: string;
  /** sha256-prefix content hash from the fs SourceAdapter — used as revision */
  sha: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

function splitFrontmatter(text: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const match = text.match(FRONTMATTER_RE);
  if (!match) return { frontmatter: {}, body: text };
  const frontmatter = (parseDocument(match[1]).toJS() ?? {}) as Record<string, unknown>;
  return { frontmatter, body: text.slice(match[0].length) };
}

/** Apply key/value updates into a YAML frontmatter block, preserving all other
 * keys and the body. This is the key round-trip primitive: unrecognised keys
 * survive every write because we parse the document and set only what changed. */
function patchFrontmatter(text: string, updates: Record<string, unknown>): string {
  const match = text.match(FRONTMATTER_RE);
  const doc = match ? parseDocument(match[1]) : new Document({});
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) {
      doc.delete(key);
    } else {
      doc.set(key, value);
    }
  }
  const body = match ? text.slice(match[0].length) : text;
  return `---\n${doc.toString()}---\n${body}`;
}

function serialiseTask(frontmatter: Record<string, unknown>, body: string): string {
  return `---\n${new Document(frontmatter).toString()}---\n${body}`;
}

function setBody(text: string, body: string): string {
  const match = text.match(FRONTMATTER_RE);
  return match ? match[0] + body : body;
}

async function readTask(backlogDir: string, fileName: string): Promise<TaskFile> {
  const { content, sha } = await fsSource.readFile(
    SOURCE_ENV,
    backlogDir,
    `${TASKS_DIR}/${fileName}`
  );
  return { fileName, raw: content, sha, ...splitFrontmatter(content) };
}

async function taskFileNames(backlogDir: string): Promise<string[]> {
  try {
    const entries = await fsSource.listFiles(SOURCE_ENV, backlogDir, TASKS_DIR);
    return entries.filter((e) => e.type === 'file' && e.name.endsWith('.md')).map((e) => e.name);
  } catch (err) {
    if ((err as { status?: number }).status === 404) return [];
    throw err;
  }
}

function taskIdOf(task: TaskFile): string {
  const id = task.frontmatter['id'];
  return id != null && String(id).trim() !== ''
    ? String(id).trim()
    : task.fileName.replace(/\.md$/, '');
}

async function findTaskFile(backlogDir: string, resourceId: string): Promise<TaskFile | undefined> {
  for (const name of await taskFileNames(backlogDir)) {
    const task = await readTask(backlogDir, name);
    if (taskIdOf(task) === resourceId) return task;
  }
  return undefined;
}

async function requireTask(backlogDir: string, id: string): Promise<TaskFile> {
  const task = await findTaskFile(backlogDir, id);
  if (!task) throw new WorkflowApiError(`Task not found: ${id}`, 404);
  return task;
}

// ---------------------------------------------------------------------------
// Mapping: TaskFile → Resource
// ---------------------------------------------------------------------------

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (value != null && String(value).trim() !== '') return [String(value).trim()];
  return [];
}

/** Keys that map to named Resource fields — everything else goes in fields and
 * is preserved on write. */
const KNOWN_KEYS = new Set([
  'id',
  'title',
  'status',
  'assignee',
  'labels',
  'parent_task_id',
  'rank',
  'claim',
]);

function isLiveClaim(claim: unknown): claim is ResourceClaim {
  if (!claim || typeof claim !== 'object') return false;
  const c = claim as Record<string, unknown>;
  if (typeof c['id'] !== 'string' || typeof c['holder'] !== 'string') return false;
  if (typeof c['expiresAt'] === 'string') {
    return new Date(c['expiresAt']).getTime() > Date.now();
  }
  // No expiresAt → claim does not expire; it is live until explicitly released.
  return true;
}

function toResource(task: TaskFile, includeBody: boolean): Resource {
  const fm = task.frontmatter;
  const id = taskIdOf(task);
  const status = typeof fm['status'] === 'string' ? fm['status'].trim() : '';
  const parent = fm['parent_task_id'];
  const rank = typeof fm['rank'] === 'number' ? fm['rank'] : undefined;
  const claim = isLiveClaim(fm['claim']) ? (fm['claim'] as ResourceClaim) : undefined;

  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm)) {
    if (!KNOWN_KEYS.has(k)) fields[k] = v;
  }

  return {
    type: RESOURCE_TYPE,
    id,
    title: typeof fm['title'] === 'string' ? fm['title'] : id,
    body: includeBody ? task.body : '',
    state: status || undefined,
    ...(parent != null && String(parent).trim() !== '' ? { parentId: String(parent).trim() } : {}),
    assigneeIds: stringList(fm['assignee']).map((a) => a.replace(/^@/, '')),
    labels: stringList(fm['labels']),
    ...(rank !== undefined ? { rank } : {}),
    ...(claim !== undefined ? { claim } : {}),
    ...(Object.keys(fields).length > 0 ? { fields } : {}),
    revision: task.sha,
  };
}

// ---------------------------------------------------------------------------
// Next task id
// ---------------------------------------------------------------------------

async function nextTaskId(backlogDir: string): Promise<string> {
  let highest = 0;
  for (const name of await taskFileNames(backlogDir)) {
    const task = await readTask(backlogDir, name);
    const match = taskIdOf(task).match(/task-(\d+)/i);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `task-${highest + 1}`;
}

function slug(title: string): string {
  return (title || 'untitled').replace(/[\\/:*?"<>|#^[\]]/g, '').trim() || 'untitled';
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function backlogDirOf(sourceUrl: string): string {
  const parsed = parseBacklogBoardPath(sourceUrl);
  if (!parsed) throw new WorkflowApiError(`Cannot parse Backlog board path: ${sourceUrl}`, 404);
  return parsed.backlogDir;
}

// ---------------------------------------------------------------------------
// ResourceAdapter implementation
// ---------------------------------------------------------------------------

async function listResourceTypes(
  env: WorkflowEnv,
  sourceUrl: string
): Promise<ResourceTypeDescriptor[]> {
  void env;
  const dir = backlogDirOf(sourceUrl);
  const { statuses, defaultStatus, claimableStatuses } = await readConfig(dir);
  return [
    {
      type: RESOURCE_TYPE,
      states: statuses,
      defaultState: defaultStatus,
      claimableStates: claimableStatuses,
      supports: ['create', 'update', 'transition', 'claim'],
    },
  ];
}

async function listResources(
  env: WorkflowEnv,
  sourceUrl: string,
  filter?: ResourceFilter
): Promise<Resource[]> {
  void env;
  const dir = backlogDirOf(sourceUrl);
  const includeBody = filter?.includeBody ?? true;
  const names = await taskFileNames(dir);
  let resources: Resource[] = [];
  for (const name of names) {
    resources.push(toResource(await readTask(dir, name), includeBody));
  }

  if (filter?.type !== undefined && filter.type !== RESOURCE_TYPE) return [];
  if (filter?.state !== undefined) resources = resources.filter((r) => r.state === filter.state);
  if (filter?.parentId !== undefined)
    resources = resources.filter((r) => r.parentId === filter.parentId);
  if (filter?.assigneeId !== undefined)
    resources = resources.filter((r) => r.assigneeIds.includes(filter.assigneeId as string));
  if (filter?.label !== undefined)
    resources = resources.filter((r) => r.labels.includes(filter.label as string));
  if (filter?.unclaimed === true) resources = resources.filter((r) => r.claim === undefined);
  if (filter?.limit !== undefined) resources = resources.slice(0, filter.limit);

  return resources;
}

async function getResource(
  env: WorkflowEnv,
  sourceUrl: string,
  ref: ResourceRef
): Promise<Resource> {
  void env;
  const task = await requireTask(backlogDirOf(sourceUrl), ref.id);
  return toResource(task, true);
}

async function createResource(
  env: WorkflowEnv,
  sourceUrl: string,
  type: string,
  fields: ResourceCreate
): Promise<Resource> {
  void env;
  if (type !== RESOURCE_TYPE) throw new WorkflowApiError(`Unknown resource type: ${type}`, 404);
  // Creating a resource IN a state is not a transition — no claim about the
  // world is being made — so status is allowed here. claim and id are not, on
  // either path.
  refuseReservedFields(fields.fields, ['status', 'state']);

  const dir = backlogDirOf(sourceUrl);
  const { statuses, defaultStatus } = await readConfig(dir);
  const state =
    fields.fields?.['status'] !== undefined
      ? String(fields.fields['status'])
      : fields.fields?.['state'] !== undefined
        ? String(fields.fields['state'])
        : defaultStatus;

  if (!statuses.includes(state)) throw new WorkflowApiError(`Unknown state: ${state}`, 400);

  const id = await nextTaskId(dir);
  const frontmatter: Record<string, unknown> = { id, title: fields.title, status: state };
  if (fields.labels?.length) frontmatter['labels'] = fields.labels;
  if (fields.assigneeIds?.length) frontmatter['assignee'] = fields.assigneeIds;
  if (fields.parentId) frontmatter['parent_task_id'] = fields.parentId;
  if (fields.rank !== undefined) frontmatter['rank'] = fields.rank;
  if (fields.fields) {
    for (const [k, v] of Object.entries(fields.fields)) {
      // status/state were consumed into the initial state above; claim and id
      // are owned by the contract, not the caller.
      // status/state were consumed into the initial state above; claim and id
      // were refused before we got here.
      if (k !== 'status' && k !== 'state') frontmatter[k] = v;
    }
  }

  const fileName = `${id} - ${slug(fields.title)}.md`;
  await fsSource.writeFile(
    SOURCE_ENV,
    dir,
    `${TASKS_DIR}/${fileName}`,
    serialiseTask(frontmatter, fields.body ?? ''),
    'local',
    `create ${id}`
  );
  return getResource(env, sourceUrl, { type: RESOURCE_TYPE, id });
}

/** MUST reject any patch that would change state — including fields.status.
 *
 * WHY: The deploy guard is only structural if every path to writing state goes
 * through setState (which is compare-and-swap and runs entry conditions). If
 * updateResource could carry state, one convenience call bypasses all guards.
 *
 * `claim` and `id` are silently dropped rather than rejected: a caller that
 * sends them has misused the API, but the right response is to do nothing with
 * those keys, not to block the whole update. Only state is actively refused,
 * because silently ignoring a state-change attempt would mislead the caller. */
async function updateResource(
  env: WorkflowEnv,
  sourceUrl: string,
  ref: ResourceRef,
  patch: ResourcePatch
): Promise<void> {
  void env;

  refuseReservedFields(patch.fields);

  const dir = backlogDirOf(sourceUrl);
  const task = await requireTask(dir, ref.id);

  if (patch.expectRevision !== undefined && patch.expectRevision !== task.sha) {
    throw new WorkflowApiError(
      `Conflict: revision mismatch for ${ref.id} (expected ${patch.expectRevision}, got ${task.sha})`,
      409
    );
  }

  const updates: Record<string, unknown> = {};
  if (patch.title !== undefined) updates['title'] = patch.title;
  if (patch.assigneeIds !== undefined) updates['assignee'] = patch.assigneeIds;
  if (patch.labels !== undefined) updates['labels'] = patch.labels;
  if (patch.parentId !== undefined) updates['parent_task_id'] = patch.parentId;
  if (patch.rank !== undefined) updates['rank'] = patch.rank;
  if (patch.fields) {
    for (const [k, v] of Object.entries(patch.fields)) updates[k] = v;
  }

  let text = task.raw;
  if (Object.keys(updates).length > 0) text = patchFrontmatter(text, updates);
  if (patch.body !== undefined) text = setBody(text, patch.body);

  await fsSource.writeFile(
    SOURCE_ENV,
    dir,
    `${TASKS_DIR}/${task.fileName}`,
    text,
    'local',
    `update ${ref.id}`
  );
}

// ---------------------------------------------------------------------------
// TransitioningResourceAdapter — compare-and-swap state change
// ---------------------------------------------------------------------------

/** Single conditional write: read, verify revision, write new state.
 *
 * WHY compare-and-swap: two runners can both read the same resource as
 * unclaimed. Without CAS, both would write and one would silently overwrite
 * the other. With CAS, the second write detects the sha moved and returns
 * conflict rather than clobbering the winner. */
async function setState(
  env: WorkflowEnv,
  sourceUrl: string,
  ref: ResourceRef,
  toState: string,
  options?: { expectRevision?: string }
): Promise<{ ok: true; resource: Resource } | { ok: false; conflict: string }> {
  void env;
  const dir = backlogDirOf(sourceUrl);
  const task = await requireTask(dir, ref.id);

  if (options?.expectRevision !== undefined && options.expectRevision !== task.sha) {
    return {
      ok: false,
      conflict: `revision mismatch for ${ref.id} (expected ${options.expectRevision}, got ${task.sha})`,
    };
  }

  const text = patchFrontmatter(task.raw, { status: toState });
  await fsSource.writeFile(
    SOURCE_ENV,
    dir,
    `${TASKS_DIR}/${task.fileName}`,
    text,
    'local',
    `transition ${ref.id} → ${toState}`
  );

  const updated = toResource(await readTask(dir, task.fileName), true);
  return { ok: true, resource: updated };
}

// ---------------------------------------------------------------------------
// ClaimingResourceAdapter — atomic single-file conditional write
// ---------------------------------------------------------------------------

/** Claim a resource.
 *
 * The operation is a single conditional write per candidate file. We read,
 * verify the state is claimable and no live claim exists, then write the
 * updated frontmatter conditional on the sha we read. If the sha moved between
 * read and write, another runner claimed it first — we either try the next
 * candidate (auto-select) or return already-claimed (specific id). */
async function claimResource(
  env: WorkflowEnv,
  sourceUrl: string,
  request: ClaimRequest
): Promise<ClaimOutcome> {
  void env;
  const dir = backlogDirOf(sourceUrl);
  const { statuses, claimableStatuses } = await readConfig(dir);

  // The states a runner may claim from.
  const allowedStates = request.state !== undefined ? [request.state] : claimableStatuses;

  // The state a claimed resource transitions into — one past the first
  // claimable state in the workflow order. If nothing follows, stay in place.
  function nextStateAfter(current: string): string {
    const idx = statuses.indexOf(current);
    return idx >= 0 && idx + 1 < statuses.length ? statuses[idx + 1] : current;
  }

  // --- specific id path ---
  if (request.id !== undefined) {
    const task = await findTaskFile(dir, request.id);
    if (!task) {
      return {
        outcome: 'not-claimable',
        ref: { type: RESOURCE_TYPE, id: request.id },
        state: undefined,
        reason: `Task not found: ${request.id}`,
      };
    }

    // Check for a live claim BEFORE checking state: claiming transitions the
    // task to the next state, so a claimed task's state is no longer in
    // allowedStates. Reporting not-claimable when already-claimed is misleading.
    if (isLiveClaim(task.frontmatter['claim'])) {
      const existing = task.frontmatter['claim'] as ResourceClaim;
      return {
        outcome: 'already-claimed',
        ref: { type: RESOURCE_TYPE, id: request.id },
        holder: existing.holder,
      };
    }

    const resource = toResource(task, false);
    if (!allowedStates.includes(resource.state ?? '')) {
      return {
        outcome: 'not-claimable',
        ref: { type: RESOURCE_TYPE, id: request.id },
        state: resource.state,
        reason: `Task ${request.id} is in state "${resource.state}", which is not claimable`,
      };
    }

    // Check if this holder already holds a live claim anywhere in the project.
    const holderCheck = await findLiveClaim(dir, request.holder);
    if (holderCheck) {
      return { outcome: 'holder-already-claiming', claim: holderCheck };
    }

    return await attemptClaim(dir, task, request, nextStateAfter);
  }

  // --- auto-select path ---
  // Check if this holder already holds a live claim anywhere in the project.
  const holderCheck = await findLiveClaim(dir, request.holder);
  if (holderCheck) {
    return { outcome: 'holder-already-claiming', claim: holderCheck };
  }

  // Collect candidates in claimable states with no live claim, sorted byRank.
  const allNames = await taskFileNames(dir);
  const candidates: Resource[] = [];
  for (const name of allNames) {
    const task = await readTask(dir, name);
    const r = toResource(task, false);
    if (allowedStates.includes(r.state ?? '') && !isLiveClaim(task.frontmatter['claim'])) {
      candidates.push(r);
    }
  }

  if (candidates.length === 0) {
    return {
      outcome: 'nothing-claimable',
      reason: `No unclaimed tasks in states: ${allowedStates.join(', ')}`,
    };
  }

  candidates.sort(byRank);

  // Try each candidate in order until one succeeds (sha may have moved if
  // another runner is claiming concurrently).
  for (const candidate of candidates) {
    const task = await findTaskFile(dir, candidate.id);
    if (!task) continue;

    // Re-verify after re-read — another runner may have claimed this in the
    // gap between listing and attempting.
    if (!allowedStates.includes((task.frontmatter['status'] as string) ?? '')) continue;
    if (isLiveClaim(task.frontmatter['claim'])) continue;

    const result = await attemptClaim(dir, task, request, nextStateAfter);
    if (result.outcome === 'claimed') return result;
    // outcome === 'already-claimed' means sha moved; try next candidate.
  }

  return {
    outcome: 'nothing-claimable',
    reason: `All candidates were claimed by the time we tried — try again.`,
  };
}

/** Write the claim and detect concurrent writes by re-reading immediately after.
 *
 * The fs SourceAdapter has no native CAS for writes — writeFile always
 * succeeds. We approximate atomicity by writing a unique claim id and
 * re-reading to verify it landed. If another writer replaced our write, the
 * claim id we see after will differ from ours, so we return already-claimed
 * rather than silently overwriting the winner. */
async function attemptClaim(
  dir: string,
  task: TaskFile,
  request: ClaimRequest,
  nextStateAfter: (s: string) => string
): Promise<Extract<ClaimOutcome, { outcome: 'claimed' | 'already-claimed' }>> {
  const currentState =
    typeof task.frontmatter['status'] === 'string' ? task.frontmatter['status'] : '';
  const claimId = `claim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const claim: ResourceClaim = {
    id: claimId,
    holder: request.holder,
    claimedAt: now,
    ...(request.ttlMs !== undefined
      ? { expiresAt: new Date(Date.now() + request.ttlMs).toISOString() }
      : {}),
  };

  const text = patchFrontmatter(task.raw, {
    claim,
    status: nextStateAfter(currentState),
  });
  await fsSource.writeFile(
    SOURCE_ENV,
    dir,
    `${TASKS_DIR}/${task.fileName}`,
    text,
    'local',
    `claim ${taskIdOf(task)} for ${request.holder}`
  );

  // Verify the write landed as ours — detect a concurrent writer by re-reading.
  const reread = await readTask(dir, task.fileName);
  const writtenClaim = reread.frontmatter['claim'] as Record<string, unknown> | undefined;

  if (!writtenClaim || writtenClaim['id'] !== claimId) {
    // Someone else's write landed on top of ours.
    const winner = (writtenClaim?.['holder'] as string | undefined) ?? 'unknown';
    return {
      outcome: 'already-claimed',
      ref: { type: RESOURCE_TYPE, id: taskIdOf(task) },
      holder: winner,
    };
  }

  const resource = toResource(reread, true);
  return { outcome: 'claimed', claim, resource };
}

/** Scan all tasks for a live claim held by `holder`. */
async function findLiveClaim(dir: string, holder: string): Promise<ResourceClaim | undefined> {
  for (const name of await taskFileNames(dir)) {
    const task = await readTask(dir, name);
    if (isLiveClaim(task.frontmatter['claim'])) {
      const c = task.frontmatter['claim'] as ResourceClaim;
      if (c.holder === holder) return c;
    }
  }
  return undefined;
}

async function releaseClaim(env: WorkflowEnv, sourceUrl: string, claimId: string): Promise<void> {
  void env;
  const dir = backlogDirOf(sourceUrl);

  // Find the task holding this claim id. If none found, the claim is already
  // released or never existed — idempotent, so resolve without error.
  for (const name of await taskFileNames(dir)) {
    const task = await readTask(dir, name);
    const c = task.frontmatter['claim'];
    if (c && typeof c === 'object' && (c as Record<string, unknown>)['id'] === claimId) {
      const text = patchFrontmatter(task.raw, { claim: undefined });
      await fsSource.writeFile(
        SOURCE_ENV,
        dir,
        `${TASKS_DIR}/${task.fileName}`,
        text,
        'local',
        `release claim ${claimId}`
      );
      return;
    }
  }
  // Not found — already released; nothing to do.
}

// ---------------------------------------------------------------------------
// Aggregate export
// ---------------------------------------------------------------------------

export const backlogResources: ResourceAdapter &
  ClaimingResourceAdapter &
  TransitioningResourceAdapter = {
  listResourceTypes,
  listResources,
  getResource,
  createResource,
  updateResource,
  setState,
  claimResource,
  releaseClaim,
};
