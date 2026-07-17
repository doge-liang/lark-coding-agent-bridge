# Phase 1b 真机冒烟 checklist

前置：`pnpm build` 后以本分支启动 bridge（`node bin/lark-channel-bridge.mjs run` 或已装的全局命令指向本仓库 dist）；确认 `claude --version` ≥ 支持 `--permission-mode auto`（`claude -p "hi" --permission-mode auto` 不报 unknown mode 即可；不支持则在 profile 配 `permissions.claude.permissionMode: "bypassPermissions"` 回退并中止本 checklist，回报版本号）。

## A. 流式对等（full → auto，默认配置）
- [ ] 发一条普通消息（如"介绍一下这个项目"），流式卡片正常增量更新、正常收尾（无 stall、无重复 final 消息）。
- [ ] 发一条会触发工具的消息（如"列出当前目录文件"），工具调用在卡片上可见，Read/LS 类操作不弹审批卡。
- [ ] 观察是否出现"⛔ 工具 X 被自动拒绝"注记（auto 分类器拒绝路径）；若出现，确认 claude 有后续应对而非静默中断。

## B. 审批全流程（read-only 或 workspace 访问模式）
配置 `permissions.defaultAccess: "workspace"` 重启，或临时把 `claude.approvalTimeoutMinutes` 设为 1 便于测超时。
- [ ] 让 claude 执行一个写操作（如"创建文件 test.txt 内容 hello"）：弹出独立审批卡片，标题为 claude 生成的提示句，含放行/拒绝按钮与超时提示。
- [ ] 点击【放行】：卡片原地变为"✅ 已放行"，run 继续并完成写入。
- [ ] 再触发一次，点击【拒绝】：卡片变"🚫 已拒绝"，claude 收到拒绝并调整。
- [ ] 再触发一次，不操作等超时：卡片变"⏱ 超时自动拒绝"，run 安全收尾。
- [ ] 审批等待期间（约 1 分钟）确认空闲看门狗未误杀 run。
- [ ] 触发审批后立即 /stop：卡片变"⏹ 运行已结束，自动拒绝"。

## C. 安全路径
- [ ] 同一审批按钮点击两次：第二次无效果（nonce 一次性）。
- [ ] （有条件时）另一账号点击审批按钮：被拒绝（token 绑定发起人）。
- [ ] 文本输入 `/perm allow xxx`：收到"仅支持通过审批卡片按钮"的拒绝回复。

结果回报：全部通过 → Phase 1b 可合并；任何一条失败 → 记录现象与 bridge 日志（`~/.lark-channel/logs/`）回报。
