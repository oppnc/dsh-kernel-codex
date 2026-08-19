// L2 subagent recipes for the codex-kernel. Codex has exactly ONE built-in
// subagent type: `explorer` (explorer.toml is empty — the explorer reuses the
// main agent's base instructions, so its prompt is the full Codex prompt plus
// a read-only framing). There is NO "general" subagent in Codex (the main
// agent is the general agent), so we deliberately do not invent one.
// Upstream: openai/codex codex-rs/core/src/agent/role.rs (explorer role).
import { SYSTEM_PROMPT } from './system-prompt.js'

const SHELL = process.platform === 'win32' ? 'pwsh' : 'bash'

const EXPLORER_FRAMING = `You are running as a Codex explorer subagent: a fast, read-only codebase exploration agent. You have NO file editing tools. Use glob/grep/view_file and read-only shell commands (ls, git status, git log, git diff, find). Report findings in a structured format with absolute paths.

Explorers are fast and authoritative. Avoid re-exploring a problem already covered; trust prior explorer results without re-verification unless you need the context yourself. You may be spawned in parallel for independent questions.`

const WORKER_FRAMING = `You are running as a Codex worker subagent: execution and production work. Typical tasks: implement part of a feature, fix tests or bugs, split large refactors into independent chunks.

Rules:
- You are NOT alone in the codebase: other workers may be making changes in parallel. Do not revert edits made by others; adjust your implementation to accommodate their changes.
- Own your assigned files/responsibility clearly, and stay within that ownership to avoid merge conflicts.
- Complete the assigned task with tools, then return a compact, technically complete summary.`

export const SUBAGENT_RECIPES = {
  'codex-explore': {
    provider: 'codex-kernel', model: 'deepseek-v4-flash:0731', type: 'explore',
    persona: SYSTEM_PROMPT + '\n\n' + EXPLORER_FRAMING,
    toolFilter: { allow: ['exec_command', 'view_file', 'view_image', 'glob', 'grep', 'web_search'] },
  },
  'codex-worker': {
    provider: 'codex-kernel', model: 'deepseek-v4-flash:0731', type: 'worker',
    persona: SYSTEM_PROMPT + '\n\n' + WORKER_FRAMING,
    toolFilter: { allow: ['exec_command', 'apply_patch', 'write_file', 'edit_file', 'view_file', 'view_image', 'glob', 'grep', 'web_search', 'update_plan', 'request_user_input', 'list_tasks', 'task_output', 'task_stop', 'sleep'] },
  },
}
