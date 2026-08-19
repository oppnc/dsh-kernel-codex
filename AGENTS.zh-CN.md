# AGENTS.md — dsh-kernel-codex

面向维护者的 `dsh-kernel-codex` 包文档。本文件解释该包*为什么*被塑造成这个样子、其 schema 从何而来、它如何经受名称冲突的考验，以及它有哪些已知局限——这样未来的维护者（或智能体）就能在无需重新推导每一个决策的情况下修改 `lib/index.js`。

## 概述

`dsh-kernel-codex` 将 **OpenAI Codex CLI 工具集**重新注册为原生 DSH 工具。目标不是去封装 Codex 二进制，而是把 Codex 工具集*直接*在 DSH 服务上*重新实现*——`fs`、`web`、`subprocess`、`jobs`、`subagents`、`planMode`、`sandboxPolicy`、`attachments`、`userQuestions`——从而使相同的名称、schema 与语义在任何模型路由上都可用，包括自定义的 `codex-kernel` 路由。

该包是一个单文件的 Cordis 插件：

```js
export const name = 'dsh-kernel-codex'
export const inject = ['fs', 'tools', 'subprocess', 'web', 'jobs']
export async function apply(ctx) { /* ... */ }
```

只有硬依赖被声明在 `inject` 中——`fs`、`tools`、`subprocess`、`web`、`jobs`（mesh AGENTS.md §2）。其余一切都通过带 `undefined` 守卫的 `ctx.get(...)` 读取，因此即使某个预设缺少某项服务，该包也能挂载（可能功能有所降级）。切勿把未声明的服务当作裸的 `ctx.<name>` 属性来读。以这种方式读取的服务有：`fs`、`tools`、`web`、`planMode`、`subagents`、`sandboxPolicy`、`subprocess`、`jobs`、`attachments`、`userQuestions`、`systemPrompt`。

`apply` 的写法是：仅在两个真正必需的服务缺失时才*提前返回*：

```js
if (!tools || !fs) return
```

每个工具都通过一个宽容的 `register()` 辅助函数注册，且每次注册都在插件 `apply` 纤程内发起即忘（fire-and-forget），因此注销/生命周期由 Cordis 负责，而非由该包负责。

## Schema 来源

这些 schema **并不是**凭对 Codex CLI 的记忆手写的，而是从本地安装的 `@openai/codex` 包提炼出来的：最初对齐 **v0.146.0**，并对照过 **v0.147.0**（2026-08-07；npm `latest`）以及 `rust-v0.148.0-alpha.20` 的 handler 树。这三处的 handler 目录没有新增模型可见工具名。Codex 的 npm 包只是已编译 Rust 二进制的启动器；该工具集是从二进制的内嵌字符串中还原的——具体而言是 `core/src/tools/handlers/*.rs` 的处理器名称及其拼接在一起的名称/描述/参数 blob（逐行证据见原始还原报告）。

已安装的 Codex 版本已经演化，超越了旧工具名（`shell`、`view`、`write`、`edit`、`task`、`todo`、`enter_plan_mode`、`exit_plan_mode`、`skill`）。现代工具集为：

- `exec_command` + `write_stdin` —— 统一的 exec 组合（取代旧的 `shell`）
- `apply_patch` —— FREEFORM 统一 diff 语法（取代 `edit` 用于多 hunk 工作）
- `request_permissions`
- `web_search`
- `view_image`
- `sleep`
- `update_plan` —— todo/checklist 原语（`todo` 的现代替代品）
- `request_user_input`
- `get_context_remaining`
- `new_context`
- 多智能体家族：`spawn_agent`、`assign_agent_task`、`send_message`、`followup_task`、`wait_agent`、`list_agents`、`resume_agent`、`interrupt_agent`、`close_agent`

工具描述忠实于提取出的文本。在旧名称仍适合作为别名之处（`view`/`write`/`edit` → `view_file`/`write_file`/`edit_file` 的映射），描述会明确点出旧名称，使偏好旧词汇的模型仍能找到正确的工具。

关于数量的一点说明：源码注册了 **30 个工具**（`apply` 顶部的 30 次 `register()` 调用），外加两个条件注册——`enter_plan_mode` 与 `exit_plan_mode`——它们仅在 `planMode` 服务存在时发生。这 30 个中有 3 个（`send_message`、`interrupt_agent`、`list_agents`）与 DSH 原生控制工具同名，仅在那些行已经胜出时被跳过（见「名称冲突兜底」）。因此默认挂载暴露 27 或 30 个静态工具，加上 `planMode` 存在时的两个计划模式工具。

## 名称冲突兜底

DSH 自带一些与 Codex 工具集名称重叠的工具——最重要的是智能体控制工具 `send_message`、`interrupt_agent` 与 `list_agents`。这三个的 Codex 版本现在实现的是与 DSH `tool-subagent-control` 行相同的 `subagents.followup` / `subagents.interrupt` / `subagents.listChildren` 管道。两者都注册仍会冲突，必有一方要落败。

该包用**宽容注册**处理此问题。`register()` 辅助函数包装了 `tools.register`，并静默跳过任何错误信息中包含 `'already registered'` 的名称：

```js
const register = (t) => {
  try { tools.register(t) } catch (e) {
    if (String(e).indexOf('already registered') >= 0) return
    throw e
  }
}
```

这意味着该包在*任意*预设中挂载时都无需手工编辑行：冲突的名称被直接丢弃，幸存的那次注册（无论哪一方）胜出而不会抛出异常。当 DSH 原生控制行存在时它们保留这些名称；当它们不存在时，Codex 同名工具仍会交付真实的可续跑 API。

## 实现决策

### `exec_command` —— 统一 exec，底层为 PowerShell

Codex 现代的 `exec_command` 取代了旧的 `shell`。DSH 形式通过 `subprocess.spawn` 用 **PowerShell** 运行命令（与目标 shell 无关）：

```js
let pwshBin = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
try { pwshBin = await subprocess.resolveExecutable('pwsh.exe', {}, exec.signal) } catch {}
```

两条输出路径，由 `run_in_background` 加以区分：

- **前台**通过 `handle.done` 与一个调用 `handle.terminate()` 的 `setTimeout` 之间的 `Promise.race` 来遵守 `timeout_ms`。超时被钳制在 `[3000, 300000]` 毫秒，默认 `60000`。超时时输出追加 `[timed out after Ns]`；否则追加 `[exit code: N]`。
- **后台**（`run_in_background: true`）把该 spawn 包装进一个 `jobs.start` shell 作业。关键之处在于，后台 spawn 创建时**不带** `exec.signal`（`signal` 只在前台分支传入）——因此一次回合中止无法杀死后台进程。只有 `task_stop`（经由作业的 `cancel` 解析为 `handle.terminate()`）才能。这是 Codex 统一 exec 的"延续会话"语义映射到 jobs 服务上的 DSH 形式近似。

`stdio` 为 `{ stdin: 'ignore', stdout: { maxBytes: 1000000 }, stderr: { maxBytes: 100000 } }`。

### `apply_patch` —— FREEFORM 统一 diff 语法

`apply_patch` 是一个 FREEFORM 工具（描述告知模型*不要*把 patch 包进 JSON）。由 `applyPatchGrammar` 实现的语法从二进制中还原：

```
*** Begin Patch                    （必需）
*** Add File: path/to/file         以 "+" 前缀的内容行
*** Update File: path/to/file      @@ 上下文、"+"/"-"/" " 行、可选的 "*** Move to:"
*** Delete File: path/to/file
*** End Patch                      （必需）
```

`applyUpdateHunk` 应用单个 update hunk：它从 `@@ … @@` 上下文的尾部文本（或退而求其次用第一条上下文/删除行）定位锚点，然后依据原文逐行走 `+`/`-`/` ` 操作，当某条删除或上下文行与文件内容不匹配时大声报错。"Move to:" 通过把源内容复制到目标路径再对该路径应用 hunk 主体来实现重命名。"*** End of File"（无尾部换行标记）被接受并忽略，因为 DSH 形式会写尾部换行。

`apply_patch` 的每次写入都把 `sandboxPolicy.resolve({ session })` 作为第 5 个参数传给 `fs.writeText`，因此 patch 编辑会像手动的 `write_file`/`edit_file` 工具一样遵守每次调用的沙箱策略。每个 hunk 独立应用，失败按文件逐一报告（`Failed update path: …`），而不是中止整个 patch。

### 文件原语 —— `view_file` / `write_file` / `edit_file` / `glob` / `grep`

这些镜像自 `dsh-kernel-kimi` 的实现。

- `glob` 与 `grep` 共享一个对 `fs.listDir` 条目的递归遍历。目录条目通过 `e.target` 递归（`listDir` 已解析好），文件按相对路径收集。遍历会跳过 `node_modules`、`.git`、`.dsh`、`.venv`、`__pycache__` 与 `dist`。
- `grep` 将文件大小上限设为 **512 KiB**，且可先检查 `fs.stat` 来指向单个文件路径（若 `rootInfo.type === 'file'`，则只 grep 那一个文件）。它用 `new RegExp(...)` 编译模式，支持三种 `output_mode`：`files_with_matches`（默认）、`content` 与 `count_matches`，外加一个 `glob` 过滤器。它**没有** `-B/-A/-C` 上下文标志——Codex 的 `grep_local` 不需要它们。
- `glob` 返回最多 1000 个排序后的匹配，并共享 `globToRegex`（处理 `*`、`**`、`?` 与 `{a,b}` 多选一）。
- `write_file`（覆盖/追加）与 `edit_file`（经由 `fs.editText` 的精确旧→新替换，含 `replace_all`）都把每次调用的沙箱策略作为写入策略传入。

### 工作目录 —— `cwdOf`

`cwdOf(exec)` 优先使用会话沙箱策略的工作区根目录，依次回退三个层级：

```js
policy = policyFor(exec)                 // sandboxPolicy.resolve({ session: exec.agent.session })
if (policy.workspaceRoot is string) ...  // 每会话根目录
else if (sandboxPolicy.workspaceRoot) ...// 共享根目录
else process.cwd()                       // 最终回退（随后是作为最后手段的 'C:\\'）
```

### 计划模式 —— `enter_plan_mode` / `exit_plan_mode`

这两个**仅在** `planMode` 存在时注册，这就是为什么该行*必须*位于预设的 planning 分组内。它们是 DSH `planMode` 服务之上的 Codex 兼容别名：`enter_plan_mode` → `planMode.set(exec.agent, true)`，`exit_plan_mode` → `planMode.set(exec.agent, false)`。值得注意的是，已安装的 Codex 0.146.0 **并不**把计划模式建模为 enter/exit 对——它用 `update_plan` 做计划——因此这对别名是面向学过旧 enter/exit 词汇的模型的兼容便利。

### 多智能体家族 —— `spawn_agent` 对齐库存 `subagent` 工具

`spawn_agent` 在原生可续跑路由上以后台优先，与 kimi 的 `Agent`、grok 的 `task` 以及库存 `subagent` 工具（`backgroundMode: 'continuable'`）完全一致：

- **后台是默认**（`run_in_background !== false` → `subagents.startContinuable`）。调用在收件箱接受时返回一个持久子智能体 id。运行时自行投递结算通知（结果 + 最终助手消息）。
- **`run_in_background` 是 DSH 形式对 Codex CLI schema 的补充**（默认 `true`），以便模型可以选择一次性等待。其余参数名（`task_name`、`message`、`agent_type`、`model`、`reasoning_effort`、`fork_turns`）保持与 Codex 工具集一致。`reasoning_effort` 与 `fork_turns` 仅为 schema 对等而接受，不会映射到子请求上；子会话始终是全新对话。
- **`agent_type` 映射到上游 Codex 角色**（`codex-rs/core/src/agent/role.rs`）：`explorer` → `codex-explore`，`worker` → `codex-worker`，省略/其他 → `codex-agent`（`default` 角色）。上游 `explorer.toml` 为空、`worker` 无配置文件，因此**任何角色都不改变子智能体的提示词或工具**——每个角色都运行完整 Codex 基础提示词 + 全量工具集。角色描述只用于指导父智能体选择，写在 `agent_type` 参数描述里。
- **每次请求都显式设置 `agentOptions` / `persona` / `toolFilter` / `maxDepth: 3`**，因为可续跑路由从不调用 `provider.start()`（mesh AGENTS.md §3.2）。`agentOptions` 为 `{ provider: recipe.provider, model: args.model || recipe.model }`；`persona` 与 `toolFilter` 来自 `lib/subagents.js`（与 mesh 共享的唯一真源）。
- **提供者优先级**是已列出时的配方名（`codex-agent` / `codex-explore` / `codex-worker`），然后是 `codex-agent`，再然后是 `spawn`。
- **前台**（`run_in_background: false`）等待 `subagents.start`，并在非 `completed` 停止时追加 `"Partial output before the run ended:"` 加上子智能体文本——原生措辞（`stopReasonError` + `withPartialText`）。
- 该工具声明 **`isConcurrencySafe: () => true`**，并注册一个 **`systemPrompt` 段落**（`tool:spawn_agent`，顺序 `116.5`），在工具可见时教授后台优先约定。

有干净映射的家族工具接到真实的 `subagents` 服务；其余保持诚实的桩：

| 工具 | 映射 |
| --- | --- |
| `assign_agent_task` | `subagents.followup` |
| `send_message` | `subagents.followup`（可选 `interrupt=true` → 先 `subagents.interrupt`） |
| `followup_task` | `subagents.followup` |
| `resume_agent` | `subagents.followup`，带一条通用继续提示 |
| `interrupt_agent` | `subagents.interrupt`（`{ kind: 'ancestor', agent: caller }`） |
| `list_agents` | `subagents.listChildren`（Codex 的 `path_prefix` 过滤 label/id） |
| `wait_agent` | 诚实的桩——没有工具内等待；运行时通知才是结算通道 |
| `close_agent` | 诚实的桩——`drainContinuableDescendants` 是父级拆除整棵森林，不是单个子智能体关闭 |

### 后台任务管理 —— `list_tasks` / `task_output` / `task_stop`

这些是 `exec_command` 后台模式的配套，由 DSH `jobs` 服务支撑。`list_tasks` 默认过滤为 running/stopping；`task_output` 可选地通过 `jobs.wait` 阻塞；`task_stop` 解析为 `jobs.kill`（最终是 `handle.terminate()`）。它们让模型能够用 `exec_command run_in_background: true` 启动一个长 shell 作业，之后轮询或停止它——这是 Codex 持久 exec 会话在 DSH 上最接近的对应物。

## DSH ToolDefinition 契约

每个工具都是一个普通对象，带 `name`、`description`、`parameters`（一个类 JSON-Schema 对象，`type: 'object'` 加 `properties`/`required`）以及一个 `execute(args, exec)` 异步函数。`strDef()` 规范化字符串型工具：

```js
const strDef = (t) => {
  t.output = {
    schema: { type: 'string' },
    render: (a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }],
  }
  return t
}
```

`view_image` 是唯一带自定义输出的工具：它返回 `{ ok, attachment }`，其渲染器在存在附件时发出一个 `image` 块，否则发出文本块。`exec` 提供 `agent`、`signal`，以及 `policyFor` 与 `cwdOf` 所需的 agent/session；中止信号经由 `exec.signal` 流动（被 `sleep`、前台 `exec_command`、`fs` 调用以及 `abort` 监听器模式使用）。

所有副作用（注册）都位于插件 `apply` 纤程之内，因此停止/取消定义插件会通过 DSH 的正常生命周期移除每一个工具。

## 已知缺口

- **`write_stdin`** —— 不受支持。DSH 在工具调用之间没有长寿命的 exec 会话句柄；该工具返回一条建议改成单次 `exec_command` 调用的说明。
- **`new_context`** —— 不受支持。上下文窗口由 harness 管理，无法编程重置。
- ~~**多智能体桩**（除 `spawn_agent` 外的所有）。~~ **已解决**（mesh 缺口 #5）。`spawn_agent` 在原生可续跑路由上以后台优先（`subagents.startContinuable`）：省略 `run_in_background`（或设为 true）会返回一个持久子智能体 id，`list_agents` / `send_message` / `interrupt_agent` / `followup_task` / `resume_agent` / `assign_agent_task` 都在其上操作，与库存 `subagent` 工具完全一致。仅在下一步依赖该结果时才设 `run_in_background: false`。见上文多智能体实现说明。`wait_agent` 与 `close_agent` 仍是诚实的桩（没有工具内等待；没有单个子智能体关闭）。
- **`request_permissions`** —— 报告当前策略（`danger-full-access` 或 `workspace-write (root: …)`）而非弹出提示，因为 DSH 文件策略是按会话而非按请求的。
- **`view_image`** —— 仅限图片：PNG/JPEG/WebP/GIF，读取上限 20 MiB；无法渲染非图片文件。
- **`web_search`** —— 委托给 DSH 的 `web` 服务（`web.search`），而非 Codex 的引擎。
- **`update_plan`** —— 一个按智能体 id 为键的插件本地 todo 存储（`planStore = new Map()`，键为 `exec.agent.id`）；它仅存活于进程生命周期，不持久化。
- **`get_context_remaining`** —— 报告 `remaining_tokens: null` 并附说明，因为 DSH 不暴露 token 计数服务。
- **`sleep`** —— 使用一个可取消的 Promise：一个 `setTimeout`，其定时器会经由 `exec.signal` 上的 `abort` 监听器清除（因此回合中止会提前 resolve，而不是泄漏定时器）。
- **`grep`** —— 没有 `-B/-A/-C` 上下文标志；Codex 的 `grep_local` 不需要它们。
- **后台 `exec_command`** —— 不带 `exec.signal`，因此回合中止无法杀死它；只有 `task_stop` 才能。

### 本工具集曾经继承的 mesh 缺口（现已在上游解决）

这些曾存在于 `dsh-kernel-mesh`，**不是**本包的开放工作。当前事实见 mesh AGENTS.md §7：

- **§7.1 Kimi thinking 签名旁表** —— 仍被上游阻塞（本工具集没有 Kimi 传输）。
- **§7.2 Grok reasoning 回放形状** —— 仍被上游阻塞（本工具集没有 Grok 传输）。
- **§7.3 MiniMax 需要 API key** —— 仍被上游阻塞（本工具集没有 MiniMax 传输）。
- **§7.4 `loop_control` 没有 DSH 旋钮** —— 仍被上游阻塞（`agentLoop` 只暴露 `maxParallelToolCalls`）。
- ~~**§7.5 可续跑子智能体路由。**~~ **已在 mesh 中解决**；本包的 `spawn_agent` 将该路由作为默认消费（见上文）。
- ~~**§7.6 非流式传输。**~~ **已在 mesh 中解决**：两个适配器工厂现在都流式传输真实 SSE（`stream: true`，curl `-N`），并在提供方忽略流式时自动回退到 JSON。本工具集没有自己的传输。
- **§7.7 Responses 线路图片被跳过** —— grok/codex 适配器仍被上游阻塞（本工具集的 `view_image` 是本地附件，不是线路图片路径）。
- ~~**未分类的适配器错误。**~~ **已在 mesh 中解决**：适配器抛出带规范自有属性码（`e.code` + `e.failure`）的错误，因此 `dsh-llm-retry` 会重试 `RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT`。本工具集不抛出适配器错误。

## 测试说明

- **语法/校验：** `node --check lib/index.js` —— 该插件是纯 ESM JavaScript，无构建步骤，所以这是第一个也是最廉价的检查。
- **注册冒烟测试：** 先在启用冲突 DSH 行的预设中挂载该包，再在禁用它们的预设中挂载，确认宽容的 `register()` 逻辑产生预期的工具集（不出现"already registered"异常；三个原生控制名称已经胜出时是 27 个静态工具，否则是 30 个——`planMode` 存在时再加两个计划模式工具）。
- **`spawn_agent` 冒烟测试：** `/tmp/kernel-surfaces-smoke-codex.js`（与 kimi/grok 套件相同的 mock-ctx 模式）。它断言插件加载；后台默认 → `startContinuable` 带显式 `agentOptions`/`persona`/`toolFilter`/`maxDepth: 3` 并返回持久 id；`followup_task` / `send_message` / `resume_agent` → `subagents.followup`；前台部分输出措辞（`Partial output before the run ended:`）；`isConcurrencySafe`；以及 `tool:spawn_agent` systemPrompt 段落。
- **功能检查：** 通过 `codex-kernel` 预设逐一演练这些工具——`exec_command`（前台超时与后台 + `task_stop`）、`apply_patch`（add/update/delete/move hunk 与匹配失败路径）、`glob`/`grep`（跳过目录与 512 KiB 上限行为）、`view_file`/`write_file`/`edit_file`（沙箱策略写入）、`request_user_input`、`spawn_agent`（后台默认、跟进与 `run_in_background: false`），以及对真实 PNG/JPEG 的 `view_image`。
- **任何改动后需重新验证的边界情况：** `exec_command` 的 3 秒/300 秒超时钳制、`applyUpdateHunk` 在无 `@@` 上下文时的锚点定位回退，以及 `cwdOf` 的三级回退。

## 布局

```
dsh-kernel-codex/
├── lib/index.js        # 插件（单文件 ESM；30 个工具 + 2 个条件计划模式工具）
├── package.json        # v0.1.2，type:module，MIT，仓库 oppnc/dsh-kernel-codex
├── LICENSE             # MIT，Copyright (c) 2026 oppnc
├── README.md           # 简短的人类友好英文 README
├── README.zh.md        # README.md 的中文翻译
├── README.i18n.yaml    # 双语配对的 git blob hash
├── AGENTS.md           # 本文件（详尽维护者文档，英文）
└── AGENTS.zh-CN.md     # AGENTS.md 的中文翻译
```
