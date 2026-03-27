# refresh-lexiang-token

自动刷新 [腾讯乐享](https://lexiangla.com) MCP access_token，确保乐享 MCP 服务不受 token 过期影响。

## 功能

- 🔄 通过 Playwright 自动访问 `lexiangla.com/mcp` 获取最新 token
- 🔍 自动发现本地所有包含乐享 token 的配置文件并批量更新
- 🍪 Cookie 持久化，避免每次都需要手动登录
- 📦 不硬编码任何路径，适配不同的安装环境
- 🔀 跨平台支持（WorkBuddy / OpenClaw / mcporter）
- 🔐 支持 URL query 和 Bearer Header 两种认证方式
- 🌐 支持通过 SSH 推送 token 到远程服务器（适用于无 GUI 的服务器）

## 安装

作为 Agent Skill 使用（WorkBuddy 或 OpenClaw 均可）：

```bash
# WorkBuddy
git clone https://github.com/ajaxhe/refresh-lexiang-token.git \
  ~/.workbuddy/skills/refresh-lexiang-token

# OpenClaw
git clone https://github.com/ajaxhe/refresh-lexiang-token.git \
  ~/.openclaw/skills/refresh-lexiang-token

# 如果两个平台都用，可以在一处安装后创建软链
ln -s ~/.openclaw/skills/refresh-lexiang-token ~/.workbuddy/skills/refresh-lexiang-token
```

### 前置依赖

```bash
npm install -D playwright
npx playwright install chromium
```

## 使用

### 通过 Agent 调用

在 Agent 中直接说：

- "帮我刷新乐享 token"
- "乐享 token 过期了"
- "更新乐享 MCP 配置"

### 手动执行

```bash
# 首次执行（会打开浏览器让你登录）
npx tsx ~/.openclaw/skills/refresh-lexiang-token/scripts/refresh-token.ts

# 后续执行（已有 cookie，无头模式）
npx tsx ~/.openclaw/skills/refresh-lexiang-token/scripts/refresh-token.ts --headless

# 指定额外配置文件
npx tsx ~/.openclaw/skills/refresh-lexiang-token/scripts/refresh-token.ts \
  --config-files "/path/to/config1.json,/path/to/config2.json"

# 刷新后推送到远程服务器（自动发现远程配置文件）
npx tsx ~/.openclaw/skills/refresh-lexiang-token/scripts/refresh-token.ts \
  --headless --push-to "root@your-server"

# 推送到指定的远程配置文件
npx tsx ~/.openclaw/skills/refresh-lexiang-token/scripts/refresh-token.ts \
  --headless --push-to "root@your-server:/root/.mcporter/mcporter.json"

# 同时推送到多台服务器
npx tsx ~/.openclaw/skills/refresh-lexiang-token/scripts/refresh-token.ts \
  --headless --push-to "root@server1,root@server2"
```

## 工作原理

1. 启动 Playwright 浏览器，加载已保存的 Cookie
2. 访问 `https://lexiangla.com/mcp`
3. 如果需要登录 → 以有头模式等待用户手动登录
4. 从 MCP 配置页面提取最新 `access_token` 和 `company_from`
5. 自动扫描并更新所有相关配置文件中的 token

### 自动发现的配置文件

| 文件路径 | 用途 |
|---------|------|
| `~/.workbuddy/mcp.json` | WorkBuddy 全局 MCP 配置 |
| `~/.openclaw/mcp.json` | OpenClaw 全局 MCP 配置 |
| `~/.mcporter/mcp.json` | mcporter MCP 配置（Bearer 认证） |
| `~/.mcporter/mcporter.json` | mcporter CLI 配置（URL query 认证） |
| `~/.workbuddy/skills/*/mcp.json` | 含 "lexiang" 的 skill 配置 |
| `~/.openclaw/skills/*/mcp.json` | 含 "lexiang" 的 skill 配置 |
| `~/clawd/config/mcporter.json` | 项目级 mcporter 配置 |

## 参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--config-files` | 自动发现 | 逗号分隔的配置文件路径 |
| `--cookie-dir` | `<skill>/.cookies` | Cookie 持久化目录 |
| `--headless` | 否 | 无头模式 |
| `--timeout` | 120000 | 超时时间 (ms) |
| `--push-to` | 无 | SSH 推送目标（`user@host` 或 `user@host:/path`，逗号分隔多个） |

## 定时自动刷新（Automation）

推荐配置定时任务，让 Agent 每天自动刷新 token，彻底告别手动操作。

### WorkBuddy 配置方式

在 WorkBuddy 中对 Agent 说：

> "创建一个定时任务，每天 11 点执行 refresh-lexiang-token skill"

Agent 会自动创建 Automation，配置如下：

| 配置项 | 值 |
|--------|-----|
| 名称 | 定期刷新乐享 Token |
| 频率 | 每天 11:00 |
| 调度规则 | `FREQ=DAILY;BYHOUR=11;BYMINUTE=0` |
| 执行命令 | `npx tsx <skill_path>/scripts/refresh-token.ts --headless` |

### 同步到远程服务器

如果你有一台无 GUI 的 Linux 服务器也运行了乐享 MCP（如 OpenClaw），可以用 `--push-to` 参数在刷新后自动将新 token 推送过去：

```bash
# 在定时任务中加上 --push-to
npx tsx <skill_path>/scripts/refresh-token.ts --headless \
  --push-to "root@your-server"
```

**前提条件**：
- 本机到远程服务器的 SSH 免密登录已配置（`ssh-copy-id`）
- 远程服务器上有包含 `lxmcp_` token 的配置文件

**工作原理**：
1. 本机（有 GUI）通过 Playwright 刷新 token
2. 通过 SSH 自动发现远程服务器上的配置文件
3. 通过 SSH + sed 远程替换 token
4. 远程服务器无需安装 Playwright 或浏览器

你也可以根据需要调整频率，比如每天执行多次：

```
# 每天 11:00 和 22:00 各执行一次
对 Agent 说："把乐享 token 刷新频率改成每天 11 点和 22 点"

# 每 6 小时执行一次
对 Agent 说："把刷新频率改成每 6 小时一次"
```

### 手动配置 crontab（非 Agent 环境）

如果不使用 Agent Automation，也可以用系统 crontab：

```bash
# 编辑 crontab
crontab -e

# 每天 11:00 自动刷新（需确保 npx/tsx 在 PATH 中）
0 11 * * * cd /tmp && npx tsx ~/.openclaw/skills/refresh-lexiang-token/scripts/refresh-token.ts --headless --timeout 30000 >> /tmp/lexiang-token-refresh.log 2>&1
```

### 注意事项

- ⚠️ 定时任务使用 `--headless` 模式，**必须已有有效的 cookie**
- 首次使用前，需先手动执行一次有头模式完成登录并保存 cookie
- 如果 cookie 过期导致定时任务失败，需要重新手动执行一次有头模式：
  ```bash
  npx tsx ~/.openclaw/skills/refresh-lexiang-token/scripts/refresh-token.ts
  ```
- Agent Automation 失败时会报告错误，方便及时发现 cookie 过期

## License

MIT
