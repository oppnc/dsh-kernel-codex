import assert from 'node:assert/strict'
import path from 'node:path'
import * as pluginMod from '../lib/index.js'

let assertionCount = 0
function ok(value, message) {
  assertionCount += 1
  assert.ok(value, message)
}
function eq(actual, expected, message) {
  assertionCount += 1
  assert.equal(actual, expected, message)
}
function match(actual, re, message) {
  assertionCount += 1
  assert.match(String(actual), re, message)
}
function deep(actual, expected, message) {
  assertionCount += 1
  assert.deepEqual(actual, expected, message)
}

function keyOf(target) {
  if (typeof target === 'string') return path.normalize(target)
  if (target && typeof target.path === 'string') return path.normalize(target.path)
  return String(target)
}

function makeTarget(p) {
  const n = path.normalize(p)
  return { path: n, displayPath: n, targetKey: n }
}

function createHarness() {
  const workspaceRoot = '/workspace'
  const files = new Map()
  const registered = new Map()
  const sections = []
  let suppressed = false
  const calls = {
    startContinuable: [],
    start: [],
    followup: [],
    interrupt: [],
    listChildren: [],
    list: [],
    writeText: [],
    editText: [],
    spawn: [],
    jobsStart: [],
    jobsRead: [],
    jobsKill: [],
  }

  const fs = {
    async resolve(p, opts) {
      const cwd = (opts && opts.cwd) || workspaceRoot
      const raw = String(p)
      if (path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)) return makeTarget(raw)
      return makeTarget(path.join(cwd, raw))
    },
    async readText(target) {
      const key = keyOf(target)
      if (!files.has(key)) {
        const err = new Error('FS_NOT_FOUND: ' + key)
        err.code = 'FS_NOT_FOUND'
        throw err
      }
      return files.get(key).text
    },
    async writeText(target, content) {
      const key = keyOf(target)
      const prev = files.get(key)
      files.set(key, { text: String(content), version: (prev ? prev.version : 0) + 1, type: 'file' })
      calls.writeText.push({ path: key, content: String(content) })
    },
    async editText(target, edit) {
      const key = keyOf(target)
      if (!files.has(key)) {
        const err = new Error('FS_NOT_FOUND: ' + key)
        err.code = 'FS_NOT_FOUND'
        throw err
      }
      const cur = files.get(key)
      const oldString = edit.oldString
      const newString = edit.newString
      let next
      if (edit.replaceAll) next = cur.text.split(oldString).join(newString)
      else {
        const idx = cur.text.indexOf(oldString)
        if (idx < 0) throw new Error('oldString not found in ' + key)
        next = cur.text.slice(0, idx) + newString + cur.text.slice(idx + oldString.length)
      }
      files.set(key, { text: next, version: cur.version + 1, type: 'file' })
      calls.editText.push({ path: key, edit })
    },
    async stat(target) {
      const key = keyOf(target)
      if (!files.has(key)) return null
      const rec = files.get(key)
      return { type: rec.type || 'file', size: Buffer.byteLength(rec.text || ''), version: rec.version }
    },
    async listDir(target) {
      const dir = keyOf(target).replace(/[\\/]+$/, '')
      const kids = new Map()
      for (const [p, rec] of files) {
        if (p === dir) continue
        const prefix = dir + path.sep
        if (!p.startsWith(prefix)) continue
        const rest = p.slice(prefix.length)
        const name = rest.split(/[\\/]/)[0]
        if (!name || kids.has(name)) continue
        const childPath = path.join(dir, name)
        const isDir = rest.includes(path.sep) || rec.type === 'directory'
        kids.set(name, {
          name,
          type: isDir ? 'directory' : 'file',
          target: makeTarget(childPath),
        })
      }
      return Array.from(kids.values())
    },
    processPath(target) { return keyOf(target) },
    contains() { return true },
  }

  const tools = {
    register(def) {
      if (!def || !def.name) throw new Error('tool missing name')
      if (registered.has(def.name)) throw new Error('already registered: ' + def.name)
      registered.set(def.name, def)
    },
    get(name) { return registered.get(name) },
  }

  const subagents = {
    list() {
      calls.list.push(true)
      return ['codex-agent', 'codex-explore', 'spawn']
    },
    async startContinuable(req) {
      calls.startContinuable.push(req)
      return { childId: 'codex-child-1' }
    },
    async start(provider, request) {
      calls.start.push({ provider, request })
      return {
        result: Promise.resolve({
          stopReason: 'max-tokens',
          output: [{ type: 'text', text: 'codex partial answer' }],
        }),
        async dispose() {},
      }
    },
    async followup(agent, childId, blocks, opts) {
      calls.followup.push({ agent, childId, blocks, opts })
      return 'codex-msg-1'
    },
    interrupt(agentId, info) { calls.interrupt.push({ agentId, info }) },
    async listChildren(parentId, signal) {
      calls.listChildren.push({ parentId, signal })
      return [
        { id: 'codex-child-1', label: 'demo', mode: 'continuable' },
        { id: 'other', label: 'skip-me', mode: 'oneshot' },
      ]
    },
  }

  const jobsStore = new Map()
  let jobSeq = 0
  const jobs = {
    start(spec) {
      const id = 'job-' + (++jobSeq)
      const handle = spec.run()
      jobsStore.set(id, { id, status: 'running', label: spec.label, handle })
      calls.jobsStart.push({ id, spec })
      return id
    },
    list() { return Array.from(jobsStore.values()).map((j) => ({ id: j.id, status: j.status, label: j.label })) },
    async read(id) {
      calls.jobsRead.push(id)
      const j = jobsStore.get(id)
      if (!j) throw new Error('job not found: ' + id)
      const text = j.handle && typeof j.handle.readOutput === 'function' ? j.handle.readOutput() : ''
      return { text, snapshot: { status: j.status, detail: '' } }
    },
    async wait() {},
    kill(id, agent, reason) {
      calls.jobsKill.push({ id, reason })
      const j = jobsStore.get(id)
      if (!j) throw new Error('job not found: ' + id)
      j.status = 'killed'
      if (j.handle && j.handle.cancel) j.handle.cancel(reason)
      return 'killed'
    },
  }

  const subprocess = {
    async resolveExecutable(name) { return '/mock/' + name },
    spawn(opts) {
      calls.spawn.push(opts)
      const stdout = { text: 'shell-ok\n', readFrom(off) { return { text: this.text.slice(off), nextOffset: this.text.length } } }
      const stderr = { text: '', readFrom(off) { return { text: this.text.slice(off), nextOffset: this.text.length } } }
      return {
        collected: { stdout, stderr },
        done: Promise.resolve({ exitCode: 0 }),
        terminate() {},
      }
    },
  }

  const services = {
    fs,
    tools,
    subprocess,
    web: {
      async search() { return { results: [] } },
      async fetch() { return { body: { content: '' } } },
    },
    jobs,
    subagents,
    sandboxPolicy: {
      workspaceRoot,
      resolve() { return { mode: 'danger-full-access', workspaceRoot } },
    },
    attachments: { async saveImage() { return { id: 'att-1' } } },
    userQuestions: { async ask() { return { answers: [] } } },
    systemPrompt: { section(s) { sections.push(s) }, suppressRuntimeContext() { suppressed = true } },
  }

  return {
    ctx: { get(name) { return services[name] } },
    registered,
    sections,
    get suppressed() { return suppressed },
    calls,
    files,
    workspaceRoot,
    seed(rel, text) {
      const p = path.isAbsolute(rel) ? rel : path.join(workspaceRoot, rel)
      files.set(path.normalize(p), { text, version: 1, type: 'file' })
      return path.normalize(p)
    },
    readSeed(rel) {
      const p = path.isAbsolute(rel) ? rel : path.join(workspaceRoot, rel)
      const rec = files.get(path.normalize(p))
      return rec ? rec.text : undefined
    },
  }
}

const EXPECTED_TOOLS = [
  'exec_command', 'write_stdin', 'apply_patch', 'request_permissions', 'web_search',
  'view_image', 'sleep', 'update_plan', 'request_user_input', 'get_context_remaining',
  'new_context', 'spawn_agent', 'assign_agent_task', 'send_message', 'followup_task',
  'wait_agent', 'list_agents', 'resume_agent', 'interrupt_agent', 'close_agent',
  'list_tasks', 'task_output', 'task_stop',
  'view_file', 'write_file', 'edit_file', 'glob', 'grep',
]

async function main() {
  const plugin = pluginMod
  ok(plugin, 'plugin module loads')
  eq(plugin.name, 'dsh-kernel-codex', 'plugin.name')
  ok(typeof plugin.apply === 'function', 'plugin.apply is a function')
  ok(Array.isArray(plugin.inject), 'plugin.inject is metadata')

  const h = createHarness()
  await plugin.apply(h.ctx)

  for (const name of EXPECTED_TOOLS) {
    ok(h.registered.has(name), 'registers ' + name)
  }
  eq(h.registered.size, EXPECTED_TOOLS.length, 'expected tool count')

  for (const [name, def] of h.registered) {
    ok(def.output && typeof def.output === 'object', name + ' has output')
    ok(def.output.schema, name + ' has output.schema')
    ok(typeof def.output.render === 'function', name + ' has output.render')
    const rendered = def.output.render({}, 'ok')
    ok(Array.isArray(rendered), name + ' render returns blocks')
  }

  const exec = { agent: { id: 'parent-session' }, signal: new AbortController().signal }
  const spawn_agent = h.registered.get('spawn_agent')
  ok(typeof spawn_agent.isConcurrencySafe === 'function', 'spawn_agent.isConcurrencySafe is a function')
  eq(spawn_agent.isConcurrencySafe(), true, 'spawn_agent.isConcurrencySafe() === true')

  const bg = await spawn_agent.execute({
    task_name: 'smoke_child',
    message: 'do the work',
  }, exec)
  eq(h.calls.startContinuable.length, 1, 'default background calls startContinuable once')
  eq(h.calls.start.length, 0, 'default background does not call start')
  const started = h.calls.startContinuable[0]
  ok(started && started.request, 'startContinuable receives a request')
  deep(
    started.request.agentOptions,
    { provider: 'codex-kernel', model: 'deepseek-v4-flash:0731' },
    'explicit agentOptions',
  )
  ok(typeof started.request.persona === 'string' && started.request.persona.length > 0, 'request.persona set')
  ok(started.request.toolFilter && Array.isArray(started.request.toolFilter.allow), 'request.toolFilter set')
  eq(started.request.maxDepth, 3, 'request.maxDepth is 3')
  match(bg, /codex-child-1/, 'background return text contains durable child id')

  const followup_task = h.registered.get('followup_task')
  const send_message = h.registered.get('send_message')
  const resume_agent = h.registered.get('resume_agent')
  const assign_agent_task = h.registered.get('assign_agent_task')

  const fu = await followup_task.execute({ agent_id: 'codex-child-1', message: 'next step' }, exec)
  eq(h.calls.followup.length, 1, 'followup_task → subagents.followup')
  eq(h.calls.followup[0].childId, 'codex-child-1', 'followup_task child id')
  eq(h.calls.followup[0].blocks[0].text, 'next step', 'followup_task message text')
  match(fu, /codex-msg-1/, 'followup_task mentions message id')

  const sm = await send_message.execute({ agent_id: 'codex-child-1', message: 'via send' }, exec)
  eq(h.calls.followup.length, 2, 'send_message → subagents.followup')
  eq(h.calls.followup[1].blocks[0].text, 'via send', 'send_message text')
  match(sm, /codex-msg-1/, 'send_message mentions message id')

  const ra = await resume_agent.execute({ agent_id: 'codex-child-1' }, exec)
  eq(h.calls.followup.length, 3, 'resume_agent → subagents.followup')
  match(h.calls.followup[2].blocks[0].text, /Continue from where you left off/, 'resume_agent continue prompt')
  match(ra, /codex-msg-1/, 'resume_agent mentions message id')

  await assign_agent_task.execute({ agent_id: 'codex-child-1', message: 'assigned' }, exec)
  eq(h.calls.followup.length, 4, 'assign_agent_task → subagents.followup')

  const interrupt_agent = h.registered.get('interrupt_agent')
  const ir = await interrupt_agent.execute({ agent_id: 'codex-child-1' }, exec)
  eq(h.calls.interrupt.length, 1, 'interrupt_agent calls subagents.interrupt')
  eq(h.calls.interrupt[0].agentId, 'codex-child-1', 'interrupt agentId')
  deep(h.calls.interrupt[0].info, { kind: 'ancestor', agent: exec.agent }, 'interrupt info is ancestor+caller')
  match(ir, /interrupt requested/, 'interrupt confirmation')

  const list_agents = h.registered.get('list_agents')
  const listed = await list_agents.execute({}, exec)
  eq(h.calls.listChildren.length, 1, 'list_agents → subagents.listChildren')
  eq(h.calls.listChildren[0].parentId, 'parent-session', 'listChildren parent id')
  match(listed, /codex-child-1/, 'list_agents includes continuable child')
  ok(!/skip-me/.test(listed), 'list_agents skips non-continuable entries')

  const wait_agent = h.registered.get('wait_agent')
  const waitText = await wait_agent.execute({ targets: ['codex-child-1'] }, exec)
  match(waitText, /not supported|no in-tool wait/i, 'wait_agent is an honest stub')

  const close_agent = h.registered.get('close_agent')
  const closeText = await close_agent.execute({ agent_id: 'codex-child-1' }, exec)
  match(closeText, /not supported|no single-child close/i, 'close_agent is an honest stub')

  const fg = await spawn_agent.execute({
    task_name: 'wait',
    message: 'finish this',
    run_in_background: false,
  }, exec)
  eq(h.calls.start.length, 1, 'foreground calls subagents.start')
  match(fg, /Partial output before the run ended:/, 'foreground max-tokens includes partial-output wording')
  match(fg, /codex partial answer/, 'foreground includes partial child text')

  eq(h.sections.length, 2, 'systemPrompt registers persona + tool section')
  eq(h.sections[0].name, 'deployment:persona', 'persona section name')
  eq(h.sections[0].order, 0, 'persona section order')
  eq(h.sections[0].complete, true, 'persona section is complete')
  ok(typeof h.sections[0].text === 'string', 'persona text is a string')
  eq(h.sections[1].name, 'tool:spawn_agent', 'tool section name')
  eq(h.sections[1].order, 116.5, 'tool section order')
  ok(typeof h.sections[1].text === 'function', 'tool section text is a function')
  ok(h.suppressed, 'runtime context suppressed')

  const apply_patch = h.registered.get('apply_patch')
  const addOut = await apply_patch.execute({
    patch: [
      '*** Begin Patch',
      '*** Add File: hello.txt',
      '+hello world',
      '+second line',
      '*** End Patch',
    ].join('\n'),
  }, exec)
  match(addOut, /Wrote hello\.txt/, 'apply_patch Add File reports write')
  eq(h.readSeed('hello.txt'), 'hello world\nsecond line', 'apply_patch Add File content')

  const updOut = await apply_patch.execute({
    patch: [
      '*** Begin Patch',
      '*** Update File: hello.txt',
      '@@',
      ' hello world',
      '-second line',
      '+updated line',
      '*** End Patch',
    ].join('\n'),
  }, exec)
  match(updOut, /Updated hello\.txt/, 'apply_patch Update File reports update')
  eq(h.readSeed('hello.txt'), 'hello world\nupdated line', 'apply_patch Update File content')

  const view_file = h.registered.get('view_file')
  const viewed = await view_file.execute({ path: 'hello.txt' }, exec)
  match(viewed, /^1: hello world\n2: updated line$/, 'view_file line-numbers content')

  console.log('dsh-kernel-codex smoke: ' + assertionCount + ' assertions ok')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
