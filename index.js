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
    chats: (function () {
      const id = store.settings.accountId;
      if (id && live[id]?.chats?.length) return live[id].chats;
      for (const k of Object.keys(live)) if (live[k]?.chats?.length) return live[k].chats;
      return [];
    })(),
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

  store.settings.accountId = accountId;
  save();

  log('Sohbetler yukleniyor...', 'info', accountId);
  await L.page.goto('https://www.tiktok.com/messages', { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
  await sleep(4000);

  // SPA render bekle
  try {
    await L.page.waitForSelector('a, [class*="Chat"], [class*="message"], [class*="Div"], [role="list"]', { timeout: 15000 });
  } catch (_) {}

  // listeyi kaydir (lazy load)
  for (let i = 0; i < 5; i++) {
    await L.page.evaluate(() => {
      const scrollables = [
        ...document.querySelectorAll('[class*="Scroll"], [class*="scroll"], [class*="List"], aside, nav, [role="list"]')
      ];
      for (const el of scrollables) {
        try { el.scrollTop = el.scrollHeight; } catch (_) {}
      }
      window.scrollBy(0, 400);
    }).catch(() => {});
    await sleep(800);
  }

  let list = await L.page.evaluate(() => {
    const out = [];
    const seen = {};
    const push = (id, name, isGroup) => {
      id = String(id || '').trim();
      name = String(name || '').trim().split('\\n')[0].slice(0, 80);
      if (!name || name.length < 1) return;
      if (/^(messages|inbox|tiktok|log in|sign up)$/i.test(name)) return;
      const key = id || name;
      if (seen[key]) return;
      seen[key] = 1;
      out.push({ id: id || name, name, isGroup: !!isGroup });
    };

    // 1) linkler
    document.querySelectorAll('a[href*="messages"], a[href*="chat"], a[href*="conversation"]').forEach((a) => {
      const href = a.href || '';
      const t = (a.innerText || a.textContent || '').trim();
      const name = t.split('\\n').map((x) => x.trim()).filter(Boolean)[0] || '';
      if (href && name) push(href, name, /group/i.test(href + name));
    });

    // 2) data-e2e
    document.querySelectorAll('[data-e2e*="chat"], [data-e2e*="conversation"], [data-e2e*="message-item"]').forEach((el, i) => {
      const name = (el.innerText || '').trim().split('\\n')[0];
      const a = el.closest('a') || el.querySelector('a');
      push(a?.href || name || ('e2e' + i), name, false);
    });

    // 3) class patterns
    const cls = ['ChatItem', 'Conversation', 'Pdm', 'DivItem', 'SpanNick', 'UserName', 'nickname', 'chat-item'];
    for (const c of cls) {
      document.querySelectorAll('[class*="' + c + '"]').forEach((el, i) => {
        const name = (el.innerText || '').trim().split('\\n')[0];
        if (!name || name.length > 80) return;
        const a = el.closest('a') || el.querySelector('a');
        push(a?.href || (c + i + name), name, /group|grup/i.test(name));
      });
    }

    // 4) sol panel text bloklari
    const panels = document.querySelectorAll('aside, [class*="Sidebar"], [class*="ListContainer"], [class*="conversation-list"]');
    panels.forEach((panel) => {
      (panel.innerText || '').split('\\n').map((l) => l.trim()).filter((l) => l.length >= 2 && l.length <= 40).forEach((name, i) => {
        if (/^\\d+$/.test(name)) return;
        if (/ago|dakika|saat|now|active|cevrimici/i.test(name)) return;
        push('txt:' + name, name, false);
      });
    });

    return out.slice(0, 120);
  }).catch((e) => {
    log('evaluate: ' + errT(e), 'warn', accountId);
    return [];
  });

  // bos ise sayfa tipini logla
  if (!list.length) {
    const info = await L.page.evaluate(() => ({
      url: location.href,
      title: document.title,
      text: (document.body?.innerText || '').slice(0, 200).replace(/\\s+/g, ' ')
    })).catch(() => ({}));
    log('Sohbet bulunamadi | ' + (info.url || '') + ' | ' + (info.text || '').slice(0, 80), 'warn', accountId);
  }

  L.chats = list || [];
  store.settings.accountId = accountId;
  save();
  io.emit('chats', { accountId, chats: L.chats });
  log(L.chats.length + ' sohbet/grup', L.chats.length ? 'success' : 'warn', accountId);
  emitStatus();
  return L.chats;
}

async function sendOne(accountId, target, text) {
  const L = live[accountId];
  if (!L?.ready || !L.page) throw new Error('Hesap bagli degil');
  text = String(text || '').trim();
  if (store.settings.usePrefix && store.settings.prefix) {
    text = String(store.settings.prefix).trim() + (text ? ' ' + text : '');
  }
  if (!text) throw new Error('Mesaj bos');

  let targetRaw = String(target || '').trim();
  const cleanName = targetRaw.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  const typingMs = Math.max(0, Number(store.settings.typingDelay) || 0);
  log('Gonder -> ' + cleanName.slice(0, 40) + ' | ' + text.slice(0, 30), 'info', accountId);

  const page = L.page;

  // --- sohbet sayfasina git / sohbeti ac ---
  async function openInbox() {
    await page.goto('https://www.tiktok.com/messages?lang=en', {
      waitUntil: 'networkidle2',
      timeout: 90000
    }).catch(() => page.goto('https://www.tiktok.com/messages', { waitUntil: 'domcontentloaded', timeout: 60000 }));
    await sleep(4000);
  }

  if (/^https?:\/\//i.test(targetRaw)) {
    await page.goto(targetRaw, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3000);
  } else {
    await openInbox();

    // TikTok bazen username ile deep link kabul eder
    if (cleanName && !cleanName.includes(' ') && !cleanName.includes(',')) {
      await page.goto('https://www.tiktok.com/messages?u=' + encodeURIComponent(cleanName), {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      }).catch(() => {});
      await sleep(2500);
    }

    // listeden tikla — bounding box + mouse
    const box = await page.evaluate((name) => {
      const norm = (s) => String(s || '').replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim().toLowerCase();
      const want = norm(name);
      const wantFirst = want.split(',')[0].trim();
      const candidates = [];
      for (const el of document.querySelectorAll('a, div, span, p, li, [role="listitem"]')) {
        const raw = (el.innerText || el.textContent || '').trim();
        const line = norm(raw.split('\\n')[0]);
        if (!line || line.length > 90) continue;
        if (line === want || line === wantFirst || line.includes(wantFirst) || wantFirst.includes(line)) {
          const clickable = el.closest('a') || el.closest('[role="listitem"]') || el.closest('div[class]') || el;
          const r = clickable.getBoundingClientRect();
          if (r.width > 5 && r.height > 5) {
            candidates.push({
              x: r.x + r.width / 2,
              y: r.y + Math.min(r.height / 2, 30),
              line,
              score: line === want ? 3 : line === wantFirst ? 2 : 1
            });
          }
        }
      }
      candidates.sort((a, b) => b.score - a.score);
      return candidates[0] || null;
    }, cleanName).catch(() => null);

    if (box) {
      await page.mouse.click(box.x, box.y);
      log('Sohbet tiklandi: ' + (box.line || '').slice(0, 30), 'info', accountId);
      await sleep(3000);
    } else {
      // ilk sohbeti dene (liste bos degilse)
      const first = await page.evaluate(() => {
        for (const el of document.querySelectorAll('a[href*="message"], [class*="Chat"], [class*="Item"]')) {
          const r = el.getBoundingClientRect();
          if (r.y > 80 && r.y < 700 && r.width > 40) {
            return { x: r.x + r.width / 2, y: r.y + 20 };
          }
        }
        return null;
      }).catch(() => null);
      if (first) {
        await page.mouse.click(first.x, first.y);
        await sleep(3000);
      }
    }
  }

  // iframe icinde ara
  async function findInFrames() {
    const frames = page.frames();
    for (const frame of frames) {
      try {
        const sel = await frame.evaluate(() => {
          const list = [
            'div[contenteditable="true"]',
            'div[contenteditable="plaintext-only"]',
            'div[role="textbox"]',
            'textarea',
            '[data-e2e*="input"]'
          ];
          for (const s of list) {
            const el = document.querySelector(s);
            if (el) {
              el.setAttribute('data-tt-in', '1');
              return true;
            }
          }
          return false;
        });
        if (sel) return frame;
      } catch (_) {}
    }
    return null;
  }

  // ana sayfada veya frame'de input bekle
  let ctx = page;
  let found = false;
  for (let i = 0; i < 10; i++) {
    found = await page.evaluate(() => {
      const sels = [
        'div[contenteditable="true"]',
        'div[contenteditable="plaintext-only"]',
        'div[role="textbox"]',
        'textarea',
        '[data-e2e*="message-input"]',
        '[data-e2e*="dm"]',
        '[class*="DraftEditor"]',
        'form [contenteditable]'
      ];
      for (const s of sels) {
        const el = document.querySelector(s);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 20 && r.height > 10) {
          el.setAttribute('data-tt-panel-input', '1');
          return true;
        }
      }
      return false;
    }).catch(() => false);

    if (found) break;

    const fr = await findInFrames();
    if (fr) {
      ctx = fr;
      found = true;
      break;
    }

    // mesaj alanina tikla (sag alt)
    await page.mouse.click(900, 820).catch(() => {});
    await sleep(800);
  }

  if (!found) {
    // API yedek denemesi: sayfadaki window nesnelerinden conversation id cekmeye calis
    const apiTry = await trySendViaApi(page, cleanName, text).catch((e) => ({ ok: false, error: errT(e) }));
    if (apiTry && apiTry.ok) {
      log('Gonderildi (api): ' + text.slice(0, 40), 'send', accountId);
      return true;
    }

    const dbg = await page.evaluate(() => ({
      url: location.href,
      ce: document.querySelectorAll('[contenteditable]').length,
      ta: document.querySelectorAll('textarea').length,
      buttons: document.querySelectorAll('button').length,
      text: (document.body?.innerText || '').slice(0, 150).replace(/\\s+/g, ' ')
    })).catch(() => ({}));
    throw new Error(
      'mesaj kutusu yok | url=' + String(dbg.url || '').slice(0, 50) +
      ' ce=' + dbg.ce + ' ta=' + dbg.ta + ' btn=' + dbg.buttons +
      ' | ' + String(dbg.text || '').slice(0, 60)
    );
  }

  const inputSel = '[data-tt-panel-input="1"], [data-tt-in="1"], div[contenteditable="true"], textarea, div[role="textbox"]';

  if (typingMs > 0) {
    try {
      if (ctx === page) await page.click(inputSel, { delay: 40 }).catch(() => {});
      await sleep(Math.min(typingMs, 2000));
    } catch (_) {}
  }

  // metni yaz
  if (ctx === page) {
    await page.focus(inputSel).catch(() => {});
    // Ctrl+A sil
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(text, { delay: 12 });
    await sleep(200);
    await page.keyboard.press('Enter');
  } else {
    await ctx.evaluate((msg) => {
      const input = document.querySelector('[data-tt-in="1"], [contenteditable="true"], textarea, [role="textbox"]');
      if (!input) throw new Error('frame input yok');
      input.focus();
      if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
        input.value = msg;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        document.execCommand('selectAll');
        document.execCommand('insertText', false, msg);
        input.dispatchEvent(new InputEvent('input', { bubbles: true, data: msg }));
      }
    }, text);
    await page.keyboard.press('Enter');
  }

  // send butonu yedek
  await page.evaluate(() => {
    for (const b of document.querySelectorAll('button, [role="button"]')) {
      const t = ((b.innerText || '') + (b.getAttribute('aria-label') || '') + (b.getAttribute('data-e2e') || '')).toLowerCase();
      if (/send|gonder/.test(t)) { b.click(); return; }
    }
  }).catch(() => {});

  await sleep(1000);
  log('Gonderildi: ' + text.slice(0, 40), 'send', accountId);
  await saveCookies(accountId, page).catch(() => {});
  return true;
}

/** Sinirli API denemesi — DOM yoksa */
async function trySendViaApi(page, targetName, text) {
  // TikTok web IM endpointleri degisken; session cookie ile fetch dener
  return page.evaluate(async (name, msg) => {
    try {
      // csrf
      const csrf = (document.cookie.match(/tt_csrf_token=([^;]+)/) || [])[1] ||
        (document.cookie.match(/passport_csrf_token=([^;]+)/) || [])[1] || '';
      const headers = {
        'content-type': 'application/json',
        'x-secsdk-csrf-token': csrf ? decodeURIComponent(csrf) : ''
      };
      // conversation list
      const r = await fetch('/api/im/conversation/list/?aid=1988', {
        method: 'GET',
        credentials: 'include',
        headers
      });
      if (!r.ok) return { ok: false, error: 'list http ' + r.status };
      const data = await r.json().catch(() => null);
      if (!data) return { ok: false, error: 'list json yok' };
      // cesitli response sekilleri
      const convs = data?.conversation_list || data?.data?.conversation_list || data?.conversations || [];
      if (!Array.isArray(convs) || !convs.length) return { ok: false, error: 'conversation yok' };
      const want = String(name || '').toLowerCase();
      let conv = convs.find((c) => {
        const n = String(c.name || c.conversation_name || c.title || '').toLowerCase();
        return n && want && (n.includes(want.slice(0, 12)) || want.includes(n.slice(0, 12)));
      }) || convs[0];
      const cid = conv.conversation_id || conv.id || conv.conversationId;
      if (!cid) return { ok: false, error: 'cid yok' };

      const body = {
        conversation_id: String(cid),
        text: msg,
        message_type: 1
      };
      const send = await fetch('/api/im/send/?aid=1988', {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify(body)
      });
      if (send.ok) return { ok: true };
      return { ok: false, error: 'send http ' + send.status };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  }, targetName, text);
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
