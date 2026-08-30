# Changelog

## 0.1.6

- **Mesh dependency + fallback mount.** `dsh-kernel-mesh` is now a declared
  dependency (`github:oppnc/dsh-kernel-mesh#semver:^0.1.6`), so installing this
  package also installs the mesh. At `apply()` time the plugin checks for the
  mesh's `kernelMesh` marker service / any `*-kernel` route; when the host
  composition never mounted the mesh, the plugin mounts its own copy
  (`lib/ensure-mesh.js`) so kernel routes and subagent recipes keep working —
  with a logged pointer to the preferred profile-level mount
  (`dsh plugin add dsh-kernel-mesh`), since a fallback-mounted mesh shares this
  row's lifecycle.

## 0.1.5

- **DSH 0.1.1-rc.2 compatibility: `spawn_agent` no longer sets `toolFilter` on
  subagent requests.** The new dsh-tools restricts `tools.restrict()` to GLOBAL
  tool names and rejects scope-local (vendor) names; the child tool mask is
  applied by the mesh `agent/created` listener instead (mesh AGENTS.md §6).
  The smoke test now asserts the request carries no `toolFilter`.
- **Codex 0.151.0 sync: model-aware persona.** `lib/system-prompt.js` gains
  `SYSTEM_PROMPT_GPT56` — the template upstream actually serves gpt-5.6
  models (`codex-rs/models-manager/models.json`
  `model_messages.instructions_template` at rust-v0.151.0; the
  `codex-rs/core/*prompt.md` files turned out to be legacy leftovers).
  New `personaForModel(model)` picks the persona upstream would serve, driven
  by the top-level `model` key of `~/.codex/config.toml` (new
  `lib/codex-config.js`); `lib/subagents.js` re-exports the picker so the mesh
  can re-derive recipe personas when it overrides recipe models. Re-check
  findings recorded in AGENTS.md: upstream removed `shell_command`, added a
  feature-gated `send_user_message_async` (off by default — not registered),
  `assign_agent_task` confirmed to have no upstream counterpart.

## 0.1.4

- **Subagent recipes match upstream Codex roles.** `codex-agent` (default),
  `codex-explore`, `codex-worker`; upstream `explorer.toml` is empty and `worker`
  has no config file, so no role restricts tools — every role runs the full Codex
  base prompt with the full toolset.
- **`spawn_agent` reuses the L2 recipes** and maps `explorer`/`worker`/default.
- **No fabricated default model.** Recipes carry an empty model; the mesh fills
  it from `~/.codex/config.toml`.

## 0.1.3

- **Upstream system prompt.** `lib/system-prompt.js` carries the full Codex prompt
  (`gpt_5_2_prompt.md`; gpt-5.6 models reuse it — there is no gpt-5.6-specific
  file). `apply()` registers it as `deployment:persona` with `complete: true` +
  `suppressRuntimeContext()`.
- **Codex's own plan mode.** Removed the DSH `enter_plan_mode`/`exit_plan_mode`
  aliases; `update_plan` is the plan mode and now writes `todo/write` session
  events so the plan renders through DSH's `todos` projection.
- **L2 subagent recipes.** `lib/subagents.js` ships `codex-explore` and
  `codex-worker` (Codex's built-in `explorer` and `worker` roles; there is no
  "general" subagent — the main agent is general).
- **Subagent mounting config.** `apply(ctx, config)` accepts `config.persona`,
  `config.skipPersona`, and `config.tools`.

## 0.1.2

- Initial DSH-form Codex CLI tool surface.
