// L2 subagent recipes for the codex-kernel. Upstream Codex has THREE built-in
// agent roles — `default`, `explorer`, `worker` (codex-rs/core/src/agent/role.rs).
// explorer.toml is empty and worker has no config file, so neither role changes
// the child's prompt or tools: every role runs on the full Codex base prompt
// with the full toolset. The role descriptions only guide the PARENT's choice
// (they are surfaced in the spawn_agent tool description), so the recipes here
// differ only in their type label.
// Upstream: openai/codex codex-rs/core/src/agent/role.rs + builtins/explorer.toml.
import { SYSTEM_PROMPT } from './system-prompt.js'

// Full Codex tool surface (the 28 tools this plugin registers). Upstream roles
// do not restrict tools, so every role gets the whole surface.
const FULL_TOOLSET = [
  'exec_command', 'write_stdin', 'apply_patch', 'request_permissions',
  'web_search', 'view_image', 'sleep', 'update_plan', 'request_user_input',
  'get_context_remaining', 'new_context', 'spawn_agent', 'assign_agent_task',
  'send_message', 'followup_task', 'wait_agent', 'list_agents', 'resume_agent',
  'interrupt_agent', 'close_agent', 'list_tasks', 'task_output', 'task_stop',
  'view_file', 'write_file', 'edit_file', 'glob', 'grep',
]

export const SUBAGENT_RECIPES = {
  'codex-agent': {
    provider: 'codex-kernel', model: 'deepseek-v4-flash:0731', type: 'default',
    persona: SYSTEM_PROMPT,
    toolFilter: { allow: FULL_TOOLSET },
  },
  'codex-explore': {
    provider: 'codex-kernel', model: 'deepseek-v4-flash:0731', type: 'explore',
    persona: SYSTEM_PROMPT,
    toolFilter: { allow: FULL_TOOLSET },
  },
  'codex-worker': {
    provider: 'codex-kernel', model: 'deepseek-v4-flash:0731', type: 'worker',
    persona: SYSTEM_PROMPT,
    toolFilter: { allow: FULL_TOOLSET },
  },
}
