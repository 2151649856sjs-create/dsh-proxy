# dsh-proxy · Qoder + JoyCode 合并网关

把 **Qoder** 和 **JoyCode** 两份额度合成**一个 OpenAI 兼容入口**，给 DSH / 任何 OpenAI 协议客户端用。
客户端只配一个 Base URL，网关按**模型名**自动分流到对应上游，哪边有额度走哪边。

零依赖，只需要 Node.js 18+。

```
   DSH / 任意 OpenAI 客户端
              │
              ▼
   ┌──────────────────────┐
   │   dsh-proxy  :8320   │   合并 /v1/models · 按模型名分流
   └──────────┬───────────┘
              │
      ┌───────┴────────┐
      ▼                ▼
 Qoder :8790      JoyCode :8318
 (13 个模型)        (5 个模型)
```

---

## 前置条件

1. **Node.js 18+**（自带 fetch，无需装任何依赖）
2. 本机已经跑着两个上游反代（本项目**不含**它们，需要你自己有）：
   - Qoder 反代，默认 `http://127.0.0.1:8790`
   - JoyCode 反代，默认 `http://127.0.0.1:8318`

   两个上游都要提供 `GET /v1/models` 和 `POST /v1/chat/completions`。如果你想接的不是这两个，
   只要它们兼容 OpenAI 协议，改 `.env` 里的地址即可。

---

## 快速开始

```bash
git clone https://github.com/2151649856sjs-create/dsh-proxy.git
cd dsh-proxy

# 1. 配置（Windows 下直接复制）
cp .env.example .env

# 2. 按需修改 .env（至少确认两个上游地址和端口）

# 3. 启动
node server.mjs
```

启动后：

| 地址 | 用途 |
|---|---|
| `http://127.0.0.1:8320/v1` | OpenAI 兼容接口（给客户端填） |
| `http://127.0.0.1:8320/health` | 健康检查（两个上游各探一次） |

Windows 用户也可以直接双击 `启动dsh反代.bat`（前台运行，关窗口即停），
或用 `开关.bat`（菜单式：启动 / 重启 / 停止 / 打开状态检查）。

---

## 配置项（`.env`）

| 键 | 默认值 | 说明 |
|---|---|---|
| `GATEWAY_HOST` | `127.0.0.1` | 监听地址，给局域网其他机器用改 `0.0.0.0` |
| `GATEWAY_PORT` | `8320` | 监听端口 |
| `QODER_BASE` | `http://127.0.0.1:8790` | Qoder 上游地址 |
| `JOYCODE_BASE` | `http://127.0.0.1:8318` | JoyCode 上游地址 |
| `DEFAULT_UPSTREAM` | `qoder` | 模型名认不出来时默认给谁 |
| `CORS_ORIGINS` | `*` | 允许来源，`*` 或逗号分隔白名单 |
| `TIMEOUT_MS` | `300000` | 上游超时（只管到拿到响应头，长回复/流式不会被掐） |
| `REQUIRE_CLIENT_KEY` | 空 | 设了就校验客户端 key（`Authorization: Bearer xxx` 或 `x-api-key`），留空不校验 |
| `MODEL_MAP` | 空 | 手工指定路由，JSON：`{"模型名":"qoder"}` 或 `"joycode"` |
| `LOG_REQUESTS` | `1` | 控制台请求日志 |

> 改了 `.env` 必须重启才算数。

---

## 路由规则

1. `GET /v1/models` —— 拉取两个上游的模型列表并合并返回，`owned_by` 标成 `gateway/qoder`、`gateway/joycode`
2. `POST /v1/chat/completions` —— 读请求体里的 `model`：
   - 属于 Qoder 名单 → 转发到 `QODER_BASE`
   - 属于 JoyCode 名单 → 转发到 `JOYCODE_BASE`
   - 认不出来 → 强制刷新一次模型表；仍认不出就用 `DEFAULT_UPSTREAM`
3. **前缀强制路由**：`model` 写成 `qoder/xxx` 或 `joycode/xxx`，网关剥掉前缀后强制走指定上游（同名模型、临时切换用）
4. 响应头带 `x-gateway-upstream`，标明这次实际走了谁
5. 其余路径按解析到的上游（或默认上游）转发，路径与查询参数原样保留
6. 模型路由表在启动时拉取，每 2 分钟或遇到未知模型时自动刷新

**HTTP 方法与头**：GET / POST / PUT / DELETE / PATCH / HEAD / OPTIONS 全支持；
除 `host`、`connection`、`content-length`、`accept-encoding` 这类由代理自管的头以外全部透传
（含 `Authorization`、`Content-Type`、`Cookie` 和自定义头）；响应头同样透传，**SSE 流式逐块转发**。

**跨域**：所有响应自动带 CORS 头，`OPTIONS` 预检直接 204，不打上游。

**错误处理**：

| 情况 | 返回 |
|---|---|
| 上游连不上 | `502` `{"error":{"message":"上游连接失败：ECONNREFUSED","type":"gateway_upstream_unreachable"}}` |
| 上游超时 | `504` `{"error":{"message":"上游超时…","type":"gateway_upstream_timeout"}}` |
| 上游自己报错（如额度不足） | **状态码和报文原样透传**，不吞 |
| 客户端 key 不对 | `401` |

---

## 接 DSH（可选）

DSH 的模型列表**不是从 `/v1/models` 拉的**，而是写在 profile 配置里。
在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 的 `llm-pi-ai.config.providers` 下加一段：

```yaml
      gateway:
        displayName: 双通道网关
        api: openai-completions
        baseURL: http://127.0.0.1:8320/v1
        apiKeyEnv: GATEWAY_API_KEY      # 必须给，否则报 No API key for provider
        defaultContextWindow: 262144
        defaultMaxTokens: 16384
        defaultInput:
          - text
        models:
          - id: Auto
            name: Auto（自动选）
          - id: GLM-5.3
            name: GLM-5.3
```

并在 `~/.dsh/.credentials.yaml` 的 `refs` 里登记一把钥匙（网关默认不校验，随便填）：

```yaml
refs:
  GATEWAY_API_KEY: local-gateway
```

改完**重启 DSH** 生效。模型 id 要和你上游真实返回的一致，可以先 `curl http://127.0.0.1:8320/v1/models` 看一眼。

---

---

## 一键启动 + 局域网/手机访问

Windows 上可以写一个「总控」脚本，把上游和网关一起拉起来（把三个路径改成你自己的）：

```bat
set "QDIR=D://path//to//qoder-proxy"
set "JDIR=D://path//to//joycode-proxy"
set "GDIR=D://path//to//dsh-proxy"
rem 缺哪个起哪个，起来后自检端口，最后打印访问地址
```

**局域网/手机调用**：把 `.env` 里的 `GATEWAY_HOST` 改成 `0.0.0.0`（默认值），
同一 WiFi 下的手机/平板可以直接调 `http://<电脑局域网IP>:8320/v1`。

> 第一次监听 `0.0.0.0` 时 Windows 可能弹防火墙提示，选「允许」；
> 没弹但手机打不开，就去防火墙里放行 TCP 8320。

**注意端口安全**：`0.0.0.0` 意味着同网段任何设备都能调你的模型接口。
只想本机用就改回 `127.0.0.1`；想对外又怕被蹭，就设 `REQUIRE_CLIENT_KEY`。

---

## 常见问题

**Q: 客户端报 `No API key for provider`？**
在 DSH 配置里给 provider 加 `apiKeyEnv`，并在凭据文件里登记同名 ref（见上文）。网关默认不校验 key，随便填。

**Q: 报 `connect-refused 127.0.0.1:8320`？**
网关没在跑。先 `node server.mjs` 或用 `开关.bat` 启动。另外客户端可能有熔断（几十秒才重试一次），启动后等一会儿或重启客户端。

**Q: 某个模型报「积分余额不足」？**
那是上游额度用完了，不是网关的问题——报文是原样透传的。换另一个通道的模型，或给上游续额度。

**Q: 想换上游？**
改 `.env` 的 `QODER_BASE` / `JOYCODE_BASE`，重启。只要对方兼容 OpenAI 协议就行。

**Q: 上游端口改了？**
同样改 `.env`，别改代码。

---

## 目录结构

```
dsh-proxy/
├── server.mjs            # 网关本体（零依赖）
├── .env.example          # 配置模板
├── 启动dsh反代.bat        # 前台启动（Windows）
├── 开关.bat              # 菜单式启动器（Windows）
├── start-dsh-proxy.bat   # 后台启动（Windows）
├── stop-dsh-proxy.bat    # 按端口停止（Windows）
└── 使用说明.txt           # 中文操作说明
```

## License

MIT
