/**
 * 方案B：浏览器代抢（独立于 sniper.cjs / webui，互不干扰）
 * 原理：真实 Edge 打开腾讯云活动页 -> 注入账号 cookie -> 页面自动生成真实指纹/X-RCE-TOKEN
 *      -> 到点后在页面 JS 环境直接发 do-goods（请求从浏览器环境出去，最接近真人操作）
 * 查询/场次/时钟复用 qcloud-client.cjs（Node 侧），仅 do-goods 走浏览器页面。
 * 用法: node browser-sniper.cjs [--accounts 落花成雨,金碧轩] [--lead 50] [--retry-interval 20] [--max-retries 200] [--parallel 2] [--goods 4核4G3M]
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { api, csrfToken, getSkey, UA } = require('./qcloud-client.cjs');
const { signDss } = require('./sign-engine.cjs');

const ROOT = __dirname;
const ACCOUNTS_FILE = path.join(ROOT, 'accounts.json');
const LOG_FILE = path.join(ROOT, 'browser-sniper-log.txt');

function opt(name, dflt) { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt; }
const CFG = {
  accounts: opt('--accounts', ''),
  leadMs: Number(opt('--lead', '50')),
  retryMs: Number(opt('--retry-interval', '20')),
  maxRetries: Number(opt('--max-retries', '200')),
  parallel: Math.max(1, Number(opt('--parallel', '2'))),
  goods: opt('--goods', '4核4G3M')
};

const ACTIVITY_ID = 164461404341040;
const REGION_NAMES = { 1: '广州', 4: '上海', 8: '北京' };
const REGIONS = [1, 4, 8];
const GOODS_MAP = {
  '4核4G3M': 1897632168296710,
  '流量包': 1897646058750049,
  '存储包': 1897655787435011
};
const TARGET_ACT_ID = GOODS_MAP[CFG.goods] || 1897632168296710;

const log = (...a) => { const line = '[' + new Date().toLocaleString('zh-CN', { hour12: false }) + '] ' + a.join(' '); console.log(line); fs.appendFileSync(LOG_FILE, line + '\n'); };

function loadAccounts() {
  const list = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8').replace(/^\uFEFF/, ''));
  if (CFG.accounts) { const names = new Set(CFG.accounts.split(',').map(s => s.trim())); return list.filter(a => names.has(a.name)); }
  return list;
}

function toPwCookies(cookies) {
  return (cookies || []).map(c => ({
    name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
    expires: (typeof c.expires === 'number' && c.expires > 0) ? c.expires : -1,
    httpOnly: !!c.httpOnly, secure: !!c.secure, sameSite: c.sameSite || 'Lax'
  }));
}

let serverOffset = 0;
async function syncClock(acct) {
  try {
    const r = await api(acct, { path: '/dianshi/get-now', body: {} });
    const j = JSON.parse(r.text);
    if (j.code === 0 && j.data) { serverOffset = j.data - Date.now(); return true; }
  } catch (e) {}
  return false;
}

// 抓页面请求头（x-rce-token / x-csrf-token 等）
function captureHeaders(page, store) {
  page.on('request', req => {
    try {
      const u = req.url();
      if (!/act-api\.cloud\.tencent\.com/.test(u)) return;
      const h = req.headers() || {};
      if (h['x-rce-token'] && !store.rceToken) store.rceToken = h['x-rce-token'];
      if (h['x-csrf-token'] && !store.csrfToken) store.csrfToken = h['x-csrf-token'];
      if (!store.referer) store.referer = h['referer'] || 'https://cloud.tencent.com/act/pro/featured-202607';
    } catch (e) {}
  });
}

// 在页面环境发 do-goods（带浏览器 cookie + 页面抓到的 token）
async function pageDoGoods(page, store, body, acct) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'X-CSRF-TOKEN': csrfToken(getSkey(acct)),
    'Origin': 'https://cloud.tencent.com',
    'Referer': store.referer || 'https://cloud.tencent.com/act/pro/featured-202607',
    'User-Agent': UA
  };
  if (store.rceToken) headers['x-rce-token'] = store.rceToken;
  try {
    const s = await signDss({ method: 'post', path: '/dianshi/do-goods', params: null, data: body, ua: UA, skey: getSkey(acct), time: Date.now() });
    headers['x-dss'] = s.value[0];
  } catch (e) {}
  const url = 'https://act-api.cloud.tencent.com/dianshi/do-goods';
  return await page.evaluate(async ({ url, headers, body }) => {
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), credentials: 'include' });
    return await r.text();
  }, { url, headers, body });
}

// 构造 do-goods body（4核4G3M 参数与参考项目一致）
function buildBody(regionId, defaultOrderParam) {
  const defParam = defaultOrderParam || {};
  const bundleType = defParam.type || 'bundle_budget_mc_lg4_01';
  const goodsParam = {
    BlueprintId: defParam.BlueprintId || 'LINUX_UNIX',
    area: defParam.area || 1,
    ddocUnionConnect: defParam.ddocUnionConnect || 0,
    goodsNum: defParam.goodsNum || 1,
    imageId: defParam.imageId || 'lhbp-eqora508',
    scenario: defParam.scenario || '0',
    timeSpanUnit: defParam.timeSpanUnit || '12m',
    zone: defParam.zone || '',
    regionId: regionId,
    type: bundleType
  };
  return {
    activity_id: ACTIVITY_ID,
    business: { id: 22755, from: 'lightningDeals' },
    goods: [{ act_id: TARGET_ACT_ID, type: bundleType, goods_param: goodsParam }],
    preview: 0,
    agent_channel: { fromChannel: '', fromSales: '', isAgentClient: false, fromUrl: 'https://cloud.tencent.com/act/pro/featured-202607?fromSource=gwzcw.12021631.12021631.12021631&utm_medium=cpc&utm_id=gwzcw.12021631.12021631.12021631' }
  };
}

async function main() {
  const accounts = loadAccounts();
  if (!accounts.length) { log('没有可用账号'); process.exit(1); }
  log('方案B浏览器代抢启动 | 商品: ' + CFG.goods + ' | 提前量: ' + CFG.leadMs + 'ms | 并行: ' + CFG.parallel + ' | 账号: ' + accounts.map(a => a.name).join(', '));

  // 时钟同步 + 场次查询（Node 侧）
  const probe = accounts[0];
  await syncClock(probe);
  log('服务器时间偏移: ' + serverOffset + 'ms');

  let sale = null, block = null;
  try {
    const r = await api(probe, { path: '/dianshi/query-seckill-by-date', body: { activity_id: ACTIVITY_ID, preview: 0, seckill_type: 'block', goods_type: 'goods', days: 2 } });
    const j = JSON.parse(r.text);
    const flash = (j.data && j.data.flashResult) || {};
    const now = Date.now();
    let best = null;
    for (const list of Object.values(flash)) {
      for (const b of list) {
        for (const s of (b.sales || [])) {
          if (s.act_id !== TARGET_ACT_ID) continue;
          const st = new Date(b.start_date + 'T' + b.start_time + '+08:00').getTime();
          if (st > now && (!best || st < best.st)) best = { st, block: b, sale: s };
        }
      }
    }
    if (best) { sale = best.sale; block = best.block; }
  } catch (e) { log('场次查询失败: ' + e.message); }
  if (!sale || !block) { log('未找到目标商品场次'); process.exit(1); }
  log('目标场次: ' + block.start_date + ' ' + block.start_time + '~' + block.end_time + ' | 商品: ' + (sale.goods_name || CFG.goods));

  const startTime = new Date(block.start_date + 'T' + block.start_time + '+08:00').getTime();

  // 为每个账号创建浏览器 context，注入 cookie，打开活动页抓 token
  let browser;
  try { browser = await chromium.launch({ channel: 'msedge', headless: false }); log('[*] 使用 Edge 浏览器（真实环境）'); }
  catch (e) { browser = await chromium.launch({ headless: false }); log('[*] Edge 不可用，回退 Chromium'); }

  const workers = [];
  for (const acct of accounts) {
    const ctx = await browser.newContext({ locale: 'zh-CN' });
    await ctx.addCookies(toPwCookies(acct.cookies || []));
    const page = await ctx.newPage();
    const store = {};
    captureHeaders(page, store);
    try { await page.goto('https://cloud.tencent.com/act/pro/featured-202607', { waitUntil: 'domcontentloaded', timeout: 45000 }); } catch (e) {}
    await page.waitForTimeout(6000);
    workers.push({ acct, ctx, page, store });
    log('[' + acct.name + '] 页面已就绪, 指纹token=' + (store.rceToken ? '已采集' : '未采集(继续抓取)'));
  }

  // 等待到点（提前 leadMs）
  const waitMs = startTime - Date.now() - CFG.leadMs;
  if (waitMs > 0) {
    log('距开抢 ' + Math.round(waitMs / 1000) + ' 秒，浏览器已就绪，等待中...');
    await new Promise(r => setTimeout(r, Math.max(waitMs, 0)));
  }

  log('>>> 开抢!');
  for (let i = 0; i < workers.length; i += CFG.parallel) {
    const group = workers.slice(i, i + CFG.parallel);
    await Promise.all(group.map(async ({ acct, page, store }) => {
      let done = false;
      for (let attempt = 0; attempt < CFG.maxRetries && !done; attempt++) {
        let res = null;
        try {
          const regionTasks = REGIONS.map(rid => pageDoGoods(page, store, buildBody(rid, sale.defaultOrderParam), acct).then(t => { try { return { rid, j: JSON.parse(t) }; } catch (e) { return { rid, j: null }; } }));
          const rs = await Promise.all(regionTasks);
          for (const r of rs) {
            if (!r.j) continue;
            if (r.j.code === 0) { log('[' + acct.name + '] 🎉 下单成功 ' + REGION_NAMES[r.rid] + '! ' + JSON.stringify(r.j.data)); try { require('child_process').execFileSync('powershell', ['-c', '[console]::beep(1000,800);[console]::beep(1200,800)']); } catch (e) {} done = true; break; }
            if (r.j.code === 408) { res = 'ratelimit'; }
            if (r.j.code === 1100106 || String(r.j.msg || '').indexOf('不满足') >= 0) { log('[' + acct.name + '] 资格拒绝: ' + (r.j.msg || r.j.code)); done = true; break; }
            if (r.j.code === 1005 || String(r.j.msg || '').indexOf('抢光') >= 0) { res = 'sellout'; }
          }
          if (done) break;
          if (res === 'ratelimit') { const back = 1500 + Math.floor(Math.random() * 1500); log('[' + acct.name + '] 限流退避 ' + back + 'ms'); await new Promise(r => setTimeout(r, back)); continue; }
          if (res === 'sellout' && attempt >= 5) { log('[' + acct.name + '] 已售罄，停止'); done = true; break; }
          if (attempt === 0) log('[' + acct.name + '] 第1轮: ' + rs.map(r => REGION_NAMES[r.rid] + ':' + (r.j ? r.j.code : 'net')).join(', '));
        } catch (e) { log('[' + acct.name + '] 请求异常: ' + e.message); }
        if (!done) await new Promise(r => setTimeout(r, CFG.retryMs));
      }
      if (!done) log('[' + acct.name + '] 达到最大重试次数');
    }));
  }

  log('===== 本轮结束 =====');
  await browser.close().catch(() => {});
  process.exit(0);
}

main().catch(e => { log('FATAL: ' + (e.stack || e.message)); process.exit(1); });