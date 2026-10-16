// qcloud API client: direct HTTP requests with account cookies + official sign engine
const fs = require('fs');
const path = require('path');
const { signDss } = require('./sign-engine.cjs');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BASE = 'https://act-api.cloud.tencent.com';

// djb2-style hash used for X-CSRF-TOKEN (from the page's login utils)
function csrfToken(skey) {
  let n = 5381;
  for (let i = 0; i < skey.length; i++) n += (n << 5) + skey.charCodeAt(i);
  return (n & 2147483647).toString();
}

function getSkey(account) {
  const c = account.cookies.find(x => x.name === 'skey') || account.cookies.find(x => x.name === 'p_skey');
  return c ? c.value : '';
}

function buildCookieHeader(account, host) {
  const parts = [];
  for (const c of account.cookies) {
    const d = (c.domain || '').replace(/^\./, '');
    if (d && (host === d || host.endsWith('.' + d))) parts.push(c.name + '=' + c.value);
  }
  return parts.join('; ');
}

async function api(account, { path: p, body, signed = false, host = 'act-api.cloud.tencent.com', extraHeaders = {} }) {
  const skey = getSkey(account);
  const cookie = buildCookieHeader(account, host);
  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    'X-CSRF-TOKEN': csrfToken(skey),
    'User-Agent': UA,
    'Cookie': cookie,
    'Origin': 'https://cloud.tencent.com',
    'Referer': 'https://cloud.tencent.com/act/pro/featured-202607',
    ...extraHeaders
  };
  if (account.deviceToken) headers['X-RCE-TOKEN'] = account.deviceToken;
  if (signed) {
    const nowTime = Date.now();
    const s = await signDss({ method: 'post', path: p, params: null, data: body, ua: UA, skey, time: nowTime });
    headers['x-dss'] = s.value[0];
  }
  const res = await fetch('https://' + host + p, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text };
}

module.exports = { api, csrfToken, getSkey, buildCookieHeader, UA };

