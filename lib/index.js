/**
 * dsh-deepseek-balance —— 在 DSH 里直接查 DeepSeek 账户余额。
 *
 * 为什么值得做成插件而不是让模型去跑 curl：
 *   1. key 只留在本机（插件配置 / 0600 密钥文件 / 环境变量），不进命令行参数，
 *      也不会出现在 shell 历史或进程列表里；
 *   2. 余额接口的错误是有语义的（401 = key 坏了、429 = 限流、5xx = 对端问题），
 *      插件把它翻成「下一步该干嘛」，模型不用猜；
 *   3. 短时间内重复查询走缓存，避免模型自问自答把接口打爆。
 *
 * 网络部分只用全局 fetch（Node 22+ 自带），没有第三方依赖。
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "deepseek-balance";

/** 只往工具注册表里塞东西，别的服务一概不碰。 */
export const inject = ["tools"];

const DEFAULT_BASE_URL = "https://api.deepseek.com";
/** 环境变量按顺序找，第一个非空生效。 */
const KEY_ENV = ["DEEPSEEK_API_KEY", "DEEPSEEK_KEY", "DSH_DEEPSEEK_API_KEY"];
const CURRENCY_LABEL = { CNY: "元", USD: "美元" };

/**
 * 统一输出契约：所有工具只回一行/一段文本。
 * defineTool 要求同时声明 output.schema 与 output.render，漏一个会在 apply 时抛错。
 */
const TEXT_OUTPUT = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      text: { type: "string", required: true },
    },
  },
  render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
};

export const Config = z.object({
  apiKey: z
    .string()
    .default("")
    .description("DeepSeek API key（sk-…）。留空则依次读 apiKeyFile、环境变量 DEEPSEEK_API_KEY。"),
  apiKeyFile: z
    .string()
    .default("")
    .description("密钥文件路径（一行纯文本）。留空则用 $DSH_HOME/deepseek-balance.key。"),
  baseUrl: z
    .string()
    .default(DEFAULT_BASE_URL)
    .description("API 根地址，默认官方 https://api.deepseek.com；走代理时改成代理域名。"),
  timeoutMs: z.number().min(1000).max(60000).default(15000).description("单次请求超时（毫秒）。"),
  cacheSeconds: z.number().min(0).max(3600).default(20).description("余额结果缓存秒数，0 = 不缓存。"),
});

// ---------------------------------------------------------------------------
// key 的解析
// ---------------------------------------------------------------------------
function defaultKeyFile() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(home, "deepseek-balance.key");
}

function readKeyFile(file) {
  if (!file) return "";
  try {
    // 第一行第一个词就够了：允许文件里带注释或换行
    return fs.readFileSync(file, "utf8").trim().split(/\s+/)[0] || "";
  } catch {
    return "";
  }
}

function maskKey(key) {
  const s = String(key || "");
  if (!s) return "（空）";
  if (s.length <= 10) return `${s.slice(0, 3)}…${s.slice(-2)}`;
  return `${s.slice(0, 5)}…${s.slice(-4)}`;
}

/** 返回 { key, from }；from 用于在结果里告诉用户 key 从哪儿来的。 */
function resolveKey(cfg) {
  if (cfg.apiKey && String(cfg.apiKey).trim()) return { key: String(cfg.apiKey).trim(), from: "插件配置" };
  const file = cfg.apiKeyFile ? String(cfg.apiKeyFile) : defaultKeyFile();
  const fromFile = readKeyFile(file);
  if (fromFile) return { key: fromFile, from: `密钥文件 ${file}` };
  for (const env of KEY_ENV) {
    const value = process.env[env];
    if (value && value.trim()) return { key: value.trim(), from: `环境变量 ${env}` };
  }
  return { key: "", from: "" };
}

// ---------------------------------------------------------------------------
// 接口
// ---------------------------------------------------------------------------
async function fetchBalance({ apiKey, baseUrl, timeoutMs }) {
  const root = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const url = `${root}/user/balance`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: controller.signal,
    });
    const raw = await res.text();
    let json = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const message = json?.error?.message || raw.slice(0, 300) || `HTTP ${res.status}`;
      const error = new Error(message);
      error.status = res.status;
      throw error;
    }
    if (!json || typeof json !== "object") {
      throw new Error(`返回的不是 JSON：${raw.slice(0, 200) || "（空响应）"}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------
function formatTime(ms) {
  try {
    return new Date(ms).toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return new Date(ms).toISOString();
  }
}

function money(value, currency) {
  const n = Number(value);
  const unit = CURRENCY_LABEL[currency] || currency || "";
  if (!Number.isFinite(n)) return `${value ?? "?"} ${unit}`.trim();
  return `${n.toFixed(2)} ${unit}`.trim();
}

function formatBalance(data, { at, cached, key, from, baseUrl }) {
  const lines = [];
  const host = (() => {
    try {
      return new URL(String(baseUrl || DEFAULT_BASE_URL)).host;
    } catch {
      return String(baseUrl || DEFAULT_BASE_URL);
    }
  })();
  const stamp = `${formatTime(at)}${cached ? " · 缓存" : ""}`;
  lines.push(`DeepSeek 账户余额（${stamp}，${host}）`);
  lines.push(`状态：${data?.is_available ? "可用" : "不可用（余额不足或账户受限）"}`);

  const infos = Array.isArray(data?.balance_infos) ? data.balance_infos : [];
  if (infos.length === 0) {
    lines.push("接口没有返回任何币种余额。");
  } else {
    for (const info of infos) {
      const currency = info?.currency || "";
      lines.push(
        `· ${currency}：总 ${money(info?.total_balance, currency)}` +
          `（赠金 ${money(info?.granted_balance, currency)} · 充值 ${money(info?.topped_up_balance, currency)}）`,
      );
    }
  }
  lines.push(`密钥：${maskKey(key)}（来自 ${from}）`);
  return lines.join("\n");
}

function formatError(error, { key, baseUrl, timeoutMs }) {
  const status = Number(error?.status) || 0;
  const mask = maskKey(key);
  const message = error?.message || String(error);
  if (error?.name === "AbortError" || /abort/i.test(message)) {
    return (
      `查余额超时（${timeoutMs} 毫秒，密钥 ${mask}）。\n` +
      `网络慢或走了代理时，把插件配置里的 timeoutMs 调大（例如 30000）再试。`
    );
  }
  if (status === 401 || status === 403) {
    return (
      `DeepSeek 拒绝了这个密钥（HTTP ${status}）：${message}\n` +
      `换 key 的方式任选一种：\n` +
      `1. 设置 → 插件 → DeepSeek 余额 → apiKey（推荐）；\n` +
      `2. 交给助手，用 deepseek_balance_set_key 存到本机密钥文件；\n` +
      `3. 环境变量 DEEPSEEK_API_KEY。`
    );
  }
  if (status === 429) {
    return `查得太频繁，被限流了（HTTP 429）。等一会儿再查；${message}`;
  }
  if (status >= 500) {
    return `DeepSeek 服务端出错（HTTP ${status}）：${message}。这是对端问题，稍后重试即可。`;
  }
  if (status) return `查余额失败（HTTP ${status}）：${message}`;
  return `查余额失败：${message}\n检查网络，或插件配置里的 baseUrl（当前 ${baseUrl}）。`;
}

const NO_KEY_TEXT = [
  "还没有可用的 DeepSeek API key，查不了余额。三种配法任选一种：",
  "1. 设置 → 插件 → DeepSeek 余额 → apiKey（推荐，改完立即生效）；",
  "2. 把 key 交给助手，用 deepseek_balance_set_key 存到本机密钥文件（权限 0600）；",
  "3. 环境变量 DEEPSEEK_API_KEY（或 DEEPSEEK_KEY）。",
].join("\n");

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------
/**
 * @param {import("@deepseek-ai/cordis").Context} ctx
 * @param {object} config
 */
export function apply(ctx, config) {
  const cfg = {
    apiKey: "",
    apiKeyFile: "",
    baseUrl: DEFAULT_BASE_URL,
    timeoutMs: 15000,
    cacheSeconds: 20,
    ...(config && typeof config === "object" ? config : {}),
  };
  const log = (line) => {
    try {
      const logger = ctx.logger?.("deepseek-balance");
      if (logger?.info) logger.info(line);
      else console.error(`[deepseek-balance] ${line}`);
    } catch {
      /* 日志失败不影响查询 */
    }
  };

  /** `${baseUrl}|${apiKey}` → { at, data } */
  const cache = new Map();

  ctx.tools.register(
    defineTool({
      name: "deepseek_balance",
      description:
        "查这个 DeepSeek 账户的余额（官方 /user/balance 接口）：可用状态 + 每个币种的总余额/赠金/充值余额。" +
        "用户问『余额还有多少 / 还剩多少钱 / 账户还能用吗』时用它。只读、无副作用；" +
        "结果默认缓存几十秒，需要强制刷新就带 refresh=true。",
      parameters: {
        currency: {
          type: "string",
          description: "只显示某个币种，例如 CNY / USD；不填则全部显示。",
        },
        refresh: {
          type: "boolean",
          description: "true = 跳过缓存，直接打接口。",
        },
      },
      output: TEXT_OUTPUT,
      execute: async (args = {}) => {
        const { key, from } = resolveKey(cfg);
        if (!key) return { text: NO_KEY_TEXT };

        const baseUrl = String(cfg.baseUrl || DEFAULT_BASE_URL);
        const timeoutMs = Number(cfg.timeoutMs) || 15000;
        const ttl = Math.max(0, Number(cfg.cacheSeconds) || 0) * 1000;
        const cacheKey = `${baseUrl}|${key}`;
        const now = Date.now();

        if (!args.refresh && ttl > 0) {
          const hit = cache.get(cacheKey);
          if (hit && now - hit.at < ttl) {
            return {
              text: formatBalance(hit.data, { at: hit.at, cached: true, key, from, baseUrl }),
            };
          }
        }

        try {
          const data = await fetchBalance({ apiKey: key, baseUrl, timeoutMs });
          const at = Date.now();
          cache.set(cacheKey, { at, data });
          let text = formatBalance(data, { at, cached: false, key, from, baseUrl });
          if (args.currency) {
            const wanted = String(args.currency).toUpperCase();
            const infos = Array.isArray(data?.balance_infos) ? data.balance_infos : [];
            const filtered = infos.filter((info) => String(info?.currency || "").toUpperCase() === wanted);
            text =
              filtered.length > 0
                ? formatBalance({ ...data, balance_infos: filtered }, { at, cached: false, key, from, baseUrl })
                : `${text}\n（注意：接口没返回 ${wanted} 币种的余额）`;
          }
          return { text };
        } catch (error) {
          log(`查询失败：${error?.message || error}`);
          return { text: formatError(error, { key, baseUrl, timeoutMs }) };
        }
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "deepseek_balance_set_key",
      description:
        "把用户明确给出的 DeepSeek API key 写进本机密钥文件（权限 0600），之后 deepseek_balance 就能直接查余额。" +
        "只在用户主动把 key 交出来时调用，别自己编 key。",
      parameters: {
        key: {
          type: "string",
          required: true,
          description: "key 原文（通常 sk- 开头）。",
        },
        file: {
          type: "string",
          description: "可选：写入路径；默认 $DSH_HOME/deepseek-balance.key。",
        },
      },
      output: TEXT_OUTPUT,
      execute: async (args = {}) => {
        const key = String(args.key || "").trim();
        if (!key) return { text: "没给 key，什么都没写。" };
        if (/\s/.test(key)) return { text: "key 里含空白字符，像是复制多了；请只给 key 本体。" };

        const file = args.file ? String(args.file) : cfg.apiKeyFile || defaultKeyFile();
        try {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, `${key}\n`, { mode: 0o600 });
          try {
            fs.chmodSync(file, 0o600);
          } catch {
            /* 文件系统不支持时忽略 */
          }
        } catch (error) {
          return { text: `写密钥文件失败（${file}）：${error?.message || error}` };
        }

        const warn = /^sk-/.test(key) ? "" : "\n注意：这个 key 不是 sk- 开头，如果查询报 401 就确认一下是不是 DeepSeek 的 API key。";
        const note = cfg.apiKey
          ? "\n提醒：插件配置里的 apiKey 优先级更高，它还在的话先用它。"
          : "";
        log(`已保存密钥 ${maskKey(key)} 到 ${file}`);
        return {
          text: `已保存密钥 ${maskKey(key)} 到 ${file}（权限 0600）。${warn}${note}`,
        };
      },
    }),
  );

  log(`就绪：baseUrl=${cfg.baseUrl}，缓存 ${cfg.cacheSeconds}s，key 来源=${resolveKey(cfg).from || "未配置"}`);
}
