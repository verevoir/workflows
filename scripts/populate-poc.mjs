// Proof-of-concept: populate the aigency Trello board with the
// PLAN-classified memory items from this morning's triage.
//
// Reads card title + source-memory pairs from below, fetches each
// memory file's `description` frontmatter as the card body, posts
// to Trello via @verevoir/workflows/trello.
//
// Run with:
//   set -a; source ../aigency-web/.env.local; set +a;
//   TRELLO_REFERER='https://ai.gency.studio' node scripts/populate-poc.mjs

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { trello, envFromTrelloProcessEnv } from '../dist/trello/index.js';

const BOARD_URL = 'https://trello.com/b/kGEulUXX/aigency';
const NEXT_UP_COLUMN_ID = '6a121166afffe0db315970d1';
const MEMORY_DIR =
  '/Users/adamsurgenor/claude-configs/nextlake/projects/-Users-adamsurgenor-Projects-Home-agency/memory';

// 32 cards: [title, source-memory-filename-without-project_-prefix-or-.md]
const CARDS = [
  ['Surface attached repos in system prompt + add read_file/list_files chat-time tools', 'attached_repos_invisible_in_chat'],
  ['Build brownfield onboarding flow: connect existing repo + reverse-engineer futurespective', 'brownfield_onboarding_future'],
  ['Build attach_repo + attach_document bucket-1 chat-time tools', 'chat_as_command_surface'],
  ['Implement prompt-cache structuring + layer-side file/issue cache in @verevoir/llm adapter', 'chat_layer_as_intelligence_surface'],
  ['Update conversation prompts for chat-time limitations + switch chat() to chatWithTools()', 'chat_time_capabilities_gap'],
  ['Decompose src/server/repo-tools.ts after code-index slices 3c + 3d land', 'chat_time_tools_decomposition'],
  ['Wire node modelOverride into generateReply to route tool tasks to cheaper models', 'cheap_tasks_cheap_models'],
  ['Decide code-generation slice shape (objective type, LLM output format, fork mechanics, PR review)', 'code_gen_scoping'],
  ['Fix cutover.yml wait-step to gate on successful deploy.yml for HEAD, not just rebased==true', 'cutover_rerun_skips_validation'],
  ['Design DeployExecutor abstraction + per-customer GCP project provisioning terraform module', 'deploy_executor_isolation_and_pluggability'],
  ['Run Verevoir + aigency-web as aigency-managed projects (gated on BYOK token economics)', 'dogfood_under_aigency'],
  ['Migrate BYOK encryption to KMS envelope encryption (per-record DEKs, KEK never in memory)', 'envelope_encryption_future'],
  ['Build resource attachment API + rollup view at every project/objective node', 'fractal_resources_at_every_node'],
  ['Re-run brownfield cascade with omitProjectContext removed once prompt caching is wired; compare quality', 'future_test_layered_context_with_caching'],
  ['Bump GitHub Actions to Node 24 versions (checkout@v5, github-script@v8, gcloud auth@v3, setup-gcloud@v3)', 'gh_actions_node24_upgrade'],
  ['Allow greenfield project modal to accept URL/zip/doc attachments for context + runtime use', 'greenfield_needs_attachments_too'],
  ['Build protagonist/antagonist Opus pair review for human-authored PRs (write ADR first)', 'human_pr_review_via_protagonist_antagonist'],
  ['Add LLM self-reported % progress via tool-call or streaming during long materialiser tasks', 'llm_self_reported_progress'],
  ['Add chatStream/chatWithToolLoopStream to @verevoir/llm + SSE chat API route + progressive ChatThread', 'message_streaming_future'],
  ['Implement per-objective model escalation: UI button + rejection-rate logging + modelClass override wiring', 'model_bump_on_problems'],
  ['Build @verevoir/llm/google + /openai adapters + modelProvider per-objective override in aigency-web', 'multi_model_direction'],
  ['Build talk-impact evidence by ~2026-06-13: Backstage merged PRs or aigency-on-aigency demo', 'one_month_presentation'],
  ['Append bridging assistant turn after each materialise completion proposing next objective', 'post_materialise_should_lead_next_turn'],
  ['Build write_file + open_pr chat-time tools with try-push / fork-pivot for attached repos', 'repos_are_work_targets'],
  ['Migrate Turn.content from string to ContentBlock[] (text + tool_use + tool_result; image later)', 'rich_content_turns'],
  ['Draft before/after slide deck for substrate extraction (ADRs 017-022, workspace → API migration)', 'substrate_work_invisible_needs_narrative'],
  ['Build project teardown (delete GH repos + Secret Manager secrets + WIF bindings + DB rows, idempotent)', 'teardown_mechanism_future'],
  ['Decide and implement test DB shape for preview deploys when first customer project with DB materialises', 'test_database_shape_deferred'],
  ['Audit + improve all chat-time tool definitions (descriptions, when-to-use, failure modes) per Anthropic guidance', 'tool_definition_optimisation'],
  ['Systematically progress through Backstage issue-clearing: discovery → propose changes → get PRs merged', 'validation_target_constraint'],
  ['Implement stateless FSM in verevoir.access for legal transitions + button labels + enable/disable', 'verevoir_access_state_machine'],
  ['Add workingRepoUrl + targetRepoUrl fields to review-repo nodes + sync-main-before-work logic', 'working_vs_target_repo'],
];

async function descriptionOf(memoryName) {
  const path = join(MEMORY_DIR, `project_${memoryName}.md`);
  const text = await fs.readFile(path, 'utf8');
  const m = text.match(/^description:\s*(.+?)$/m);
  return m ? m[1].trim() : '';
}

async function main() {
  const env = envFromTrelloProcessEnv();
  if (!env) {
    console.error('TRELLO_API_KEY / TRELLO_API_TOKEN not set');
    process.exit(1);
  }
  if (!env.referer) {
    console.error('TRELLO_REFERER not set');
    process.exit(1);
  }

  let created = 0;
  let failed = 0;

  for (const [title, sourceMemory] of CARDS) {
    const desc = await descriptionOf(sourceMemory);
    const body = `${desc}\n\n---\nSource: memory/project_${sourceMemory}.md`;

    try {
      const card = await trello.createCard(env, BOARD_URL, NEXT_UP_COLUMN_ID, {
        title,
        body,
      });
      console.log(`OK  ${card.id}  ${title.slice(0, 80)}`);
      created++;
    } catch (err) {
      console.error(`ERR  ${title.slice(0, 80)}  →  ${err.message}`);
      failed++;
    }

    // Trello rate limit: 100 req / 10s per token. Sleep 100ms between
    // creates → well under cap.
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log(`\nCreated ${created}; failed ${failed}; total ${CARDS.length}`);
}

await main();
