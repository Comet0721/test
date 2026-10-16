// 腾讯云抢购控制台 —— 前端逻辑
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let accounts = [];
let snipe = { running: false, cmd: '', startedAt: null };
let login = { running: false, name: '' };
let onlySelection = null;
const seenAccounts = new Set();
function persistOnly() {
  try { localStorage.setItem('snipe_only_selection', JSON.stringify([...onlySelection])); localStorage.setItem('snipe_seen_accounts', JSON.stringify([...seenAccounts])); } catch (e) {}
}
function restoreOnly() {
  try {
    const s = localStorage.getItem('snipe_seen_accounts');
    if (s) JSON.parse(s).forEach(n => seenAccounts.add(n));
    const o = localStorage.getItem('snipe_only_selection');
    if (o) { onlySelection = new Set(JSON.parse(o)); return; }
  } catch (e) {}
  onlySelection = new Set();
}
const cookieStatus = {}; // 账号名 -> Cookie 检测结果文本，避免重渲染时丢失

async function apiGet(url) { const r = await fetch(url); return r.json(); }
async function apiSend(url, method, body) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
}
function fmtTime(iso) { if (!iso) return '-'; try { return new Date(iso).toLocaleString('zh-CN', { hour12: false }); } catch (e) { return iso; } }
function fmtTs(ms) { if (!ms) return '-'; return new Date(ms).toLocaleString('zh-CN', { hour12: false }); }

// ---------- 选项卡 ----------
function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + name));
}
document.querySelectorAll('.tab-btn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
// ---------- 表单记忆 ----------
["cfg-goods","cfg-time","cfg-lead","cfg-regions","cfg-retries","cfg-retry-ms","cfg-wave-size","cfg-wave-gap","cfg-wave-attempts"].forEach(id => {
  const el = $(id);
  if (!el) return;
  const saved = localStorage.getItem("snipe_" + id);
  if (saved !== null) el.value = saved;
  el.addEventListener("change", () => localStorage.setItem("snipe_" + id, el.value));
  el.addEventListener("input", () => localStorage.setItem("snipe_" + id, el.value));
});
if ($("cfg-dry")) {
  if (localStorage.getItem("snipe_cfg-dry") === "true") $("cfg-dry").checked = true;
  $("cfg-dry").addEventListener("change", () => localStorage.setItem("snipe_cfg-dry", $("cfg-dry").checked));
}

// ---------- 账号 ----------
function renderAccounts() {
  const tbody = $('account-tbody');
  tbody.innerHTML = '';
  if (!accounts.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty">还没有账号，先扫码登录采集一个吧</td></tr>';
  }
  for (const a of accounts) {
    const tr = document.createElement('tr');
    const del = document.createElement('button');
    del.className = 'btn danger sm';
    del.textContent = '删除';
    del.addEventListener('click', async () => {
      if (!confirm('确定删除账号「' + a.name + '」？')) return;
      const res = await apiSend('/api/accounts/' + encodeURIComponent(a.name), 'DELETE');
      if (res.error) { alert(res.error); return; }
      delete cookieStatus[a.name];
    });
    const tdR = document.createElement('td');
    tdR.style.cssText = 'white-space:nowrap;font-size:12px;';
    const regs = a.regions || [];
    for (const [rid, rname] of [[1,'广州'],[4,'上海'],[8,'北京']]) {
      const lbl = document.createElement('label');
      lbl.className = 'check';
      lbl.style.cssText = 'margin-right:4px;';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = rid;
      cb.checked = regs.length === 0 || regs.includes(rid);
      cb.addEventListener('change', async () => {
        const checked = [...tdR.querySelectorAll('input:checked')].map(c => Number(c.value));
        const toSave = (checked.length === 0 || checked.length === 3) ? [] : checked;
        await apiSend('/api/accounts/' + encodeURIComponent(a.name) + '/regions', 'PUT', { regions: toSave });
      });
      lbl.appendChild(cb);
      lbl.appendChild(document.createTextNode(rname));
      tdR.appendChild(lbl);
    }
    const reloginBtn = document.createElement('button');
    reloginBtn.className = 'btn sm';
    reloginBtn.textContent = '重新扫码';
    reloginBtn.title = '重新扫码登录，更新cookie';
    reloginBtn.addEventListener('click', async () => {
      if (!confirm('确定重新扫码账号「' + a.name + '」？将弹出浏览器窗口。')) return;
      const res = await apiSend('/api/accounts/' + encodeURIComponent(a.name) + '/relogin', 'POST');
      if (res.error) { alert(res.error); return; }
      delete cookieStatus[a.name];
    });
    const renameBtn = document.createElement('button');
    renameBtn.className = 'btn sm';
    renameBtn.textContent = '改名';
    renameBtn.addEventListener('click', async () => {
      const nw = prompt('新名称:', a.name);
      if (!nw || nw === a.name) return;
      const res = await apiSend('/api/accounts/' + encodeURIComponent(a.name) + '/rename', 'PUT', { name: nw });
      if (res.error) { alert(res.error); return; }
    });
    tr.innerHTML = '<td>' + esc(a.name) + '</td><td>' + esc(a.uin) + '</td><td>' + esc(fmtTime(a.savedAt)) + '</td><td>' + a.cookieCount + '</td><td>' + (a.hasToken ? '✔' : '—') + '</td><td class="cookie-status" data-name="' + esc(a.name) + '">' + esc(cookieStatus[a.name] || '-') + '</td><td></td><td></td>';
    tr.children[6].appendChild(tdR);
    tr.lastElementChild.appendChild(reloginBtn);
    tr.lastElementChild.appendChild(renameBtn);
    tr.lastElementChild.appendChild(del);
    tbody.appendChild(tr);
  }
  $('account-count').textContent = accounts.length;
  renderOnlyAccounts();
}

function renderOnlyAccounts() {
  const box = $('only-accounts');
  box.innerHTML = '';
  if (!accounts.length) { box.innerHTML = '<span class="hint">先采集账号</span>'; return; }
  if (onlySelection === null) restoreOnly();
  for (const a of accounts) {
    if (!seenAccounts.has(a.name)) { seenAccounts.add(a.name); onlySelection.add(a.name); }
    const label = document.createElement('label');
    label.className = 'check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.name = 'only';
    cb.value = a.name;
    cb.checked = onlySelection.has(a.name);
    cb.addEventListener('change', () => { if (cb.checked) onlySelection.add(a.name); else onlySelection.delete(a.name); persistOnly(); });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(' ' + a.name));
    box.appendChild(label);
  }
}
function renderLoginStatus() {
  const pill = $('pill-login');
  const st = $('login-status');
  if (login.running) {
    pill.textContent = '登录采集：进行中（' + login.name + '）';
    pill.className = 'pill run';
    st.textContent = '正在打开浏览器，请在弹出的 Edge 窗口中扫码登录…';
    $('btn-login').disabled = true;
    $('btn-login-stop').disabled = false;
  } else {
    pill.textContent = '登录采集：空闲';
    pill.className = 'pill idle';
    st.textContent = '';
    $('btn-login').disabled = false;
    $('btn-login-stop').disabled = true;
  }
}

$('btn-login').addEventListener('click', async () => {
  const name = $('login-name').value.trim();
  if (!name) { alert('请输入账号备注名'); return; }
  const res = await apiSend('/api/login', 'POST', { name });
  if (res.error) { alert(res.error); return; }
  $('login-name').value = '';
});
$('btn-login-stop').addEventListener('click', async () => { await apiSend('/api/login/stop', 'POST'); });

// ---------- 场次 ----------
async function refreshSessions() {
  $('sessions-status').textContent = '查询中…';
  const res = await apiGet('/api/sessions');
  if (res.error) { $('sessions-status').textContent = res.error; $('sessions-list').innerHTML = '<div class="empty">' + esc(res.error) + '</div>'; return; }
  $('sessions-status').textContent = '共 ' + res.blocks.length + ' 个场次';
  renderBlocks(res.blocks);
}

function statusTag(b) {
  const st = b.dynamic_status;
  if (st === 1) return '<span class="tag open">进行中</span>';
  if (st === 2) return '<span class="tag end">已结束</span>';
  return '<span class="tag wait">未开始</span>';
}

function renderBlocks(blocks) {
  const list = $('sessions-list');
  list.innerHTML = '';
  if (!blocks.length) { list.innerHTML = '<div class="empty">没有查到场次，可能活动已结束或接口返回为空</div>'; return; }
  for (const b of blocks) {
    const card = document.createElement('div');
    card.className = 'session-card';
    const sales = (b.sales || []).filter(s => s && s.act_id);
    let rows = '';
    if (!sales.length) rows = '<div class="empty">该场次无商品数据</div>';
    for (const s of sales) {
      const avail = s.available === 1 ? '有货' : (s.available === 0 ? '抢光/下架' : '未知');
      const proc = s.process != null ? Math.round(s.process * 100) + '%' : '';
      rows += '<div class="goods-row" data-gid="' + esc(s.act_id) + '" data-gname="' + esc(s.goods_name || '') + '">'
        + '<span class="gname">' + esc(s.goods_name || ('商品 ' + s.act_id)) + '</span>'
        + '<span class="badge-avail">' + esc(avail) + '</span>'
        + (proc ? '<span class="badge-avail">进度 ' + esc(proc) + '</span>' : '')
        + '<span class="gid">act_id: ' + esc(s.act_id) + '</span>'
        + '</div>';
    }
    card.innerHTML = '<div class="session-head"><span class="time">' + esc(b.start_date + ' ' + b.start_time) + ' → ' + esc(b.end_time) + '</span>' + statusTag(b) + (b.dynamic_status_cn ? '<span class="tag">' + esc(b.dynamic_status_cn) + '</span>' : '') + '</div>' + rows;
    list.appendChild(card);
  }
  list.querySelectorAll('.goods-row').forEach(row => {
    row.addEventListener('click', () => {
      $('cfg-goods').value = row.dataset.gname || row.dataset.gid;
      switchTab('snipe');
    });
  });
}
$('btn-refresh-sessions').addEventListener('click', refreshSessions);

// ---------- 抢购 ----------
function renderSnipeStatus() {
  const pill = $('pill-snipe');
  const st = $('snipe-status');
  if (snipe.running) {
    pill.textContent = '抢购：运行中';
    pill.className = 'pill run';
    st.textContent = '运行中（启动于 ' + fmtTime(snipe.startedAt) + '）';
    $('btn-snipe-start').disabled = true;
    $('btn-snipe-stop').disabled = false;
  } else {
    pill.textContent = '抢购：空闲';
    pill.className = 'pill idle';
    st.textContent = '';
    $('btn-snipe-start').disabled = false;
    $('btn-snipe-stop').disabled = true;
  }
}

$('btn-snipe-start').addEventListener('click', async () => {
  const only = [...document.querySelectorAll('input[name="only"]:checked')].map(c => c.value);
  const body = {
    goods: $('cfg-goods').value.trim() || '4核4G3M',
    time: $('cfg-time').value.trim(),
    leadMs: parseInt($('cfg-lead').value || '0', 10),
    retryMs: parseInt($('cfg-retry-ms').value || '100', 10),
    maxRetries: parseInt($('cfg-retries').value || '30', 10),
    waveSize: parseInt($('cfg-wave-size').value || '0', 10),
    waveGap: parseInt($('cfg-wave-gap').value || '1200', 10),
    waveAttempts: parseInt($('cfg-wave-attempts').value || '3', 10),
    dryRun: $('cfg-dry').checked,
    regions: $('cfg-regions').value.trim() || '',
    only
  };
  const res = await apiSend('/api/snipe/start', 'POST', body);
  if (res.error) { alert(res.error); return; }
  switchTab('log');
});
$('btn-snipe-stop').addEventListener('click', async () => {
  const res = await apiSend('/api/snipe/stop', 'POST');
  if (res.error) alert(res.error);
});
$('btn-config-save').addEventListener('click', async () => {
  const cfg = {
    goods: $('cfg-goods').value.trim() || '4核4G3M',
    time: $('cfg-time').value.trim(),
    leadMs: parseInt($('cfg-lead').value || '0', 10),
    retryMs: parseInt($('cfg-retry-ms').value || '500', 10),
    maxRetries: parseInt($('cfg-retries').value || '30', 10),
    regions: $('cfg-regions').value.trim() || '1',
    waveSize: parseInt($('cfg-wave-size').value || '4', 10),
    waveGap: parseInt($('cfg-wave-gap').value || '1200', 10),
    waveAttempts: parseInt($('cfg-wave-attempts').value || '3', 10)
  };
  const res = await apiSend('/api/config', 'PUT', cfg);
  if (res.ok) { alert('配置已保存，全局生效'); } else { alert(res.error || '保存失败'); }
});

// ---------- 日志 ----------
let logLines = [];
function appendLog(line) {
  logLines.push(line);
  const view = $('log-view');
  view.textContent = logLines.join('\n');
  if ($('log-autoscroll').checked) view.scrollTop = view.scrollHeight;
}
$('btn-log-clear').addEventListener('click', () => { logLines = []; $('log-view').textContent = ''; });

// ---------- SSE ----------
function setupSSE() {
  const es = new EventSource('/api/events');
  es.addEventListener('log', e => { try { appendLog(JSON.parse(e.data).line); } catch (err) {} });
  es.addEventListener('accounts', e => { const d = JSON.parse(e.data); accounts = Array.isArray(d) ? d : (d.accounts || []); renderAccounts(); });
  es.addEventListener('snipe-status', e => { snipe = JSON.parse(e.data); renderSnipeStatus(); });
  es.addEventListener('login-status', e => { login = JSON.parse(e.data); renderLoginStatus(); });
  es.onerror = () => { /* EventSource 自动重连 */ };
}

// ---------- 初始化 ----------
(async function init() {
  setupSSE();
  const boot = await apiGet('/api/bootstrap');
  accounts = boot.accounts || [];
  snipe = boot.snipe || { running: false };
  login = boot.login || { running: false };
  renderAccounts();
  try {
    const cfg = await apiGet('/api/config');
    if (cfg && cfg.goods) {
      if (cfg.goods) $('cfg-goods').value = cfg.goods;
      if (cfg.time) $('cfg-time').value = cfg.time;
      if (cfg.leadMs != null) $('cfg-lead').value = cfg.leadMs;
      if (cfg.retryMs != null) $('cfg-retry-ms').value = cfg.retryMs;
      if (cfg.maxRetries != null) $('cfg-retries').value = cfg.maxRetries;
      if (cfg.regions) $('cfg-regions').value = cfg.regions;
      if (cfg.waveSize != null) $('cfg-wave-size').value = cfg.waveSize;
      if (cfg.waveGap != null) $('cfg-wave-gap').value = cfg.waveGap;
      if (cfg.waveAttempts != null) $('cfg-wave-attempts').value = cfg.waveAttempts;
    }
  } catch (e) {}
  renderSnipeStatus();
  renderLoginStatus();
  const logs = await apiGet('/api/logs?n=300');
  logLines = (logs.lines || []);
  $('log-view').textContent = logLines.join('\n');
  const view = $('log-view');
  view.scrollTop = view.scrollHeight;
  if (accounts.length) refreshSessions();

  $('btn-check-cookies').addEventListener('click', async () => {
    $('btn-check-cookies').disabled = true;
    $('check-status').textContent = '检测中...';
    for (const a of accounts) cookieStatus[a.name] = '...';
    renderAccounts();
    const res = await apiSend('/api/accounts/check-all', 'POST');
    if (res.results) {
      for (const r of res.results) {
        cookieStatus[r.name] = r.ok ? '✅ 有效' : '❌ ' + (r.msg || r.error || '失效');
      }
    }
    renderAccounts();
    $('btn-check-cookies').disabled = false;
    $('check-status').textContent = '完成';
  });
})();