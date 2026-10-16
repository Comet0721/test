// 多账号并发抢购脚本 —— 腾讯云活动页秒杀（直连 HTTP，不模拟点击）
// 用法示例:
//   node sniper.cjs                          # 自动找下一场，抢 4核4G3M
//   node sniper.cjs --goods "4核4G3M"
//   node sniper.cjs --goods 1897632168296710  # 按 act_id 指定
//   node sniper.cjs --dry-run                 # 只监控不抢购
const fs = require('fs');
const path = require('path');
const { api, getSkey } = require('./qcloud-client.cjs');

// ---------- 参数解析 ----------
const args = process.argv.slice(2);
function opt(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
}
function flag(name) { return args.includes(name); }

const CFG = {
  goods: opt('--goods', '4核4G3M'),
  time: opt('--time', ''),
  leadMs: Number(opt('--lead', '0')),
  pollMs: Number(opt('--interval', '3000')),
  retryMs: Number(opt('--retry-interval', '10')),
  maxRetries: Number(opt('--max-retries', '30')),
  noPrepare: flag('--no-prepare'),
  subscribe: flag('--subscribe'),
  regions: opt('--regions', '1,4,8'),
  dryRun: flag('--dry-run'),
  only: opt('--only', ''),
  waveSize: Number(opt('--wave-size', '0')),
  waveGap: Number(opt('--wave-gap', '1200')),
  waveAttempts: Number(opt('--wave-attempts', '3')),
  verbose: flag('--verbose'),
};

const ACTIVITY_ID = 164461404341040;
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
const LOG_FILE = path.join(__dirname, 'sniper-log.txt');
const log = (...a) => { const line = '[' + new Date().toLocaleString('zh-CN', { hour12: false }) + '] ' + a.join(' '); console.log(line); fs.appendFileSync(LOG_FILE, line + '\n'); };

const REGION_ALIAS = { '广州':1,'华南':1, '上海':4,'华东':4, '北京':8,'华北':8 };
function parseRegions(str) { return str.split(',').map(s => s.trim()).filter(Boolean).map(s => REGION_ALIAS[s] || Number(s)).filter(n => [1,4,8].includes(n)); }
const REGIONS = parseRegions(CFG.regions); if (!REGIONS.length) { REGIONS.push(1,4,8); }
const REGION_NAMES = { 1: '广州', 4: '上海', 8: '北京' };

function loadAccounts() {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); } catch (e) { log('无法读取 accounts.json，请先运行: node login-capture.cjs <账号名>'); process.exit(1); }
  if (CFG.only) { const names = new Set(CFG.only.split(',').map(s => s.trim())); list = list.filter(a => names.has(a.name)); }
  return list;
}
let accounts = loadAccounts();
if (!accounts.length) { log('没有可用账号'); process.exit(1); }
log(`加载 ${accounts.length} 个账号: ${accounts.map(a => a.name).join(', ')}`);

// 时钟偏移
let clockOffset = 0;
async function syncClock() {
  try {
    const r = await api(accounts[0], { path: '/dianshi/get-now', body: {} });
    const j = JSON.parse(r.text);
    if (j.code === 0) { clockOffset = j.data - Date.now(); if (CFG.verbose) log(`服务器时间已同步, 偏移 ${clockOffset}ms`); return true; }
  } catch (e) {}
  return false;
}
const nowServer = () => Date.now() + clockOffset;

function parseSeckill(text) {
  const j = JSON.parse(text);
  if (j.code !== 0) throw new Error('query-seckill 失败: ' + j.msg);
  const flash = j.data.flashResult || {};
  const blocks = [];
  for (const [date, list] of Object.entries(flash)) for (const b of list) blocks.push(b);
  return blocks;
}
function findTarget(blocks) {
  const key = /^\d+$/.test(CFG.goods) ? CFG.goods : null;
  const now = nowServer();
  const hits = [];
  for (const b of blocks) {
    const sale = (b.sales || []).find(s => (key && String(s.act_id) === key) || (!key && (s.goods_name || '').includes(CFG.goods)));
    if (sale) hits.push({ block: b, sale });
  }
  if (!hits.length) return null;
  const active = hits.filter(h => h.block.endTime > now).sort((a, b) => a.block.startTime - b.block.startTime);
  if (active.length) return active[0];
  return null;
}

// ---------- 库存预检 ----------
async function checkAvailable(acct, sale) {
  try {
    const r = await api(acct, {
      path: '/dianshi/check-available',
      body: { activity_id: ACTIVITY_ID, goods: [{ act_id: sale.act_id, region_id: REGIONS }], preview: 0 }
    });
    const j = JSON.parse(r.text);
    if (j.code !== 0) return null;
    const goodsData = (j.data || [{}])[0];
    if (goodsData.available !== 1 || goodsData.user_available !== 1) return null;
    // 返回有库存的区域
    const quota = goodsData.quota || {};
    const availableRegions = [];
    for (const rid of REGIONS) {
      const q = (quota[String(rid)] || {});
      // 遍历 quota 下的 bundle key
      for (const key of Object.keys(q)) {
        if (q[key]?.available > 0) { availableRegions.push(rid); break; }
      }
    }
    return availableRegions.length ? availableRegions : null;
  } catch (e) { return null; }
}

// ---------- 抢购动作（单账号，多区域并发）----------
async function snipeAccount(acct, target, maxAttempts = CFG.maxRetries) {
  const { sale } = target;
  const defParam = sale.defaultOrderParam || {};
  // 从 API 数据提取正确的 type
  const bundleType = defParam.type || 'bundle_budget_mc_lg4_01';

  // 先预检库存，筛选有货区域
  // 账号可单独指定区域，未设置则用全局
  let targetRegions = (acct.regions && acct.regions.length) ? acct.regions.filter(n => [1,4,8].includes(n)) : REGIONS;
  if (!targetRegions.length) targetRegions = REGIONS;
  const available = await checkAvailable(acct, sale);
  if (available && available.length) {
    targetRegions = available;
    if (CFG.verbose) log(`${acct.name} 有货区域: ${targetRegions.map(r => REGION_NAMES[r]).join(', ')}`);
  }

  const REASONS = {};

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // prepare-do
    if (!CFG.noPrepare) {
      try {
        const pr = await api(acct, { path: '/dianshi/prepare-do', body: { activity_id: ACTIVITY_ID, act_id: sale.act_id, preview: 0, from_channel: '', agent_key: '', channel_tag: '' } });
        const pj = JSON.parse(pr.text);
        if (pj.code !== 0) {
          if (pj.code === 1003) return { status: 'rejected', code: pj.code, msg: pj.msg };
        }
      } catch (e) {}
    }

    // 多区域并发 do-goods
    const regionTasks = targetRegions.map(regionId => (async () => {
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
      const body = {
        activity_id: ACTIVITY_ID,
        business: { id: 22755, from: 'lightningDeals' },
        goods: [{ act_id: sale.act_id, type: bundleType, goods_param: goodsParam }],
        preview: 0,
        agent_channel: {
          fromChannel: '',
          fromSales: '',
          isAgentClient: false,
          fromUrl: 'https://cloud.tencent.com/act/pro/featured-202607?fromSource=gwzcw.12021631.12021631.12021631&utm_medium=cpc&utm_id=gwzcw.12021631.12021631.12021631'
        }
      };
      try {
        const r = await api(acct, { path: '/dianshi/do-goods', body, signed: true });
        const j = JSON.parse(r.text);
        return { regionId, regionName: REGION_NAMES[regionId], code: j.code, msg: j.msg, data: j.data };
      } catch (e) {
        return { regionId, regionName: REGION_NAMES[regionId], error: e.message };
      }
    })());

    const tasks = regionTasks.map((task, i) => (async () => { if (i > 0) await new Promise(r => setTimeout(r, 100 * i)); return await task; })()); const results = await Promise.all(tasks);
    const reasons = results.map(r => r.error ? `${r.regionName}:net=${r.error}` : `${r.regionName}:code=${r.code}`).join(', ');

        for (const r of results) {
      if (r.error) continue;
      if (r.code === 0) return { status: 'success', code: 0, msg: `${r.regionName} 下单成功`, region: r.regionName, reasons };
      if (r.code === 408) { REASONS['ratelimit'] = r; } // 频率限制，减速重试
      if (r.code === 1005 || (r.msg || '').includes('抢光')) { REASONS['sellout'] = r; }
      if (r.code === 1100106 || (r.msg || '').includes('不满足')) { REASONS['rejected'] = r; }
    }
    if (REASONS['ratelimit']) { const back = 2000 + Math.floor(Math.random() * 2000); log(`${acct.name} 触发限流，退避 ${back}ms`); await new Promise(r => setTimeout(r, back)); continue; }
    if (REASONS['rejected']) return { status: 'rejected', code: REASONS['rejected'].code, msg: REASONS['rejected'].msg, reasons };
    if (REASONS['sellout'] && attempt >= 1) return { status: 'sellout', code: REASONS['sellout'].code, msg: REASONS['sellout'].msg, reasons };

    if (CFG.verbose && attempt === 0) log(`${acct.name} 第1轮: ${reasons}`);
    if (attempt < CFG.maxRetries - 1) { const retryDelay = Math.min(CFG.retryMs * (1 + Math.floor(attempt / 5)), 1000); await new Promise(r => setTimeout(r, retryDelay)); }
  }
  return { status: 'timeout', msg: '达到最大重试次数' };
}

// 订阅
async function subscribeAccount(acct, target) {
  try {
    const { block, sale } = target;
    const sub = await api(acct, { path: '/dianshi/query-seckill-subs', body: { activity_id: ACTIVITY_ID, goods_ids: [sale.act_id] } });
    const sj = JSON.parse(sub.text);
    const subscribed = (sj.data?.subscribe_list || []).some(x => String(x.resource_id) === String(sale.act_id));
    if (!subscribed) {
      const s = await api(acct, { path: '/dianshi/subs-seckill', body: { activity_id: ACTIVITY_ID, session_id: block.id, goods_ids: [sale.act_id] } });
      const ssj = JSON.parse(s.text);
      return { code: ssj.code, msg: ssj.msg };
    }
    return { code: 0, msg: '已预约' };
  } catch (e) { return { code: -1, msg: String(e.message) }; }
}

// ---------- 主流程 ----------
(async () => {
  await syncClock();
  log(`目标商品: ${CFG.goods} | 提前量: ${CFG.leadMs}ms | 区域: ${REGIONS.map(r => REGION_NAMES[r]).join('/')}`);
  if (CFG.dryRun) log('DRY-RUN 模式：只监控，不抢购');

  let target = null;
  let subscribedFor = null;
  let lastSnipeAt = 0;
  let sessionSnipeAttempted = false;
  let lastSessionId = null;
  let timerBackup = null;
  let fetchErrors = 0;

  let firing = false; // 防重入锁
  async function fireSnipe(found, trigger) {
    if (CFG.dryRun || firing) return;
    accounts = loadAccounts();
    const { block, sale } = found;
    if (sale.available === 0) { log(`跳过发射: 已售罄`); return; }
    firing = true;
    lastSnipeAt = nowServer();
    sessionSnipeAttempted = true;
    log(`>>> 开抢! [${trigger}] ${block.start_time}-${block.end_time} | available=${sale.available}`);
    const results = [];
    const useWaves = CFG.waveSize > 0 && accounts.length > CFG.waveSize;
    if (useWaves) {
      const waves = Math.ceil(accounts.length / CFG.waveSize);
      for (let i = 0; i < accounts.length; i += CFG.waveSize) {
        const waveNo = Math.floor(i / CFG.waveSize) + 1;
        const group = accounts.slice(i, i + CFG.waveSize);
        log(`[波浪 ${waveNo}/${waves}] ${group.map(a => a.name).join('、')}`);
        const gps = [];
        for (const a of group) { gps.push(snipeAccount(a, found, CFG.waveAttempts)); if (group.length > 1) await new Promise(r => setTimeout(r, 200 + Math.floor(Math.random() * 300))); }
        const gr = await Promise.allSettled(gps);
        results.push(...gr);
        if (gr.some(r => r.status === 'fulfilled' && r.value && r.value.status === 'success')) { log('波浪抢购成功，停止后续波浪'); break; }
        if (i + CFG.waveSize < accounts.length) { const gap = CFG.waveGap + Math.floor(Math.random() * 800); log(`波浪间隔 ${gap}ms`); await new Promise(r => setTimeout(r, gap)); }
      }
    } else {
      const promises = []; const staggerBase = accounts.length > 3 ? 200 : 0;
      for (const a of accounts) { promises.push(snipeAccount(a, found)); if (staggerBase > 0) await new Promise(r => setTimeout(r, staggerBase + Math.floor(Math.random() * 300))); }
      const all = await Promise.allSettled(promises);
      results.push(...all);
    }
    for (let i = 0; i < accounts.length; i++) {
      const rr = results[i]; const res = rr ? (rr.status === 'fulfilled' ? rr.value : { status: 'error', msg: rr.reason?.message }) : { status: 'skipped', msg: '波浪提前停止' };
      log(`[${accounts[i].name}] ${res.status}${res.region ? ' ' + res.region : ''} ${res.msg || ''}${res.code !== undefined ? ' (code=' + res.code + ')' : ''}${res.reasons ? ' [' + res.reasons + ']' : ''}`);
      if (res.status === 'success') { try { require('child_process').execFileSync('powershell', ['-c', '[console]::beep(1000,800);[console]::beep(1200,800)']); } catch (e) {} }
    }
    firing = false;
  }

  while (true) {
    try {
      const r = await api(accounts[0], { path: '/dianshi/query-seckill-by-date', body: { activity_id: ACTIVITY_ID, preview: 0, seckill_type: 'block', goods_type: 'goods', days: 2 } });
      fetchErrors = 0;
      const blocks = parseSeckill(r.text);
      const found = findTarget(blocks);
      if (!found) { log('未找到目标商品场次，1 分钟后重试'); await new Promise(r => setTimeout(r, 60000)); continue; }
      target = found;
      const { block, sale } = found;
      const st = block.dynamic_status;
      const start = block.startTime;
      const end = block.endTime;
      const now = nowServer();
      const waitMs = start - now - CFG.leadMs;
      const isOpen = st === 1 && end > now;

      if (block.id !== lastSessionId) {
        lastSessionId = block.id;
        sessionSnipeAttempted = false;
      }

      if (st === 2) { log('场次已结束，等待下一场...'); await new Promise(r => setTimeout(r, 5000)); continue; }

      if (waitMs > 0) {
        const mm = Math.floor(waitMs / 60000), ss = Math.floor((waitMs % 60000) / 1000);
        log(`场次 ${block.start_date} ${block.start_time} 距开抢 ${mm}分${ss}秒 (${block.dynamic_status_cn || st})`);

        if (timerBackup) clearTimeout(timerBackup);
        timerBackup = setTimeout(async () => { log('!!! 定时器兜底触发 !!!'); await fireSnipe(found, 'timer'); }, Math.max(waitMs, 500));

        if (CFG.subscribe && subscribedFor !== block.id) {
          for (const acct of accounts) { const sr = await subscribeAccount(acct, found); if (CFG.verbose) log(`${acct.name} 预约: ${sr.msg}`); }
          subscribedFor = block.id;
        }
        await new Promise(r => setTimeout(r, Math.min(CFG.pollMs, Math.max(waitMs > 30000 ? 10000 : 2000, 1000))));
        await syncClock();
        continue;
      }

      if (isOpen) {
        const justStarted = now - start < 5000;
        const restock = sale.available === 1 && now - lastSnipeAt > 10000;
        const shouldFire = !sessionSnipeAttempted || justStarted || restock;
        if (!CFG.dryRun && shouldFire) {
          if (timerBackup) { clearTimeout(timerBackup); timerBackup = null; }
          await fireSnipe(found, justStarted ? 'justStarted' : restock ? 'restock' : 'firstAttempt');
        } else {
          log(`[${CFG.dryRun ? 'DRY-RUN' : '监控'}] 进行中: available=${sale.available} 进度=${Math.round((sale.process || 0) * 100)}%`);
        }
        await new Promise(r => setTimeout(r, CFG.dryRun ? 5000 : 2000));
        continue;
      }

      log('等待开抢...');
      await new Promise(r => setTimeout(r, 2000));
    } catch (e) {
      fetchErrors++;
      const backoff = Math.min(100 * Math.pow(2, Math.min(fetchErrors, 5)), 5000);
      log(`监控出错(连续${fetchErrors}次): ${e.message}，${backoff}ms 重试`);
      await new Promise(r => setTimeout(r, backoff));
    }
  }
})().catch(e => { log('FATAL: ' + e.stack); process.exit(1); });