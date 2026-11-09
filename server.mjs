// ============================================================
// Qoder + JoyCode 合并网关（零依赖，Node 18+）
// 用途：把两份反代额度合成一个入口给 DSH 用。
//   DSH 只配 http://127.0.0.1:8320/v1
//   网关按模型名自动分流到 Qoder(8790) 或 JoyCode(8318)
// 配置：同目录 .env（说明见 使用说明.txt）
// ============================================================
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
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
  fallback:  (process.env.DEFAULT_UPSTREAM || 'qoder').toLowerCase(),
  cors:      process.env.CORS_ORIGINS || '*',
  timeoutMs: parseInt(process.env.TIMEOUT_MS || '300000', 10),
  clientKey: process.env.REQUIRE_CLIENT_KEY || '',
  log:       (process.env.LOG_REQUESTS || '1') !== '0',
};
let manualMap = {};
try { manualMap = JSON.parse(process.env.MODEL_MAP || '{}'); }
catch { console.error('[gateway] MODEL_MAP 不是合法 JSON，已忽略'); manualMap = {}; }

const UPSTREAMS = {
  qoder:   CFG.qoder,
  joycode: CFG.joycode,
};

// 模型 -> 上游 的路由表（启动时拉取，定期/按需刷新）
const routeTable = new Map();   // modelName -> 'qoder' | 'joycode'
let lastSync = 0;
let syncing = null;

async function fetchModels(name) {
  const base = UPSTREAMS[name];
  const r = await fetch(base + '/v1/models', { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const d = await r.json();
  const list = Array.isArray(d?.data) ? d.data : [];
  return list.map(m => (typeof m === 'string' ? m : m?.id)).filter(Boolean);
}

async function syncRoutes(force = false) {
  if (!force && Date.now() - lastSync < 120000) return;
  if (syncing) return syncing;
  syncing = (async () => {
    routeTable.clear();
    for (const [name] of Object.entries(UPSTREAMS)) {
      try {
        const ids = await fetchModels(name);
        for (const id of ids) if (!routeTable.has(id)) routeTable.set(id, name);
      } catch (e) {
        console.error('[gateway] 拉取 ' + name + ' 模型列表失败:', e.message);
      }
    }
    // 手工映射优先
    for (const [model, up] of Object.entries(manualMap)) {
      if (UPSTREAMS[up]) routeTable.set(model, up);
    }
    lastSync = Date.now();
    console.log('[gateway] 路由表已刷新: qoder=' +
      [...routeTable.values()].filter(v => v === 'qoder').length + ' 个, joycode=' +
      [...routeTable.values()].filter(v => v === 'joycode').length + ' 个');
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
          const r = await fetch(base + '/v1/models', { signal: AbortSignal.timeout(8000) });
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

    const outUrl = UPSTREAMS[target] + u.pathname + (u.search || '');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), CFG.timeoutMs);
    let upstream;
    try {
      upstream = await fetch(outUrl, { method: req.method, headers: fwd, body: reqBody, signal: ac.signal, redirect: 'manual' });
    } finally { clearTimeout(timer); }

    const resHeaders = {};
    for (const [k, v] of upstream.headers) {
      if (RES_SKIP.has(k)) continue;
      resHeaders[k] = v;
    }
    const cookies = typeof upstream.headers.getSetCookie === 'function' ? upstream.headers.getSetCookie() : [];
    if (cookies.length) resHeaders['set-cookie'] = cookies;
    Object.assign(resHeaders, cors);
    resHeaders['x-gateway-upstream'] = target;
    res.writeHead(upstream.status, resHeaders);
    if (upstream.body) for await (const chunk of upstream.body) res.write(chunk);
    res.end();
    if (CFG.log) console.log(req.method + ' ' + u.pathname + ' [' + (model || '-') + ' -> ' + target + '] ' + upstream.status + ' ' + (Date.now() - t0) + 'ms');

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
  console.log('[gateway] 上游 Qoder: ' + CFG.qoder + ' | JoyCode: ' + CFG.joycode);
  await syncRoutes(true);
});
