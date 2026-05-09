#!/usr/bin/env python3
"""
chrome-cookies.py

从系统 Chrome 浏览器中读取指定域名的 cookie，
解密后输出为 Playwright 兼容的 JSON 格式。

用法:
    python3 chrome-cookies.py [--domain lexiangla.com] [--browser chrome] [--output json|names]

原理:
    使用 browser_cookie3 库读取浏览器 cookie，该库：
    - 自动处理 macOS Keychain / Windows DPAPI / Linux libsecret 解密
    - 支持 Chrome / Firefox / Edge / Opera 等主流浏览器
    - 自动适配不同 Chrome 版本的加密方案（v10/v11/v20）

注意:
    - 首次运行时 macOS 可能弹出 Keychain 访问授权对话框，需要点击"允许"
    - Chrome 运行时其 Cookie 数据库会被锁定，browser_cookie3 会处理此问题
    - 依赖: browser_cookie3, pycryptodomex, lz4
"""

import argparse
import json
import sys
from typing import Dict, List


def read_cookies(domain: str, browser: str = "chrome") -> List[Dict]:
    """从指定浏览器读取域名 cookie，返回 Playwright 兼容格式"""
    try:
        import browser_cookie3
    except ImportError:
        print(
            "❌ 缺少依赖 browser_cookie3，请安装:\n"
            "   pip3 install browser_cookie3 pycryptodomex lz4",
            file=sys.stderr,
        )
        sys.exit(1)

    # 获取浏览器 cookie jar
    cookie_jar = None
    browser_funcs = {
        "chrome": browser_cookie3.chrome,
        "chromium": browser_cookie3.chromium,
        "firefox": browser_cookie3.firefox,
        "edge": browser_cookie3.edge,
        "opera": browser_cookie3.opera,
    }

    func = browser_funcs.get(browser)
    if not func:
        print(f"❌ 不支持的浏览器: {browser}，支持: {', '.join(browser_funcs.keys())}", file=sys.stderr)
        sys.exit(1)

    try:
        cookie_jar = func(domain_name=domain)
    except browser_cookie3.BrowserCookieError as e:
        print(f"❌ 读取浏览器 cookie 失败: {e}", file=sys.stderr)
        sys.exit(1)
    except PermissionError as e:
        print(f"❌ 权限不足，无法访问浏览器 cookie: {e}", file=sys.stderr)
        print("   提示: macOS 可能需要授权 Keychain 访问", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"❌ 未知错误: {e}", file=sys.stderr)
        sys.exit(1)

    # 转换为 Playwright addCookies() 兼容格式
    cookies = []
    seen = set()  # 去重（同名同域的 cookie 只保留一个）

    for c in cookie_jar:
        # 去重 key
        dedup_key = f"{c.name}@{c.domain}@{c.path}"
        if dedup_key in seen:
            continue
        seen.add(dedup_key)

        cookie = {
            "name": c.name,
            "value": c.value,
            "domain": c.domain,
            "path": c.path,
            "secure": c.secure,
            "httpOnly": bool(c.has_nonstandard_attr("HttpOnly") if hasattr(c, "has_nonstandard_attr") else False),
        }

        # SameSite
        if hasattr(c, "get_nonstandard_attr"):
            ss = c.get_nonstandard_attr("SameSite")
            if ss:
                cookie["sameSite"] = ss

        # Expires
        if c.expires and c.expires > 0:
            cookie["expires"] = c.expires

        cookies.append(cookie)

    return cookies


def main():
    parser = argparse.ArgumentParser(description="从浏览器读取指定域名的 cookie（Playwright 格式）")
    parser.add_argument(
        "--domain", "-d",
        default="lexiangla.com",
        help="目标域名 (默认: lexiangla.com)",
    )
    parser.add_argument(
        "--browser", "-b",
        default="chrome",
        choices=["chrome", "chromium", "firefox", "edge", "opera"],
        help="浏览器类型 (默认: chrome)",
    )
    parser.add_argument(
        "--output", "-o",
        choices=["json", "names"],
        default="json",
        help="输出格式: json (Playwright 格式), names (仅 cookie 名称)",
    )
    args = parser.parse_args()

    print(f"📂 读取 {args.browser} cookie (domain={args.domain})...", file=sys.stderr)
    cookies = read_cookies(args.domain, args.browser)

    if not cookies:
        print(f"❌ 未找到 {args.domain} 的 cookie", file=sys.stderr)
        sys.exit(1)

    print(f"✅ 找到 {len(cookies)} 个 cookie", file=sys.stderr)

    if args.output == "json":
        # Playwright addCookies() 兼容格式
        print(json.dumps(cookies, indent=2, ensure_ascii=False))
    elif args.output == "names":
        for c in cookies:
            val_preview = c["value"][:30] + "..." if len(c["value"]) > 30 else c["value"]
            print(f"{c['name']:30s} ({c['domain']:25s}) = {val_preview}")


if __name__ == "__main__":
    main()
