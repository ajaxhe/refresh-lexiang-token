#!/usr/bin/env npx tsx
/**
 * refresh-token.ts
 *
 * 使用 Playwright 自动访问 https://lexiangla.com/mcp 获取最新的 MCP access_token，
 * 并更新所有相关配置文件中的 token。
 *
 * 设计原则：
 * - 不硬编码任何路径，通过命令行参数或自动发现配置文件位置
 * - 支持 cookie 持久化，避免每次都需要手动登录
 * - 兼容多个 Agent 平台（WorkBuddy / OpenClaw / mcporter）
 * - 支持 URL query 和 Bearer Header 两种认证方式的 token 替换
 *
 * 用法：
 *   npx tsx refresh-token.ts [--config-files file1,file2,...] [--cookie-dir /path/to/cookies] [--headless]
 */

import { chromium, type BrowserContext, type Page } from "playwright";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

// ============================================================
// 参数解析
// ============================================================
interface Args {
  configFiles: string[]; // 需要更新 token 的配置文件路径列表
  cookieDir: string; // cookie 持久化目录
  headless: boolean; // 是否无头模式
  timeout: number; // 等待超时（毫秒）
  pushTo: string[]; // 远程推送目标列表，格式: user@host:/path/to/config.json
}

function parseArgs(): Args {
  const args = process.argv.slice(2);

  // cookie 目录默认放在本脚本所在 skill 目录的 .cookies 下
  const scriptDir = path.dirname(path.resolve(__filename));
  const skillDir = path.dirname(scriptDir); // scripts/ 的上一级即 skill 根目录

  const result: Args = {
    configFiles: [],
    cookieDir: path.join(skillDir, ".cookies"),
    headless: false, // 默认有头模式（首次需要登录）
    timeout: 120_000, // 2 分钟超时
    pushTo: [],
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--config-files":
        result.configFiles = (args[++i] || "").split(",").filter(Boolean);
        break;
      case "--cookie-dir":
        result.cookieDir = args[++i] || result.cookieDir;
        break;
      case "--headless":
        result.headless = true;
        break;
      case "--no-headless":
        result.headless = false;
        break;
      case "--timeout":
        result.timeout = parseInt(args[++i] || "120000", 10);
        break;
      case "--push-to":
        result.pushTo = (args[++i] || "").split(",").filter(Boolean);
        break;
    }
  }

  return result;
}

// ============================================================
// Cookie 持久化
// ============================================================
const COOKIE_FILE_NAME = "lexiang-session.json";

async function loadCookies(
  context: BrowserContext,
  cookieDir: string
): Promise<boolean> {
  const cookiePath = path.join(cookieDir, COOKIE_FILE_NAME);
  if (!fs.existsSync(cookiePath)) {
    console.log("ℹ️  未找到已保存的 cookie，将需要手动登录");
    return false;
  }

  try {
    const cookies = JSON.parse(fs.readFileSync(cookiePath, "utf-8"));
    await context.addCookies(cookies);
    console.log("✅ 已加载保存的 cookie");
    return true;
  } catch (e) {
    console.warn("⚠️  加载 cookie 失败，将需要手动登录:", (e as Error).message);
    return false;
  }
}

async function saveCookies(
  context: BrowserContext,
  cookieDir: string
): Promise<void> {
  fs.mkdirSync(cookieDir, { recursive: true });
  const cookiePath = path.join(cookieDir, COOKIE_FILE_NAME);
  const cookies = await context.cookies();
  fs.writeFileSync(cookiePath, JSON.stringify(cookies, null, 2));
  console.log(`✅ Cookie 已保存到: ${cookiePath}`);
}

// ============================================================
// Token 提取
// ============================================================
interface TokenInfo {
  accessToken: string;
  companyFrom: string;
}

async function extractToken(
  page: Page,
  timeout: number
): Promise<TokenInfo | null> {
  const MCP_URL = "https://lexiangla.com/mcp";
  console.log(`🌐 正在访问 ${MCP_URL} ...`);

  // 使用 domcontentloaded 避免 networkidle 超时（乐享页面有持续的 WS 连接）
  const response = await page.goto(MCP_URL, {
    waitUntil: "domcontentloaded",
    timeout,
  });
  console.log(`   HTTP ${response?.status()} — ${page.url()}`);

  // 等待一下让 JS 重定向生效
  await page.waitForTimeout(2000);

  // 检查是否需要登录（如果重定向到了登录页）
  const currentUrl = page.url();
  if (
    currentUrl.includes("/login") ||
    currentUrl.includes("/auth") ||
    currentUrl.includes("/passport")
  ) {
    console.log("🔑 需要登录，请在浏览器中完成登录操作...");
    console.log("   （登录成功后页面会自动跳转到 MCP 配置页面）");

    // 等待用户登录并跳转回 MCP 或新版 Agent 页面
    try {
      await page.waitForURL(/\/(mcp|ai\/)/, { timeout });
      console.log("✅ 登录成功，已跳转到配置页面");
      // 等待页面 JS 渲染
      await page.waitForTimeout(3000);
    } catch {
      console.error("❌ 登录超时，请重试");
      return null;
    }
  }

  // 等待页面 JS 渲染完成，尝试多种策略提取 token
  console.log("⏳ 等待页面渲染...");
  await page.waitForTimeout(3000);

  // 策略0：新版页面 /ai/claw —— 需要点击"查看个人凭证"按钮展开 token
  const newPageUrl = page.url();
  if (newPageUrl.includes("/ai/claw") || newPageUrl.includes("/ai/")) {
    console.log("📌 检测到新版乐享 Agent 页面，尝试提取凭证...");

    // 方法A：拦截剪贴板 API，然后点击"一键复制安装指令"按钮获取完整配置
    let clipboardContent = '';
    try {
      // 注入剪贴板拦截
      await page.evaluate(() => {
        (window as any).__clipboardData = '';
        const originalWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
        navigator.clipboard.writeText = async (text: string) => {
          (window as any).__clipboardData = text;
          return originalWriteText(text);
        };
        // 也拦截 execCommand('copy')
        const originalExecCommand = document.execCommand.bind(document);
        document.execCommand = (command: string, ...args: any[]) => {
          if (command === 'copy') {
            const selection = window.getSelection();
            if (selection) {
              (window as any).__clipboardData = selection.toString();
            }
          }
          return originalExecCommand(command, ...args);
        };
      });

      // 点击"一键复制安装指令"按钮
      const copyInstBtn = page.getByText('一键复制安装指令');
      if (await copyInstBtn.isVisible({ timeout: 3000 })) {
        await copyInstBtn.click();
        console.log('   ✅ 已点击 [一键复制安装指令]');
        await page.waitForTimeout(2000);

        clipboardContent = await page.evaluate(() => (window as any).__clipboardData || '');
        if (clipboardContent) {
          console.log(`   📋 剪贴板内容长度: ${clipboardContent.length}`);
          // 从复制内容中提取 token
          const tokenMatch = clipboardContent.match(/lxmcp_[a-f0-9]{16,}/i);
          if (tokenMatch) {
            console.log(`   ✅ 从复制内容中提取到 token: ${tokenMatch[0].substring(0, 20)}...`);
          }
        }
      }
    } catch (e) {
      console.log(`   ⚠️ 剪贴板拦截方式失败: ${(e as Error).message}`);
    }

    // 方法B：查找页面中所有 React fiber / Vue 数据中的 token
    if (!clipboardContent || !/lxmcp_[a-f0-9]{16,}/.test(clipboardContent)) {
      try {
        const reactToken = await page.evaluate(() => {
          // 遍历所有元素的 React fiber，查找 token 数据
          const allEls = document.querySelectorAll('*');
          for (const el of allEls) {
            // React fiber
            const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
            if (fiberKey) {
              const fiber = (el as any)[fiberKey];
              const str = JSON.stringify(fiber?.memoizedProps || {});
              const match = str.match(/lxmcp_[a-f0-9]{16,}/i);
              if (match) return match[0];
            }
            // Vue
            if ((el as any).__vue_app__) {
              const str = JSON.stringify((el as any).__vue_app__.config?.globalProperties || {});
              const match = str.match(/lxmcp_[a-f0-9]{16,}/i);
              if (match) return match[0];
            }
          }
          return '';
        });
        if (reactToken) {
          clipboardContent = reactToken;
          console.log(`   ✅ 从 React state 中提取到 token: ${reactToken.substring(0, 20)}...`);
        }
      } catch {
        console.log('   ⚠️ React/Vue state 提取失败');
      }
    }

    // 方法C：查找页面网络请求中的 token（从 performance entries）
    if (!clipboardContent || !/lxmcp_[a-f0-9]{16,}/.test(clipboardContent)) {
      try {
        const perfToken = await page.evaluate(() => {
          const entries = performance.getEntriesByType('resource');
          for (const entry of entries) {
            const match = entry.name.match(/lxmcp_[a-f0-9]{16,}/i);
            if (match) return match[0];
          }
          return '';
        });
        if (perfToken) {
          clipboardContent = perfToken;
          console.log(`   ✅ 从网络请求中提取到 token: ${perfToken.substring(0, 20)}...`);
        }
      } catch {
        console.log('   ⚠️ 网络请求提取失败');
      }
    }

    // 如果从复制内容中获取到了 token，直接注入到后续的提取流程
    if (clipboardContent && /lxmcp_[a-f0-9]{16,}/.test(clipboardContent)) {
      // 将 token 写入一个隐藏元素，以便后续的 evaluate 能提取到
      const extractedToken = clipboardContent.match(/lxmcp_[a-f0-9]{16,}/i)?.[0] || '';
      await page.evaluate((token) => {
        const div = document.createElement('div');
        div.id = '__injected_token__';
        div.style.display = 'none';
        div.textContent = token;
        document.body.appendChild(div);
      }, extractedToken);
    }

    // 方法D：尝试点击"查看个人凭证"，然后找到显示/眼睛按钮
    try {
      const viewCredBtn = page.getByText('查看个人凭证');
      if (await viewCredBtn.isVisible({ timeout: 3000 })) {
        await viewCredBtn.click();
        console.log('   ✅ 已点击 [查看个人凭证]');
        await page.waitForTimeout(1500);

        // 查找凭证区域附近的 SVG 眼睛图标或"显示"/"复制"按钮
        const credSection = page.locator(':has-text("凭证：")').last();
        // 尝试点击凭证区域内的所有可交互元素（图标按钮等）
        const buttons = credSection.locator('button, svg, [role="button"], [class*="icon"], [class*="eye"], [class*="copy"], [class*="show"]');
        const btnCount = await buttons.count();
        console.log(`   🔍 凭证区域发现 ${btnCount} 个可交互元素`);
        for (let i = 0; i < btnCount && i < 10; i++) {
          try {
            const btn = buttons.nth(i);
            if (await btn.isVisible()) {
              await btn.click();
              await page.waitForTimeout(500);
            }
          } catch { /* ignore */ }
        }
        await page.waitForTimeout(1000);
      }
    } catch {
      console.log('   ⚠️ 凭证展开失败');
    }

    await page.waitForTimeout(1000);
  }

  // 策略1：从页面中查找 access_token 文本
  const tokenInfo = await page.evaluate(() => {
    const bodyText = document.body.innerText || "";
    const bodyHtml = document.body.innerHTML || "";

    // 尝试匹配 lxmcp_ 开头的 token
    const tokenMatch =
      bodyText.match(/lxmcp_[a-f0-9]{64}/i) ||
      bodyHtml.match(/lxmcp_[a-f0-9]{64}/i);

    // 尝试匹配 company_from
    const companyMatch =
      bodyText.match(/company_from[=:]\s*([a-f0-9]+)/i) ||
      bodyHtml.match(/company_from[=:]\s*["']?([a-f0-9]+)["']?/i);

    // 尝试从 URL 参数格式文本中提取
    const urlMatch = bodyHtml.match(
      /company_from=([a-f0-9]+).*?access_token=(lxmcp_[a-f0-9]+)/i
    );
    const urlMatch2 = bodyHtml.match(
      /access_token=(lxmcp_[a-f0-9]+).*?company_from=([a-f0-9]+)/i
    );

    let token = "";
    let company = "";

    if (urlMatch) {
      company = urlMatch[1];
      token = urlMatch[2];
    } else if (urlMatch2) {
      token = urlMatch2[1];
      company = urlMatch2[2];
    } else {
      if (tokenMatch) token = tokenMatch[0];
      if (companyMatch) company = companyMatch[1];
    }

    // 尝试从 input / code / pre 元素中提取
    if (!token) {
      const inputs = document.querySelectorAll(
        "input, code, pre, [data-token], [data-access-token]"
      );
      for (const el of inputs) {
        const val =
          (el as HTMLInputElement).value ||
          el.textContent ||
          el.getAttribute("data-token") ||
          el.getAttribute("data-access-token") ||
          "";
        const m = val.match(/lxmcp_[a-f0-9]{64}/i);
        if (m) {
          token = m[0];
          break;
        }
      }
    }

    // 尝试从 复制按钮 附近的文本或 data 属性中提取
    if (!token) {
      const copyBtns = document.querySelectorAll(
        '[class*="copy"], [data-clipboard], button'
      );
      for (const btn of copyBtns) {
        const clipboardText =
          btn.getAttribute("data-clipboard-text") ||
          btn.getAttribute("data-copy") ||
          "";
        const m = clipboardText.match(/lxmcp_[a-f0-9]{64}/i);
        if (m) {
          token = m[0];
          break;
        }
        // 也检查整个 URL 形式
        const urlM = clipboardText.match(
          /company_from=([a-f0-9]+).*?access_token=(lxmcp_[a-f0-9]+)/i
        );
        if (urlM) {
          company = urlM[1];
          token = urlM[2];
          break;
        }
      }
    }

    // 尝试从注入的隐藏元素获取（策略0注入的）
    if (!token) {
      const injected = document.getElementById('__injected_token__');
      if (injected && injected.textContent) {
        const m = injected.textContent.match(/lxmcp_[a-f0-9]{16,}/i);
        if (m) token = m[0];
      }
    }

    // 尝试从所有元素的 textContent 做宽松匹配（lxmcp_ + 至少 16 位 hex）
    if (!token) {
      const allElements = document.querySelectorAll('*');
      for (const el of allElements) {
        if (el.children.length === 0 && el.textContent) {
          const m = el.textContent.match(/lxmcp_[a-f0-9]{16,}/i);
          if (m && m[0] !== 'lxmcp_xxxx') {
            token = m[0];
            break;
          }
        }
      }
    }

    return { token, company };
  });

  if (!tokenInfo.token) {
    // 策略2：尝试截图以便调试
    console.log("⚠️  未能从页面自动提取 token，尝试截图...");

    // 额外调试：滚动到凭证区域并截图
    await page.evaluate(() => {
      // 找到包含"凭证"的元素并滚动到那里
      const elements = document.querySelectorAll('*');
      for (const el of elements) {
        if (el.textContent && el.textContent.includes('凭证：') && el.children.length < 3) {
          el.scrollIntoView({ behavior: 'instant', block: 'center' });
          break;
        }
      }
    });
    await page.waitForTimeout(1000);

    const screenshotPath = path.join(process.cwd(), "lexiang-mcp-page.png");
    await page.screenshot({ path: screenshotPath, fullPage: false });
    console.log(`📸 页面截图已保存到: ${screenshotPath}`);

    // 策略3：打印页面内容用于调试
    const pageText = await page.evaluate(() => document.body.innerText);
    console.log("📄 页面文本内容 (前2000字符):");
    console.log(pageText.substring(0, 2000));

    // 策略4：打印所有 input/textarea 的值和所有 data 属性
    const debugInfo = await page.evaluate(() => {
      const info: string[] = [];
      // 所有 input 和 textarea
      document.querySelectorAll('input, textarea').forEach((el, i) => {
        const inp = el as HTMLInputElement;
        info.push(`input[${i}] type=${inp.type} name=${inp.name} value=${inp.value.substring(0, 100)}`);
      });
      // 所有含 lxmcp 的元素
      const allEls = document.querySelectorAll('*');
      for (const el of allEls) {
        for (const attr of el.attributes) {
          if (attr.value && attr.value.includes('lxmcp')) {
            info.push(`attr: ${el.tagName}[${attr.name}]=${attr.value.substring(0, 100)}`);
          }
        }
      }
      // 查找凭证附近的元素
      for (const el of allEls) {
        if (el.children.length === 0 && el.textContent && /lxmcp_[a-f0-9]{8,}/.test(el.textContent)) {
          info.push(`text-node: ${el.tagName}.${el.className} = ${el.textContent.substring(0, 100)}`);
        }
      }
      return info;
    });
    console.log("🔍 调试信息:");
    debugInfo.forEach(d => console.log(`   ${d}`));

    // 策略5：获取凭证区域的 HTML
    const credHtml = await page.evaluate(() => {
      const allEls = document.querySelectorAll('*');
      for (const el of allEls) {
        if (el.textContent && el.textContent.includes('有效期至') && el.innerHTML.length < 5000) {
          return el.innerHTML.substring(0, 3000);
        }
      }
      return '';
    });
    if (credHtml) {
      console.log("🔍 凭证区域 HTML (前 1500 字符):");
      console.log(credHtml.substring(0, 1500));
    }

    return null;
  }

  console.log(
    `✅ 成功提取 token: ${tokenInfo.token.substring(0, 20)}...${tokenInfo.token.slice(-8)}`
  );
  if (tokenInfo.company) {
    console.log(`✅ 成功提取 company_from: ${tokenInfo.company}`);
  }

  return {
    accessToken: tokenInfo.token,
    companyFrom: tokenInfo.company,
  };
}

// ============================================================
// 配置文件更新
// ============================================================

/**
 * 更新 JSON 配置文件中的 token
 * 支持三种格式：
 * 1. URL 中的 access_token 参数（如 mcporter.json）
 * 2. Bearer Header 中的 token（如 mcp.json 的 Authorization header）
 * 3. 环境变量形式（如 LEXIANG_TOKEN=xxx）
 */
function updateConfigFile(
  filePath: string,
  tokenInfo: TokenInfo
): { success: boolean; message: string } {
  if (!fs.existsSync(filePath)) {
    return { success: false, message: `文件不存在: ${filePath}` };
  }

  try {
    let content = fs.readFileSync(filePath, "utf-8");
    const originalContent = content;
    let updated = false;

    // 1. 替换 URL 中的 access_token=lxmcp_xxx
    const tokenRegex = /access_token=lxmcp_[a-f0-9]+/gi;
    if (tokenRegex.test(content)) {
      content = content.replace(
        /access_token=lxmcp_[a-f0-9]+/gi,
        `access_token=${tokenInfo.accessToken}`
      );
      updated = true;
    }

    // 2. 替换 Bearer lxmcp_xxx（Authorization header 中的 token）
    const bearerRegex = /Bearer\s+lxmcp_[a-f0-9]+/gi;
    if (bearerRegex.test(originalContent)) {
      content = content.replace(
        /Bearer\s+lxmcp_[a-f0-9]+/gi,
        `Bearer ${tokenInfo.accessToken}`
      );
      updated = true;
    }

    // 3. 替换 URL 中的 company_from=xxx（如果提取到了新的 company_from）
    if (tokenInfo.companyFrom) {
      const companyRegex = /company_from=[a-f0-9]{20,}(?=&|"|'|\s|$)/gi;
      if (companyRegex.test(originalContent)) {
        content = content.replace(
          /company_from=[a-f0-9]{20,}(?=&|"|'|\s|$)/gi,
          `company_from=${tokenInfo.companyFrom}`
        );
        // company_from 变更不单独算 updated，只是顺带更新
      }
    }

    // 4. 替换 "LEXIANG_TOKEN": "lxmcp_xxx" 或 LEXIANG_TOKEN=lxmcp_xxx 形式
    const envTokenRegex =
      /(["']?LEXIANG_TOKEN["']?\s*[:=]\s*["']?)lxmcp_[a-f0-9]+(["']?)/gi;
    if (envTokenRegex.test(originalContent)) {
      content = content.replace(
        /(["']?LEXIANG_TOKEN["']?\s*[:=]\s*["']?)lxmcp_[a-f0-9]+(["']?)/gi,
        `$1${tokenInfo.accessToken}$2`
      );
      updated = true;
    }

    if (!updated) {
      return {
        success: false,
        message: `未在文件中找到可替换的 token: ${filePath}`,
      };
    }

    if (content === originalContent) {
      return { success: true, message: `Token 未变化，无需更新: ${filePath}` };
    }

    fs.writeFileSync(filePath, content, "utf-8");
    return { success: true, message: `✅ 已更新: ${filePath}` };
  } catch (e) {
    return {
      success: false,
      message: `更新失败 ${filePath}: ${(e as Error).message}`,
    };
  }
}

// ============================================================
// 自动发现配置文件
// ============================================================

/**
 * 自动扫描可能包含乐享 token 的配置文件。
 *
 * 扫描范围覆盖多个 Agent 平台：
 * - WorkBuddy (~/.workbuddy)
 * - OpenClaw (~/.openclaw)
 * - mcporter (~/.mcporter)
 *
 * 不硬编码路径，而是扫描已知目录下的候选文件。
 */
function discoverConfigFiles(): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || "~";
  const candidates: string[] = [];

  // ---- 1. Agent 平台全局 MCP 配置 ----
  const globalConfigs = [
    path.join(home, ".workbuddy", "mcp.json"),
    path.join(home, ".openclaw", "mcp.json"),
  ];
  candidates.push(...globalConfigs);

  // ---- 2. mcporter 配置 ----
  const mcporterConfigs = [
    path.join(home, ".mcporter", "mcp.json"),
    path.join(home, ".mcporter", "mcporter.json"),
  ];
  candidates.push(...mcporterConfigs);

  // ---- 3. 动态扫描各平台 skills 目录下含 "lexiang" 的 mcp.json ----
  const skillsDirs = [
    path.join(home, ".workbuddy", "skills"),
    path.join(home, ".openclaw", "skills"),
  ];

  for (const skillsDir of skillsDirs) {
    if (!fs.existsSync(skillsDir)) continue;
    try {
      const skills = fs.readdirSync(skillsDir);
      for (const skill of skills) {
        if (skill.toLowerCase().includes("lexiang")) {
          // 检查是否是软链，如果是则解析真实路径避免重复
          const skillPath = path.join(skillsDir, skill);
          const realPath = fs.realpathSync(skillPath);
          const mcpJson = path.join(realPath, "mcp.json");
          if (fs.existsSync(mcpJson)) {
            candidates.push(mcpJson);
          }
        }
      }
    } catch {
      // 忽略权限错误等
    }
  }

  // ---- 4. 项目级配置（如 ~/clawd/config/mcporter.json）----
  const projectConfigs = [
    path.join(home, "clawd", "config", "mcporter.json"),
  ];
  candidates.push(...projectConfigs);

  // 去重（按真实路径）
  const seen = new Set<string>();
  const uniqueCandidates = candidates.filter((f) => {
    try {
      const real = fs.existsSync(f) ? fs.realpathSync(f) : f;
      if (seen.has(real)) return false;
      seen.add(real);
      return true;
    } catch {
      return true;
    }
  });

  // 只返回存在且包含真实 token（非占位符）的文件
  return uniqueCandidates.filter((f) => {
    if (!fs.existsSync(f)) return false;
    try {
      const content = fs.readFileSync(f, "utf-8");
      // 必须包含真实的 lxmcp_ token（非环境变量占位符）
      // 跳过只有 ${LEXIANG_TOKEN} 占位符的模板文件
      return /lxmcp_[a-f0-9]{16,}/i.test(content);
    } catch {
      return false;
    }
  });
}

// ============================================================
// 远程推送 Token（通过 SSH）
// ============================================================

/**
 * 通过 SSH 将新 token 推送到远程服务器的配置文件中。
 *
 * 格式: user@host 或 user@host:/path/to/config.json
 * - 如果不指定路径，自动发现远程服务器上的配置文件
 * - 通过 sed 命令远程替换 token，无需传输文件
 */
function pushTokenToRemote(
  target: string,
  tokenInfo: TokenInfo
): { success: boolean; message: string } {
  // 解析 target: user@host 或 user@host:/path/to/file
  const colonIdx = target.indexOf(":");
  let sshTarget: string;
  let remotePaths: string[];

  if (colonIdx > 0 && target[colonIdx + 1] === "/") {
    // 指定了路径: user@host:/path/to/file
    sshTarget = target.substring(0, colonIdx);
    remotePaths = [target.substring(colonIdx + 1)];
  } else {
    // 未指定路径: user@host，自动发现
    sshTarget = target;
    remotePaths = [];
  }

  try {
    // 如果没指定路径，先通过 SSH 自动发现远程配置文件
    if (remotePaths.length === 0) {
      console.log(`   🔍 自动发现 ${sshTarget} 上的配置文件...`);
      const discoverCmd = `ssh -o ConnectTimeout=10 -o BatchMode=yes ${sshTarget} "grep -rl 'lxmcp_[a-f0-9]' ~/.workbuddy/mcp.json ~/.openclaw/mcp.json ~/.openclaw/openclaw.json ~/.mcporter/mcp.json ~/.mcporter/mcporter.json 2>/dev/null || true"`;
      try {
        const result = execSync(discoverCmd, {
          encoding: "utf-8",
          timeout: 15_000,
        }).trim();
        remotePaths = result.split("\n").filter(Boolean);
      } catch {
        remotePaths = [];
      }

      if (remotePaths.length === 0) {
        return {
          success: false,
          message: `未在 ${sshTarget} 上找到包含乐享 token 的配置文件`,
        };
      }
      console.log(
        `   📂 发现 ${remotePaths.length} 个文件: ${remotePaths.join(", ")}`
      );
    }

    // 对每个远程文件执行 sed 替换
    const results: string[] = [];
    for (const remotePath of remotePaths) {
      // 替换 access_token=lxmcp_xxx
      const sedAccessToken = `sed -i 's/access_token=lxmcp_[a-f0-9]\\{16,\\}/access_token=${tokenInfo.accessToken}/g' '${remotePath}'`;
      // 替换 Bearer lxmcp_xxx
      const sedBearer = `sed -i 's/Bearer lxmcp_[a-f0-9]\\{16,\\}/Bearer ${tokenInfo.accessToken}/g' '${remotePath}'`;
      // 替换 company_from（如果有）
      const sedCompany = tokenInfo.companyFrom
        ? `sed -i 's/company_from=[a-f0-9]\\{20,\\}/company_from=${tokenInfo.companyFrom}/g' '${remotePath}'`
        : "";
      // 替换 LEXIANG_TOKEN 环境变量形式（简化正则避免嵌套引号转义问题）
      const sedEnvToken = `sed -i 's/lxmcp_[a-f0-9]\\{16,\\}/${tokenInfo.accessToken}/g' '${remotePath}'`;

      const commands = [sedAccessToken, sedBearer];
      if (sedCompany) commands.push(sedCompany);
      // sedEnvToken 作为兜底全局替换放最后（它会匹配所有 lxmcp_ token）
      // 注意：前面的 sed 已经替换了 access_token= 和 Bearer 格式，这里再跑一次全局替换确保不遗漏
      commands.push(sedEnvToken);
      const fullCmd = `ssh -o ConnectTimeout=10 -o BatchMode=yes ${sshTarget} "${commands.join(" && ")}"`;

      try {
        execSync(fullCmd, { encoding: "utf-8", timeout: 15_000 });
        results.push(`✅ ${sshTarget}:${remotePath}`);
      } catch (e) {
        results.push(
          `❌ ${sshTarget}:${remotePath} — ${(e as Error).message.split("\n")[0]}`
        );
      }
    }

    const successCount = results.filter((r) => r.startsWith("✅")).length;
    return {
      success: successCount > 0,
      message: results.join("\n   "),
    };
  } catch (e) {
    return {
      success: false,
      message: `SSH 推送失败 ${sshTarget}: ${(e as Error).message.split("\n")[0]}`,
    };
  }
}

// ============================================================
// 主流程
// ============================================================
async function main() {
  const args = parseArgs();

  console.log("🔄 乐享 MCP Token 刷新工具");
  console.log("================================");

  // 确定需要更新的配置文件
  let configFiles = args.configFiles;
  if (configFiles.length === 0) {
    console.log("📂 自动发现配置文件...");
    configFiles = discoverConfigFiles();
    if (configFiles.length === 0) {
      console.log(
        "⚠️  未找到包含乐享 token 的配置文件，将只获取 token 并输出"
      );
    } else {
      console.log(`📂 找到 ${configFiles.length} 个配置文件:`);
      configFiles.forEach((f) => console.log(`   - ${f}`));
    }
  }

  // 启动浏览器
  console.log(
    `\n🚀 启动浏览器 (${args.headless ? "无头模式" : "有头模式"})...`
  );
  const browser = await chromium.launch({
    headless: args.headless,
    args: ["--disable-blink-features=AutomationControlled"],
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
    });

    // 加载已保存的 cookie
    await loadCookies(context, args.cookieDir);

    const page = await context.newPage();

    // 提取 token
    const tokenInfo = await extractToken(page, args.timeout);

    if (!tokenInfo) {
      console.error("\n❌ 未能获取 token。请检查:");
      console.error("   1. 是否成功登录了乐享");
      console.error("   2. 页面是否正确显示了 MCP 配置信息");
      console.error("   3. 查看截图 lexiang-mcp-page.png 了解页面状态");
      process.exit(1);
    }

    // 保存 cookie（无论是否有变化，都更新一下）
    await saveCookies(context, args.cookieDir);

    // 更新配置文件
    console.log("\n📝 更新配置文件...");
    if (configFiles.length === 0) {
      console.log(`\n🔑 新 token: ${tokenInfo.accessToken}`);
      if (tokenInfo.companyFrom) {
        console.log(`🏢 company_from: ${tokenInfo.companyFrom}`);
      }
      console.log("\n提示：使用 --config-files 参数指定要更新的配置文件");
    } else {
      const results = configFiles.map((f) => updateConfigFile(f, tokenInfo));
      results.forEach((r) => console.log(`   ${r.message}`));

      const successCount = results.filter((r) => r.success).length;
      console.log(
        `\n✅ 更新完成: ${successCount}/${configFiles.length} 个文件成功`
      );
    }

    // 远程推送 token
    if (args.pushTo.length > 0) {
      console.log("\n🌐 推送 token 到远程服务器...");
      const pushResults = args.pushTo.map((target) => {
        console.log(`   📡 推送到 ${target}...`);
        return pushTokenToRemote(target, tokenInfo);
      });
      pushResults.forEach((r) => console.log(`   ${r.message}`));

      const pushSuccessCount = pushResults.filter((r) => r.success).length;
      console.log(
        `\n✅ 远程推送完成: ${pushSuccessCount}/${args.pushTo.length} 个目标成功`
      );
    }

    // 输出结构化结果（便于调用方解析）
    const resultJson = JSON.stringify(
      {
        success: true,
        accessToken: tokenInfo.accessToken,
        companyFrom: tokenInfo.companyFrom,
        updatedFiles: configFiles,
        pushedTo: args.pushTo.length > 0 ? args.pushTo : undefined,
      },
      null,
      2
    );
    console.log(`\n📋 结果 JSON:\n${resultJson}`);
  } finally {
    await browser.close();
    console.log("\n🔒 浏览器已关闭");
  }
}

main().catch((e) => {
  console.error("❌ 执行失败:", e);
  process.exit(1);
});
