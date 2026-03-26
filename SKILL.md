---
name: refresh-lexiang-token
description: "自动刷新乐享 MCP access_token。通过 Playwright 访问 lexiangla.com/mcp 获取最新 token，并动态更新所有相关配置文件，确保乐享 MCP 服务不受 token 过期影响。"
description_zh: "自动刷新乐享 MCP Token"
description_en: "Auto-refresh Lexiang MCP access_token via browser automation"
version: "1.1.0"
homepage: https://github.com/user/refresh-lexiang-token
metadata: {}
---

# 乐享 Token 自动刷新

> **触发场景**：当用户提到「刷新乐享 token」「乐享 token 过期」「更新乐享配置」「lexiang token」，或在使用乐享 MCP 时遇到认证失败（401/403/token expired）时，使用本 Skill。

---

## 工作原理

```
1. 启动 Playwright 浏览器（复用已保存的 cookie）
       ↓
2. 访问 https://lexiangla.com/mcp
       ↓
3. 如需登录 → 打开有头浏览器让用户手动登录 → 保存 cookie
       ↓
4. 从页面提取最新的 access_token 和 company_from
       ↓
5. 自动发现所有包含乐享 token 的配置文件（跨平台）
       ↓
6. 批量替换旧 token（支持 URL query 和 Bearer Header 两种格式）→ 完成
```

---

## 使用方式

### 前置条件

确保 Playwright 已安装：

```bash
npm list playwright 2>/dev/null || npm install -D playwright
npx playwright install chromium
```

### 执行命令

核心脚本位于本 Skill 的 `scripts/refresh-token.ts`。

**⚠️ 重要**：不要硬编码脚本路径。每次执行时，Agent 应当根据当前 Skill 的实际安装位置动态拼接路径。

```bash
# 获取本 skill 的脚本目录（Agent 应动态确定）
SKILL_DIR="<本 skill 的实际安装路径>/scripts"

# 方式1：自动发现配置文件并更新（推荐）
npx tsx "$SKILL_DIR/refresh-token.ts"

# 方式2：指定配置文件
npx tsx "$SKILL_DIR/refresh-token.ts" --config-files "/path/to/mcp.json,/path/to/other.json"

# 方式3：无头模式（已有 cookie 时）
npx tsx "$SKILL_DIR/refresh-token.ts" --headless
```

### 参数说明

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--config-files` | 自动发现 | 逗号分隔的配置文件路径列表 |
| `--cookie-dir` | `<skill>/.cookies` | cookie 持久化目录（默认在脚本所在 skill 目录下） |
| `--headless` | 否 | 无头模式（需要已有有效 cookie） |
| `--no-headless` | 默认 | 有头模式（可进行手动登录） |
| `--timeout` | 120000 | 超时时间（毫秒） |

---

## Agent 执行流程

当需要刷新 token 时，Agent 应按以下步骤操作：

### Step 1：确定脚本路径

本 Skill 不假设自己的安装位置。Agent 需要根据实际环境确定脚本路径：

```
# 可能的安装位置（取决于 Agent 平台）：
~/.workbuddy/skills/refresh-lexiang-token/scripts/refresh-token.ts
~/.openclaw/skills/refresh-lexiang-token/scripts/refresh-token.ts

# 如果是软链，两者指向同一位置
```

### Step 2：自动发现配置文件

脚本会自动扫描以下位置（无需手动指定）：

**Agent 平台全局配置：**
- `~/.workbuddy/mcp.json` — WorkBuddy 全局 MCP 配置
- `~/.openclaw/mcp.json` — OpenClaw 全局 MCP 配置

**mcporter 配置：**
- `~/.mcporter/mcp.json` — mcporter MCP 配置（Bearer 认证）
- `~/.mcporter/mcporter.json` — mcporter CLI 配置（URL query 认证）

**Skill 级配置：**
- `~/.workbuddy/skills/*/mcp.json` — 名称含 "lexiang" 的 skill 配置
- `~/.openclaw/skills/*/mcp.json` — 名称含 "lexiang" 的 skill 配置

**项目级配置：**
- `~/clawd/config/mcporter.json` — 项目级 mcporter 配置

如果需要更新额外的配置文件，通过 `--config-files` 参数指定。

### Step 3：执行刷新

```bash
# 首次执行（需要登录）
npx tsx "<skill_path>/scripts/refresh-token.ts"

# 后续执行（已有 cookie）
npx tsx "<skill_path>/scripts/refresh-token.ts" --headless
```

### Step 4：验证结果

刷新后，脚本会输出结构化 JSON 结果：

```json
{
  "success": true,
  "accessToken": "lxmcp_xxxx...xxxx",
  "companyFrom": "e6c565d6d16811efac17768586f8a025",
  "updatedFiles": [
    "/Users/xxx/.workbuddy/mcp.json",
    "/Users/xxx/.mcporter/mcp.json",
    "/Users/xxx/.mcporter/mcporter.json",
    "/Users/xxx/.openclaw/skills/lexiang/mcp.json"
  ]
}
```

### Step 5：更新配置文件汇总

脚本支持替换两种认证格式的 token：

| 格式 | 示例 | 适用配置 |
|------|------|----------|
| URL query | `access_token=lxmcp_xxx` | mcporter.json, openclaw skill |
| Bearer Header | `"Authorization": "Bearer lxmcp_xxx"` | mcporter mcp.json |

---

## Cookie 管理

- Cookie 默认保存在本 Skill 目录下的 `.cookies/lexiang-session.json`
- 首次执行会打开浏览器让用户手动登录
- 登录成功后 cookie 被持久化，后续执行可使用 `--headless` 模式
- 如果 cookie 过期，脚本会自动回退到有头模式等待用户重新登录

---

## 定时自动刷新

推荐配合 Agent Automation 设置定时刷新（需要有效 cookie）。

**WorkBuddy 配置方式**：对 Agent 说 "创建定时任务，每天 11 点刷新乐享 token"

**调度规则**：`FREQ=DAILY;BYHOUR=11;BYMINUTE=0`

如果 cookie 过期导致无头模式失败，Automation 会报告错误，需要手动执行一次有头模式重新登录：

```bash
npx tsx <skill_path>/scripts/refresh-token.ts
```

---

## 故障排查

| 问题 | 解决方案 |
|------|----------|
| `Executable doesn't exist` | 运行 `npx playwright install chromium` |
| 页面显示空白 | 检查截图 `lexiang-mcp-page.png`，可能需要登录 |
| 提取不到 token | 乐享页面可能改版，检查截图并更新提取逻辑 |
| cookie 过期 | 删除 `.cookies` 目录，重新以有头模式执行 |
| 配置文件未更新 | 检查 `--config-files` 参数，或确认文件中包含 `lxmcp_` 格式的 token |
| Bearer token 未更新 | 确认配置中包含 `Bearer lxmcp_xxx` 格式 |

---

## 安全说明

- Token 以明文存储在本地 JSON 配置文件中（与乐享 skill 的设计一致）
- Cookie 文件包含登录会话信息，请勿泄露
- `.cookies` 目录已添加到 `.gitignore`（如果将 skill 提交到 GitHub）
