// ============================================================
// Qoder + JoyCode + DeepAI 合并网关（零依赖，Node 18+）
// 用途：把三份反代额度合成一个入口给 DSH 用。
//   DSH 只配 http://127.0.0.1:8320/v1
//   网关按模型名自动分流到 Qoder(8790) / JoyCode(8318) / DeepAI(8791)
// 配置：同目录 .env（说明见 使用说明.txt）
// ============================================================
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- .env 自加载（真环境变量优先） ----------
if (existsSync(join(__dirname, '.env'))) {
  for (const line of readFileSync(join(__dirname, '.env'), 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']+|["']+$/g, '');
  }
}

const CFG = {
  host:      process.env.GATEWAY_HOST || '127.0.0.1',
  port:      parseInt(process.env.GATEWAY_PORT || '8320', 10),
  qoder:     (process.env.QODER_BASE || 'http://127.0.0.1:8790').replace(/\/+$/, ''),
  joycode:   (process.env.JOYCODE_BASE || 'http://127.0.0.1:8318').replace(/\/+$/, ''),
  deepai:    (process.env.DEEPAI_BASE || '').replace(/\/+$/, ''),
  opencode:  (process.env.OPENCODE_BASE || '').replace(/\/+$/, ''),
  fallback:  (process.env.DEFAULT_UPSTREAM || 'qoder').toLowerCase(),
  cors:      process.env.CORS_ORIGINS || '*',
  timeoutMs: parseInt(process.env.TIMEOUT_MS || '300000', 10),
  clientKey: process.env.REQUIRE_CLIENT_KEY || '',
  // 自动降级：主模型失败（额度/排队/超时/拒权）时按链换模型重试
  failover:      (process.env.FAILOVER || '1') !== '0',
  failoverMs:    parseInt(process.env.FAILOVER_TIMEOUT_MS || '25000', 10),
  failoverChain: (process.env.FAILOVER_CHAIN || 'gpt-6-luna,GLM-5.3-agent,GLM-5.3')
                   .split(',').map(s => s.trim()).filter(Boolean),
  log:       (process.env.LOG_REQUESTS || '1') !== '0',
};
let manualMap = {};
try { manualMap = JSON.parse(process.env.MODEL_MAP || '{}'); }
catch { console.error('[gateway] MODEL_MAP 不是合法 JSON，已忽略'); manualMap = {}; }

const UPSTREAMS = {
  qoder:   CFG.qoder,
  joycode: CFG.joycode,
  ...(CFG.deepai ? { deepai: CFG.deepai } : {}),
  ...(CFG.opencode ? { opencode: CFG.opencode } : {}),
};

// ---------- 按通道的用量记账（JoyCode 上游不返回余额，只能看消耗） ----------
const USAGE_FILE = join(__dirname, 'usage.json');
const todayStr = () => new Date().toISOString().slice(0, 10);
const emptyBucket = () => ({ requests: 0, prompt: 0, completion: 0, failed: 0 });
const freshBuckets = () => {
  const b = {};
  for (const k of Object.keys(UPSTREAMS)) b[k] = emptyBucket();
  return b;
};
let USAGE = { date: todayStr(), today: freshBuckets(), total: freshBuckets() };
try {
  if (existsSync(USAGE_FILE)) {
    const u = JSON.parse(readFileSync(USAGE_FILE, 'utf-8'));
    if (u && u.total) {
      USAGE = u;
      if (USAGE.date !== todayStr()) { USAGE.date = todayStr(); USAGE.today = freshBuckets(); }
    }
  }
} catch { /* 账本坏了就从零开始，不影响转发 */ }

function recordUsage(upstream, { prompt = 0, completion = 0, ok = true } = {}) {
  if (!USAGE.today[upstream]) return;
  if (USAGE.date !== todayStr()) { USAGE.date = todayStr(); USAGE.today = freshBuckets(); }
  for (const bucket of [USAGE.today[upstream], USAGE.total[upstream]]) {
    bucket.requests += 1;
    bucket.prompt += prompt || 0;
    bucket.completion += completion || 0;
    if (!ok) bucket.failed += 1;
  }
  try { writeFileSync(USAGE_FILE, JSON.stringify(USAGE, null, 2)); } catch {}
}

// 从响应体（JSON 或 SSE 尾巴）里抠出 usage（usage 里可能嵌套 details，需括号配对）
function extractUsage(text) {
  if (!text) return { prompt: 0, completion: 0 };
  let idx = -1, from = 0;
  for (;;) {
    const k = text.indexOf('"usage"', from);
    if (k === -1) break;
    idx = k; from = k + 7;
  }
  if (idx === -1) return { prompt: 0, completion: 0 };
  const start = text.indexOf('{', idx);
  if (start === -1) return { prompt: 0, completion: 0 };
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          const u = JSON.parse(text.slice(start, i + 1));
          return { prompt: u.prompt_tokens || 0, completion: u.completion_tokens || 0 };
        } catch { return { prompt: 0, completion: 0 }; }
      }
    }
  }
  return { prompt: 0, completion: 0 };
}

// 模型 -> 上游 的路由表（启动时拉取，定期/按需刷新）
const routeTable = new Map();   // modelName -> 'qoder' | 'joycode'
let lastSync = 0;
let syncing = null;

async function fetchModels(name) {
  const base = UPSTREAMS[name];
  const r = await fetch(base + '/v1/models', { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const d = await r.json();
  const list = Array.isArray(d?.data) ? d.data : [];
  return list.map(m => (typeof m === 'string' ? m : m?.id)).filter(Boolean);
}

async function syncRoutes(force = false) {
  if (!force && Date.now() - lastSync < 120000) return;
  if (syncing) return syncing;
  syncing = (async () => {
    const prev = new Map(routeTable);
    routeTable.clear();
    for (const [name] of Object.entries(UPSTREAMS)) {
      try {
        const ids = await fetchModels(name);
        for (const id of ids) if (!routeTable.has(id)) routeTable.set(id, name);
      } catch (e) {
        console.error('[gateway] 拉取 ' + name + ' 模型列表失败:', e.message);
      }
    }
    // 本轮没拉到的，沿用上次的映射（上游临时故障不清空路由）
    for (const [m, up] of prev) if (!routeTable.has(m)) routeTable.set(m, up);
    // 手工映射优先
    for (const [model, up] of Object.entries(manualMap)) {
      if (UPSTREAMS[up]) routeTable.set(model, up);
    }
    lastSync = Date.now();
    const counts = Object.keys(UPSTREAMS).map(n =>
      n + '=' + [...routeTable.values()].filter(v => v === n).length + ' 个').join(', ');
    console.log('[gateway] 路由表已刷新: ' + counts);
  })().finally(() => { syncing = null; });
  return syncing;
}

function corsHeaders(req) {
  const origin = req.headers.origin || '';
  let allowOrigin = '*';
  if (CFG.cors.trim() !== '*') {
    const list = CFG.cors.split(',').map(s => s.trim()).filter(Boolean);
    allowOrigin = list.includes(origin) ? origin : '';
  }
  return {
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,PATCH,HEAD,OPTIONS',
    'access-control-allow-headers': req.headers['access-control-request-headers'] ||
      'content-type,authorization,x-api-key,x-requested-with',
    'access-control-max-age': '86400',
  };
}

function sendJson(res, status, obj, extra = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extra });
  res.end(body);
}

// 从请求体里取模型名（兼容 OpenAI 风格）
function pickModel(buf) {
  try {
    const j = JSON.parse(buf.toString('utf-8'));
    return typeof j.model === 'string' ? j.model : '';
  } catch { return ''; }
}

const REQ_SKIP = new Set(['host','connection','content-length','transfer-encoding','keep-alive','upgrade','expect','accept-encoding']);
const RES_SKIP = new Set(['connection','content-length','transfer-encoding','keep-alive','upgrade','content-encoding']);

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  const u = new URL(req.url, 'http://localhost');
  const cors = corsHeaders(req);

  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

    // ---- 健康检查：两个上游各探一次 ----
    if (u.pathname === '/health') {
      const info = { status: 'ok', service: 'qoder-joycode-gateway', port: CFG.port, upstreams: {} };
      for (const [name, base] of Object.entries(UPSTREAMS)) {
        try {
          const ids = await fetchModels(name);
          info.upstreams[name] = { url: base, reachable: true, models: ids.length };
        } catch (e) {
          info.upstreams[name] = { url: base, reachable: false, error: e.message };
        }
      }
      info.routes = routeTable.size;
      return void sendJson(res, 200, info, cors);
    }

    // ---- 客户端鉴权（可选） ----
    if (CFG.clientKey) {
      const got = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') ||
                  req.headers['x-api-key'] || '';
      if (got !== CFG.clientKey) {
        return void sendJson(res, 401, { error: { message: '客户端 key 不对或未提供', type: 'gateway_unauthorized' } }, cors);
      }
    }

    // ---- 模型列表：两边合并 ----
    if (u.pathname === '/v1/models' || u.pathname === '/models') {
      await syncRoutes();
      const merged = [];
      for (const [name, base] of Object.entries(UPSTREAMS)) {
        try {
          const r = await fetch(base + '/v1/models', { signal: AbortSignal.timeout(20000) });
          const d = await r.json();
          for (const m of (Array.isArray(d?.data) ? d.data : [])) {
            const id = typeof m === 'string' ? m : m?.id;
            if (!id) continue;
            merged.push(typeof m === 'object'
              ? { ...m, owned_by: 'gateway/' + name }
              : { id, object: 'model', owned_by: 'gateway/' + name });
          }
        } catch (e) {
          console.error('[gateway] /v1/models 拉取 ' + name + ' 失败:', e.message);
        }
      }
      return void sendJson(res, 200, { object: 'list', data: merged }, cors);
    }

    // ---- 根路径：只回一个最小状态（看板已移除） ----
    if (u.pathname === '/') {
      return void sendJson(res, 200, {
        status: 'ok',
        service: 'qoder-joycode-gateway',
        routes: routeTable.size,
        upstreams: Object.keys(UPSTREAMS),
      }, cors);
    }

    // ---- 其余请求：读 body，按模型分流 ----
    let reqBody;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const buf = Buffer.concat(chunks);
      if (buf.length) reqBody = buf;
    }

    const rawModel = reqBody ? pickModel(reqBody) : '';
    let model = rawModel;
    let forced = '';

    // 支持 "qoder/xxx"、"joycode/xxx" 前缀强制路由
    if (model.includes('/')) {
      const idx = model.indexOf('/');
      const p = model.slice(0, idx).toLowerCase();
      if (UPSTREAMS[p]) { forced = p; model = model.slice(idx + 1); }
    }

    if (!forced) await syncRoutes();
    let target = forced || routeTable.get(model) || '';
    if (!target) {
      await syncRoutes(true);              // 未知模型：强制刷新一次再试
      target = routeTable.get(model) || '';
    }
    if (!target) target = CFG.fallback;

    // 前缀被剥掉时，把 body 里的 model 改回裸名
    if (reqBody && forced && model !== rawModel) {
      try {
        const j = JSON.parse(reqBody.toString('utf-8'));
        j.model = model;
        reqBody = Buffer.from(JSON.stringify(j), 'utf-8');
      } catch {}
    }

    // 转发头
    const fwd = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (REQ_SKIP.has(k)) continue;
      fwd[k] = Array.isArray(v) ? v.join(', ') : v;
    }

    // ---- 自动降级：按 [原模型, ...降级链] 依次尝试 ----
    const isChatPath = u.pathname.includes('/chat/completions');
    const attempts = [model];
    if (isChatPath && CFG.failover) {
      for (const m of CFG.failoverChain) if (m && !attempts.includes(m)) attempts.push(m);
    }

    let upstream = null, usedModel = model, usedTarget = target, lastStatus = 0, lastErr = '';

    for (let i = 0; i < attempts.length; i++) {
      const attemptModel = attempts[i];
      let upTarget = target, bare = attemptModel;

      if (i > 0) {                                   // 降级链上的模型：重新解析路由
        let f2 = '';
        if (bare.includes('/')) {
          const ix = bare.indexOf('/');
          const p2 = bare.slice(0, ix).toLowerCase();
          if (UPSTREAMS[p2]) { f2 = p2; bare = bare.slice(ix + 1); }
        }
        await syncRoutes();
        upTarget = f2 || routeTable.get(bare) || '';
        if (!upTarget) {
          if (CFG.log) console.error('[gateway] 降级跳过（无路由）: ' + bare);
          continue;
        }
      }

      let body = reqBody;
      if (body && isChatPath) {                      // 改写 body 里的 model
        try {
          const j = JSON.parse(body.toString('utf-8'));
          j.model = bare;
          body = Buffer.from(JSON.stringify(j), 'utf-8');
        } catch {}
      }

      const ac = new AbortController();
      const budget = attempts.length > 1 ? CFG.failoverMs : CFG.timeoutMs;
      const timer = setTimeout(() => ac.abort(), budget);
      try {
        const resp = await fetch(UPSTREAMS[upTarget] + u.pathname + (u.search || ''), {
          method: req.method, headers: fwd, body, signal: ac.signal, redirect: 'manual',
        });
        if (resp.ok || i === attempts.length - 1) {
          upstream = resp; usedModel = bare; usedTarget = upTarget;
          break;
        }
        lastStatus = resp.status;
        try { lastErr = (await resp.text()).slice(0, 300); } catch {}
        if (CFG.log) console.error('[gateway] 降级: ' + bare + '@' + upTarget + ' HTTP ' + resp.status + ' ' + lastErr.slice(0, 120));
      } catch (e) {
        lastStatus = e.name === 'AbortError' ? 504 : 502;
        lastErr = e.name === 'AbortError' ? '超时(' + budget + 'ms)' : String(e.cause?.code || e.message);
        if (CFG.log) console.error('[gateway] 降级: ' + bare + '@' + upTarget + ' ' + lastErr);
        if (i === attempts.length - 1) throw e;
      } finally { clearTimeout(timer); }
    }

    const resHeaders = {};
    for (const [k, v] of upstream.headers) {
      if (RES_SKIP.has(k)) continue;
      resHeaders[k] = v;
    }
    const cookies = typeof upstream.headers.getSetCookie === 'function' ? upstream.headers.getSetCookie() : [];
    if (cookies.length) resHeaders['set-cookie'] = cookies;
    Object.assign(resHeaders, cors);
    resHeaders['x-gateway-upstream'] = usedTarget;
    resHeaders['x-gateway-model'] = usedModel;
    if (usedModel !== model) resHeaders['x-gateway-fallback'] = '1';
    res.writeHead(upstream.status, resHeaders);
    // 边转发边攒一段文本，事后从中抠 usage（流式取 SSE 尾巴，非流式取整个 JSON）
    const dec = new TextDecoder();
    let seen = '';
    const isChat = u.pathname.includes('/chat/completions');
    if (upstream.body) {
      for await (const chunk of upstream.body) {
        res.write(chunk);
        if (isChat && seen.length < 300000) seen += dec.decode(chunk, { stream: true });
      }
    }
    res.end();
    if (isChat) {
      const u2 = extractUsage(seen);
      recordUsage(usedTarget, { prompt: u2.prompt, completion: u2.completion, ok: upstream.ok });
    }
    if (CFG.log) console.log(req.method + ' ' + u.pathname + ' [' + (model || '-') + ' -> ' + usedModel + '@' + usedTarget + (usedModel !== model ? ' 降级' : '') + '] ' + upstream.status + ' ' + (Date.now() - t0) + 'ms');

  } catch (e) {
    const status = e.name === 'AbortError' ? 504 : 502;
    const msg = e.name === 'AbortError'
      ? '上游超时（超过 ' + CFG.timeoutMs + 'ms）'
      : '上游连接失败：' + (e.cause?.code || e.message);
    if (CFG.log) console.error(req.method + ' ' + u.pathname + ' -> ' + status + ' ' + msg);
    if (!res.headersSent) {
      sendJson(res, status, { error: { message: msg, type: status === 504 ? 'gateway_upstream_timeout' : 'gateway_upstream_unreachable', path: u.pathname } }, cors);
    } else {
      res.end();
    }
  }
});

server.on('clientError', (err, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {} });
process.on('uncaughtException', e => console.error('[gateway] 未捕获异常（已吞掉保活）:', e.message));

server.listen(CFG.port, CFG.host, async () => {
  console.log('[gateway] 已启动: http://' + CFG.host + ':' + CFG.port);
  console.log('[gateway] 上游: ' + Object.entries(UPSTREAMS).map(([n, b]) => n + ' ' + b).join(' | '));
  await syncRoutes(true);
});
