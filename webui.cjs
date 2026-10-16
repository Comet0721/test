// 腾讯云抢购 Web 控制台 —— 本地服务（仅绑定 127.0.0.1）
// 启动: node webui.cjs   （或双击 run-webui.cmd）
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { api, getSkey } = require('./qcloud-client.cjs');

const ROOT = __dirname;
const WEB_DIR = path.join(ROOT, 'webui');
const ACCOUNTS_FILE = path.join(ROOT, 'accounts.json');
const LOG_FILE = path.join(ROOT, 'sniper-log.txt');
const ACTIVITY_ID = 164461404341040;
const CONFIG_FILE = path.join(ROOT, 'config.json');
const DEFAULT_CONFIG = { goods: '4核4G3M', time: '', leadMs: 50, retryMs: 500, maxRetries: 30, regions: '1', waveSize: 4, waveGap: 1200, waveAttempts: 3 };
function readConfig() {
  try { const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '')); return Object.assign({}, DEFAULT_CONFIG, c); } catch (e) { return Object.assign({}, DEFAULT_CONFIG); }
}
function writeConfig(c) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2)); }

// ---------- 工具 ----------
function readAccounts() {
  try {
    const list = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8').replace(/^\uFEFF/, ''));
    return Array.isArray(list) ? list : [];
  } catch (e) { return []; }
}
function writeAccounts(list) {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(list, null, 2));
}
function listAccounts() {
  return readAccounts().map(a => ({
    name: a.name, uin: a.uin || '', savedAt: a.savedAt || '',
    cookieCount: (a.cookies || []).length, hasToken: !!a.deviceToken, regions: a.regions || [],
    hasSkey: !!getSkey(a)
  }));
}
function logTail(n) {
  try {
    const lines = fs.readFileSync(LOG_FILE, 'utf8').split(/\r?\n/).filter(Boolean);
    return lines.slice(-n);
  } catch (e) { return []; }
}

// ---------- SSE 广播 ----------
const sseClients = new Set();
function broadcast(type, data) {
  const payload = 'event: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const res of sseClients) { try { res.write(payload); } catch (e) {} }
}
function serverLog(line) {
  const ts = new Date().toLocaleString('zh-CN', { hour12: false });
  broadcast('log', { line: '[' + ts + '] [webui] ' + line });
}

// ---------- 子进程管理 ----------
const procs = { login: null, sniper: null };

function findPlaywrightPath() {
  const candidates = [];
  if (process.env.NODE_PATH) candidates.push(process.env.NODE_PATH);
  candidates.push('C:\\Users\\A\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\node\\node_modules');
  for (const p of candidates) {
    try { if (fs.existsSync(path.join(p, 'playwright'))) return p; } catch (e) {}
  }
  return '';
}

function spawnNode(script, args, tag) {
  const env = { ...process.env };
  if (tag === 'login') {
    const np = findPlaywrightPath();
    if (np) env.NODE_PATH = np;
  }
  const child = spawn(process.execPath, [script, ...args], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const rec = { child, tag, startedAt: new Date().toISOString(), cmd: [process.execPath, script, ...args].join(' ') };
  const handle = (buf) => {
    const text = buf.toString().replace(/\r\n$/, '');
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      broadcast('log', { line: '[' + tag + '] ' + line, ts: Date.now() });
    }
  };
  child.stdout.on('data', handle);
  child.stderr.on('data', handle);
  child.on('error', e => broadcast('log', { line: '[' + tag + '] 启动失败: ' + e.message }));
  child.on('exit', (code) => {
    broadcast('log', { line: '[' + tag + '] 进程退出 code=' + code });
    if (procs[tag] && procs[tag].child === child) procs[tag] = null;
    broadcastStatus();
    if (tag === 'login') broadcast('accounts', listAccounts());
  });
  procs[tag] = rec;
  return rec;
}

function broadcastStatus() {
  broadcast('snipe-status', {
    running: !!procs.sniper, cmd: procs.sniper ? procs.sniper.cmd : '',
    startedAt: procs.sniper ? procs.sniper.startedAt : null
  });
  broadcast('login-status', {
    running: !!procs.login, name: procs.login ? procs.login.name : ''
  });
}

function stopProc(tag) {
  const rec = procs[tag];
  if (!rec) return { error: '没有正在运行的任务' };
  try { rec.child.kill(); } catch (e) {}
  return { ok: true };
}

// ---------- 接口逻辑 ----------
async function querySessions() {
  const accounts = readAccounts();
  if (!accounts.length) return { error: '还没有账号，请先在「账号」页扫码登录采集' };
  try {
    const r = await api(accounts[0], {
      path: '/dianshi/query-seckill-by-date',
      body: { activity_id: ACTIVITY_ID, preview: 0, seckill_type: 'block', goods_type: 'goods', days: 2 }
    });
    const j = JSON.parse(r.text);
    if (j.code !== 0) return { error: '查询失败: ' + (j.msg || r.text.slice(0, 200)) };
    const flash = j.data.flashResult || {};
    const blocks = [];
    for (const [date, list] of Object.entries(flash)) {
      for (const b of list) blocks.push(b);
    }
    blocks.sort((a, b) => a.startTime - b.startTime);
    return { blocks };
  } catch (e) {
    return { error: '请求失败: ' + e.message + '（可能网络不通或账号 cookie 过期）' };
  }
}

// ---------- HTTP 服务 ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.resolve(WEB_DIR, rel);
  if (file !== WEB_DIR && !file.startsWith(WEB_DIR + path.sep)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function sendJson(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function handleApi(req, res, url, method) {
  const p = url.pathname;
  if (method === 'GET' && p === '/api/bootstrap') {
    return sendJson(res, { accounts: listAccounts(), snipe: { running: !!procs.sniper, cmd: procs.sniper ? procs.sniper.cmd : '', startedAt: procs.sniper ? procs.sniper.startedAt : null }, login: { running: !!procs.login, name: procs.login ? procs.login.name : '' } });
  }
  if (method === 'GET' && p === '/api/accounts') return sendJson(res, { accounts: listAccounts() });
    if (method === 'POST' && p.startsWith('/api/accounts/') && p.endsWith('/relogin')) {
    if (procs.login) return sendJson(res, { error: '已有登录采集进行中，请先等待或停止' });
    const rname = decodeURIComponent(p.slice('/api/accounts/'.length, -'/relogin'.length));
    const rec = spawnNode('login-capture.cjs', [rname], 'login');
    rec.name = rname;
    broadcastStatus();
    return sendJson(res, { ok: true, name: rec.name });
  }
  if (method === 'POST' && p === '/api/login') {
    if (procs.login) return sendJson(res, { error: '已有登录采集进行中，请先等待或停止' });
    const { name } = await readBody(req);
    if (!name || !String(name).trim()) return sendJson(res, { error: '缺少账号备注名' });
    const rec = spawnNode('login-capture.cjs', [String(name).trim()], 'login');
    rec.name = String(name).trim();
    broadcastStatus();
    return sendJson(res, { ok: true, name: rec.name });
  }
  if (method === 'POST' && p === '/api/login/stop') return sendJson(res, stopProc('login'));
  if (method === 'DELETE' && p.startsWith('/api/accounts/')) {
    const name = decodeURIComponent(p.slice('/api/accounts/'.length));
    const before = readAccounts();
    const list = before.filter(a => a.name !== name);
    if (list.length === before.length) return sendJson(res, { error: '账号不存在' });
    writeAccounts(list);
    broadcast('accounts', listAccounts());
    serverLog('已删除账号: ' + name);
    return sendJson(res, { ok: true });
  }
  if (method === "PUT" && p.startsWith("/api/accounts/") && p.endsWith("/regions")) {
    const rname = decodeURIComponent(p.slice("/api/accounts/".length, -"/regions".length));
    const rlist = readAccounts();
    const racct = rlist.find(a => a.name === rname);
    if (!racct) return sendJson(res, { error: "账号不存在" });
    const body = await readBody(req);
    const ALIAS = { "广州":1,"华南":1, "上海":4,"华东":4, "北京":8,"华北":8 };
    racct.regions = Array.isArray(body.regions) ? body.regions.map(r => ALIAS[String(r).trim()] || Number(r)).filter(n => [1,4,8].includes(n)) : [];
    writeAccounts(rlist);
    return sendJson(res, { ok: true, regions: racct.regions });
  if (method === "PUT" && p.startsWith("/api/accounts/") && p.endsWith("/rename")) {
    const oldName = decodeURIComponent(p.slice("/api/accounts/".length, -"/rename".length));
    const { name: newName } = await readBody(req);
    if (!newName || !String(newName).trim()) return sendJson(res, { error: "名称不能为空" });
    const list = readAccounts();
    const acct = list.find(a => a.name === oldName);
    if (!acct) return sendJson(res, { error: "账号不存在" });
    if (list.some(a => a.name === newName)) return sendJson(res, { error: "名称已存在" });
    acct.name = String(newName).trim();
    writeAccounts(list);
    broadcast("accounts", listAccounts());
    serverLog("已改名: " + oldName + " -> " + newName);
    return sendJson(res, { ok: true });
  }
  }
  if (method === 'GET' && p === '/api/config') return sendJson(res, readConfig());
  if (method === 'PUT' && p === '/api/config') {
    const body = await readBody(req);
    const cfg = Object.assign({}, readConfig(), body);
    writeConfig(cfg);
    return sendJson(res, { ok: true, config: cfg });
  }
  if (method === 'GET' && p === '/api/sessions') return sendJson(res, await querySessions());
  if (method === 'POST' && p === '/api/snipe/start') {
    if (procs.sniper) return sendJson(res, { error: '抢购已在运行，请先停止' });
    const accounts = readAccounts();
    if (!accounts.length) return sendJson(res, { error: '还没有账号，请先扫码登录采集' });
    const body = await readBody(req);
    const args = [];
    if (body.goods) args.push('--goods', String(body.goods));
    if (body.time) args.push('--time', String(body.time));
    if (body.leadMs > 0) args.push('--lead', String(body.leadMs));
    if (body.retryMs > 0) args.push('--retry-interval', String(body.retryMs));
    if (body.maxRetries > 0) args.push('--max-retries', String(body.maxRetries));
    if (body.noPrepare) args.push('--no-prepare');
    if (body.waveSize > 0) args.push('--wave-size', String(body.waveSize));
    if (body.waveGap > 0) args.push('--wave-gap', String(body.waveGap));
    if (body.waveAttempts > 0) args.push('--wave-attempts', String(body.waveAttempts));
    if (body.dryRun) args.push('--dry-run');
    if (body.regions) args.push('--regions', String(body.regions));
    if (Array.isArray(body.only) && body.only.length) args.push('--only', body.only.join(','));
    const rec = spawnNode('sniper.cjs', args, 'sniper');
    broadcastStatus();
    return sendJson(res, { ok: true, cmd: rec.cmd });
  }
  if (method === 'POST' && p === '/api/snipe/stop') return sendJson(res, stopProc('sniper'));
  if (method === 'GET' && p === '/api/snipe/status') {
    return sendJson(res, { running: !!procs.sniper, cmd: procs.sniper ? procs.sniper.cmd : '', startedAt: procs.sniper ? procs.sniper.startedAt : null });
  }
  if (method === 'GET' && p === '/api/logs') {
    const n = Math.min(Number(url.searchParams.get('n') || 200), 2000);
    return sendJson(res, { lines: logTail(n) });
  }
  if (method === 'GET' && p === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write('retry: 3000\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }
  if (method === 'POST' && p === '/api/accounts/check-all') {
    const accounts = readAccounts();
    const results = [];
    for (const acct of accounts) {
      try {
        const r = await api(acct, {
          path: '/dianshi/check-available',
          body: { activity_id: ACTIVITY_ID, goods: [{ act_id: 1897632168296710, region_id: [1] }], preview: 0 }
        });
        const j = JSON.parse(r.text);
        const d = (j.data || [{}])[0];
        results.push({ name: acct.name, ok: j.code === 0 && d.available === 1 && d.user_available === 1, code: j.code, msg: j.msg });
      } catch (e) {
        results.push({ name: acct.name, ok: false, error: e.message });
      }
      await new Promise(r2 => setTimeout(r2, 200));
    }
    return sendJson(res, { results });
  }
  
  sendJson(res, { error: 'not found' }, 404);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url, req.method).catch(e => sendJson(res, { error: 'server: ' + e.message }, 500));
  } else {
    serveStatic(req, res, url.pathname);
  }
});

function listen(port, tries) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && tries > 0) { console.log('端口 ' + port + ' 被占用，尝试 ' + (port + 1) + '...'); listen(port + 1, tries - 1); }
    else { console.error('启动失败: ' + e.message); process.exit(1); }
  });
  server.listen(port, '127.0.0.1', () => {
    console.log('腾讯云抢购控制台已启动: http://127.0.0.1:' + port);
    serverLog('控制台已启动 http://127.0.0.1:' + port);
    try { spawn('cmd', ['/c', 'start', '', 'http://127.0.0.1:' + port], { detached: true, stdio: 'ignore' }).unref(); } catch (e) {}
  });
}
const argPort = Number(process.argv[2] || 8790);
listen(argPort, 5);

process.on('exit', () => { for (const t of ['login', 'sniper']) { if (procs[t]) { try { procs[t].child.kill(); } catch (e) {} } } });