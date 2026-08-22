[English](README.md) | 中文

# dsh-kernel-codex

DSH 有个很朴素的想法：**一切都是插件**。模型是插件，工具是插件，子代理也是插件，想怎么拼就怎么拼。

顺着这个思路，我们把 **OpenAI Codex CLI 写成了 DSH 插件**。你熟悉的 codex 工具面——`exec_command`、`write_stdin`、`apply_patch`、`request_permissions`、`web_search`、`view_image`、`sleep`、`update_plan`、`request_user_input`、`get_context_remaining`、`new_context`、`spawn_agent` 那一大家子多代理工具、`list_tasks`/`task_output`/`task_stop` 后台任务管理，还有 `view_file`/`write_file`/`edit_file`/`glob`/`grep` 文件操作——一共 30 个工具，现在就是 DSH 的原生工具，名字一样、schema 一样、行为一样。

好处很简单：在 DSH 里原生使用 Codex CLI 这套工具，和直接打开 Codex **没有任何区别**。每个模型都待在自己最熟悉的环境里，不管是主 agent 还是 subagent，感觉就像回家一样。

对齐 `@openai/codex` **0.147.0**（稳定版）。0.148 系列仍是 alpha，handler 名称未变。

## 系统提示词与子代理

`lib/system-prompt.js` 携带完整的上游 **Codex** prompt（`gpt_5_2_prompt.md`；
gpt-5.6 系列模型复用它）。`apply()` 把它注册为 agent 唯一的 system-prompt 段
（`complete: true` + `suppressRuntimeContext()`）。

Codex 自己的计划模式是 `update_plan`（它会写 `todo/write` 事件，让计划通过 DSH
的 `todos` 投影渲染）；没有 DSH 的 `enter_plan_mode` / `exit_plan_mode` 对。

`lib/subagents.js` 提供 `codex-agent`、`codex-explore` 和 `codex-worker`（Codex 内置的
`default`、`explorer` 与 `worker` 角色）。mesh 会加载它们，并在每个子代理上以
`config.tools` 白名单挂载本插件。

## 安装

1. 用官方插件命令把本包装进你的 profile：

   ```sh
   dsh plugin --profile web add github:oppnc/dsh-kernel-codex
   ```

   本包是普通插件（没有 `dsh.bundle` 声明），`dsh plugin` 会把它作为不激活的依赖安装——这是预期行为：下面的预设行会按名字引用它。

2. 安装 `codex-kernel` agent 预设：把它的目录复制到 `~/.dsh/.agent-presets/codex-kernel/`。随附的预设已经包含 `codex-surface` 行；如果你自己写预设，就加上这一行（预设也会替你禁用冲突的 DSH 行 `tool-fs-search`、`tool-web`）：

   ```yaml
   - id: codex-surface
     name: dsh-kernel-codex
   ```

   `send_message`、`interrupt_agent`、`list_agents` 与 DSH 原生控制工具同名：若那些行已经注册了这些名字，Codex 会跳过；否则 Codex 同名工具会交付相同的可续跑 `subagents` API。

## 使用

选 **codex-kernel** 预设和 **codex-kernel** 模型路由。Codex CLI 那套工具就挂在当前路由跑的模型上了。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
