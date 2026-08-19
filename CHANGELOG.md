# Changelog

## 1.0.3

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
