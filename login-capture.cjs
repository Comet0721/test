/**
 * 扫码登录采集工具：支持批量（串行，扫完一个自动开下一个）
 * 用法: node login-capture.cjs <账号备注名> [账号2 账号3 ...]
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const names = process.argv.slice(2).map(s => String(s).trim()).filter(Boolean);
if (!names.length) { console.log('用法: node login-capture.cjs <账号备注名> [账号2 ...]'); process.exit(1); }

const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
const ACTIVITY_URL = 'https://cloud.tencent.com/act/pro/featured-202607';
const MAX_WAIT = names.length > 1 ? 240 : 600;

function loadAccounts() {
  try { const a = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8').replace(/^\uFEFF/, '')); return Array.isArray(a) ? a : []; }
  catch (e) { return []; }
}
function saveAccount(entry) {
  const accounts = loadAccounts();
  const i = accounts.findIndex(a => a.name === entry.name);
  if (i >= 0) accounts[i] = entry; else accounts.push(entry);
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
  return accounts.length;
}

async function captureDeviceToken(page) {
  const found = await page.evaluate(() => new Promise(resolve => {
    const origSet = XMLHttpRequest.prototype.setRequestHeader;
    const origFetch = window.fetch;
    let finished = false;
    const restore = () => { XMLHttpRequest.prototype.setRequestHeader = origSet; window.fetch = origFetch; };
    const finish = (v) => { if (finished || !v) return; finished = true; clearTimeout(timer); restore(); resolve(String(v)); };
    let timer = setTimeout(() => { restore(); resolve(''); }, 25000);
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
      const r = origSet.apply(this, arguments);
      if (String(k).toLowerCase() === 'x-rce-token') finish(v);
      return r;
    };
    window.fetch = function (...args) {
      let req = args[0];
      if (!(req instanceof Request)) { try { req = new Request(args[0], args[1] || {}); } catch (e) {} }
      const v = req && req.headers ? req.headers.get('x-rce-token') : null;
      if (v) finish(v);
      return origFetch.apply(this, args);
    };
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && /rce|risk/i.test(k)) finish(localStorage.getItem(k)); } } catch (e) {}
    try { document.cookie.split(';').forEach(p => { if (/rce/i.test(p)) finish(p.split('=').slice(1).join('=').trim()); }); } catch (e) {}
  }));
  return found || '';
}

(async () => {
  let browser;
  try { browser = await chromium.launch({ channel: 'msedge', headless: false }); console.log('[*] 使用 Edge 浏览器'); }
  catch (e) { browser = await chromium.launch({ headless: false }); console.log('[*] Edge 不可用，回退到 Chromium'); }

  const results = [];
  for (let k = 0; k < names.length; k++) {
    const name = names[k];
    console.log('========== [' + (k + 1) + '/' + names.length + '] 请扫码账号「' + name + '」 ==========');
    const context = await browser.newContext({ locale: 'zh-CN' });
    const page = await context.newPage();
    try {
      await page.goto('https://cloud.tencent.com/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
      console.log('[*] 请在浏览器中扫码登录（可用微信/QQ）...');
      let loggedIn = false;
      for (let i = 0; i < MAX_WAIT; i++) {
        await page.waitForTimeout(1000);
        const url = page.url();
        if (!/login|passport|ssl\.ptlogin2/i.test(url)) { loggedIn = true; break; }
        const hasUser = await page.evaluate(() => { const t = document.body ? document.body.innerText : ''; return /控制台|退出登录|账号信息|费用中心/.test(t) && !/扫码|二维码/.test(t); }).catch(() => false);
        if (hasUser) { loggedIn = true; break; }
      }
      if (!loggedIn) { console.log('[!] 账号「' + name + '」等待登录超时，自动跳过到下一个'); results.push({ name, ok: false, reason: 'timeout' }); continue; }

      await page.waitForTimeout(2000);
      const cookies = await context.cookies();
      const uin = (cookies.find(c => c.name === 'uin') || {}).value || 'unknown';

      let deviceToken = '';
      try {
        await page.goto(ACTIVITY_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        deviceToken = await captureDeviceToken(page);
      } catch (e) { deviceToken = ''; }
      console.log(deviceToken ? '[OK] 已采集设备指纹 token' : '[!] 未采集到设备指纹（不影响基本抢购）');

      const total = saveAccount({ name, uin, savedAt: new Date().toISOString(), cookies, deviceToken });
      console.log('[OK] 账号「' + name + '」(uin=' + uin + ') 已保存，共 ' + total + ' 个账号');
      results.push({ name, ok: true, uin });
    } catch (e) {
      console.error('[ERR] 账号「' + name + '」处理失败:', e.message);
      results.push({ name, ok: false, reason: e.message });
    } finally {
      await context.close().catch(() => {});
    }
  }
  await browser.close().catch(() => {});
  const okN = results.filter(r => r.ok).length;
  console.log('========== 批量采集完成: ' + okN + '/' + names.length + ' 成功 ==========');
  for (const r of results) console.log('  ' + (r.ok ? '[OK]' : '[FAIL]') + ' ' + r.name + (r.ok ? ' (' + r.uin + ')' : ' - ' + r.reason));
  process.exit(0);
})().catch(e => { console.error('[ERR]', e); process.exit(1); });