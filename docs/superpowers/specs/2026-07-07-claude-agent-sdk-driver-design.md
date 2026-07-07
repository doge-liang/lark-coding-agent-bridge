# 设计：Claude 对接升级为 Agent SDK 驱动（分阶段，终点长驻会话）

- 日期：2026-07-07
- 状态：已批准（待写实现计划）
- 作用范围：`src/agent/claude/`、`src/agent/types.ts`、`src/runtime/run-executor.ts`、`src/bot/active-runs.ts`、`src/bot/channel.ts`、卡片层、相关测试

## 1. 背景与动机

当前 Claude 对接以 headless 一次性模式驱动本地 `claude` CLI：每轮消息 `claude -p <prompt> --output-format stream-json --verbose --permission-mode bypassPermissions --append-system-prompt … [--resume <sessionId>] [--model …]`，一轮一进程，靠 `--resume` 续话（见 `src/agent/claude/adapter.ts`）。

这种模式拿不到 Claude Code 的若干新能力。经核查（Claude Code 官方文档），四项目标能力中：

- **交互审批** 与 **中途转向** 在 CLI 双向流模式下天生做不到——stdin 协议未公开，且不暴露权限回调。
- 只有 **Claude Agent SDK**（`@anthropic-ai/claude-agent-sdk`，`query()`）能同时满足四项：`canUseTool` 审批回调、streaming input 异步生成器（长驻会话 + 中途转向）、hooks/skills/MCP 原生加载。

因此驱动层换用 Agent SDK。

## 2. 目标与非目标

**目标（按落地顺序）**
1. 交互审批（`canUseTool`）——危险/未知工具在飞书卡片里放行或拒绝。
2. skills / hooks / MCP 高保真加载。
3. 长驻会话——进程跨轮存活、保留进程内上下文。
4. 真中途转向——run 执行中注入新指令重定向，而非排队到下一轮。

**非目标**
- 不改 Codex 适配器。
- 不改认证模型：继续复用 `~/.claude` 环境态凭据与 `claude.env` profile 覆盖。
- 不做多用户 token 隔离——本 bridge 为**个人自用**（单人、单订阅、合理频率）。

## 3. 驱动与认证

- 新增 `ClaudeSdkAdapter`（`src/agent/claude/`），基于 `@anthropic-ai/claude-agent-sdk` 的 `query()`。
- `pathToClaudeCodeExecutable` 指向用户**已安装的 `claude`**，而非 SDK 自带二进制——与项目现有 preflight、版本检测、`/upgrade` 保持一致，驱动用户实测过的同一个 claude。
- **认证不变**：SDK 所用二进制读同一份 `~/.claude` 凭据；无 `ANTHROPIC_API_KEY` 时回退到 `/login` 写入的 `~/.claude/.credentials.json`（订阅 OAuth）。`claude.env` profile 可注入 `CLAUDE_CODE_OAUTH_TOKEN`。订阅计费不受影响。

### 3.1 无回退决策与去风险

用户明确要求**不保留** CLI 适配器作为回退、**不引入** `claude.driver` 开关——以 SDK 实现直接替换旧 `ClaudeAdapter`。因此去风险不再依赖运行时开关，而是靠以下三条腿：

1. **测试对等**：SDK 适配器针对旧适配器的既有行为做对等测试（事件翻译、错误路径、流式收尾）。
2. **删除次序**：**先让 SDK 适配器达到行为对等、再删除 CLI 适配器**，绝非先删后建。旧 `tests/process/claude-adapter.test.ts` 随之重写为 SDK 适配器测试。
3. **分阶段**：Phase 1（审批，改动小）先行验证，Phase 2（长驻 + 转向，改动大）单独灰度。

（本节不再出现任何 `claude.driver` / CLI 回退开关的表述。）

## 4. 契约扩展（`src/agent/types.ts`）

新增两类事件与两个**可选**控制方法；Codex 适配器不实现即可，翻译层不受影响。

- `AgentEvent` 新增：
  `{ type: 'permission_request'; id: string; toolName: string; input: unknown; suggestedAction?: 'allow' | 'deny' }`
- `AgentRun` 新增可选方法：
  - `respondPermission?(id: string, decision: 'allow' | 'deny', opts?: { updatedInput?: unknown }): void`
  - `steer?(text: string): void`（Phase 2）
- 翻译层把 SDK 的 `SDKMessage` 流映射到现有 `AgentEvent`（system/text/thinking/tool_use/tool_result/usage/done/error），与现有卡片渲染零改动对接。

### 4.1 stop() 语义改变

现适配器的 `stop()` 走 SIGTERM→SIGKILL + `waitForExit`（信号级）。SDK 不再以信号停止，`AgentRun` 控制面**在 abort 语义上重新实现**：以 `AbortController` / query `interrupt()` 停止。`waitForExit` 相应改为等待 query 迭代结束。实现计划阶段须以 SDK 出厂 TypeScript 类型为准确认具体 API。

## 5. Phase 1 —— SDK 驱动 + 交互审批（每轮一跑，`resume` 续话）

每轮 `query({ prompt, options: { resume: sessionId, canUseTool, pathToClaudeCodeExecutable, appendSystemPrompt, permissionMode } })`。run-executor / active-runs 的"一轮=一 run"模型**不动**。

### 5.1 审批策略（`canUseTool`）

- **白名单自动放行、其余一律询问**（而非危险黑名单）：已知安全只读工具（Read/Grep/Glob/LS 等）自动 `allow`；其余（Bash/Write/Edit/MultiEdit/NotebookEdit/WebFetch 及**未知/MCP 工具**）→ 发 `permission_request` 事件。
  - *理由*：白名单让新出现的工具默认走审批，不会漏放行；黑名单会随工具演进漏项。
- 卡片渲染放行/拒绝按钮。按钮回传经 `CallbackNonceStore` 校验 nonce 防重放 → 按 scope 取 `ActiveRuns.get(chatId).run.respondPermission(id, decision)`。

### 5.2 审批的 promise 桥接（Phase 1 的真正难点）

`canUseTool` 是**阻塞 SDK 进度的异步回调**，但决策从**完全独立的通道**（卡片按钮 → dispatcher → `respondPermission`）回来。因此适配器内部维护一个**按 permission `id` 键控的 pending promise 注册表**：

- `canUseTool` 触发时：生成 `id`，emit `permission_request` 事件，**返回一个挂起的 promise**，并登记到注册表。
- `respondPermission(id, decision)`：从注册表取出并 resolve 对应 promise，返回 `{ behavior: 'allow' | 'deny', … }`。
- **超时归属**：计时器由**适配器**持有。等待 N 分钟（profile 可配，默认 5 分钟）无回传 → 按 `deny` resolve，让该轮安全收尾。
- **停止/中断时的强制收尾（必须写死）**：当 run 在等待某个 permission 期间被 `stop()`/`interrupt()`，所有**挂起的 permission promise 必须被强制 resolve（按 deny）**，否则 SDK 迭代永久挂起、进程泄漏。这一条与现适配器对退出路径的谨慎处理同级，是最容易被忽略然后咬人的地方。

### 5.3 Phase 1 退出标准

- 审批三条路径（allow / deny / 超时 deny）全部有测试覆盖，且停止期间挂起 promise 被强制收尾。
- **流式收尾对等**：现有卡片流式收尾逻辑（见近期提交 `send final reply for long lark streams`、`fallback final markdown on stream stall`、`cap markdown stream length`）是**对着 CLI 的事件时序精调过的**——尤其是 `result`/done 相对最后一段 assistant 文本的到达时机。SDK 的终止事件时序与收尾语义不同，须显式**重新验证 stall 兜底与 final-reply 触发**。（按 message-step 的分块渲染两侧一致，风险在收尾/stall 处理，不在 token 级流式。）
- skills / hooks / MCP 在 SDK 下加载并生效。

## 6. Phase 2 —— 长驻流式会话 + 真转向

### 6.1 入场门（先验证再开工）

Item 4（真中途转向）是四项里 SDK 支持**最不确证**的一项——核查显示 streaming input 可 queue/interrupt，但"是否在**单轮执行中**被 Claude 看到并重定向，还是只能在**轮次之间**排队"文档未讲透。**Phase 2 开工前须先用最小实验确认 SDK 确实做到 mid-turn steering**；若仅能 between-turn 排队，则退回沿用现有排队语义并据实调整本节。

### 6.2 设计（门通过后）

- 每个对话 scope 维持一个长驻 `query()`，输入用异步生成器，进程跨轮存活。
- **转向**：run 活跃时用户再发消息 → `handle.run.steer(text)` 把消息 yield 进生成器，不再一律排队到下一轮。
- **生命周期**：新增 `ClaudeSessionRegistry`，负责 scope→长驻会话映射、空闲超时驱逐、并发上限（与 `ProcessPool` 协调）。`RunExecutor`/`ActiveRuns` 改为"进程生命周期与单轮解耦"：一个长驻会话下可串行多轮。
- 波及 `run-executor`、`active-runs`、`channel.ts`、卡片层，单独灰度验证。

## 7. 测试策略

- 沿用 `tests/process/` 的 fake-executable / fake-agent 模式：给 SDK 适配器做可注入的 fake `query`（或 fake claude 二进制），断言：
  - 事件翻译（SDKMessage → AgentEvent）；
  - 审批 allow / deny / 超时 deny 三条路径，及停止期间挂起 promise 的强制收尾；
  - stop() 的 abort 语义；
  - Phase 2：转向与会话驱逐。
- `tests/static/contracts.test.ts` 补充新事件类型与新方法的契约。
- 重写 `tests/process/claude-adapter.test.ts` 为 SDK 适配器测试（对齐旧行为的对等断言）。

## 8. 风险

- **ToS 灰色地带**仅在"多人共用一个订阅"时才实质相关；个人自用不触及。若日后转为多人/商用，需每人各自 `setup-token` 或改走 API key，并向 Anthropic 确认 bridge 架构合规。
- **无回退网**：靠 §3.1 三条腿（测试对等 / 达到对等后再删旧适配器 / 分阶段）承担。
- **流式收尾时序**：§5.3 列为 Phase 1 退出标准显式验证。
- **mid-turn steering 不确证**：§6.1 列为 Phase 2 入场门。

## 9. 实现计划阶段须先做的事

在 writing-plans 固定具体 API 调用（`canUseTool` 签名、`includePartialMessages`、`interrupt()`、`resume` 等）之前，**以 SDK 出厂 TypeScript 类型为准**核对，而非仅依赖文档——本轮文档研究已出现过一次反转（SDK 认证从"仅 API-key"更正为"支持订阅 token"）。
