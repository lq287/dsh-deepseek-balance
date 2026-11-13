# dsh-deepseek-balance

在 DSH 里直接查 DeepSeek 账户余额的插件。给模型两个工具，走官方 `GET /user/balance`：

| 工具 | 作用 |
| --- | --- |
| `deepseek_balance` | 查余额：可用状态 + 每个币种的总余额 / 赠金 / 充值余额。参数 `currency`（只看某个币种）、`refresh`（跳过缓存）。只读、无副作用。 |
| `deepseek_balance_set_key` | 把用户明确给出的 API key 写进本机密钥文件（权限 0600）。只在用户主动交 key 时用。 |

输出长这样：

```
DeepSeek 账户余额（2026-11-13 17:12:30，api.deepseek.com）
状态：可用
· CNY：总 110.00 元（赠金 10.00 元 · 充值 100.00 元）
密钥：sk-ab…wxyz（来自 密钥文件 /…/dsh-home/deepseek-balance.key）
```

## key 从哪来（按优先级）

1. 插件配置 `apiKey` —— 在「设置 → 插件 → DeepSeek 余额」里填，改完立即生效；
2. 密钥文件 —— 默认 `$DSH_HOME/deepseek-balance.key`（一行纯文本），路径可用 `apiKeyFile` 改；
3. 环境变量 —— `DEEPSEEK_API_KEY` / `DEEPSEEK_KEY` / `DSH_DEEPSEEK_API_KEY`。

都没有时，`deepseek_balance` 不会报错崩掉，而是返回一段「三种配法」的说明。

## 安装到别的 DSH

npm 上**还没有**发布（作者 npm 账号受限），从 GitHub 装：

```bash
# 1) 装进某个 profile（web / tui / headless / desktop 一样）
dsh plugin --profile web add github:lq287/dsh-deepseek-balance

# 2) 把 "dsh-deepseek-balance" 加进该 profile 的 dsh.profile.bundles
#    （$DSH_HOME/profiles/web/package.json）

# 3) 重启 dsh
```

不想用 git 的话，把仓库目录拷过去，用 `file:/绝对路径` 代替上面那条 `github:` 也一样。

要求：DSH 引擎 **0.2.1+**（靠它的 profile 解析把 `@deepseek-ai/*` peer 注入引擎实例）、**Node 22+**。

## 本机（android profile）的安装记录

插件是一条 cordis bundle：`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，
里面 `insert` 一行 `id: deepseek-balance`。装进某个 profile 要动三处：

1. profile 的 `package.json`：`dependencies` 加 `"dsh-deepseek-balance": "file:<插件目录>"`；
2. 同一个文件的 `dsh.profile.bundles` 追加 `"dsh-deepseek-balance"`；
3. 在 profile 目录跑 `pnpm install`（DSH 自带 pnpm），然后**重启 DSH**。

卸载就是反过来：从 `dependencies` 和 `bundles` 里删掉，`pnpm install`，重启。
（`cordis.patch.yml` 是插件自带的，删掉依赖后它自然不再插进来。）

## 配置项

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `apiKey` | 空 | DeepSeek API key |
| `apiKeyFile` | 空 | 密钥文件路径；空 = `$DSH_HOME/deepseek-balance.key` |
| `baseUrl` | `https://api.deepseek.com` | 换代理时改这里 |
| `timeoutMs` | `15000` | 单次请求超时 |
| `cacheSeconds` | `20` | 结果缓存秒数，0 = 不缓存；`refresh=true` 可绕过 |

## 错误怎么读

- `HTTP 401/403` → key 无效或已停用，换 key；
- `HTTP 429` → 查太频繁，等一会儿；
- `HTTP 5xx` → DeepSeek 服务端问题，不是配置问题；
- 超时 → 网络/代理慢，调大 `timeoutMs`；
- 没 key → 会直接告诉你三种配法。

## 安全

- key 只存在本机（插件配置 / 0600 密钥文件 / 环境变量），插件日志和返回值都只打印掩码（`sk-ab…wxyz`）；
- 不往任何第三方地址发数据，只打 `baseUrl` 上的 `/user/balance`；
- 没有第三方运行依赖（只用 Node 自带 `fetch`）。

## 开发

`test/smoke.mjs` 起一个本地 HTTP 服务冒充余额接口，跑 7 项断言（无 key 提示、渲染、币种过滤、缓存、
401 文案、断网、set_key 写 0600）。插件是 ESM，直接 `import "@deepseek-ai/schemastery"`，
所以跑测试时它必须能解析到这三个 peer：

```
node --version          # >= 22
mkdir -p $H/node_modules/@deepseek-ai
ln -s <engine>/node_modules/@deepseek-ai/schemastery $H/node_modules/@deepseek-ai/
ln -s <engine>/node_modules/@deepseek-ai/dsh-tools   $H/node_modules/@deepseek-ai/
ln -s <engine>/node_modules/@deepseek-ai/cordis      $H/node_modules/@deepseek-ai/
cp -r plugin $H/node_modules/dsh-deepseek-balance
cd $H/node_modules/dsh-deepseek-balance && node test/smoke.mjs
```
