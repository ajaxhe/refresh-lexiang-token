---
name: refresh-lexiang-token
description: "自动刷新乐享 MCP access_token。通过 Playwright 访问 lexiangla.com/mcp 获取最新 token，并动态更新所有相关配置文件（支持 OpenClaw、Hermes、WorkBuddy 本地和远程），确保乐享 MCP 服务不受 token 过期影响。"
description_zh: "自动刷新乐享 MCP Token"
description_en: "Auto-refresh Lexiang MCP access_token via browser automation"
version: "3.0.0"
homepage: https://github.com/ajaxhe/refresh-lexiang-token
metadata: {}
---

# 乐享 Token 自动刷新

> **触发场景**：当用户提到「刷新乐享 token」「乐享 token 过期」「更新乐享配置」「lexiang token」，或在使用乐享 MCP 时遇到认证失败（401/403/token expired）时，使用本 Skill。

---

## 工作原理

本 Skill 使用**三层浏览器策略**自动获取乐享 MCP token，按优先级依次尝试：

```
策略1: CDP 连接已运行的 Chrome
  │     （需 Chrome 以 --remote-debugging-port 启动）
  │     ✅ 复用完整登录态，无需重新登录
  ↓ 失败
策略2: Playwright Chromium + 从系统 Chrome 导入 cookie  ← 推荐默认方案
  │     （使用 browser_cookie3 库读取 Chrome cookie）
  │     ✅ 复用 Chrome 登录态，无需重新登录
  │     ✅ Chrome 正常运行即可，无需特殊启动参数
  ↓ 失败
策略3: Playwright Chromium + 已保存的 cookie 文件
  │     （从 .cookies/ 目录读取之前保存的 cookie）
  │     ⚠️ cookie 可能过期，需手动登录一次
  ↓
提取 token → 更新配置文件 → 可选推送到远程服务器
```

---

## 初始化（首次使用必须）

```bash
SKILL_DIR="<本 skill 的实际安装路径>/scripts"
npx tsx "$SKILL_DIR/refresh-token.ts" --init
```

初始化向导会自动完成：

1. **扫描本地安装**：检测 OpenClaw、Hermes、WorkBuddy 是否已安装
2. **检查乐享 Skill**：扫描各平台的乐享知识库 Skill 是否已安装
   - 如果未安装，提示访问 https://lexiangla.com/ai/claw 完成安装
3. **配置本地目标**：引导确认本地各平台的配置文件路径
   - OpenClaw: `~/.openclaw/workspace/skills/lexiang-mcp-skill/mcp.json`
   - Hermes: `~/.hermes/skills/lexiang-knowledge-base/mcp.json` + `~/.hermes/.env`
   - WorkBuddy: `~/.workbuddy/connectors/<id>/.credentials.json`
4. **配置远程目标**：可选输入远程服务器 SSH 地址
5. **保存配置**：所有配置保存到 `.local-config.json`（已加入 .gitignore，不会提交到 GitHub）

---

## 使用方式

### 前置条件

1. **Playwright + Chromium**：

```bash
npm list playwright 2>/dev/null || npm install -D playwright
npx playwright install chromium
```

2. **Python 依赖**（策略2 Chrome cookie 导入需要）：

```bash
pip3 install browser_cookie3 pycryptodomex lz4
```

### 执行命令

核心脚本位于本 Skill 的 `scripts/refresh-token.ts`。

**⚠️ 重要**：不要硬编码脚本路径。每次执行时，Agent 应当根据当前 Skill 的实际安装位置动态拼接路径。

```bash
# 获取本 skill 的脚本目录（Agent 应动态确定）
SKILL_DIR="<本 skill 的实际安装路径>/scripts"

# 方式1：初始化配置（首次使用）
npx tsx "$SKILL_DIR/refresh-token.ts" --init

# 方式2：使用缓存配置自动刷新（推荐，定时任务用）
npx tsx "$SKILL_DIR/refresh-token.ts" --use-cache --headless

# 方式3：自动发现配置文件并更新
npx tsx "$SKILL_DIR/refresh-token.ts" --headless

# 方式4：指定配置文件
npx tsx "$SKILL_DIR/refresh-token.ts" --config-files "/path/to/mcp.json,/path/to/.env"

# 方式5：刷新后推送到远程服务器
npx tsx "$SKILL_DIR/refresh-token.ts" --headless --push-to "root@your-server"

# 方式6：推送到指定的远程配置文件
npx tsx "$SKILL_DIR/refresh-token.ts" --headless --push-to "root@your-server:/root/.mcporter/mcporter.json"

# 方式7：同时推送到多个服务器（逗号分隔）
npx tsx "$SKILL_DIR/refresh-token.ts" --headless --push-to "root@server1,root@server2"

# 方式8：禁用 CDP 模式（直接使用 Chrome cookie 导入）
npx tsx "$SKILL_DIR/refresh-token.ts" --use-cache --no-cdp --headless

# 方式9：使用 CDP 连接指定端口
npx tsx "$SKILL_DIR/refresh-token.ts" --use-cache --cdp --cdp-port 9222 --headless
```

### 参数说明

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--init` | 否 | 初始化引导模式，首次使用时运行 |
| `--use-cache` | 否 | 使用 `.local-config.json` 中缓存的配置 |
| `--config-files` | 自动发现 | 逗号分隔的配置文件路径列表 |
| `--cookie-dir` | `<skill>/.cookies` | cookie 持久化目录 |
| `--headless` | 否 | 无头模式 |
| `--no-headless` | 默认 | 有头模式（可进行手动登录） |
| `--cdp` | 默认开启 | 启用 CDP 模式尝试连接 Chrome |
| `--no-cdp` | 否 | 禁用 CDP 模式，直接使用 Chrome cookie 导入 |
| `--cdp-port` | 9222 | CDP 连接端口号 |
| `--timeout` | 120000 | 超时时间（毫秒） |
| `--push-to` | 无 | 逗号分隔的 SSH 推送目标 |

---

## Agent 执行流程

当需要刷新 token 时，Agent 应按以下步骤操作：

### Step 1：确定脚本路径

本 Skill 不假设自己的安装位置。Agent 需要根据实际环境确定脚本路径：

```
# 可能的安装位置（取决于 Agent 平台）：
~/.workbuddy/skills/refresh-lexiang-token/scripts/refresh-token.ts
~/.openclaw/skills/refresh-lexiang-token/scripts/refresh-token.ts
~/.hermes/skills/refresh-lexiang-token/scripts/refresh-token.ts
```

### Step 2：检查是否已初始化

检查 `.local-config.json` 是否存在。如果不存在，提醒用户先运行 `--init`。

### Step 3：执行刷新

```bash
# 首次执行（需要登录）
npx tsx "<skill_path>/scripts/refresh-token.ts"

# 后续执行（Chrome cookie 导入 + 缓存配置，推荐）
npx tsx "<skill_path>/scripts/refresh-token.ts" --use-cache --headless
```

### Step 4：验证结果

刷新后，脚本会输出结构化 JSON 结果：

```json
{
  "success": true,
  "accessToken": "lxmcp_xxxx...xxxx",
  "companyFrom": "your_company_id_here",
  "updatedFiles": [
    "/Users/xxx/.openclaw/workspace/skills/lexiang-mcp-skill/mcp.json",
    "/Users/xxx/.hermes/skills/lexiang-knowledge-base/mcp.json",
    "/Users/xxx/.hermes/.env"
  ]
}
```

### Step 5：更新配置文件汇总

脚本支持替换三种认证格式的 token：

| 格式 | 示例 | 适用配置 |
|------|------|----------|
| URL query | `access_token=lxmcp_xxx` | OpenClaw skill, mcporter.json |
| Bearer Header | `"Authorization": "Bearer lxmcp_xxx"` | mcp.json |
| .env 变量 | `LEXIANG_TOKEN=lxmcp_xxx` | Hermes .env |

---

## 支持的平台配置位置

### OpenClaw

| 文件 | 格式 | 说明 |
|------|------|------|
| `~/.openclaw/workspace/skills/lexiang-mcp-skill/mcp.json` | URL query | 乐享 Skill MCP 配置 |
| `~/.openclaw/skills/lexiang-*/mcp.json` | URL query | Skills 目录下的配置 |

### Hermes

| 文件 | 格式 | 说明 |
|------|------|------|
| `~/.hermes/skills/lexiang-knowledge-base/mcp.json` | Bearer Header | 乐享 Skill MCP 配置 |
| `~/.hermes/.env` | 环境变量 | `LEXIANG_TOKEN` 和 `COMPANY_FROM` |

### WorkBuddy

| 文件 | 格式 | 说明 |
|------|------|------|
| `~/.workbuddy/connectors/<id>/.credentials.json` | OAuth token | 乐享连接器凭证（注意：此文件使用 `lx_at_` 格式，非 `lxmcp_`） |

### mcporter

| 文件 | 格式 | 说明 |
|------|------|------|
| `~/.mcporter/mcp.json` | Bearer Header | MCP 配置 |
| `~/.mcporter/mcporter.json` | URL query | CLI 配置 |

---

## Cookie 管理

### Chrome Cookie 导入（策略2，推荐）

- 使用 `browser_cookie3` 库从系统 Chrome 浏览器读取 cookie
- 无需用户重新登录——只要 Chrome 中已登录乐享即可
- **macOS 首次运行**：系统会弹出 Keychain 授权对话框，点击「始终允许」即可
- 导入的 cookie 仅在内存中使用，**不写入磁盘**，降低隐私泄露风险
- Python 依赖：`browser_cookie3`, `pycryptodomex`, `lz4`

### Cookie 文件缓存（策略3，降级方案）

- Cookie 保存在本 Skill 目录下的 `.cookies/lexiang-session.json`
- 文件权限：仅 owner 可读写（0600），目录权限 0700
- 首次执行会打开浏览器让用户手动登录
- 登录成功后 cookie 被持久化，后续执行可使用 `--headless` 模式
- 如果 cookie 过期，脚本会自动回退到有头模式等待用户重新登录

---

## 定时自动刷新

推荐配合 Agent Automation 设置定时刷新。

**WorkBuddy 配置方式**：对 Agent 说 "创建定时任务，每天 23 点 30 分刷新乐享 token"

**调度规则**：`FREQ=DAILY;BYHOUR=23;BYMINUTE=30`

**Automation Prompt 示例**：
```
执行 refresh-lexiang-token skill，刷新乐享 MCP access_token。使用缓存配置和无头模式。如果无头模式失败（cookie 过期），提示用户手动执行一次有头模式重新登录。
```

---

## 故障排查

| 问题 | 解决方案 |
|------|----------|
| `Executable doesn't exist` | 运行 `npx playwright install chromium` |
| `No module named browser_cookie3` | 运行 `pip3 install browser_cookie3 pycryptodomex lz4` |
| Keychain 授权对话框 | 点击「始终允许」，这是读取 Chrome cookie 的必要权限 |
| 页面显示空白 | 检查截图 `lexiang-mcp-page.png`，可能需要登录 |
| 提取不到 token | 乐享页面可能改版，检查截图并更新提取逻辑 |
| cookie 过期 | 删除 `.cookies` 目录，重新以有头模式执行 |
| CDP 连接失败 | 使用 `--no-cdp` 跳过 CDP，直接用 Chrome cookie 导入 |
| Chrome 未登录乐享 | 在 Chrome 中打开 lexiangla.com 并登录一次 |
| 配置文件未更新 | 检查 `--config-files` 参数，或确认文件中包含 `lxmcp_` 格式的 token |
| Bearer token 未更新 | 确认配置中包含 `Bearer lxmcp_xxx` 格式 |
| .env 未更新 | 确认文件中有 `LEXIANG_TOKEN=lxmcp_xxx` 行 |
| 本地缓存配置丢失 | 重新运行 `--init` 初始化 |

---

## 安全说明

- **Chrome Cookie 导入**：cookie 仅在脚本运行时存在于内存中，**不写入磁盘**，降低泄露风险
- **Cookie 缓存文件**：`.cookies/` 目录权限为 0700，文件权限为 0600（仅 owner 可读写）
- **Chrome Safe Storage 密码**：仅从 Keychain 临时读取，不缓存不存储
- Token 以明文存储在本地 JSON 配置文件中（与乐享 skill 的设计一致）
- `.cookies` 目录和 `.local-config.json` 已添加到 `.gitignore`
- **Python 依赖供应链**：`browser_cookie3` 是第三方库，如需更高安全性可审查其源码
