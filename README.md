English | [中文](README.zh.md)

# dsh-kernel-codex

DSH runs on one simple idea: **everything is a plugin**. Models, tools, subagents — plug them together however you like.

So we did exactly that: we turned the **OpenAI Codex CLI into a DSH plugin**. The codex tool surface you already know — `exec_command`, `write_stdin`, `apply_patch`, `request_permissions`, `web_search`, `view_image`, `sleep`, `update_plan`, `request_user_input`, `get_context_remaining`, `new_context`, the multi-agent family (`spawn_agent` and friends), background-task management (`list_tasks` / `task_output` / `task_stop`), and the file primitives `view_file` / `write_file` / `edit_file` / `glob` / `grep` — 30 tools in all, now native DSH tools. Same names, same schemas, same behavior.

The payoff is simple: use the Codex CLI tool surface natively inside DSH — **no different** from opening Codex itself. Every model stays in the environment it knows best — main agent or subagent, it feels like coming home.

Distilled from `@openai/codex` **0.147.0** (stable). The 0.148 series is still alpha; handler names are unchanged.

## Install

1. Copy the package into your harness profile:

   ```
   ~/.dsh/profiles/node_modules/dsh-kernel-codex
   ```

2. Add a row inside the **planning group** of the `codex-kernel` preset (the preset already disables the colliding DSH rows `tool-fs-search` and `tool-web` for you):

   ```yaml
   - id: codex-surface
     name: dsh-kernel-codex
   ```

   `send_message`, `interrupt_agent`, and `list_agents` share names with DSH's native control tools: if those rows already registered the names, Codex skips them; otherwise the Codex-named tools deliver the same continuable `subagents` APIs.

## Usage

Pick the **codex-kernel** preset and the **codex-kernel** model route. The Codex CLI tool surface is then available to whatever model that route runs.

## License

MIT — see [LICENSE](LICENSE).
