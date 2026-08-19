// dsh-kernel-codex — "Codex CLI written in DSH form": the OpenAI Codex CLI tool
// surface registered as DSH tools with the SAME names, schemas and semantics,
// implemented directly on DSH services (fs/web/subprocess/jobs/subagents),
// so the surface survives toolFilter scoping.
//
// Schemas distilled from the locally installed @openai/codex package
// (v0.146.0, re-checked against v0.147.0 / rust-v0.148.0-alpha.20 — handler
// names unchanged). The npm package is only a launcher for a compiled
// Rust binary; the tool surface was recovered from the binary's embedded
// strings — specifically `core/src/tools/handlers/*.rs` handler names and their
// concatenated name/description/parameter blobs (see report for line-level
// evidence). The installed Codex version has EVOLVED past the older tool names
// (shell/view/write/edit/task/todo/enter_plan_mode/exit_plan_mode/skill); the
// modern surface is: exec_command + write_stdin (unified exec), apply_patch
// (FREEFORM unified-diff grammar), request_permissions, web_search, view_image,
// sleep, update_plan (todo/checklist), request_user_input, get_context_remaining,
// new_context, and the multi-agent family (spawn_agent, assign_agent_task,
// send_message, followup_task, wait_agent, list_agents, resume_agent,
// interrupt_agent, close_agent). Tool descriptions are faithful to the
// extracted text.
'use strict'

import nodeFs from 'node:fs' // durable plugin: Node builtins are available; used for apply_patch delete/move.
import nodePath from 'node:path'
import { SYSTEM_PROMPT } from './system-prompt.js'
import { SUBAGENT_RECIPES } from './subagents.js'

function globFragment(p) {
  let re = ''
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === '*') {
      if (p[i + 1] === '*') { re += p[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += 1; if (p[i + 1] === '/') i += 1 } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if (c === '{') {
      const end = p.indexOf('}', i)
      if (end > i) {
        const opts = p.slice(i + 1, end).split(',').map((o) => globFragment(o))
        re += '(' + opts.join('|') + ')'
        i = end
      } else re += '\\{'
    } else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return re
}

function globToRegex(pattern) {
  const p = String(pattern).replace(/\\/g, '/')
  try { return new RegExp('^' + globFragment(p) + '$') } catch { return null }
}

// A small, robust unified-diff-ish applier for Codex's FREEFORM apply_patch.
// Grammar (extracted from the binary):
//   start:           begin_patch hunk+ end_patch
//   begin_patch:     "*** Begin Patch\n"
//   end_patch:       "*** End Patch\n"
//   add_hunk:        "*** Add File: " filename "\n" add_line+
//   delete_hunk:     "*** Delete File: " filename "\n"
//   update_hunk:     "*** Update File: " filename "\n" change_move? change?
//   change_move:     "*** Move to: " filename "\n"
//   change_context:  ("@@" | "@@ " anything) "\n"
//   change_line:     ("+" | "-" | " ") anything "\n"
//   eof_line:        "*** End of File\n"
// Returns { files: [{path, content|deleted}], moves: [{from,to}] } or throws.
function applyPatchGrammar(patchText) {
  const text = String(patchText)
  if (!/^\s*\*\*\* Begin Patch\s*\r?\n/.test(text)) {
    throw new Error('Patch must start with "*** Begin Patch"')
  }
  if (!/\*\*\* End Patch\s*$/.test(text.trim())) {
    throw new Error('Patch must end with "*** End Patch"')
  }
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  // Trim leading Begin Patch line and trailing End Patch line(s).
  let i = 0
  while (i < lines.length && lines[i].trim() !== '*** Begin Patch') i++
  i++
  const files = [] // {path, type:'add'|'delete'|'update'|'moveAdd', contentLines:[]}
  const moves = [] // {from,to}
  let cur = null // {path, type, contentLines:[]}
  let sawHunk = false
  const flushCur = () => {
    if (!cur) return
    files.push({ path: cur.path, type: cur.type, contentLines: cur.contentLines })
    cur = null
  }
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '*** End Patch') break
    // Only a truly EMPTY line separates hunks; a " " line is a legitimate empty
    // CONTEXT line inside an Update hunk and must flow into the hunk body.
    if (line === '') continue
    if (line.startsWith('*** Add File: ')) {
      flushCur()
      cur = { path: line.slice('*** Add File: '.length).trim(), type: 'add', contentLines: [] }
      sawHunk = true
    } else if (line.startsWith('*** Delete File: ')) {
      flushCur()
      cur = { path: line.slice('*** Delete File: '.length).trim(), type: 'delete', contentLines: [] }
      sawHunk = true
    } else if (line.startsWith('*** Update File: ')) {
      flushCur()
      cur = { path: line.slice('*** Update File: '.length).trim(), type: 'update', contentLines: [] }
      sawHunk = true
    } else if (line.startsWith('*** Move to: ')) {
      if (!cur || cur.type !== 'update') throw new Error('"*** Move to:" must appear inside an Update File hunk')
      const to = line.slice('*** Move to: '.length).trim()
      // A Move renames the file; the following change lines (the update hunk body)
      // apply to the destination path. Keep type 'update' so '@@'/+/−/space lines
      // continue to parse into the same hunk.
      moves.push({ from: cur.path, to })
      cur.path = to
      sawHunk = true
    } else if (line.trim() === '*** End of File') {
      // No-trailing-newline marker: the DSH form cannot represent it, so the
      // marker is accepted and the file keeps the platform's trailing newline.
    } else if (line.startsWith('@@')) {
      if (!cur || cur.type !== 'update') throw new Error('"@@" context appeared outside an Update File hunk')
      cur.contentLines.push({ __hunk: line })
    } else {
      if (!cur) throw new Error('Content line appeared outside any file hunk')
      if (cur.type === 'delete') throw new Error('Content line in a Delete File hunk: "' + line + '"')
      if (cur.type === 'add' && !line.startsWith('+')) throw new Error('Content line in an Add File hunk must start with "+": "' + line + '"')
      cur.contentLines.push(line)
    }
  }
  if (!sawHunk) throw new Error('Patch contains no hunks')
  flushCur()
  return { files: files.map((f) => ({ path: f.path, type: f.type, contentLines: f.contentLines })), moves }
}

// Apply one group of update ops (from a single '@@' hunk) to the working line
// list. Returns the new line list.
function applyHunkGroup(lines, ops, hint) {
  let anchorIdx = -1
  let anchorOpIdx = -1
  const firstCtxDel = ops.findIndex((o) => o.op === 'ctx' || o.op === 'del')
  const allAdd = ops.every((o) => o.op === 'add')
  if (!allAdd) {
    if (hint) {
      const h = lines.indexOf(hint)
      if (h >= 0) anchorIdx = h
    }
    if (anchorIdx >= 0 && firstCtxDel >= 0) {
      // Explicit '@@' hint: the first ctx/del op may sit below the hint line.
      for (let s = anchorIdx; s < lines.length; s++) {
        if (lines[s] === ops[firstCtxDel].text) { anchorIdx = s; anchorOpIdx = firstCtxDel; break }
      }
    } else if (firstCtxDel >= 0) {
      for (let k = 0; k < ops.length; k++) {
        if (ops[k].op === 'ctx' || ops[k].op === 'del') {
          const at = lines.indexOf(ops[k].text)
          if (at >= 0) { anchorIdx = at; anchorOpIdx = k; break }
        }
      }
    }
  }
  if (anchorIdx < 0) {
    if (allAdd) {
      // Pure insertion (e.g. "@@ -0,0 +1,N @@ new file section"): append at the
      // end, or right after the hint line when it exists. Insert BEFORE the
      // phantom trailing empty element so the original trailing newline is kept.
      anchorIdx = lines.length
      if (lines.length > 0 && lines[lines.length - 1] === '') anchorIdx = lines.length - 1
      if (hint) { const h = lines.indexOf(hint); if (h >= 0) anchorIdx = h + 1 }
    } else {
      throw new Error('Could not locate a matching anchor line for this hunk')
    }
  }
  const out = []
  let si = anchorIdx
  for (let s = 0; s < anchorIdx; s++) out.push(lines[s])
  let startOp = 0
  if (anchorOpIdx >= 0) {
    // Consume ops up to and including the anchor op.
    for (let k = 0; k <= anchorOpIdx; k++) {
      const op = ops[k]
      if (op.op === 'add') out.push(op.text)
      else if (op.op === 'del') {
        if (lines[si] !== undefined && lines[si] === op.text) si++
        else throw new Error('Hunk deletion did not match file content: "' + op.text + '"')
      } else {
        if (lines[si] !== undefined && lines[si] === op.text) { out.push(lines[si]); si++ }
        else throw new Error('Hunk context did not match file content: "' + op.text + '"')
      }
    }
    startOp = anchorOpIdx + 1
  }
  for (let k = startOp; k < ops.length; k++) {
    const op = ops[k]
    if (op.op === 'add') {
      out.push(op.text)
    } else if (op.op === 'del') {
      if (si < lines.length && lines[si] === op.text) si++
      else throw new Error('Hunk deletion did not match file content at line: "' + op.text + '"')
    } else {
      if (si < lines.length && lines[si] === op.text) { out.push(lines[si]); si++ }
      else throw new Error('Hunk context did not match file content at line: "' + op.text + '"')
    }
  }
  for (; si < lines.length; si++) out.push(lines[si])
  return out
}

// Apply a full Update File hunk (possibly several '@@' sub-hunks) to the
// original text. contentLines is a mix of {__hunk} markers and '+/-/ ' strings.
// Returns the new text.
function applyUpdateHunk(original, contentLines) {
  const srcLines = original.replace(/\r\n/g, '\n').split('\n')
  // Split into independent hunk groups on '@@' markers; each re-anchors against
  // the text produced by the previous group (unified-diff semantics).
  const groups = []
  let curOps = null
  let curHint = null
  const close = () => {
    if (curOps) groups.push({ ops: curOps, hint: curHint })
    curOps = null
    curHint = null
  }
  for (const raw of contentLines) {
    if (raw && typeof raw === 'object' && raw.__hunk) {
      close()
      const m = String(raw.__hunk).match(/^@@[^@]*@@\s*(.*)$/)
      if (m && m[1]) {
        curHint = m[1]
      } else {
        // Codex also accepts bare "@@ <anything>" context hints.
        const alt = /^@@\s?(.*)$/.exec(String(raw.__hunk))
        curHint = alt && alt[1] ? alt[1].trim() : null
      }
      curOps = []
      continue
    }
    if (!curOps) curOps = []
    const ch = raw[0]
    if (ch === '+') curOps.push({ op: 'add', text: raw.slice(1) })
    else if (ch === '-') curOps.push({ op: 'del', text: raw.slice(1) })
    else if (ch === ' ') curOps.push({ op: 'ctx', text: raw.slice(1) })
    else throw new Error('Unexpected line in update hunk (must start with +, - or space): "' + raw + '"')
  }
  close()
  // A pure rename (`*** Move to:` with no change body) yields empty groups; the
  // move already copied the content, so the update is a no-op on the text.
  if (groups.length === 0 || groups.every((g) => g.ops.length === 0)) {
    return srcLines.join('\n')
  }
  let lines = srcLines
  for (const g of groups) {
    if (g.ops.length === 0) continue
    lines = applyHunkGroup(lines, g.ops, g.hint)
  }
  return lines.join('\n')
}

/** A non-`completed` stop reason means the child did not finish cleanly. */
function stopReasonError(result) {
  switch (result.stopReason) {
    case 'completed': return undefined
    case 'aborted': return 'subagent run was cancelled'
    case 'error': return 'subagent run failed'
    case 'max-tokens': return 'subagent run hit its token limit before finishing'
    case 'refusal': return 'subagent declined the task'
    default: return 'subagent run ended abnormally (' + String(result.stopReason) + ')'
  }
}

/**
 * Append the child's preserved partial answer to a stop-reason error so a
 * truncated or cancelled child's real text still reaches the parent model.
 * Wording matches the stock `subagent` tool.
 */
function withPartialText(error, output) {
  const blocks = Array.isArray(output) ? output : []
  const text = blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('')
  return text.length === 0 ? error : error + '\nPartial output before the run ended:\n' + text
}

function textOf(output) {
  if (typeof output === 'string') return output
  if (!Array.isArray(output)) return ''
  return output.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n')
}

const name = 'dsh-kernel-codex'
const inject = ['fs', 'tools', 'subprocess', 'web', 'jobs']

async function apply(ctx, config = {}) {
    const fs = ctx.get('fs')
    const tools = ctx.get('tools')
    const web = ctx.get('web')
    const subagents = ctx.get('subagents')
    const sandboxPolicy = ctx.get('sandboxPolicy')
    const subprocess = ctx.get('subprocess')
    const jobs = ctx.get('jobs')
    const attachments = ctx.get('attachments')
    const userQuestions = ctx.get('userQuestions')

    // Tolerant registration: a colliding tool name (e.g. the DSH-native
    // send_message/interrupt_agent/list_agents controls, which implement the
    // same subagents.followup / interrupt / listChildren plumbing) is skipped
    // so the package mounts in any preset without hand-editing rows.
    const register = (t) => {
      // When mounted as a subagent surface, only register the tools the
      // subagent type is allowed to use (config.tools whitelist).
      if (config.tools && !config.tools.includes(t.name)) return
      try { tools.register(t) } catch (e) {
        if (String(e).indexOf('already registered') >= 0) return
        throw e
      }
    }
    if (!tools || !fs) return

    const SKIP_DIRS = new Set(['node_modules', '.git', '.dsh', '.venv', '__pycache__', 'dist'])
    const policyFor = (exec) => {
      try {
        if (sandboxPolicy && typeof sandboxPolicy.resolve === 'function') {
          return sandboxPolicy.resolve(exec && exec.agent && exec.agent.session ? { session: exec.agent.session } : {})
        }
      } catch {}
      return undefined
    }
    const cwdOf = (exec) => {
      const policy = policyFor(exec)
      if (policy && typeof policy.workspaceRoot === 'string') return policy.workspaceRoot
      try { if (sandboxPolicy && typeof sandboxPolicy.workspaceRoot === 'string') return sandboxPolicy.workspaceRoot } catch {}
      try { return process.cwd() } catch {}
      return 'C:\\'
    }
    const strDef = (t) => {
      t.output = { schema: { type: 'string' }, render: (a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }] }
      return t
    }

    // shared recursive walker over fs.listDir (listDir already returns resolved child targets).
    // A depth cap plus a visited-target set break junction/symlink cycles.
    async function walk(dirTarget, rel, out, max, signal, depth, seen) {
      if (out.length >= max || (depth || 0) > 64) return
      const visited = seen || new Set()
      let entries
      try { entries = await fs.listDir(dirTarget, signal) } catch { return }
      for (const e of entries || []) {
        if (out.length >= max) return
        const name = e.name
        if (SKIP_DIRS.has(name)) continue
        const isDir = e.type === 'directory'
        const childRel = rel ? rel + '/' + name : name
        if (isDir) {
          const key = e.target && e.target.targetKey ? e.target.targetKey : childRel
          if (visited.has(key)) continue
          visited.add(key)
          try { await walk(e.target, childRel, out, max, signal, (depth || 0) + 1, visited) } catch {}
        } else {
          out.push({ rel: childRel, target: e.target })
        }
      }
    }

    // Reads a full file as text (used by exec_command's read fallback and grep).
    async function readFileText(pathArg, exec) {
      const target = await fs.resolve(pathArg, { cwd: cwdOf(exec), signal: exec.signal })
      return await fs.readText(target, exec.signal)
    }

    // ---- exec_command (unified exec; the modern replacement for `shell`) ----
    // Extracted schema: command, cwd, timeout_ms, login, sandbox_permissions,
    // justification, additional_permissions{network{enabled},file_system{read[],write[]}},
    // environment_id. DSH form runs on PowerShell with a background-task escape
    // hatch via run_in_background/description (mapping Codex's unified-exec
    // continue-session semantics onto the jobs service).
    register(strDef({
      name: 'exec_command',
      description: 'Runs a PowerShell command (Windows) and returns its output. Use this to execute shell commands. On this machine commands run under PowerShell regardless of the target shell. timeout_ms caps runtime (default 60000). Set run_in_background=true (with a description) to run as a background task managed via list_tasks/task_output/task_stop — the DSH-form approximation of Codex unified-exec session continuation.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The PowerShell command to execute.' },
          cwd: { type: 'string', description: 'Working directory for the command. Defaults to the workspace.' },
          timeout_ms: { type: 'integer', description: 'Maximum command runtime in milliseconds. Defaults to 60000 ms.' },
          login: { type: 'boolean', description: 'Ignored in DSH form (PowerShell always runs non-interactively). Defaults to false.', default: false },
          run_in_background: { type: 'boolean', description: 'Whether to run the command as a background task instead of waiting.', default: false },
          description: { type: 'string', description: 'Short description for the background task. Required when run_in_background=true.', default: '' },
        },
        required: ['command'],
      },
      execute: async (args, exec) => {
        if (!subprocess) return 'Error: subprocess service unavailable.'
        let pwshBin = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
        try { const r = await subprocess.resolveExecutable('pwsh.exe', undefined, exec.signal); if (r) pwshBin = r } catch {}
        const argv = [pwshBin, '-NoProfile', '-NonInteractive', '-Command', args.command]
        const stdioSpec = { stdin: 'ignore', stdout: { maxBytes: 1000000 }, stderr: { maxBytes: 100000 } }
        // Resolve the model-supplied cwd against the session workspace; a raw
        // relative path would otherwise resolve against process.cwd().
        let spawnCwd = cwdOf(exec)
        try {
          const cwdTarget = await fs.resolve(args.cwd || cwdOf(exec), { cwd: cwdOf(exec), signal: exec.signal })
          if (typeof fs.processPath === 'function') {
            spawnCwd = fs.processPath(cwdTarget) || spawnCwd
          } else if (typeof cwdTarget === 'string') {
            spawnCwd = cwdTarget
          } else if (cwdTarget && typeof cwdTarget.displayPath === 'string') {
            spawnCwd = cwdTarget.displayPath
          } else {
            return 'exec_command: could not resolve a spawn working directory for cwd "' + (args.cwd || '') + '"'
          }
        } catch {}
        if (args.run_in_background === true) {
          if (!jobs) return 'Error: jobs service unavailable.'
          if (!exec.agent) return 'Error: no caller agent.'
          if (exec.signal && exec.signal.aborted) return 'exec_command: aborted before start.'
          // Spawn INSIDE run(): jobs.start preflights first (controller, label,
          // per-owner cap) and only then invokes run(), so a preflight failure
          // can never leak a live process tree. Background spawns carry no
          // exec.signal: only task_stop (handle.terminate) may kill them.
          let handle = null
          let cursor = 0
          let errCursor = 0
          const id = jobs.start({
            kind: 'shell',
            label: String(args.description || args.command).slice(0, 120) || 'exec_command',
            owner: exec.agent,
            run: () => {
              handle = subprocess.spawn({ argv, cwd: spawnCwd, stdio: stdioSpec, graceMs: 3000 })
              return {
                cancel: (reason) => { try { handle.terminate() } catch {} },
                done: handle.done.then(
                  (o) => ({ status: o.exitCode === 0 ? 'completed' : 'failed', detail: 'exit ' + o.exitCode }),
                  (e) => ({ status: 'failed', detail: String(e) }),
                ),
                readOutput: () => {
                  if (!handle) return ''
                  const rd = handle.collected.stdout ? handle.collected.stdout.readFrom(cursor) : { text: '', nextOffset: cursor }
                  cursor = rd.nextOffset
                  const er = handle.collected.stderr ? handle.collected.stderr.readFrom(errCursor) : { text: '', nextOffset: errCursor }
                  errCursor = er.nextOffset
                  return rd.text + (er.text ? '\n[stderr]\n' + er.text : '')
                },
              }
            },
          })
          return 'Background task started: ' + id
        }
        const handle = subprocess.spawn({ argv, cwd: spawnCwd, stdio: stdioSpec, graceMs: 3000, signal: exec.signal })
        const doneSafe = handle.done.then(
          (o) => ({ ok: true, o }),
          (e) => ({ ok: false, e }),
        )
        let timer = null
        const timeoutMs = Math.max(3000, Math.min(300000, args.timeout_ms || 60000))
        let outcome
        try {
          outcome = await Promise.race([
            doneSafe,
            new Promise((resolve) => {
              timer = setTimeout(() => {
                try { handle.terminate() } catch {}
                resolve(null)
              }, timeoutMs)
            }),
          ])
        } finally {
          if (timer) clearTimeout(timer)
        }
        if (outcome === null) {
          // Terminate escalates asynchronously; wait (or until the turn aborts)
          // so collected output is complete. An already-aborted signal resolves
          // the grace wait immediately.
          const grace = new Promise((resolve) => {
            if (exec.signal && exec.signal.aborted) { resolve(); return }
            const t = setTimeout(resolve, 4000)
            if (exec.signal) exec.signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
          })
          await Promise.race([handle.done.catch(() => {}), grace])
        }
        const out = handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : ''
        const err = handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : ''
        const body = (out + (err ? '\n[stderr]\n' + err : '')).trim()
        if (outcome === null) {
          return body + '\n[timed out after ' + Math.round(timeoutMs / 1000) + 's]'
        }
        if (!outcome.ok) {
          return body + '\n[spawn failed: ' + String(outcome.e) + ']'
        }
        return body + '\n[exit code: ' + outcome.o.exitCode + ']'
      },
    }))

    // ---- write_stdin (unified exec session continuation) ----
    // DSH form has no long-lived session handles; this is a best-effort stub that
    // reports the limitation while remaining name-compatible.
    register(strDef({
      name: 'write_stdin',
      description: 'Writes characters to an existing unified exec session and returns recent output. DSH form does not retain long-lived exec sessions across tool calls, so this is a best-effort no-op: it reports that the session is not available. Prefer a single exec_command invocation.',
      parameters: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'Identifier of the running unified exec session.' },
          stdin: { type: 'string', description: 'Bytes to write to stdin. Defaults to empty, which polls without writing.' },
          max_output_tokens: { type: 'integer', description: 'Output token budget. Defaults to 10000 tokens.' },
        },
        required: ['session_id'],
      },
      execute: async (args, exec) => {
        return 'write_stdin is not supported in DSH form: long-lived exec sessions are not retained across tool calls. Re-run the work as a single exec_command call.'
      },
    }))

    // ---- apply_patch (FREEFORM tool) ----
    register(strDef({
      name: 'apply_patch',
      description: 'Edits files using a FREEFORM unified-diff-ish patch, passed as the JSON string argument `patch`:\n\n*** Begin Patch\n*** Add File: path/to/file\n+line one\n+line two\n*** Update File: path/to/file\n@@\n context line\n-removed line\n+added line\n*** Delete File: path/to/file\n*** End Patch',
      parameters: {
        type: 'object',
        properties: {
          patch: { type: 'string', description: 'The freeform patch text (Begin Patch / file hunks / End Patch).' },
        },
        required: ['patch'],
      },
      execute: async (args, exec) => {
        const policy = policyFor(exec)
        let plan
        try { plan = applyPatchGrammar(args.patch) } catch (e) { return 'apply_patch error: ' + String(e) }
        const results = []
        const failedPaths = new Set()
        // Resolve a patch path to an absolute on-disk path for unlink.
        const absOf = (target, rel) => {
          if (target && typeof target.displayPath === 'string') return target.displayPath
          return nodePath.resolve(cwdOf(exec), rel)
        }
        // Unlinks must respect the per-call sandbox policy exactly like writes:
        // read-only denies, workspace-write requires containment in the root.
        const unlinkAllowed = async (target) => {
          if (!policy || policy.mode === 'danger-full-access') return true
          if (policy.mode !== 'workspace-write') return false
          try {
            if (typeof fs.contains === 'function' && policy.workspaceRoot) {
              const rootT = await fs.resolve(policy.workspaceRoot, {})
              return fs.contains(rootT, target)
            }
          } catch {}
          const p = typeof fs.processPath === 'function' ? fs.processPath(target) : (target && typeof target.displayPath === 'string' ? target.displayPath : '')
          if (typeof p !== 'string' || p === '') return false
          // Separator-bounded containment: relative() rejects escape paths.
          const rel = nodePath.relative(policy.workspaceRoot, p)
          return rel === '' || (!rel.startsWith('..') && !nodePath.isAbsolute(rel))
        }
        // Apply moves (rename): copy source content to destination when the
        // destination is a different, absent file; the update hunk body then
        // applies to it. Same-identity moves (case-only renames, ./file) apply
        // in place with no copy and NO source unlink.
        for (const mv of plan.moves) {
          try {
            const src = await fs.resolve(mv.from, { cwd: cwdOf(exec), signal: exec.signal })
            const dst = await fs.resolve(mv.to, { cwd: cwdOf(exec), signal: exec.signal })
            const sameKey = src && dst && src.targetKey !== undefined && src.targetKey === dst.targetKey
            const samePath = src && dst && typeof src.displayPath === 'string' && src.displayPath === dst.displayPath
            const sameTarget = sameKey || samePath
            if (sameTarget) {
              results.push('Moved (same file) ' + mv.from + ' -> ' + mv.to)
              continue
            }
            const dstInfo = await fs.stat(dst, exec.signal)
            if (dstInfo) {
              results.push('Move failed ' + mv.from + ' -> ' + mv.to + ': destination already exists')
              failedPaths.add(mv.to)
              continue
            }
            const content = await fs.readText(src, exec.signal)
            await fs.writeText(dst, content, undefined, exec.signal, policy)
            results.push('Moved ' + mv.from + ' -> ' + mv.to)
          } catch (e) { results.push('Move failed ' + mv.from + ' -> ' + mv.to + ': ' + String(e)); failedPaths.add(mv.to) }
        }
        for (const f of plan.files) {
          // A move whose copy failed already marked its destination: do not let
          // the synthesized update hunk resurrect it as an empty file.
          if (failedPaths.has(f.path)) continue
          try {
            const target = await fs.resolve(f.path, { cwd: cwdOf(exec), signal: exec.signal })
            if (f.type === 'delete') {
              // fs.resolve succeeds even for a missing path, so probe first and
              // never fabricate an empty file as a "delete".
              const info = await fs.stat(target, exec.signal)
              if (!info) {
                results.push('Deleted (already absent) ' + f.path)
                continue
              }
              if (!(await unlinkAllowed(target))) {
                results.push('Delete denied by sandbox policy: ' + f.path)
                failedPaths.add(f.path)
                continue
              }
              const p = typeof fs.processPath === 'function' ? fs.processPath(target) : absOf(target, f.path)
              try {
                nodeFs.unlinkSync(p)
                results.push('Deleted ' + f.path)
              } catch (e) {
                results.push('Delete failed ' + f.path + ': ' + String(e))
                failedPaths.add(f.path)
              }
            } else if (f.type === 'add') {
              // Add File must never clobber an existing file.
              const info = await fs.stat(target, exec.signal)
              if (info) {
                results.push('Add failed ' + f.path + ': already exists')
                failedPaths.add(f.path)
                continue
              }
              const content = f.contentLines.filter((l) => typeof l === 'string' && l[0] === '+').map((l) => l.slice(1)).join('\n')
              await fs.writeText(target, content, undefined, exec.signal, policy)
              results.push('Wrote ' + f.path)
            } else if (f.type === 'update') {
              let original = ''
              let exists = true
              try {
                original = await fs.readText(target, exec.signal)
              } catch (e) {
                const code = e && e.code ? e.code : ''
                if (code === 'FS_NOT_FOUND') { original = ''; exists = false }
                else { results.push('Failed update (unreadable) ' + f.path + ': ' + String(e)); failedPaths.add(f.path); continue }
              }
              if (!exists) {
                // Absent target: an update hunk with only additions may create it.
                const info = await fs.stat(target, exec.signal).catch(() => null)
                if (info) {
                  results.push('Failed update ' + f.path + ': file exists but was not readable')
                  failedPaths.add(f.path)
                  continue
                }
              }
              const updated = applyUpdateHunk(original, f.contentLines)
              await fs.writeText(target, updated, undefined, exec.signal, policy)
              results.push('Updated ' + f.path)
            }
          } catch (e) {
            const isMoveDest = plan.moves.some((mv) => mv.to === f.path)
            results.push('Failed ' + f.type + ' ' + f.path + ': ' + String(e) + (isMoveDest ? ' (move copy left in place at ' + f.path + '; source kept)' : ''))
            failedPaths.add(f.path)
          }
        }
        // A real rename removes the source once the destination hunk succeeded —
        // except when both paths are the same file (case-only rename), where an
        // unlink would delete the only copy.
        for (const mv of plan.moves) {
          if (failedPaths.has(mv.to)) continue
          try {
            const src = await fs.resolve(mv.from, { cwd: cwdOf(exec), signal: exec.signal })
            const dst = await fs.resolve(mv.to, { cwd: cwdOf(exec), signal: exec.signal })
            const sameKey2 = src && dst && src.targetKey !== undefined && src.targetKey === dst.targetKey
            const samePath2 = src && dst && typeof src.displayPath === 'string' && src.displayPath === dst.displayPath
            if (sameKey2 || samePath2) continue
            if (!(await unlinkAllowed(src))) {
              results.push('Remove denied by sandbox policy: ' + mv.from)
              continue
            }
            const p = typeof fs.processPath === 'function' ? fs.processPath(src) : absOf(src, mv.from)
            nodeFs.unlinkSync(p)
            results.push('Removed ' + mv.from)
          } catch (e) { results.push('Remove failed ' + mv.from + ': ' + String(e)) }
        }
        return results.join('\n') || 'apply_patch: no changes applied'
      },
    }))

    // ---- request_permissions ----
    register(strDef({
      name: 'request_permissions',
      description: 'Requests additional filesystem or network permissions from the user and waits for a subset to be granted. DSH form: the current session already runs under a full-access file policy, so this reports the effective policy instead of prompting.',
      parameters: {
        type: 'object',
        properties: {
          environment_id: { type: 'string', description: 'Environment id; omit to use the primary environment.' },
          file_system: { type: 'object', description: 'Filesystem access request: { read: string[], write: string[] }.' },
          network: { type: 'object', description: 'Network access request: { enabled: boolean }.' },
          reason: { type: 'string', description: 'Optional short explanation for why additional permissions are needed.' },
        },
      },
      execute: async (args, exec) => {
        const policy = policyFor(exec)
        let mode = 'danger-full-access'
        if (policy) mode = policy.mode === 'workspace-write' ? 'workspace-write (root: ' + policy.workspaceRoot + ')' : String(policy.mode)
        return 'Permission profile unchanged. Current DSH file policy: ' + mode + '; requested file_system/network permissions are already within scope.'
      },
    }))

    // ---- web_search ----
    register(strDef({
      name: 'web_search',
      description: 'Queries the internet search engine for a given list of queries. Returns results with title, URL and snippet. Optionally filters by a list of domains (recency is accepted but the DSH web service applies no date filter).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query text.' },
          recency: { type: 'integer', description: 'Whether to filter by recency, as a number of recent days.' },
          domains: { type: 'array', items: { type: 'string' }, description: 'Whether to filter by a specific list of domains.' },
          limit: { type: 'integer', description: 'Maximum number of results to return. Defaults to 5.', default: 5 },
        },
        required: ['query'],
      },
      execute: async (args, exec) => {
        if (!web) return '(web service unavailable)'
        const res = await web.search({ query: args.query, maxResults: args.limit || 5 }, exec.signal)
        let out = ''
        for (const s of res.sources || []) {
          if (args.domains && args.domains.length) {
            let ok = false
            for (const d of args.domains) {
              try {
                const host = new URL(s.url).hostname
                if (host === d || host.endsWith('.' + d)) { ok = true; break }
              } catch {}
            }
            if (!ok) continue
          }
          out += '- [' + (s.title || s.url) + '](' + s.url + ')' + (s.snippet ? '\n  ' + s.snippet : '') + '\n'
        }
        return out || '(no results)'
      },
    }))

    // ---- view_image ----
    register({
      name: 'view_image',
      description: 'View a local image file from the filesystem when visual inspection is needed. Use this for images already available on disk.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Local filesystem path to an image file.' },
          detail: { type: 'string', enum: ['high', 'original'], description: 'Image detail level. Defaults to `high`; use `original` to preserve exact resolution.' },
        },
        required: ['path'],
      },
      output: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' }, error: { type: 'string' } }, additionalProperties: true },
        render: (a, v) => {
          if (v && v.attachment) return [{ type: 'image', attachment: v.attachment }]
          return [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }]
        },
      },
      execute: async (args, exec) => {
        if (!attachments) return { ok: false, error: 'attachments service unavailable' }
        const lower = String(args.path).toLowerCase()
        const mediaType = lower.endsWith('.png') ? 'image/png' : lower.endsWith('.jpg') || lower.endsWith('.jpeg') ? 'image/jpeg' : lower.endsWith('.webp') ? 'image/webp' : lower.endsWith('.gif') ? 'image/gif' : ''
        if (!mediaType) return { ok: false, error: 'Unsupported image type: ' + args.path }
        try {
          const target = await fs.resolve(args.path, { cwd: cwdOf(exec), signal: exec.signal })
          const data = await fs.readBytes(target, exec.signal, 20 * 1024 * 1024)
          const ref = await attachments.saveImage({ data, mediaType, name: args.path.split(/[\\/]/).pop() })
          return { ok: true, attachment: ref }
        } catch (e) {
          return { ok: false, error: 'Failed to view image: ' + String(e) }
        }
      },
    })

    // ---- sleep ----
    register(strDef({
      name: 'sleep',
      description: 'Pauses execution for a specified duration and returns the elapsed wall-clock time. Tools for reading and waiting on time.',
      parameters: {
        type: 'object',
        properties: {
          milliseconds: { type: 'integer', description: 'How long to sleep in milliseconds. Must be between 1 and 600000 (10 minutes).' },
        },
        required: ['milliseconds'],
      },
      execute: async (args, exec) => {
        const ms = Math.max(1, Math.min(600000, args.milliseconds || 1000))
        const start = Date.now()
        if (exec.signal && exec.signal.aborted) return 'Slept for 0 ms (already aborted).'
        await new Promise((resolve) => {
          const t = setTimeout(resolve, ms)
          try { exec.signal && exec.signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true }) } catch {}
        })
        return 'Slept for ' + (Date.now() - start) + ' ms.'
      },
    }))

    // ---- update_plan (todo/checklist) ----
    // Codex's own plan mode: a step-by-step plan that renders to the user.
    // We write `todo/write` session events so the plan renders through DSH's
    // `todos` projection (the same UI channel as todo_write) — that is the
    // "display interface" for the codex plan. Statuses match the codex prompt:
    // pending | in_progress | completed.
    const planStore = new Map()
    register(strDef({
      name: 'update_plan',
      description: 'Updates the task plan (a TODO/checklist rendered to the user). Provide an optional explanation and a list of plan items, each with a step and status (pending | in_progress | completed).',
      parameters: {
        type: 'object',
        properties: {
          explanation: { type: 'string', description: 'Optional explanation for this plan update.' },
          plan: {
            type: 'array',
            description: 'The list of steps.',
            items: {
              type: 'object',
              properties: {
                step: { type: 'string', description: 'The step description.' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'The step status.' },
              },
              required: ['step', 'status'],
              additionalProperties: false,
            },
          },
        },
        required: ['plan'],
      },
      execute: async (args, exec) => {
        const key = exec.agent && exec.agent.id != null ? String(exec.agent.id) : 'default'
        if (Array.isArray(args.plan)) {
          planStore.set(key, args.plan)
          // Display interface: render the plan through the `todos` projection.
          if (exec.agent && typeof exec.agent.session.append === 'function') {
            try {
              exec.agent.session.append('todo/write', {
                todos: args.plan.map((t) => ({ content: t.step, status: t.status })),
              })
            } catch {}
          }
        }
        const list = planStore.get(key) || []
        if (list.length === 0) return '(plan is empty)'
        return list.map((t) => '- [' + t.status + '] ' + t.step).join('\n')
      },
    }))

    // ---- request_user_input ----
    register(strDef({
      name: 'request_user_input',
      description: 'Requests user input for one to three short questions and waits for the response. Provide 2-3 mutually exclusive choices per question; put the recommended option first and suffix its label with "(Recommended)". Do not include an "Other" option — the client adds one automatically.',
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            description: 'Questions to show the user. Prefer 1 and do not exceed 3.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Stable identifier for mapping answers (snake_case).' },
                header: { type: 'string', description: 'Short header label shown in the UI (12 or fewer chars).' },
                prompt: { type: 'string', description: 'Single-sentence prompt shown to the user.' },
                options: {
                  type: 'array',
                  description: '2-3 mutually exclusive choices.',
                  items: {
                    type: 'object',
                    properties: {
                      label: { type: 'string', description: 'User-facing label (1-5 words).' },
                      description: { type: 'string', description: 'One short sentence explaining impact/tradeoff if selected.' },
                    },
                    required: ['label'],
                    additionalProperties: false,
                  },
                },
                multi_select: { type: 'boolean', description: 'Whether the user can select multiple options.', default: false },
              },
              required: ['id', 'prompt', 'options'],
              additionalProperties: false,
            },
          },
        },
        required: ['questions'],
      },
      execute: async (args, exec) => {
        if (!userQuestions) return '(user questions unavailable)'
        try {
          const answer = await userQuestions.ask({
            questions: (args.questions || []).map((q, i) => ({
              id: String(q.id || 'q' + (i + 1)),
              question: q.prompt,
              header: q.header || undefined,
              options: (q.options || []).map((o) => ({ label: o.label, description: o.description || undefined })),
              multiSelect: q.multi_select === true,
            })),
            agent: exec.agent,
            signal: exec.signal,
          })
          return JSON.stringify(answer)
        } catch (e) {
          return 'request_user_input error: ' + String(e)
        }
      },
    }))

    // ---- get_context_remaining ----
    register(strDef({
      name: 'get_context_remaining',
      description: 'Gets the remaining tokens in the current context window. DSH form does not expose a token-counting service, so this reports that the value is unavailable.',
      parameters: { type: 'object', properties: {} },
      execute: async (args, exec) => {
        return JSON.stringify({ remaining_tokens: null, note: 'Token budget is not exposed in DSH form.' })
      },
    }))

    // ---- new_context ----
    register(strDef({
      name: 'new_context',
      description: 'Starts a new context window. Does not clear, reset, or otherwise affect environment state. DSH form: the context window is managed by the harness and cannot be programmatically reset here.',
      parameters: { type: 'object', properties: {} },
      execute: async (args, exec) => {
        return 'new_context is not supported in DSH form: the context window is managed by the harness.'
      },
    }))

    // ---- multi-agent family (via subagents service) ----
    // Codex's built-in agent roles map onto the single source of truth in
    // lib/subagents.js (upstream codex-rs role.rs: default / explorer / worker).
    // The recipe's persona/toolFilter are set EXPLICITLY on every request
    // because DSH's continuable (background) route never invokes
    // provider.start() — the continuation manager rebuilds the child from the
    // request fields recorded in the durable descriptor.
    const CODEX_TYPE_TO_RECIPE = { explore: 'codex-explore', explorer: 'codex-explore', worker: 'codex-worker' }

    async function followupChild(exec, childId, text) {
      if (!subagents) return 'Error: subagents service unavailable.'
      if (!exec.agent) return 'Error: no caller agent.'
      if (typeof subagents.followup !== 'function') return 'Error: subagents.followup is unavailable.'
      try {
        const messageId = await subagents.followup(exec.agent, String(childId), [{ type: 'text', text: String(text) }], {
          source: { kind: 'coordinator', form: 'relay', senderSessionId: exec.agent.id },
          signal: exec.signal,
        })
        return 'resumed subagent ' + childId + ' — message queued as its next turn (messageId: ' + messageId + '). You will receive a notice when it settles.'
      } catch (e) {
        return 'Error: follow-up failed: ' + String(e)
      }
    }

    register(strDef({
      name: 'spawn_agent',
      // Wording keeps the Codex CLI name/schema and mirrors the stock
      // `subagent` tool (backgroundMode: 'continuable').
      description: 'Spawns a sub-agent for a well-scoped task. Provide a concrete, bounded, self-contained subtask prompt (a subagent does not see your context). The subagent inherits your current model by default. This tool runs in the background by default, immediately returns a durable agent id, and keeps the child conversation available for later turns. When that run settles, the runtime sends the parent a notice containing its outcome and any final assistant message; followup_task / send_message / resume_agent starts a later turn in the same child conversation. Set run_in_background: false only when your next action depends on receiving the result.',
      parameters: {
        type: 'object',
        properties: {
          task_name: { type: 'string', description: 'Task name for the new agent. Use lowercase letters, digits, and underscores.' },
          message: { type: 'string', description: 'Initial plain-text task for the new agent.' },
          agent_type: { type: 'string', description: 'Agent type override for the new agent. Omit for the default agent. Built-in roles: "explorer" (fast, authoritative codebase questions; spawn several in parallel for independent questions) and "worker" (execution/production work: implement a feature, fix tests/bugs, split refactors; assign clear file ownership and tell it other workers may edit in parallel).' },
          model: { type: 'string', description: 'Model override for the new agent. Omit unless an explicit override is needed.' },
          reasoning_effort: { type: 'string', description: 'Reasoning effort override for the new agent. Omit to inherit the parent effort. Accepted for schema parity; DSH form does not map this onto the child request.' },
          fork_turns: { type: 'string', description: 'Optional number of turns to fork ("none", "all", or a positive-integer string). In DSH form the child is always a fresh conversation; fork context is limited to the prompt.' },
          run_in_background: { type: 'boolean', description: 'Whether to run in the background and return a durable agent id immediately. Defaults to true. Set false to wait for the result when your next action depends on it.', default: true },
        },
        required: ['message'],
      },
      // Background starts and sibling foreground runs overlap safely under the
      // loop's rolling pool, exactly like the native delegation tool.
      isConcurrencySafe: () => true,
      execute: async (args, exec) => {
        if (!subagents) return 'Error: subagents service unavailable.'
        if (!exec.agent) return 'Error: no caller agent.'
        const recipeName = CODEX_TYPE_TO_RECIPE[args.agent_type] || 'codex-agent'
        const recipe = SUBAGENT_RECIPES[recipeName]
        const names = subagents.list()
        let providerName = names.indexOf(recipeName) >= 0 ? recipeName : (names.indexOf('codex-agent') >= 0 ? 'codex-agent' : (names.indexOf('spawn') >= 0 ? 'spawn' : null))
        if (!providerName) return 'Error: no usable subagent provider (available: ' + (names.join(', ') || 'none') + ').'

        // Build the FULL child request here: persona/toolFilter/agentOptions/
        // maxDepth must be set by the caller because the continuable route
        // never invokes provider.start() — the durable descriptor records
        // exactly these fields for cold resume. maxDepth matches the native
        // default delegation-depth cap.
        const label = String(args.task_name || args.message).slice(0, 80)
        const request = {
          label,
          prompt: [{ type: 'text', text: String(args.message) }],
          parent: exec.agent,
          agentOptions: { provider: recipe.provider, model: args.model || recipe.model },
          persona: recipe.persona,
          toolFilter: recipe.toolFilter,
          maxDepth: 3,
        }

        // Background-first (native default): establish a durable continuable
        // child and return at inbox acceptance. The child owns its turns from
        // here — no in-tool await, and the runtime delivers the settlement
        // notice itself.
        if (args.run_in_background !== false) {
          try {
            const started = await subagents.startContinuable({ provider: providerName, label, request, signal: exec.signal })
            return 'started background subagent ' + started.childId + '. It runs independently; you will receive a notice with its outcome and final message when it settles. Use followup_task / send_message / resume_agent with agent_id="' + started.childId + '" to send it follow-up messages.'
          } catch (e) {
            return 'Error: background start failed: ' + String(e)
          }
        }

        // Foreground override: collect the result and dispose, preserving the
        // child's partial output on a non-completed stop (native semantics).
        const run = await subagents.start(providerName, { ...request, signal: exec.signal })
        try {
          const result = await run.result
          const error = stopReasonError(result)
          if (error !== undefined) return withPartialText(error, result.output)
          return textOf(result.output)
        } finally {
          try { await run.dispose() } catch {}
        }
      },
    }))

    // Native parity: a prompt section teaches the background-first calling
    // convention while the tool is visible (dsh-tool-subagent does the same
    // for `subagent` at order 116.5).
    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt) {
      // The kernel's own system prompt, shadowing the deployment persona.
      // `complete: true` makes it the SOLE system-prompt section and
      // `suppressRuntimeContext()` drops the runtime-context snapshot, so a
      // session on this kernel sees ONLY the upstream Codex CLI prompt.
      if (!(config && config.skipPersona)) {
        systemPrompt.section({
          name: 'deployment:persona',
          order: 0,
          text: (config && config.persona) || SYSTEM_PROMPT,
          complete: true,
        })
        if (typeof systemPrompt.suppressRuntimeContext === 'function') systemPrompt.suppressRuntimeContext()
      }
      systemPrompt.section({
        name: 'tool:spawn_agent',
        order: 116.5,
        text: (context) => (tools.get('spawn_agent', context && context.scope) === undefined ? '' : 'Use spawn_agent in the background by default. Start independent delegations together in one assistant message and continue useful work while they run. Set `run_in_background: false` only when your next action depends on that subagent\'s result. When a background run settles, the runtime sends you a notice containing its outcome and any final assistant message; use followup_task / send_message / resume_agent with the durable agent id to give it more work.'),
      })
    }

    // Family tools that map cleanly onto the continuable subagents service.
    // send_message / interrupt_agent / list_agents share names with DSH's
    // native control tools; register() skips them when those rows already won.
    register(strDef({
      name: 'assign_agent_task',
      description: 'Assigns a follow-up task to an existing sub-agent by id. In DSH form this queues the message as the child\'s next turn via subagents.followup (the same channel send_message uses).',
      parameters: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'Agent id to message (from spawn_agent).' },
          message: { type: 'string', description: 'Message text to send to the target agent.' },
        },
        required: ['agent_id', 'message'],
      },
      execute: async (args, exec) => followupChild(exec, args.agent_id, args.message),
    }))
    register(strDef({
      name: 'send_message',
      description: 'Sends a message to an existing agent by id, continuing the same conversation. It becomes the subagent\'s next turn: if it is still working, the message waits until its current turn finishes, so it cannot redirect work already underway. Set interrupt=true to cancel the current turn first. This call returns no answer from the subagent — only confirmation that the message was delivered.',
      parameters: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'Agent id to message (from spawn_agent).' },
          message: { type: 'string', description: 'Legacy plain-text message to send.' },
          interrupt: { type: 'boolean', description: 'True interrupts the current task and handles this message immediately.', default: false },
        },
        required: ['agent_id', 'message'],
      },
      execute: async (args, exec) => {
        if (!subagents) return 'Error: subagents service unavailable.'
        if (!exec.agent) return 'Error: no caller agent.'
        if (args.interrupt === true && typeof subagents.interrupt === 'function') {
          try {
            subagents.interrupt(String(args.agent_id), { kind: 'ancestor', agent: exec.agent })
          } catch (e) {
            return 'Error: interrupt failed: ' + String(e)
          }
        }
        return followupChild(exec, args.agent_id, args.message)
      },
    }))
    register(strDef({
      name: 'followup_task',
      description: 'Sends a follow-up task to an existing non-root target agent and triggers a turn if it is idle. In DSH form this is subagents.followup — the same continuation channel as send_message.',
      parameters: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'Agent id or canonical task name to message.' },
          message: { type: 'string', description: 'Message text to send.' },
        },
        required: ['agent_id', 'message'],
      },
      execute: async (args, exec) => followupChild(exec, args.agent_id, args.message),
    }))
    register(strDef({
      name: 'wait_agent',
      description: 'Waits for agents to reach a final status. DSH form has no in-tool wait on a continuable child: the runtime delivers a settlement notice (outcome + final assistant message) to the parent when the child\'s Activation epoch ends. Do not poll; keep working until that notice arrives.',
      parameters: {
        type: 'object',
        properties: {
          targets: { type: 'array', items: { type: 'string' }, description: 'Agent ids to wait on.' },
          timeout_ms: { type: 'integer', description: 'Timeout in milliseconds.' },
        },
        required: ['targets'],
      },
      execute: async () => 'wait_agent is not supported in DSH form: there is no in-tool wait on a continuable child. The runtime sends a notice with the child\'s outcome and final message when it settles. Keep working until that notice arrives.',
    }))
    register(strDef({
      name: 'list_agents',
      description: 'Lists live agents in the current root thread tree. Optionally filter by task-path prefix. In DSH form this lists continuable children of the caller via subagents.listChildren (path_prefix filters the label when provided).',
      parameters: {
        type: 'object',
        properties: {
          path_prefix: { type: 'string', description: 'Task-path prefix filter without a trailing slash. Omit to list all live agents.' },
        },
      },
      execute: async (args, exec) => {
        if (!subagents) return 'Error: subagents service unavailable.'
        if (!exec.agent) return 'Error: no caller agent.'
        if (typeof subagents.listChildren !== 'function') return 'Error: subagents.listChildren is unavailable.'
        try {
          const entries = await subagents.listChildren(exec.agent.id, exec.signal)
          const prefix = args.path_prefix ? String(args.path_prefix) : ''
          const lines = []
          for (const entry of entries || []) {
            if (!entry || entry.kind === 'diagnostic') {
              if (entry && entry.id) lines.push('- ' + entry.id + ' [diagnostic: ' + (entry.reason || 'unknown') + ']')
              continue
            }
            if (entry.mode && entry.mode !== 'continuable') continue
            const label = entry.label || ''
            if (prefix && label.indexOf(prefix) !== 0 && String(entry.id).indexOf(prefix) !== 0) continue
            lines.push('- ' + entry.id + (label ? ' — ' + label : ''))
          }
          return lines.join('\n') || '(no live agents)'
        } catch (e) {
          return 'list_agents error: ' + String(e)
        }
      },
    }))
    register(strDef({
      name: 'resume_agent',
      description: 'Resumes a previously closed agent by id. In DSH form a continuable child stays durable after a turn ends; this queues a continue prompt as its next turn via subagents.followup. Prefer followup_task / send_message when you have a specific next instruction.',
      parameters: {
        type: 'object',
        properties: { agent_id: { type: 'string', description: 'Agent id to resume.' } },
        required: ['agent_id'],
      },
      execute: async (args, exec) => followupChild(exec, args.agent_id, 'Continue from where you left off and report your status.'),
    }))
    register(strDef({
      name: 'interrupt_agent',
      description: 'Interrupts an agent\u2019s current turn, if any. Only the current turn stops: queued follow-ups stay parked, descendants keep running, and the agent remains available for later followup_task / send_message. An already-finished target is an accepted no-op.',
      parameters: {
        type: 'object',
        properties: { agent_id: { type: 'string', description: 'Agent id or canonical task name to interrupt.' } },
        required: ['agent_id'],
      },
      execute: async (args, exec) => {
        if (!subagents) return 'Error: subagents service unavailable.'
        if (!exec.agent) return 'Error: no caller agent.'
        if (typeof subagents.interrupt !== 'function') return 'Error: subagents.interrupt is unavailable.'
        try {
          subagents.interrupt(String(args.agent_id), { kind: 'ancestor', agent: exec.agent })
          return 'interrupt requested for agent ' + args.agent_id
        } catch (e) {
          return 'Error: interrupt failed: ' + String(e)
        }
      },
    }))
    register(strDef({
      name: 'close_agent',
      description: 'Closes an agent and any open descendants when no longer needed. DSH form has no single-child close API (drainContinuableDescendants is parent-teardown of a whole forest), so this remains an honest stub: leave the child idle; it stays durable and resumable.',
      parameters: {
        type: 'object',
        properties: { agent_id: { type: 'string', description: 'Agent id to close.' } },
        required: ['agent_id'],
      },
      execute: async () => 'close_agent is not supported in DSH form: there is no single-child close on the subagents service. Leave the child idle — it stays durable and can be resumed with followup_task / send_message / resume_agent.',
    }))

    // ---- background-task management (DSH jobs service; companion to exec_command background mode) ----
    register(strDef({
      name: 'list_tasks',
      description: 'Lists background tasks started via exec_command run_in_background. active_only: whether to list only non-terminal tasks (default true). limit: maximum number of tasks (default 20).',
      parameters: {
        type: 'object',
        properties: {
          active_only: { type: 'boolean', description: 'Whether to list only non-terminal background tasks.', default: true },
          limit: { type: 'integer', description: 'Maximum number of tasks to return.', default: 20 },
        },
      },
      execute: async (args, exec) => {
        if (!jobs) return '(jobs service unavailable)'
        if (!exec.agent) return 'Error: no caller agent.'
        let list = jobs.list(exec.agent)
        if (args.active_only !== false) list = list.filter((j) => j.status === 'running' || j.status === 'stopping')
        list = list.slice(0, args.limit || 20)
        return list.map((j) => '- ' + j.id + ' [' + j.status + '] ' + (j.label || '')).join('\n') || '(no background tasks)'
      },
    }))
    register(strDef({
      name: 'task_output',
      description: 'Reads the output of a background task. block: whether to wait for the task to finish before returning (default false). timeout: maximum seconds to wait when block=true (default 30).',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'The background task ID to inspect.' },
          block: { type: 'boolean', description: 'Whether to wait for the task to finish before returning.', default: false },
          timeout: { type: 'integer', description: 'Maximum number of seconds to wait when block=true.', default: 30 },
        },
        required: ['task_id'],
      },
      execute: async (args, exec) => {
        if (!jobs) return '(jobs service unavailable)'
        if (!exec.agent) return 'Error: no caller agent.'
        try {
          if (args.block === true) await jobs.wait(args.task_id, (args.timeout || 30) * 1000, exec.agent, exec.signal)
          const read = await jobs.read(args.task_id, exec.agent)
          const fallback = read.snapshot && read.snapshot.status != null ? '[' + read.snapshot.status + '] ' + (read.snapshot.detail || '') : '(no output)'
          return read.text || fallback
        } catch (e) {
          return 'task_output error: ' + String(e)
        }
      },
    }))
    register(strDef({
      name: 'task_stop',
      description: 'Stops a background task by ID.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'The background task ID to stop.' },
          reason: { type: 'string', description: 'Short reason recorded when the task is stopped.', default: 'Stopped by task_stop' },
        },
        required: ['task_id'],
      },
      execute: async (args, exec) => {
        if (!jobs) return '(jobs service unavailable)'
        if (!exec.agent) return 'Error: no caller agent.'
        try {
          const outcome = jobs.kill(args.task_id, exec.agent, args.reason)
          return 'task_stop: ' + outcome
        } catch (e) {
          return 'task_stop error: ' + String(e)
        }
      },
    }))

    // ---- plan mode ----
    // Codex models plan mode as `update_plan` (a TODO/checklist rendered to the
    // user), NOT as a dedicated enter/exit pair. We deliberately do NOT expose
    // the DSH planMode service here: the codex prompt's own Planning section is
    // the plan mode, and `update_plan` below writes a session projection so the
    // plan renders in the UI.

    // ---- view_file / edit_file / write_file (Codex read/edit primitives, mapped
    // best-effort onto DSH fs; older Codex called these `view`/`edit`/`write`) ----
    register(strDef({
      name: 'view_file',
      description: 'Reads a file from the local filesystem. Reads up to 2000 lines by default; use offset and limit to read a range (line-numbered output). (Older Codex named this tool `view`.)',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'The path to the file to read.' },
          offset: { type: 'integer', description: 'Line number to start reading from (default 1).' },
          limit: { type: 'integer', description: 'Number of lines to read (default 2000).' },
        },
        required: ['path'],
      },
      execute: async (args, exec) => {
        const raw = await readFileText(args.path, exec)
        const lines = raw.split(/\r?\n/)
        const off = Math.max(1, args.offset || 1)
        const n = Math.max(1, args.limit || 2000)
        const slice = lines.slice(off - 1, off - 1 + n)
        return slice.map((l, i) => String(off + i) + ': ' + l).join('\n')
      },
    }))
    register(strDef({
      name: 'write_file',
      description: 'Writes a file to the local filesystem (overwrite or append). The parent directory must exist. (Older Codex named this tool `write`.)',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'The path to the file to write.' },
          content: { type: 'string', description: 'The content to write.' },
          mode: { type: 'string', enum: ['overwrite', 'append'], description: 'overwrite (default) or append.', default: 'overwrite' },
        },
        required: ['path', 'content'],
      },
      execute: async (args, exec) => {
        const policy = policyFor(exec)
        const target = await fs.resolve(args.path, { cwd: cwdOf(exec), signal: exec.signal })
        if (args.mode === 'append') {
          // Only a genuinely absent file counts as empty; any other read failure
          // (binary, unreadable, too large) must not silently clobber the file.
          let oldText = ''
          try {
            oldText = await fs.readText(target, exec.signal)
          } catch (e) {
            const code = e && e.code ? e.code : ''
            if (code !== 'FS_NOT_FOUND') return 'write_file append error: ' + String(e)
            oldText = ''
          }
          await fs.writeText(target, oldText + args.content, undefined, exec.signal, policy)
        } else {
          await fs.writeText(target, args.content, undefined, exec.signal, policy)
        }
        return 'File successfully ' + (args.mode === 'append' ? 'appended to' : 'overwritten') + ': ' + args.path
      },
    }))
    register(strDef({
      name: 'edit_file',
      description: 'Performs exact string replacements in an existing file. Each edit replaces `old` with `new`; set replace_all to replace all occurrences. (Older Codex named this tool `edit`; prefer the freeform apply_patch tool for multi-hunk edits.)',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'The path to the file to edit.' },
          old: { type: 'string', description: 'The old string to replace (can be multi-line).' },
          new: { type: 'string', description: 'The new string to replace with (can be multi-line).' },
          replace_all: { type: 'boolean', description: 'Whether to replace all occurrences.', default: false },
        },
        required: ['path', 'old', 'new'],
      },
      execute: async (args, exec) => {
        const policy = policyFor(exec)
        const target = await fs.resolve(args.path, { cwd: cwdOf(exec), signal: exec.signal })
        await fs.editText(target, { oldString: args.old, newString: args.new, replaceAll: args.replace_all === true }, undefined, exec.signal, policy)
        return 'File successfully edited: ' + args.path
      },
    }))

    // ---- glob / grep (filesystem discovery, mapped like the kimi package) ----
    register(strDef({
      name: 'glob',
      description: 'Finds files and directories matching a glob pattern. Returns up to 1000 matches, sorted.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern to match files/directories.' },
          directory: { type: 'string', description: 'Absolute path to the directory to search in (defaults to workspace).' },
          include_dirs: { type: 'boolean', description: 'Whether to include directories in results.', default: true },
        },
        required: ['pattern'],
      },
      execute: async (args, exec) => {
        const re = globToRegex(args.pattern)
        if (!re) return 'Invalid glob pattern: ' + args.pattern
        const base = args.directory || cwdOf(exec)
        const root = await fs.resolve(base, { cwd: cwdOf(exec), signal: exec.signal })
        const out = []
        const MAX = 1000
        const seen = new Set()
        async function rec(dirTarget, rel, depth) {
          if (out.length >= MAX || depth > 64) return
          const entries = await fs.listDir(dirTarget, exec.signal)
          for (const e of entries || []) {
            if (out.length >= MAX) return
            if (SKIP_DIRS.has(e.name)) continue
            const isDir = e.type === 'directory'
            const childRel = rel ? rel + '/' + e.name : e.name
            if (isDir) {
              if (args.include_dirs !== false && re.test(childRel)) out.push(childRel + '/')
              const key = e.target && e.target.targetKey ? e.target.targetKey : childRel
              if (seen.has(key)) continue
              seen.add(key)
              try { await rec(e.target, childRel, depth + 1) } catch {}
            } else if (re.test(childRel)) {
              out.push(childRel)
            }
          }
        }
        try {
          await rec(root, '', 0)
        } catch (e) {
          return 'glob error: ' + String(e)
        }
        return out.sort().join('\n') || '(no matches)'
      },
    }))
    register(strDef({
      name: 'grep',
      description: 'Searches file contents with a regular expression. output_mode: `files_with_matches` (default) shows file paths, `content` shows matching lines, `count_matches` shows total matches. Use `glob` to filter files.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'The regular expression pattern to search for.' },
          path: { type: 'string', description: 'File or directory to search in. Defaults to the workspace.', default: '.' },
          glob: { type: 'string', description: 'Glob pattern to filter files (e.g. `*.js`).' },
          output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count_matches'], description: 'Output mode.', default: 'files_with_matches' },
          head_limit: { type: 'integer', description: 'Maximum number of matching lines/files to return.' },
        },
        required: ['pattern'],
      },
      execute: async (args, exec) => {
        let re
        try { re = new RegExp(args.pattern) } catch (e) { return 'Invalid regex: ' + String(e) }
        const filter = args.glob ? globToRegex(args.glob) : null
        const base = args.path && args.path !== '.' ? args.path : cwdOf(exec)
        const root = await fs.resolve(base, { cwd: cwdOf(exec), signal: exec.signal })
        let files
        let singleFile = false
        let rootInfo
        try { rootInfo = await fs.stat(root, exec.signal) } catch { rootInfo = null }
        if (rootInfo && rootInfo.type === 'file') {
          files = [{ rel: typeof args.path === 'string' ? String(args.path) : '.', target: root }]
          singleFile = true
        } else {
          files = []
          await walk(root, '', files, 2000, exec.signal)
        }
        const lines = []
        const matchedFiles = []
        let count = 0
        for (const item of files) {
          const rel = item.rel
          const baseName = rel.split('/').pop()
          if (filter && !filter.test(rel) && !filter.test(baseName)) continue
          let text
          try {
            const info = await fs.stat(item.target, exec.signal)
            if (info && info.size > 512 * 1024) continue
            text = await fs.readText(item.target, exec.signal)
          } catch { continue }
          for (const line of text.split(/\r?\n/)) {
            if (re.test(line)) {
              count += 1
              lines.push(rel + ':' + line)
              if (matchedFiles.indexOf(rel) < 0) matchedFiles.push(rel)
            }
          }
        }
        if (args.output_mode === 'count_matches') return 'Total matches: ' + count
        if (args.output_mode === 'content') {
          const out = args.head_limit ? lines.slice(0, args.head_limit) : lines.slice(0, 500)
          return out.join('\n') || '(no matches)'
        }
        const out = args.head_limit ? matchedFiles.slice(0, args.head_limit) : matchedFiles
        return out.join('\n') || '(no matches)'
      },
    }))
}

export { name, inject, apply }
