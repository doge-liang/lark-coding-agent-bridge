# Phase 2 入场门实验：mid-turn steering 判定

**日期：** 2026-07-07
**结论：** (b) 仅轮间排队 —— streaming input **不支持**真 mid-turn steering。Phase 2 退回排队语义，按 spec §6.1 降级；`priority:'now'` 作为“抢占（打断当前轮 + 新起一轮）”路径记录备用。

## 环境与版本

- SDK `@anthropic-ai/claude-agent-sdk` **0.3.202**
- `claude` **2.1.202 (Claude Code)**，路径 `/usr/bin/claude`
- node **v20.20.2**

## 实验命令

脚本：`/root/.claude/jobs/8a337e3b/tmp/steering-gate.mjs`（job 临时目录，未提交）。
从 worktree 根目录运行（裸导入解析需要）：

```bash
# 基础（默认 priority）
node /root/.claude/jobs/8a337e3b/tmp/steering-gate.mjs
# 抢占变体
STEER_PRIORITY=now node /root/.claude/jobs/8a337e3b/tmp/steering-gate.mjs
```

脚本发第一条 user 消息「从 1 慢数到 30」，8s 后（注入前当轮尚在执行）注入第二条「STOP counting，只说 PIVOT」。
判据：注入是否让**同一轮**输出中途转向（(a) 一轮内 pivot），还是**数完/另起一轮**才 PIVOT（(b) 排队）。

**脚本适配说明（与 brief sketch 的差异，仅为可运行）：** 以绝对路径导入 `sdk.mjs`；
去掉 `permissionMode:'bypassPermissions'` / `allowDangerouslySkipPermissions`——**root 身份**下 claude 拒绝
`--dangerously-skip-permissions`（stderr: `cannot be used with root/sudo privileges`），而数数任务不用任何工具、无审批弹窗；
加 `pathToClaudeCodeExecutable:'/usr/bin/claude'`。

## 原始观察（截断）

### 运行 1：默认 priority — 排队

日志 `steering-gate-run1.log`：

```
>>> [+8.1s] injecting steering message (priority=default)
--- [+9.7s] assistant msg #2 ---
1 2 3 ... 29 30            (完整数到 30，未转向)
>>> [+9.7s] result #1: num_turns=1 assistantMsgs=2 is_error=false
--- [+14.7s] assistant msg #3 ---
PIVOT
>>> [+14.7s] result #2: num_turns=1 assistantMsgs=3 is_error=false
```

注入在 +8.1s（当轮输出 +9.0s 才开始，即注入时当轮**未完成**），可第一轮仍**完整数到 30**；
PIVOT 作为**独立第二轮**出现。**两个 result，各 `num_turns=1`**——不是一轮吸收两条消息。

### 运行 2：`priority:'now'` — 抢占并另起一轮

日志 `steering-gate-run2-priority-now.log`：

```
--- [+8.1s] assistant msg #2 ---
1 2 3 4                     (当轮被截断在 4，未数到 30)
>>> [+8.1s] result #1: num_turns=1 assistantMsgs=2 is_error=false subtype=success
--- [+13.8s] assistant msg #3 ---
PIVOT
>>> [+13.9s] result #2: num_turns=1 assistantMsgs=3 is_error=false subtype=success
```

`priority:'now'` **打断**当前轮（本次干净截断在「4」，`subtype=success`；另一次注入更早时当轮以 `is_error=true`、0 条 assistant 消息中止），
随后 PIVOT 仍作为**单独第二轮**运行。同样是**两个 result、各 `num_turns=1`**。

## 判定

- (a) 真 mid-turn steering **不成立**：两种模式都没有“单轮内输出从计数 pivot 到 PIVOT、`num_turns` 反映单一流程”的现象；始终是两个独立 result。
- 默认 = **轮间排队**：第一轮跑完，注入消息作为独立下一轮执行。
- `priority:'now'` = **抢占**：取消/截断当前轮，注入消息**新起一轮**——非“同轮改写”。

**时序说明（不夸大）：** 注入落在当轮**起点附近**（模型忽略「slowly」、把 1–30 几乎原子吐出；无工具轮无法拉长），
即测的是“注入于轮开始前后”，结果**仍排队**。“两个独立 result”这一形态与精确时序无关，足以判定排队。

## 对 Phase 2 的影响

按 **spec §6.1** 采用排队语义（steer 消息进队列、下一轮生效），不按 §6.2 的同轮改写设计。
若需“打断当前轮立即改向”，唯一可用机制是 `priority:'now'`（抢占 + 新轮），须按“取消当前轮 + 新轮”而非“同轮 redirect”实现与文档化。
