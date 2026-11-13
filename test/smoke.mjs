/**
 * 冒烟测试：不需要真 key，也不需要联网 —— 起一个本地 HTTP 服务冒充 DeepSeek
 * 的 /user/balance，然后走插件的真实代码路径。
 *
 * 跑法（插件目录所在位置必须能解析到 @deepseek-ai/*，见 README）：
 *   node test/smoke.mjs
 */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const VALID = "sk-smoke-0123456789abcdef";
const balanceBody = {
  is_available: true,
  balance_infos: [
    { currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" },
    { currency: "USD", total_balance: "0.00", granted_balance: "0.00", topped_up_balance: "0.00" },
  ],
};

let hits = 0;
const server = http.createServer((req, res) => {
  if (req.url !== "/user/balance") {
    res.writeHead(404).end("nope");
    return;
  }
  hits += 1;
  const auth = String(req.headers.authorization || "");
  const key = auth.replace(/^Bearer\s+/i, "");
  if (key !== VALID) {
    res.writeHead(401, { "content-type": "application/json" }).end(
      JSON.stringify({ error: { message: "Authentication Fails, your api key is invalid", type: "authentication_error" } }),
    );
    return;
  }
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(balanceBody));
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}`;

const { apply } = await import("../lib/index.js");

function mount(config) {
  const tools = new Map();
  const ctx = {
    tools: { register: (tool) => tools.set(tool.name, tool) },
    logger: () => ({ info: () => {} }),
  };
  apply(ctx, config);
  return tools;
}

const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dbal-")), "key.txt");
let passed = 0;
const check = (label, fn, timeout = 8000) => {
  const start = Date.now();
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`ok   ${label} (${Date.now() - start}ms)`);
    })
    .catch((error) => {
      console.error(`FAIL ${label}:`, error?.message || error);
      process.exitCode = 1;
    });
};

const call = async (tools, name, args = {}) => {
  const tool = tools.get(name);
  assert.ok(tool, `工具 ${name} 没注册`);
  const out = await tool.execute({ ...args }, {});
  assert.equal(typeof out?.text, "string", "输出必须是 { text }");
  return out.text;
};

await check("没有 key 时给出三种配法", async () => {
  const tools = mount({ apiKey: "", apiKeyFile: tmpFile, baseUrl });
  const text = await call(tools, "deepseek_balance");
  assert.match(text, /还没有可用的 DeepSeek API key/);
  assert.match(text, /deepseek_balance_set_key/);
});

await check("有 key 时渲染余额", async () => {
  const tools = mount({ apiKey: VALID, baseUrl, cacheSeconds: 0 });
  const text = await call(tools, "deepseek_balance");
  assert.match(text, /状态：可用/);
  assert.match(text, /CNY：总 110\.00 元（赠金 10\.00 元 · 充值 100\.00 元）/);
  assert.match(text, /USD：总 0\.00 美元/);
  assert.match(text, /密钥：sk-sm…cdef（来自 插件配置）/);
});

await check("币种过滤", async () => {
  const tools = mount({ apiKey: VALID, baseUrl, cacheSeconds: 0 });
  const text = await call(tools, "deepseek_balance", { currency: "usd" });
  assert.match(text, /USD：总 0\.00 美元/);
  assert.doesNotMatch(text, /CNY：/);
});

await check("缓存命中不打第二次接口", async () => {
  const tools = mount({ apiKey: VALID, baseUrl, cacheSeconds: 30 });
  const before = hits;
  await call(tools, "deepseek_balance");
  const first = hits;
  const text = await call(tools, "deepseek_balance");
  assert.equal(hits, first, "第二次查询不应该再打接口");
  assert.match(text, /缓存/);
  assert.ok(hits >= before + 1);
  const fresh = await call(tools, "deepseek_balance", { refresh: true });
  assert.equal(hits, first + 1, "refresh=true 应该真的再打一次");
  assert.doesNotMatch(fresh, /缓存/);
});

await check("401 给出换 key 的下一步", async () => {
  const tools = mount({ apiKey: "sk-bad-key-000000", baseUrl, cacheSeconds: 0 });
  const text = await call(tools, "deepseek_balance");
  assert.match(text, /HTTP 401/);
  assert.match(text, /设置 → 插件 → DeepSeek 余额/);
});

await check("网络不通时不抛异常", async () => {
  const tools = mount({ apiKey: VALID, baseUrl: "http://127.0.0.1:1", timeoutMs: 2000, cacheSeconds: 0 });
  const text = await call(tools, "deepseek_balance");
  assert.match(text, /查余额失败/);
});

await check("set_key 写文件（0600）后能查", async () => {
  const tools = mount({ apiKey: "", apiKeyFile: tmpFile, baseUrl, cacheSeconds: 0 });
  const saved = await call(tools, "deepseek_balance_set_key", { key: VALID });
  assert.match(saved, /已保存密钥/);
  assert.equal(fs.statSync(tmpFile).mode & 0o777, 0o600);
  const text = await call(tools, "deepseek_balance");
  assert.match(text, /状态：可用/);
  assert.match(text, new RegExp(`密钥文件 ${tmpFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

server.close();
console.log(process.exitCode ? `\n${passed} 项通过，有失败项` : `\n全部 ${passed} 项通过`);
