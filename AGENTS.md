# AGENTS.md — dsh-kernel-codex

Maintainer-facing documentation for the `dsh-kernel-codex` package. This file explains *why* the package is shaped the way it is, where its schemas came from, how it survives name collisions, and what its known limitations are — so a future maintainer (or agent) can modify `lib/index.js` without re-deriving every decision.

## Overview

`dsh-kernel-codex` re-registers the **OpenAI Codex CLI tool surface** as native DSH tools. The goal is not to wrap the Codex binary, but to *re-implement* the Codex tool surface directly on DSH services — `fs`, `web`, `subprocess`, `jobs`, `subagents`, `sandboxPolicy`, `attachments`, `userQuestions` — so that the same names, schemas, and semantics are available on any model route, including the custom `codex-kernel` route.

The package is a single-file Cordis plugin:

```js
export const name = 'dsh-kernel-codex'
export const inject = ['fs', 'tools', 'subprocess', 'web', 'jobs']
export async function apply(ctx) { /* ... */ }
```

Only the hard dependencies are declared in `inject` — `fs`, `tools`, `subprocess`, `web`, `jobs` (mesh AGENTS.md §2). Everything else is read through `ctx.get(...)` with `undefined` guards, so the package mounts (possibly with reduced functionality) in presets that lack a given service. Never read an undeclared service as a bare `ctx.<name>` property. The services read this way are: `fs`, `tools`, `web`, `subagents`, `sandboxPolicy`, `subprocess`, `jobs`, `attachments`, `userQuestions`, `systemPrompt`.

`apply` is written so that it *returns early* only if the two truly essential services are missing:

```js
if (!tools || !fs) return
```

Every tool registers through a tolerant `register()` helper and every registration is fire-and-forget inside the plugin's `apply` fiber, so unregistration/lifecycle is owned by Cordis, not by the package.

## System prompt (persona)

`lib/system-prompt.js` carries the upstream **Codex CLI** system prompt, rewritten in DSH
form: tool names and runtime placeholders are adapted to the DSH tool surface, while the
behavior rules are kept verbatim. (gpt-5.6 models reuse this prompt — the repo has no gpt-5.6-specific file.) Upstream source: https://github.com/openai/codex/blob/main/codex-rs/core/gpt_5_2_prompt.md

`apply()` registers it as the `deployment:persona` section (order `0`) with
`complete: true`, and calls `systemPrompt.suppressRuntimeContext()`. Together these make
the vendor prompt the **sole** system-prompt section and drop the runtime-context snapshot,
so a session on this kernel sees ONLY the vendor's own system prompt.

Consequence for presets: a preset that mounts this plugin MUST NOT also mount a
`@deepseek-ai/dsh-persona` row — both register `deployment:persona` in the same scope and
the second registration throws. The kernel presets ship without that row.

## Schema provenance

The schemas are **not** hand-written from memory of the Codex CLI. They are distilled from the locally installed `@openai/codex` package, originally **v0.146.0** and re-checked against **v0.147.0** (2026-08-07; npm `latest`) and the `rust-v0.148.0-alpha.20` handler tree. The handler directory is unchanged across those three points — no new model-facing tool names. The npm package for Codex is only a launcher for a compiled Rust binary; the tool surface was recovered from the binary's embedded strings — specifically the `core/src/tools/handlers/*.rs` handler names and their concatenated name/description/parameter blobs (see the original recovery report for line-level evidence).

The installed Codex version has evolved past the older tool names (`shell`, `view`, `write`, `edit`, `task`, `todo`, `enter_plan_mode`, `exit_plan_mode`, `skill`). The modern surface is:

- `exec_command` + `write_stdin` — the unified exec pair (replacing the old `shell`)
- `apply_patch` — the FREEFORM unified-diff grammar (replacing `edit` for multi-hunk work)
- `request_permissions`
- `web_search`
- `view_image`
- `sleep`
- `update_plan` — the todo/checklist primitive (the modern replacement for `todo`)
- `request_user_input`
- `get_context_remaining`
- `new_context`
- the multi-agent family: `spawn_agent`, `assign_agent_task`, `send_message`, `followup_task`, `wait_agent`, `list_agents`, `resume_agent`, `interrupt_agent`, `close_agent`

Tool descriptions are faithful to the extracted text. Where an older name still makes sense as an alias (the `view`/`write`/`edit` → `view_file`/`write_file`/`edit_file` mapping), the description calls the legacy name out explicitly so models that prefer the older vocabulary still find the right tool.

A note on counts: the source registers **30 tools** (30 `register()` calls at the top of `apply`). Three of the 30 (`send_message`, `interrupt_agent`, `list_agents`) share names with DSH's native control tools and are skipped only when those rows already won (see Name-collision backstop). A default mount therefore exposes 27 or 30 static tools. There is no `enter_plan_mode`/`exit_plan_mode` pair — Codex models plan mode as `update_plan` (see below).

## Name-collision backstop

DSH itself ships tools whose names overlap the Codex surface — most importantly the agent-control tools `send_message`, `interrupt_agent`, and `list_agents`. The Codex versions of these three now implement the same `subagents.followup` / `subagents.interrupt` / `subagents.listChildren` plumbing as DSH's `tool-subagent-control` rows. Registering both would still collide; one would have to lose.

The package handles this with **tolerant registration**. The `register()` helper wraps `tools.register` and silently skips any name whose error contains `'already registered'`:

```js
const register = (t) => {
  try { tools.register(t) } catch (e) {
    if (String(e).indexOf('already registered') >= 0) return
    throw e
  }
}
```

This means the package mounts in *any* preset without hand-editing rows: a colliding name is simply dropped, and the surviving registration (whichever it is) wins without an exception. When the DSH native control rows are present they keep the names; when they are not, the Codex-named tools still deliver the real continuable APIs.

## Implementation decisions

### `exec_command` — unified exec, PowerShell under the hood

Codex's modern `exec_command` replaces the old `shell`. The DSH form runs commands through **PowerShell** regardless of the target shell, via `subprocess.spawn`:

```js
let pwshBin = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
try { pwshBin = await subprocess.resolveExecutable('pwsh.exe', {}, exec.signal) } catch {}
```

Two output paths, gated on `run_in_background`:

- **Foreground** honors `timeout_ms` with a `Promise.race` between `handle.done` and a `setTimeout` that calls `handle.terminate()`. The timeout is clamped to `[3000, 300000]` ms, default `60000`. On timeout the output is appended with `[timed out after Ns]`; otherwise `[exit code: N]`.
- **Background** (`run_in_background: true`) wraps the spawn in a `jobs.start` shell job. Critically, the background spawn is created **without** `exec.signal` (`signal` is passed only in the foreground branch) — so a turn abort cannot kill the background process. Only `task_stop` (which resolves to `handle.terminate()` via the job's `cancel`) can. This is the DSH-form approximation of Codex's unified-exec "continue session" semantics, mapped onto the jobs service.

`stdio` is `{ stdin: 'ignore', stdout: { maxBytes: 1000000 }, stderr: { maxBytes: 100000 } }`.

### `apply_patch` — FREEFORM unified-diff grammar

`apply_patch` is a FREEFORM tool (the description tells the model *not* to wrap the patch in JSON). The grammar, recovered from the binary, is implemented by `applyPatchGrammar`:

```
*** Begin Patch                    (required)
*** Add File: path/to/file         + content lines prefixed with "+"
*** Update File: path/to/file      @@ context, "+"/"-"/" " lines, optional "*** Move to:"
*** Delete File: path/to/file
*** End Patch                      (required)
```

`applyUpdateHunk` applies a single update hunk: it locates an anchor from the `@@ … @@ context` trailing text (or falls back to the first context/deletion line), then walks `+`/`-`/` ` ops against the original text, erroring loudly when a deletion or context line does not match the file content. "Move to:" renames by copying source content to the destination path and applying the hunk body to it. "*** End of File" (the no-trailing-newline marker) is accepted and ignored, since the DSH form writes a trailing newline.

Every write from `apply_patch` passes `sandboxPolicy.resolve({ session })` as the 5th argument to `fs.writeText`, so patch edits respect the per-call sandbox policy exactly like the manual `write_file`/`edit_file` tools do. Each hunk is applied independently and failures are reported per-file (`Failed update path: …`) rather than aborting the whole patch.

### File primitives — `view_file` / `write_file` / `edit_file` / `glob` / `grep`

These mirror the `dsh-kernel-kimi` implementations.

- `glob` and `grep` share a recursive walk over `fs.listDir` entries. A directory entry recurses through `e.target`, which `listDir` already resolves; files are collected by relative path. The walk skips `node_modules`, `.git`, `.dsh`, `.venv`, `__pycache__`, and `dist`.
- `grep` caps file size at **512 KiB** and can target a single file path by checking `fs.stat` first (if `rootInfo.type === 'file'`, it greps just that file). It compiles the pattern with `new RegExp(...)` and supports three `output_mode`s: `files_with_matches` (default), `content`, and `count_matches`, plus a `glob` filter. It has **no** `-B/-A/-C` context flags — Codex's `grep_local` doesn't need them.
- `glob` returns up to 1000 sorted matches and shares `globToRegex` (which handles `*`, `**`, `?`, and `{a,b}` alternation).
- `write_file` (overwrite/append) and `edit_file` (exact old→new replacement via `fs.editText`, with `replace_all`) both pass the per-call sandbox policy as the write policy.

### Working directory — `cwdOf`

`cwdOf(exec)` prefers the session's sandbox policy workspace root, falling back through three levels:

```js
policy = policyFor(exec)                 // sandboxPolicy.resolve({ session: exec.agent.session })
if (policy.workspaceRoot is string) ...  // per-session root
else if (sandboxPolicy.workspaceRoot) ...// shared root
else process.cwd()                       // final fallback (then 'C:\\' as a last resort)
```

### Plan mode — `update_plan`

Codex models plan mode as `update_plan` (a TODO/checklist rendered to the user), NOT as a dedicated enter/exit pair. The plugin therefore does **not** register `enter_plan_mode`/`exit_plan_mode` and does **not** read the DSH `planMode` service. `update_plan` writes `todo/write` session events so the plan renders through DSH's `todos` projection — that is the display interface (the codex preset keeps `tool-todo` enabled for the projection).

### Multi-agent family — `spawn_agent` matches the stock `subagent` tool

`spawn_agent` is background-first on the native continuable route, exactly like kimi's `Agent`, grok's `task`, and the stock `subagent` tool (`backgroundMode: 'continuable'`):

- **Background is the default** (`run_in_background !== false` → `subagents.startContinuable`). The call returns a durable child id at inbox acceptance. The runtime delivers the settlement notice (outcome + final assistant message) itself.
- **`run_in_background` is a DSH-form addition** to the Codex CLI schema (default `true`) so the model can opt into a one-shot wait. The rest of the parameter names (`task_name`, `message`, `agent_type`, `model`, `reasoning_effort`, `fork_turns`) stay Codex-surface-identical. `reasoning_effort` and `fork_turns` are accepted for schema parity and are not mapped onto the child request; the child is always a fresh conversation.
- **`agent_type` maps onto the upstream Codex roles** (`codex-rs/core/src/agent/role.rs`): `explorer` → `codex-explore`, `worker` → `codex-worker`, omit/other → `codex-agent` (the `default` role). Upstream `explorer.toml` is empty and `worker` has no config file, so **no role changes the child's prompt or tools** — every role runs on the full Codex base prompt with the full toolset. The role descriptions only guide the parent's choice and live in the `agent_type` parameter description.
- **Every request sets `agentOptions` / `persona` / `toolFilter` / `maxDepth: 3` explicitly**, because the continuable route never calls `provider.start()` (mesh AGENTS.md §3.2). `agentOptions` is `{ provider: recipe.provider, model: args.model || recipe.model }`; `persona` and `toolFilter` come from `lib/subagents.js` (the single source of truth shared with the mesh).
- **Provider preference** is the recipe name (`codex-agent` / `codex-explore` / `codex-worker`) when listed, then `codex-agent`, then `spawn`.
- **Foreground** (`run_in_background: false`) awaits `subagents.start` and, on a non-`completed` stop, appends `"Partial output before the run ended:"` plus the child's text — the native wording (`stopReasonError` + `withPartialText`).
- The tool declares **`isConcurrencySafe: () => true`** and registers a **`systemPrompt` section** (`tool:spawn_agent`, order `116.5`) that teaches the background-first convention while the tool is visible.

Family tools that have a clean mapping are wired to the real `subagents` service; the rest stay honest stubs:

| Tool | Mapping |
| --- | --- |
| `assign_agent_task` | `subagents.followup` |
| `send_message` | `subagents.followup` (optional `interrupt=true` → `subagents.interrupt` first) |
| `followup_task` | `subagents.followup` |
| `resume_agent` | `subagents.followup` with a generic continue prompt |
| `interrupt_agent` | `subagents.interrupt` (`{ kind: 'ancestor', agent: caller }`) |
| `list_agents` | `subagents.listChildren` (Codex `path_prefix` filters the label/id) |
| `wait_agent` | honest stub — no in-tool wait; the runtime notice is the settlement channel |
| `close_agent` | honest stub — `drainContinuableDescendants` is parent-teardown of a whole forest, not a single-child close |

### Background-task management — `list_tasks` / `task_output` / `task_stop`

These are companions to `exec_command`'s background mode, backed by the DSH `jobs` service. `list_tasks` filters to running/stopping by default; `task_output` optionally blocks via `jobs.wait`; `task_stop` resolves to `jobs.kill` (and ultimately `handle.terminate()`). They let a model start a long shell job with `exec_command run_in_background: true` and later poll or stop it — the closest DSH analogue to Codex's persistent exec sessions.

## The DSH ToolDefinition contract

Every tool is a plain object with `name`, `description`, `parameters` (a JSON-Schema-ish object with `type: 'object'` and `properties`/`required`), and an `execute(args, exec)` async function. `strDef()` normalizes string tools:

```js
const strDef = (t) => {
  t.output = {
    schema: { type: 'string' },
    render: (a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }],
  }
  return t
}
```

`view_image` is the one tool with a custom output: it returns `{ ok, attachment }` and its renderer emits an `image` block when an attachment is present, otherwise a text block. `exec` provides `agent`, `signal`, and the agent/session needed by `policyFor` and `cwdOf`; abort signalling flows through `exec.signal` (used by `sleep`, foreground `exec_command`, `fs` calls, and the `abort` listener patterns).

All side effects (registrations) live inside the plugin's `apply` fiber, so stopping/undefining the plugin removes every tool through DSH's normal lifecycle.

## Known gaps

- **`write_stdin`** — not supported. DSH has no long-lived exec session handles across tool calls; the tool returns a note advising a single `exec_command` invocation.
- **`new_context`** — not supported. The context window is managed by the harness and cannot be programmatically reset.
- ~~**Multi-agent stubs** (everything except `spawn_agent`).~~ **RESOLVED** (mesh gap #5). `spawn_agent` is background-first on the native continuable route (`subagents.startContinuable`): omitting `run_in_background` (or setting it true) returns a durable child id that `list_agents` / `send_message` / `interrupt_agent` / `followup_task` / `resume_agent` / `assign_agent_task` operate on, exactly like the stock `subagent` tool. Set `run_in_background: false` only to wait for the one-shot result. See the multi-agent implementation note above. `wait_agent` and `close_agent` remain honest stubs (no in-tool wait; no single-child close).
- **`request_permissions`** — reports the current policy (`danger-full-access` or `workspace-write (root: …)`) instead of prompting, since the DSH file policy is session-wide rather than per-request.
- **`view_image`** — image only: PNG/JPEG/WebP/GIF, with a 20 MiB read cap; no non-image file rendering.
- **`web_search`** — delegates to the DSH `web` service (`web.search`) rather than Codex's engine.
- **`update_plan`** — a plugin-local todo store keyed by agent id (`planStore = new Map()`, keyed on `exec.agent.id`); it is process-lifetime, not persisted.
- **`get_context_remaining`** — reports `remaining_tokens: null` with a note, because DSH exposes no token-counting service.
- **`sleep`** — uses a cancellable promise: a `setTimeout` whose timer is cleared via an `abort` listener on `exec.signal` (so a turn abort resolves it early rather than leaking the timer).
- **`grep`** — no `-B/-A/-C` context flags; Codex's `grep_local` doesn't need them.
- **Background `exec_command`** — carries no `exec.signal`, so a turn abort cannot kill it; only `task_stop` can.

### Mesh gaps this surface used to inherit (now resolved upstream)

These lived in `dsh-kernel-mesh` and are **not** open work for this package. Current truth from mesh AGENTS.md §7:

- **§7.1 Kimi thinking signature side table** — still upstream-blocked (this surface has no Kimi transport).
- **§7.2 Grok reasoning replay shape** — still upstream-blocked (this surface has no Grok transport).
- **§7.3 MiniMax needs an API key** — still upstream-blocked (this surface has no MiniMax transport).
- **§7.4 `loop_control` has no DSH knob** — still upstream-blocked (`agentLoop` only exposes `maxParallelToolCalls`).
- ~~**§7.5 Continuable subagent route.**~~ **RESOLVED** in the mesh; this package's `spawn_agent` consumes that route as its default (see above).
- ~~**§7.6 Non-streaming transports.**~~ **RESOLVED** in the mesh: both adapter factories stream real SSE (`stream: true`, curl `-N`) with JSON auto-fallback when a provider ignores streaming. This surface has no transport of its own.
- **§7.7 Responses-wire images are skipped** — still upstream-blocked for grok/codex adapters (this surface's `view_image` is a local attachment, not a wire-image path).
- ~~**Unclassified adapter errors.**~~ **RESOLVED** in the mesh: adapters throw with canonical own-property codes (`e.code` + `e.failure`) so `dsh-llm-retry` retries `RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT`. This surface does not throw adapter errors.

## Testing notes

- **Syntax/validation:** `node --check lib/index.js` — the plugin is plain ESM JavaScript with no build step, so this is the first and cheapest check.
- **Registration smoke test:** mount the package in a preset with colliding DSH rows enabled, then disabled, and confirm the tolerant `register()` logic produce the expected tool set (no "already registered" exceptions; 27 static tools when the three native control names already won, or 30 when they did not).
- **`spawn_agent` smoke test:** `/tmp/kernel-surfaces-smoke-codex.js` (same mock-ctx pattern as the kimi/grok suite). It asserts the plugin loads; background default → `startContinuable` with explicit `agentOptions`/`persona`/`toolFilter`/`maxDepth: 3` and a durable-id return; `followup_task` / `send_message` / `resume_agent` → `subagents.followup`; foreground partial-output wording (`Partial output before the run ended:`); `isConcurrencySafe`; and the `tool:spawn_agent` systemPrompt section.
- **Functional checks:** exercise the tools through the `codex-kernel` preset — `exec_command` (foreground timeout and background + `task_stop`), `apply_patch` (add/update/delete/move hunks and matching-failure paths), `glob`/`grep` (skip-dir and 512 KiB cap behavior), `view_file`/`write_file`/`edit_file` (sandbox-policy writes), `request_user_input`, `spawn_agent` (background default, follow-up, and `run_in_background: false`), and `view_image` on a real PNG/JPEG.
- **Edge cases to re-verify after any edit:** the 3-second/300-second timeout clamp in `exec_command`, the anchor-location fallback in `applyUpdateHunk` (no `@@` context), and `cwdOf`'s three-level fallback.

## Layout

```
dsh-kernel-codex/
├── lib/index.js        # the plugin (single-file ESM; 30 tools + 2 conditional plan-mode tools)
├── package.json        # v0.1.2, type:module, MIT, repo oppnc/dsh-kernel-codex
├── LICENSE             # MIT, Copyright (c) 2026 oppnc
├── README.md           # short human-facing English README
├── README.zh.md        # Chinese translation of README.md
├── README.i18n.yaml    # bilingual-pair git blob hashes
├── AGENTS.md           # this file (verbose maintainer docs, English)
└── AGENTS.zh-CN.md     # Chinese translation of AGENTS.md
```
