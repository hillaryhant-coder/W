const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const DATA = path.join(__dirname, 'data');
const DB = path.join(DATA, 'store.json');
if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });

const DEFAULT = {
  accounts: {},
  settings: { delay: 5000, typingDelay: 1200, targetId: '', accountId: '', prefix: '', usePrefix: false },
  messages: ['Merhaba'],
  logs: []
};

function load() {
  try {
    if (fs.existsSync(DB)) {
      const d = JSON.parse(fs.readFileSync(DB, 'utf8'));
      return {
        accounts: d.accounts || {},
        settings: { ...DEFAULT.settings, ...(d.settings || {}) },
        messages: Array.isArray(d.messages) ? d.messages : ['Merhaba'],
        logs: d.logs || []
      };
    }
  } catch (_) {}
  return JSON.parse(JSON.stringify(DEFAULT));
}
function save() {
  try {
    store.logs = store.logs.slice(0, 150);
    fs.writeFileSync(DB, JSON.stringify(store, null, 2));
  } catch (_) {}
}
let store = load();

function log(msg, type = 'info', id = null) {
  const e = { msg: String(msg).slice(0, 350), type, id, time: new Date().toLocaleTimeString('tr-TR') };
  store.logs.unshift(e);
  if (store.logs.length > 150) store.logs.length = 150;
  save();
  io.emit('log', e);
  console.log(`[${type}] ${msg}`);
}
function errT(e) { return e ? (e.message || String(e)).slice(0, 280) : 'hata'; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function chromePath() {
  for (const p of [process.env.PUPPETEER_EXECUTABLE_PATH, process.env.CHROME_PATH, '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean)) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

/** id -> { browser, page, ready, info, chats } */
const live = {};
/** key accountId::target -> job */
const jobs = {};

function snap() {
  return {
    accounts: Object.keys(store.accounts).map((id) => {
      const a = store.accounts[id];
      const L = live[id];
      return {
        id,
        name: L?.info?.name || a.name || id,
        status: L?.ready ? 'ready' : (a.status || 'off'),
        ready: !!L?.ready
      };
    }),
    settings: store.settings,
    messages: store.messages,
    chats: (store.settings.accountId && live[store.settings.accountId]?.chats) || [],
    jobs: Object.keys(jobs).filter((k) => jobs[k]?.running).map((k) => ({
      key: k,
      accountId: jobs[k].accountId,
      targetId: jobs[k].targetId
    })),
    logs: store.logs.slice(0, 50)
  };
}
function emitStatus() { io.emit('status', snap()); }

async function launchPage() {
  const puppeteer = require('puppeteer-core');
  const exec = chromePath();
  if (!exec) throw new Error('Chromium yok (Dockerfile / CHROME_PATH)');
  const browser = await puppeteer.launch({
    executablePath: exec,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,900'
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    timeout: 0,
    protocolTimeout: 0
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1280, height: 900 });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  return { browser, page };
}

function cookiePath(id) {
  return path.join(DATA, 'cookies_' + id + '.json');
}

async function applySession(page, sessionid, extraCookies) {
  sessionid = String(sessionid || '').trim().replace(/^["']|["']$/g, '');
  if (!sessionid) return false;

  // JSON export (Cookie-Editor)
  if (sessionid.startsWith('[') || sessionid.startsWith('{')) {
    try {
      const parsed = JSON.parse(sessionid);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      await page.goto('https://www.tiktok.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
      const mapped = arr.map((c) => ({
        name: c.name,
        value: String(c.value || ''),
        domain: (c.domain && String(c.domain).startsWith('.')) ? c.domain : (c.domain || '.tiktok.com'),
        path: c.path || '/',
        httpOnly: c.httpOnly !== false,
        secure: c.secure !== false
      })).filter((c) => c.name && c.value);
      if (mapped.length) {
        const client = await page.createCDPSession();
        await client.send('Network.enable');
        for (const c of mapped) {
          await client.send('Network.setCookie', {
            name: c.name,
            value: c.value,
            domain: c.domain.replace(/^\./, '') ? c.domain : '.tiktok.com',
            path: c.path,
            secure: true,
            httpOnly: !!c.httpOnly
          }).catch(() => {});
        }
        await page.setCookie(...mapped.map((c) => ({
          name: c.name,
          value: c.value,
          domain: '.tiktok.com',
          path: c.path || '/',
          httpOnly: !!c.httpOnly,
          secure: true
        }))).catch(() => {});
      }
      await page.goto('https://www.tiktok.com/messages', { waitUntil: 'domcontentloaded', timeout: 90000 });
      await sleep(3500);
      return await isLoggedIn(page);
    } catch (e) {
      log('Cookie JSON: ' + errT(e), 'warn');
    }
  }

  await page.goto('https://www.tiktok.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(1000);

  // CDP ile cookie yaz (puppeteer setCookie bazen yetmez)
  try {
    const client = await page.createCDPSession();
    await client.send('Network.enable');
    for (const name of ['sessionid', 'sessionid_ss', 'sid_tt']) {
      for (const domain of ['.tiktok.com', 'www.tiktok.com']) {
        await client.send('Network.setCookie', {
          name,
          value: sessionid,
          domain,
          path: '/',
          secure: true,
          httpOnly: true,
          sameSite: 'None',
          expires: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 120
        }).catch(() => {});
      }
    }
  } catch (e) {
    log('CDP cookie: ' + errT(e), 'warn');
  }

  // yedek setCookie
  try {
    await page.setCookie(
      { name: 'sessionid', value: sessionid, domain: '.tiktok.com', path: '/', httpOnly: true, secure: true },
      { name: 'sessionid_ss', value: sessionid, domain: '.tiktok.com', path: '/', httpOnly: true, secure: true },
      { name: 'sid_tt', value: sessionid, domain: '.tiktok.com', path: '/', httpOnly: true, secure: true }
    );
  } catch (_) {}

  if (Array.isArray(extraCookies)) {
    for (const c of extraCookies) {
      if (!c?.name || !c?.value) continue;
      try {
        await page.setCookie({
          name: c.name,
          value: String(c.value),
          domain: c.domain || '.tiktok.com',
          path: c.path || '/',
          httpOnly: !!c.httpOnly,
          secure: true
        });
      } catch (_) {}
    }
  }

  await page.goto('https://www.tiktok.com/foryou', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await sleep(2000);
  await page.goto('https://www.tiktok.com/messages', { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
  await sleep(3500);

  const ok = await isLoggedIn(page);
  if (!ok) {
    const url = page.url();
    const snippet = await page.evaluate(() => (document.body?.innerText || '').slice(0, 120)).catch(() => '');
    log('Giris kontrol fail URL=' + url.slice(0, 50) + ' | ' + snippet.replace(/\\s+/g, ' ').slice(0, 80), 'warn');
  }
  return ok;
}

async function isLoggedIn(page) {
  const url = page.url();
  if (/\/login|\/signup|\/i18n\/login/i.test(url)) return false;

  const state = await page.evaluate(() => {
    const c = document.cookie || '';
    const hasSession = /(?:^|;\\s*)(sessionid|sid_tt)=/.test(c);
    // login form?
    const pass = document.querySelector('input[type="password"]');
    const loginBtn = document.querySelector('[data-e2e="top-login-button"], a[href*="/login"]');
    // messages / inbox markers
    const msgUi = document.querySelector('[class*="Message"], [class*="message"], [data-e2e*="message"], [class*="Chat"]');
    const avatar = document.querySelector('[data-e2e="nav-profile"], [data-e2e="profile-icon"]');
    return {
      hasSession,
      hasPass: !!pass,
      hasLoginBtn: !!loginBtn,
      hasMsgUi: !!msgUi,
      hasAvatar: !!avatar,
      cookiePreview: c.slice(0, 80)
    };
  }).catch(() => null);

  if (!state) return false;
  // acik login formu varsa basarisiz
  if (state.hasPass) return false;
  // session cookie tarayicida yoksa genelde basarisiz (httpOnly bazen document.cookie'de gorunmez!)
  // httpOnly sessionid document.cookie'de YOK olabilir — bu yuzden sadece buna bakma
  if (state.hasMsgUi || state.hasAvatar) return true;
  if (!/login/i.test(url) && !state.hasPass && !state.hasLoginBtn) return true;
  // messages sayfasindayiz ve login yok
  if (url.includes('/messages') && !state.hasPass) return true;
  return false;
}

async function saveCookies(id, page) {
  try {
    const cookies = await page.cookies();
    fs.writeFileSync(cookiePath(id), JSON.stringify(cookies, null, 2));
  } catch (_) {}
}

async function loadCookies(page, id) {
  const fp = cookiePath(id);
  if (!fs.existsSync(fp)) return false;
  const cookies = JSON.parse(fs.readFileSync(fp, 'utf8'));
  if (!Array.isArray(cookies) || !cookies.length) return false;
  await page.goto('https://www.tiktok.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.setCookie(...cookies);
  await page.goto('https://www.tiktok.com/messages', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await sleep(2000);
  return page.evaluate(() => document.cookie.includes('sessionid=')).catch(() => false);
}

let reqExtraCookies = null;
async function addAccount(sessionid, name, extraCookies) {
  reqExtraCookies = extraCookies || null;
  sessionid = String(sessionid || '').trim();
  if (!sessionid || sessionid.length < 10) throw new Error('sessionid gecersiz / cok kisa');

  const id = 'tt_' + sessionid.slice(0, 12).replace(/[^a-zA-Z0-9]/g, '');
  if (live[id]?.browser) {
    try { await live[id].browser.close(); } catch (_) {}
    delete live[id];
  }

  store.accounts[id] = { name: name || ('TT ' + id.slice(-6)), sessionid, status: 'connecting' };
  save();
  emitStatus();
  log('Hesap ekleniyor...', 'info', id);

  const { browser, page } = await launchPage();
  live[id] = { browser, page, ready: false, info: { name: store.accounts[id].name }, chats: [] };

  const ok = await applySession(page, sessionid, reqExtraCookies);
  if (!ok) {
    const finalUrl = page.url();
    try { await browser.close(); } catch (_) {}
    delete live[id];
    store.accounts[id].status = 'error';
    save();
    throw new Error('Giris basarisiz. URL=' + finalUrl.slice(0, 60) + ' — sessionid suresi dolmus veya sadece web cookie lazim. Cookie-Editor Export (JSON) dene.');
  }

  await saveCookies(id, page);
  live[id].ready = true;
  store.accounts[id].status = 'ready';
  save();
  log('Bagli: ' + store.accounts[id].name, 'success', id);
  emitStatus();
  setTimeout(() => loadChats(id).catch((e) => log('Sohbet: ' + errT(e), 'warn', id)), 1500);
  return { ok: true, accountId: id };
}

async function restore() {
  for (const id of Object.keys(store.accounts)) {
    const a = store.accounts[id];
    if (!a || a.status === 'removed') continue;
    log('Oturum yukleniyor: ' + id, 'info', id);
    try {
      const { browser, page } = await launchPage();
      live[id] = { browser, page, ready: false, info: { name: a.name }, chats: [] };
      let ok = await loadCookies(page, id);
      if (!ok && a.sessionid) ok = await applySession(page, a.sessionid);
      if (ok) {
        await saveCookies(id, page);
        live[id].ready = true;
        store.accounts[id].status = 'ready';
        save();
        log('Kalici oturum: ' + a.name, 'success', id);
        await loadChats(id).catch(() => {});
      } else {
        store.accounts[id].status = 'expired';
        save();
        try { await browser.close(); } catch (_) {}
        delete live[id];
        log('Oturum dusmus: ' + id, 'warn', id);
      }
    } catch (e) {
      log('Restore: ' + errT(e), 'error', id);
    }
    await sleep(1500);
  }
  emitStatus();
}

async function loadChats(accountId) {
  const L = live[accountId];
  if (!L?.ready || !L.page) throw new Error('Hesap bagli degil');
  await L.page.goto('https://www.tiktok.com/messages', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await sleep(2500);

  let list = await L.page.evaluate(() => {
    const out = [];
    const seen = {};
    const nodes = document.querySelectorAll('a[href*="/messages"], [class*="DivChatItem"], [class*="conversation"], [data-e2e*="chat"]');
    nodes.forEach((el, i) => {
      try {
        const name = (el.innerText || el.textContent || '').trim().split('\n')[0].slice(0, 60);
        const href = el.href || el.closest('a')?.href || '';
        const id = href || name || ('c' + i);
        if (!name || name.length < 1 || seen[id]) return;
        seen[id] = 1;
        out.push({ id: href || id, name, isGroup: /group|grup/i.test(name + href) });
      } catch (_) {}
    });
    return out.slice(0, 100);
  }).catch(() => []);

  // isim bos olanlari at
  list = (list || []).filter((c) => c.name && c.name !== '.');
  L.chats = list;
  store.settings.accountId = accountId;
  save();
  io.emit('chats', { accountId, chats: list });
  log(list.length + ' sohbet', list.length ? 'success' : 'warn', accountId);
  emitStatus();
  return list;
}

async function sendOne(accountId, target, text) {
  const L = live[accountId];
  if (!L?.ready || !L.page) throw new Error('Hesap bagli degil');
  text = String(text || '').trim();
  if (store.settings.usePrefix && store.settings.prefix) {
    text = String(store.settings.prefix).trim() + (text ? ' ' + text : '');
  }
  if (!text) throw new Error('Mesaj bos');

  const typingMs = Math.max(0, Number(store.settings.typingDelay) || 0);
  log('Gonder -> ' + String(target).slice(0, 40) + ' | ' + text.slice(0, 30), 'info', accountId);

  if (target && String(target).includes('http')) {
    await L.page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } else {
    await L.page.goto('https://www.tiktok.com/messages', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(1200);
    if (target) {
      await L.page.evaluate((name) => {
        const nodes = [...document.querySelectorAll('a, div, span')];
        const el = nodes.find((n) => (n.innerText || '').trim().split('\n')[0] === name);
        if (el) el.click();
      }, target).catch(() => {});
    }
  }
  await sleep(1000);

  // typing simulasyonu
  if (typingMs > 0) {
    await L.page.evaluate(() => {
      const input = document.querySelector('div[contenteditable="true"], textarea, [data-e2e*="message-input"]');
      if (input) input.focus();
    }).catch(() => {});
    await sleep(Math.min(typingMs, 3000));
  }

  const sent = await L.page.evaluate((msg) => {
    const input = document.querySelector('div[contenteditable="true"], textarea, [data-e2e*="message-input"]');
    if (!input) return { ok: false, error: 'mesaj kutusu yok' };
    input.focus();
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      input.value = msg;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, msg);
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: msg }));
    }
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    const btn = document.querySelector('[data-e2e*="send"], button[type="submit"], button[aria-label*="Send" i]');
    if (btn) btn.click();
    return { ok: true };
  }, text);

  if (!sent?.ok) throw new Error(sent?.error || 'gonderilemedi');
  log('Gonderildi: ' + text.slice(0, 40), 'send', accountId);
  await saveCookies(accountId, L.page);
  return true;
}

function stopJob(accountId, targetId) {
  if (!accountId) {
    Object.keys(jobs).forEach((k) => stopJobKey(k));
    return;
  }
  if (targetId) return stopJobKey(accountId + '::' + targetId);
  Object.keys(jobs).forEach((k) => {
    if (k.startsWith(accountId + '::') || k === accountId) stopJobKey(k);
  });
}
function stopJobKey(key) {
  const j = jobs[key];
  if (!j) return;
  j.running = false;
  if (j.timer) clearTimeout(j.timer);
  delete jobs[key];
  log('Dongu durdu', 'warn', j.accountId);
  emitStatus();
}

function startJob(opts = {}) {
  const accountId = String(opts.accountId || store.settings.accountId || '');
  const targetId = String(opts.targetId || store.settings.targetId || '');
  const delay = Math.max(3000, Number(opts.delay != null ? opts.delay : store.settings.delay) || 5000);
  let messages = opts.messages;
  if (!Array.isArray(messages) || !messages.length) messages = store.messages;
  messages = messages.map((x) => String(x).trim()).filter(Boolean);

  if (!accountId || !live[accountId]?.ready) return log('Hesap bagli degil', 'error');
  if (!targetId) return log('Hedef sec', 'error');
  if (!messages.length) return log('Mesaj yok', 'error');

  const key = accountId + '::' + targetId;
  if (jobs[key]?.running) stopJobKey(key);

  const job = { accountId, targetId, running: true, timer: null, index: 0, delay, messages };
  jobs[key] = job;
  store.settings.accountId = accountId;
  store.settings.targetId = targetId;
  store.settings.delay = delay;
  if (opts.typingDelay != null) store.settings.typingDelay = Number(opts.typingDelay);
  if (opts.prefix != null) store.settings.prefix = String(opts.prefix);
  if (typeof opts.usePrefix === 'boolean') store.settings.usePrefix = opts.usePrefix;
  store.messages = messages;
  save();

  log('Dongu basladi → ' + targetId.slice(0, 40), 'success', accountId);
  emitStatus();

  const tick = async () => {
    if (!jobs[key]?.running) return;
    try {
      if (!live[accountId]?.ready) {
        jobs[key].timer = setTimeout(tick, 8000);
        return;
      }
      const text = job.messages[job.index % job.messages.length];
      job.index++;
      await sendOne(accountId, job.targetId, text);
    } catch (e) {
      log('Gonderim: ' + errT(e), 'error', accountId);
    }
    if (jobs[key]?.running) jobs[key].timer = setTimeout(tick, job.delay);
  };
  tick();
}

async function removeAccount(id) {
  stopJob(id);
  try { if (live[id]?.browser) await live[id].browser.close(); } catch (_) {}
  delete live[id];
  delete store.accounts[id];
  try { if (fs.existsSync(cookiePath(id))) fs.unlinkSync(cookiePath(id)); } catch (_) {}
  save();
  emitStatus();
  log('Hesap silindi', 'warn', id);
}

app.use(express.json({ limit: '1mb' }));
app.get('/api/status', (_req, res) => res.json(snap()));
app.post('/api/account/add', async (req, res) => {
  try {
    const sid = req.body?.sessionid || req.body?.cookies || '';
    const r = await addAccount(sid, (req.body?.name || '').trim(), req.body?.extraCookies);
    res.json(r);
  } catch (e) {
    res.status(400).json({ ok: false, error: errT(e) });
  }
});
app.post('/api/account/remove', async (req, res) => {
  try {
    await removeAccount(req.body?.accountId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: errT(e) });
  }
});
app.post('/api/chats', async (req, res) => {
  try {
    const id = req.body?.accountId || store.settings.accountId;
    const chats = await loadChats(id);
    res.json({ ok: true, chats });
  } catch (e) {
    res.status(400).json({ ok: false, error: errT(e) });
  }
});
app.post('/api/settings', (req, res) => {
  Object.assign(store.settings, req.body || {});
  if (store.settings.delay) store.settings.delay = Math.max(3000, Number(store.settings.delay));
  save();
  res.json({ ok: true });
});
app.post('/api/messages', (req, res) => {
  let m = req.body?.messages;
  if (typeof m === 'string') m = m.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  store.messages = Array.isArray(m) ? m.filter(Boolean) : [];
  save();
  res.json({ ok: true, count: store.messages.length });
});
app.post('/api/loop/start', (req, res) => {
  const b = req.body || {};
  if (Array.isArray(b.messages) && b.messages.length) store.messages = b.messages.filter(Boolean);
  save();
  startJob(b);
  res.json({ ok: true, running: Object.keys(jobs).some((k) => jobs[k]?.running) });
});
app.post('/api/loop/stop', (req, res) => {
  stopJob(req.body?.accountId, req.body?.targetId);
  res.json({ ok: true });
});

const HTML = `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TikTok Session Panel</title>
<script src="/socket.io/socket.io.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#0a0a0a;color:#eee;padding:12px}
.w{max-width:480px;margin:0 auto}
h1{color:#fe2c55;text-align:center;font-size:22px}
.sub{text-align:center;color:#666;font-size:12px;margin:4px 0 12px}
.card{background:#141414;border:1px solid #2a2a2a;border-radius:12px;padding:14px;margin-bottom:10px}
label{display:block;font-size:12px;color:#999;margin:8px 0 4px}
input,textarea,select{width:100%;background:#0d0d0d;border:1px solid #333;border-radius:8px;padding:10px;color:#eee}
textarea{min-height:90px}
.btn{border:none;border-radius:8px;padding:11px;font-weight:700;cursor:pointer;width:100%;margin-top:8px}
.btn-g{background:#fe2c55;color:#fff}.btn-r{background:#e74c3c;color:#fff}.btn-s{background:#2a2a2a;color:#ccc}
.row{display:flex;gap:8px}.row .btn{flex:1}
.hint{font-size:11px;color:#666;margin-top:6px;line-height:1.4}
.acc{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #222;font-size:13px}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:6px;background:#666}
.dot.on{background:#25d366}
.chats{max-height:180px;overflow:auto}
.ci{padding:8px;border-bottom:1px solid #1a1a1a;cursor:pointer;font-size:13px;display:flex;justify-content:space-between}
.ci:hover{background:#1a1a1a}
.logs{max-height:140px;overflow:auto;font-family:monospace;font-size:11px;background:#0d0d0d;padding:8px;border-radius:8px}
.log{color:#888}.log.error{color:#e74c3c}.log.success{color:#25d366}.log.send{color:#53bdeb}
</style>
</head>
<body>
<div class="w">
  <h1>TikTok Panel</h1>
  <p class="sub">sessionid · coklu hesap · kalici oturum · typing · prefix</p>

  <div class="card">
    <label>sessionid</label>
    <input id="sid" placeholder="Cookie-Editor → sessionid">
    <label>Isim</label>
    <input id="name" placeholder="Hesap 1">
    <button type="button" class="btn btn-g" id="btnAdd">Hesap Ekle</button>
    <p class="hint">Cookie-Editor → tiktok.com → sessionid (tam deger). Olmazsa Export ile JSON yapistir. Mobil uygulama sessioni webde calismayabilir.</p>
    <div id="accs"></div>
  </div>

  <div class="card">
    <label>Hesap</label>
    <select id="acc"></select>
    <label>Hedef sohbet</label>
    <input id="target" placeholder="listeden sec">
    <label>Hiz ms</label>
    <input id="delay" type="number" value="5000" min="3000">
    <label>Typing ms</label>
    <input id="typing" type="number" value="1200" min="0">
    <label>Prefix</label>
    <input id="prefix" placeholder="@user veya metin">
    <label><input type="checkbox" id="usePrefix"> Prefix aktif</label>
    <label>Mesajlar (satir = 1)</label>
    <textarea id="msgs">Merhaba</textarea>
    <label class="hint">TXT <input type="file" id="txt" accept=".txt"></label>
    <div class="row">
      <button type="button" class="btn btn-g" id="btnStart">Baslat</button>
      <button type="button" class="btn btn-r" id="btnStop">Durdur</button>
    </div>
    <button type="button" class="btn btn-s" id="btnChats">Sohbetleri Yukle</button>
  </div>
  <div class="card"><div class="chats" id="chats"></div></div>
  <div class="card"><div class="logs" id="logs"></div></div>
</div>
<script>
(function(){
  var socket=null;
  try{if(typeof io==="function")socket=io();}catch(e){}
  function esc(s){return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;");}
  function api(u,m,b){
    return fetch(u,{method:m||"GET",headers:{"Content-Type":"application/json"},body:b?JSON.stringify(b):undefined})
      .then(function(r){return r.text().then(function(t){try{return JSON.parse(t);}catch(e){return{ok:false,error:t.slice(0,120)};}});})
      .catch(function(e){return{ok:false,error:e.message};});
  }
  function addLog(e){
    var el=document.getElementById("logs");
    var d=document.createElement("div");
    d.className="log "+(e.type||"");
    d.textContent="["+(e.time||"")+"] "+(e.msg||"");
    el.insertBefore(d,el.firstChild);
  }
  function renderChats(list){
    var el=document.getElementById("chats");
    if(!list||!list.length){el.innerHTML='<div style="color:#666;padding:8px">Sohbet yok</div>';return;}
    el.innerHTML="";
    list.forEach(function(c){
      var row=document.createElement("div");
      row.className="ci";
      row.innerHTML="<span>"+esc(c.name)+"</span>";
      row.onclick=function(){document.getElementById("target").value=c.id||c.name;};
      el.appendChild(row);
    });
  }
  function render(s){
    if(!s)return;
    var accs=s.accounts||[];
    var box=document.getElementById("accs");
    box.innerHTML="";
    accs.forEach(function(a){
      var d=document.createElement("div");
      d.className="acc";
      d.innerHTML='<span><span class="dot '+(a.ready?"on":"")+'"></span>'+esc(a.name)+" · "+esc(a.status)+"</span>";
      var rm=document.createElement("button");
      rm.type="button";rm.className="btn btn-r";rm.style.cssText="padding:4px 8px;font-size:11px;width:auto";
      rm.textContent="Sil";
      rm.onclick=function(){if(confirm("Sil?"))api("/api/account/remove","POST",{accountId:a.id}).then(load);};
      d.appendChild(rm);box.appendChild(d);
    });
    var sel=document.getElementById("acc");
    var cur=sel.value||(s.settings&&s.settings.accountId)||"";
    sel.innerHTML=accs.map(function(a){return '<option value="'+esc(a.id)+'"'+(a.id===cur?" selected":"")+">"+esc(a.name)+(a.ready?" *":"")+"</option>";}).join("");
    if(s.settings){
      if(s.settings.delay)document.getElementById("delay").value=s.settings.delay;
      if(s.settings.typingDelay!=null)document.getElementById("typing").value=s.settings.typingDelay;
      if(s.settings.targetId)document.getElementById("target").value=s.settings.targetId;
      if(s.settings.prefix!=null)document.getElementById("prefix").value=s.settings.prefix;
      document.getElementById("usePrefix").checked=!!s.settings.usePrefix;
    }
    if(s.messages)document.getElementById("msgs").value=s.messages.join("\\n");
    if(s.chats&&s.chats.length)renderChats(s.chats);
    if(s.logs){document.getElementById("logs").innerHTML="";s.logs.slice().reverse().forEach(addLog);}
  }
  function load(){api("/api/status").then(function(s){if(s&&!s.error)render(s);});}

  document.getElementById("btnAdd").onclick=function(){
    var sid=document.getElementById("sid").value.trim();
    var name=document.getElementById("name").value.trim();
    if(!sid)return alert("sessionid yapistir");
    api("/api/account/add","POST",{sessionid:sid,name:name}).then(function(r){
      if(!r.ok)return alert(r.error||"Hata");
      document.getElementById("sid").value="";
      load();
    });
  };
  document.getElementById("btnChats").onclick=function(){
    api("/api/chats","POST",{accountId:document.getElementById("acc").value}).then(function(r){
      if(r.error)alert(r.error);
      if(r.chats)renderChats(r.chats);
    });
  };
  document.getElementById("txt").onchange=function(){
    var f=this.files&&this.files[0];if(!f)return;
    var fr=new FileReader();
    fr.onload=function(){
      var lines=String(fr.result||"").split(/\\r?\\n/).map(function(l){return l.trim();}).filter(Boolean);
      document.getElementById("msgs").value=lines.join("\\n");
      api("/api/messages","POST",{messages:lines});
    };
    fr.readAsText(f);this.value="";
  };
  document.getElementById("btnStart").onclick=function(){
    var messages=document.getElementById("msgs").value.split("\\n").filter(function(l){return l.trim();});
    api("/api/loop/start","POST",{
      accountId:document.getElementById("acc").value,
      targetId:document.getElementById("target").value.trim(),
      delay:parseInt(document.getElementById("delay").value,10)||5000,
      typingDelay:parseInt(document.getElementById("typing").value,10)||0,
      prefix:document.getElementById("prefix").value.trim(),
      usePrefix:document.getElementById("usePrefix").checked,
      messages:messages
    }).then(function(r){if(!r.running)alert("Baslamadi");load();});
  };
  document.getElementById("btnStop").onclick=function(){
    api("/api/loop/stop","POST",{accountId:document.getElementById("acc").value}).then(load);
  };
  if(socket){socket.on("log",addLog);socket.on("status",render);socket.on("chats",function(d){if(d.chats)renderChats(d.chats);});}
  load();
})();
</script>
</body>
</html>`;

app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(HTML);
});

server.listen(PORT, () => {
  console.log('TT Panel http://localhost:' + PORT);
  log('Sunucu ayakta', 'success');
  restore().catch((e) => log('restore: ' + errT(e), 'error'));
});
