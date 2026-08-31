English | [中文](README.zh.md)

# dsh-kernel-codex

DSH runs on one simple idea: **everything is a plugin**. Models, tools, subagents — plug them together however you like.

So we did exactly that: we turned the **OpenAI Codex CLI into a DSH plugin**. The codex tool surface you already know — `exec_command`, `write_stdin`, `apply_patch`, `request_permissions`, `web_search`, `view_image`, `sleep`, `update_plan`, `request_user_input`, `get_context_remaining`, `new_context`, the multi-agent family (`spawn_agent` and friends), background-task management (`list_tasks` / `task_output` / `task_stop`), and the file primitives `view_file` / `write_file` / `edit_file` / `glob` / `grep` — 30 tools in all, now native DSH tools. Same names, same schemas, same behavior.

The payoff is simple: use the Codex CLI tool surface natively inside DSH — **no different** from opening Codex itself. Every model stays in the environment it knows best — main agent or subagent, it feels like coming home.

Distilled from `@openai/codex` **0.147.0** (stable). The 0.148 series is still alpha; handler names are unchanged.

## System prompt & subagents

`lib/system-prompt.js` carries the full upstream **Codex** prompt
(`gpt_5_2_prompt.md`; gpt-5.6 models reuse it). `apply()` registers it as the
agent's sole system-prompt section (`complete: true` + `suppressRuntimeContext()`).

Codex's own plan mode is `update_plan` (it writes `todo/write` events so the plan
renders through DSH's `todos` projection); there is no DSH `enter_plan_mode` /
`exit_plan_mode` pair.

`lib/subagents.js` ships `codex-agent`, `codex-explore`, and `codex-worker` (Codex's built-in
`default`, `explorer`, and `worker` roles). The mesh loads them and mounts this plugin on each
child with a `config.tools` whitelist.

## Install

1. Install the plugin into your profile with the official plugin command:

   ```sh
   dsh plugin --profile web add github:oppnc/dsh-kernel-codex
   ```

   Once the package is on npm, `dsh plugin --profile web add dsh-kernel-codex` is preferred (prebuilt, no `allowBuilds`).

   This package is a plain plugin (no `dsh.bundle` declaration), so `dsh plugin` installs it as an inactive dependency — that is expected: the preset row below references it by name.

2. The `codex-kernel` agent preset ships in `dsh-kernel-mesh`'s `presets/` directory. Copy it into the official user-preset root (or, if you run without the mesh, get the preset directory from the mesh repo):

     ```sh
     dsh_home="${DSH_HOME:-$HOME/.dsh}"
     cp -r "$dsh_home/profiles/web/node_modules/dsh-kernel-mesh/presets/codex-kernel" "$dsh_home/.agent-presets/"
     ```

     The preset already includes the `codex-surface` row; if you author your own preset, add it (the preset also disables the colliding DSH rows `tool-fs-search` and `tool-web`):

   ```yaml
   - id: codex-surface
     name: dsh-kernel-codex
   ```

   `send_message`, `interrupt_agent`, and `list_agents` share names with DSH's native control tools: if those rows already registered the names, Codex skips them; otherwise the Codex-named tools deliver the same continuable `subagents` APIs.

## Usage

Pick the **codex-kernel** preset and the **codex-kernel** model route. The Codex CLI tool surface is then available to whatever model that route runs.

## License

MIT — see [LICENSE](LICENSE).
