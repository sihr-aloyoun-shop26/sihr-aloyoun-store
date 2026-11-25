// متجر سحر العيون - سيرفر بدون مكتبات خارجية (Node 18+)
// التخزين الدائم: Supabase (لو SUPABASE_URL و SUPABASE_SERVICE_KEY مضبوطين)، وإلا ملفات محلية (للتجربة فقط).
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = (process.env.SUPABASE_SERVICE_KEY || '') + (process.env.SUPABASE_SERVICE_KEY_2 || '');
const USE_DB = !!(SB_URL && SB_KEY);
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('s:' + ADMIN_PASSWORD).digest('hex');
if (!ADMIN_PASSWORD) console.warn('تحذير: ADMIN_PASSWORD غير مضبوط، لوحة الأدمن مقفولة.');
console.log(USE_DB ? 'التخزين: Supabase' : 'تحذير: التخزين محلي ومؤقت');

fs.mkdirSync(DATA_DIR, { recursive: true });
const readJSON = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const DEFAULT_PRODUCTS = readJSON(path.join(__dirname, 'products.default.json'));
const DEFAULT_SETTINGS = readJSON(path.join(__dirname, 'settings.default.json'));

/* ---------- طبقة التخزين ---------- */
const localFile = n => path.join(DATA_DIR, n + '.json');
function localRead(n, def) { try { return readJSON(localFile(n)); } catch (e) { return def; } }
function localWrite(n, d) { const t = localFile(n) + '.tmp'; fs.writeFileSync(t, JSON.stringify(d)); fs.renameSync(t, localFile(n)); }

async function sb(method, pathq, body, extra) {
  const r = await fetch(SB_URL + '/rest/v1/' + pathq, {
    method,
    headers: Object.assign({ apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' }, extra || {}),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const txt = await r.text();
  if (!r.ok) throw new Error('db ' + r.status + ' ' + txt.slice(0, 200));
  return txt ? JSON.parse(txt) : null;
}
async function kvGet(key, def) {
  if (!USE_DB) return localRead(key, def);
  const rows = await sb('GET', 'kv?key=eq.' + encodeURIComponent(key) + '&select=value');
  return rows && rows.length ? rows[0].value : def;
}
async function kvSet(key, value) {
  if (!USE_DB) return localWrite(key, value);
  await sb('POST', 'kv?on_conflict=key', { key, value }, { Prefer: 'resolution=merge-duplicates,return=minimal' });
}
async function ordersAll() {
  if (!USE_DB) return localRead('orders', []);
  const rows = await sb('GET', 'orders?select=data&order=created_at.asc&limit=5000');
  return rows.map(r => r.data);
}
async function orderAdd(o) {
  if (!USE_DB) { const a = localRead('orders', []); a.push(o); return localWrite('orders', a); }
  await sb('POST', 'orders', { num: o.num, data: o }, { Prefer: 'return=minimal' });
}
async function orderSetStatus(num, status) {
  if (!USE_DB) { const a = localRead('orders', []); const o = a.find(x => x.num === num); if (!o) return false; o.status = status; localWrite('orders', a); return true; }
  const rows = await sb('GET', 'orders?num=eq.' + encodeURIComponent(num) + '&select=data');
  if (!rows.length) return false;
  const o = rows[0].data; o.status = status;
  await sb('PATCH', 'orders?num=eq.' + encodeURIComponent(num), { data: o }, { Prefer: 'return=minimal' });
  return true;
}
async function getProducts() { return kvGet('products', DEFAULT_PRODUCTS); }
async function getSettings() { return Object.assign({}, DEFAULT_SETTINGS, await kvGet('settings', {})); }

/* ---------- أدوات ---------- */
const hits = new Map();
function limited(ip, max) {
  const now = Date.now(), a = (hits.get(ip) || []).filter(t => now - t < 3600e3);
  a.push(now); hits.set(ip, a); return a.length > (max || 10);
}
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const cleanLong = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n);
const okImg = s => s === '' || (typeof s === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+\/=]+$/.test(s) && s.length < 900000);

function sign(v) { return crypto.createHmac('sha256', SECRET).update(v).digest('hex'); }
function makeToken() { const e = String(Date.now() + 7 * 864e5); return e + '.' + sign(e); }
function validToken(t) {
  if (!t) return false; const [e, sg] = t.split('.');
  if (!e || !sg || Number(e) < Date.now()) return false;
  const a = Buffer.from(sg), b = Buffer.from(sign(e));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function isAdmin(req) {
  if (!ADMIN_PASSWORD) return false;
  const m = /(?:^|;\s*)adm=([^;]+)/.exec(req.headers.cookie || '');
  return !!(m && validToken(m[1]));
}
function body(req, max) {
  return new Promise((res, rej) => {
    let d = '', big = false; req.on('data', c => { if (big) return; d += c; if (d.length > (max || 50000)) { big = true; d = ''; } });
    req.on('end', () => { if (big) { const e = new Error('big'); e.code = 413; return rej(e); } try { res(JSON.parse(d || '{}')); } catch (e) { rej(e); } });
  });
}
function send(res, code, obj, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
}

async function notify(o, items) {
  if (!TG_TOKEN || !TG_CHAT) return 'not-configured';
  const text = '🛍 طلب جديد - سحر العيون\nرقم: ' + o.num + '\nالاسم: ' + o.name + '\nالموبايل: ' + o.phone +
    '\nالمحافظة: ' + o.gov + '\nالعنوان: ' + o.addr + '\nالدفع: ' + o.pay + '\n' +
    items.map(i => '- ' + i.name + ' x' + i.qty).join('\n') + '\n' + (o.discount ? 'خصم (' + o.code + '): ' + o.discount + ' ج.م\n' : '') + (o.shipping ? 'شحن: ' + o.shipping + ' ج.م\n' : '') + 'الإجمالي: ' + o.total + ' ج.م' + (o.notes ? '\nملاحظات: ' + o.notes : '');
  try {
    const r = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text })
    });
    if (!r.ok) console.error('Telegram error', r.status);
    return r.ok ? 'sent' : 'telegram-error-' + r.status;
  } catch (e) { console.error('Telegram failed', e.message); return 'failed'; }
}

function priceOrder(S, subtotal, codeStr) {
  let discount = 0, code = '';
  const c = (S.codes || []).find(x => x.active !== false && x.code === String(codeStr || '').toUpperCase().replace(/\s/g, ''));
  if (c) { code = c.code; discount = c.type === 'fixed' ? Math.min(c.value, subtotal) : Math.round(subtotal * Math.min(c.value, 100) / 100); }
  const after = subtotal - discount;
  const shipping = (S.shippingFee > 0 && !(S.freeShipFrom > 0 && after >= S.freeShipFrom)) ? S.shippingFee : 0;
  return { subtotal, discount, shipping, total: after + shipping, code, valid: !!c };
}
const publicSettings = S => { const o = Object.assign({}, S); delete o.codes; return o; };
const sha = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
async function passwordOk(pw) {
  const a = await kvGet('admin', null);
  if (a && a.salt) { const x = Buffer.from(sha(pw, a.salt)), y = Buffer.from(a.hash); return x.length === y.length && crypto.timingSafeEqual(x, y); }
  const p = Buffer.from(pw), q = Buffer.from(ADMIN_PASSWORD);
  return !!ADMIN_PASSWORD && p.length === q.length && crypto.timingSafeEqual(p, q);
}

function sanitizeSettings(b) {
  const s = {};
  for (const k of ['brandName', 'brandSub', 'heroEyebrow', 'heroTitle1', 'heroTitle2', 'collectionEyebrow', 'collectionTitle',
    'aboutTitle1', 'aboutTitle2', 'reviewsTitle', 'footerText', 'copyright']) if (b[k] !== undefined) s[k] = clean(b[k], 120);
  for (const k of ['colorGold', 'colorGoldLight', 'colorBg', 'colorCard', 'colorText']) if (b[k] !== undefined) { if (!/^#[0-9a-fA-F]{6}$/.test(b[k])) throw new Error('لون غير صالح'); s[k] = b[k]; }
  for (const k of ['contactPhone', 'whatsapp', 'contactEmail', 'contactAddress', 'instagram', 'facebook', 'tiktok', 'closedMessage', 'transferInfo', 'announcement']) if (b[k] !== undefined) s[k] = clean(b[k], 200);
  for (const k of ['shippingFee', 'freeShipFrom']) if (b[k] !== undefined) { const n = Number(b[k]); if (!(n >= 0 && n < 1e6)) throw new Error('رقم غير صالح'); s[k] = n; }
  if (b.bgStyle !== undefined) s.bgStyle = ['both', 'particles', 'mist', 'none'].includes(b.bgStyle) ? b.bgStyle : 'both';
  if (b.bgDim !== undefined) s.bgDim = Math.min(95, Math.max(0, Number(b.bgDim) || 0));
  if (b.bgImage !== undefined) { if (!(b.bgImage === '' || (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+\/=]+$/.test(b.bgImage) && b.bgImage.length < 1400000))) throw new Error('صورة الخلفية غير صالحة أو كبيرة'); s.bgImage = b.bgImage; }
  for (const k of ['storeOpen', 'payCash', 'payTransfer']) if (b[k] !== undefined) s[k] = !!b[k];
  if (Array.isArray(b.codes)) s.codes = b.codes.slice(0, 50).map(c => ({ code: clean(c.code, 30).toUpperCase().replace(/\s/g, ''), type: c.type === 'fixed' ? 'fixed' : 'percent', value: Math.max(0, Number(c.value) || 0), active: c.active !== false })).filter(c => c.code && c.value > 0);
  if (Array.isArray(b.sectionOrder)) { const ok = ['collection', 'about', 'reviews']; s.sectionOrder = b.sectionOrder.filter(x => ok.includes(x)); for (const x of ok) if (!s.sectionOrder.includes(x)) s.sectionOrder.push(x); }
  for (const k of ['showAbout', 'showReviews']) if (b[k] !== undefined) s[k] = !!b[k];
  if (b.heroSub !== undefined) s.heroSub = cleanLong(b.heroSub, 400);
  if (b.aboutText !== undefined) s.aboutText = cleanLong(b.aboutText, 1200);
  if (b.logoImage !== undefined) { if (!okImg(b.logoImage)) throw new Error('صورة اللوجو غير صالحة'); s.logoImage = b.logoImage; }
  if (Array.isArray(b.features)) s.features = b.features.slice(0, 8).map(f => ({ ico: clean(f.ico, 8), title: clean(f.title, 80), desc: clean(f.desc, 160) }));
  if (Array.isArray(b.reviews)) s.reviews = b.reviews.slice(0, 12).map(r => ({ stars: Math.min(5, Math.max(1, Number(r.stars) || 5)), text: cleanLong(r.text, 300), name: clean(r.name, 40) }));
  return s;
}


/* ---- صفحة تجربة اللبس: الملفات الكبيرة بتتحمّل مرة واحدة من المصدر الرسمي وبتتأكد بالبصمة ---- */
const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/';
const TRYON_ASSETS = {
  'lib/vision_bundle.mjs': [MP + 'vision_bundle.mjs', 'fb0c02c296f44ce0cc324ba16bd646d8773eb4a7847db4019cc4d0430db7a9b5'],
  'wasm/vision_wasm_internal.js': [MP + 'wasm/vision_wasm_internal.js', '2aa5fd3fdd3d8208cd7587df0bb19fb6925c4ea16a76dd025aedc1f64d6a6309'],
  'wasm/vision_wasm_internal.wasm': [MP + 'wasm/vision_wasm_internal.wasm', '225bc06c0f51a9cf31fea0e9e0b0243e9e01fb5ef332cc1a7fa6656dbdfdaabf'],
  'lib/pose.task': ['https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task', '59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a']
};
const MP14 = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/';
const BINGO_ASSETS = {
  'lib/vision_bundle.mjs': [MP14 + 'vision_bundle.mjs', 'e77f281f9619150d937023c355bae170e9120e3b9e43f1e23a2a7bee07197669'],
  'wasm/vision_wasm_internal.js': [MP14 + 'wasm/vision_wasm_internal.js', '9440cf0cc0cea21800e31581ec32aeedcc5fbf9df4509796bbc7d3f99e52ab9c'],
  'wasm/vision_wasm_internal.wasm': [MP14 + 'wasm/vision_wasm_internal.wasm', 'f82a8e6c05e08a44cc9f9e7ec5f845935bcbb1b1500ebe8c2f4812fb4e2917dc'],
  'lib/pose.task': TRYON_ASSETS['lib/pose.task'],
  'lib/three.module.js': ['https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js', '76dea8151bc9352aef3528b4262e249b2604f62543828328db978d060d61a495']
};
const APPS = { tryon: TRYON_ASSETS, bingo: BINGO_ASSETS };
const tryonMem = {}, tryonBusy = {};
function tryonAsset(app, rel) {
  const k = app + '/' + rel;
  if (tryonMem[k]) return Promise.resolve(tryonMem[k]);
  if (tryonBusy[k]) return tryonBusy[k];
  const [url, hash] = APPS[app][rel], cf = path.join(DATA_DIR, 'tryon-' + hash.slice(0, 16));
  return (tryonBusy[k] = (async () => {
    try {
      let b = null;
      try { b = fs.readFileSync(cf); } catch (e) {}
      if (!b || crypto.createHash('sha256').update(b).digest('hex') !== hash) {
        const r = await fetch(url); if (!r.ok) throw new Error('upstream ' + r.status);
        b = Buffer.from(await r.arrayBuffer());
        if (crypto.createHash('sha256').update(b).digest('hex') !== hash) throw new Error('hash mismatch ' + rel);
        try { fs.writeFileSync(cf, b); } catch (e) {}
      }
      tryonMem[k] = b; return b;
    } finally { delete tryonBusy[k]; }
  })());
}
const CASH = 'الدفع عند الاستلام';
const MIME = { '.html': 'text/html; charset=utf-8' };
const PAGES = { '/': 'index.html', '/index.html': 'index.html', '/admin': 'admin.html', '/admin.html': 'admin.html' };


// Decart live try-on: daily caps (all visitors / per visitor), reset each UTC day
let decartDay = '', decartUsed = 0; const decartPerIp = new Map();
function decartAllow(ip) {
  const d = new Date().toISOString().slice(0, 10);
  if (d !== decartDay) { decartDay = d; decartUsed = 0; decartPerIp.clear(); }
  if (decartUsed >= parseInt(process.env.DECART_MAX_PER_DAY || '5', 10)) return false;
  const n = decartPerIp.get(ip) || 0; if (n >= 3) return false;
  decartPerIp.set(ip, n + 1); decartUsed++; return true;
}
// The 1.1 MB Decart SDK bundle is stored in the repo as base64 parts; assembled and SHA-256 checked at first use
const DECART_SHA = '9d7cb6f974b6157311eb8939134bfe4f555e734e73976549b41b9279320f6ceb';
let decartBuf = null;
function decartBundle() {
  if (decartBuf) return decartBuf;
  const dir = path.join(__dirname, 'bingo', 'lib'); let b64 = '';
  for (let i = 1; ; i++) { const f = path.join(dir, 'decart.z64.' + i + '.txt'); if (!fs.existsSync(f)) break; b64 += fs.readFileSync(f, 'utf8').replace(/\s+/g, ''); }
  const b = require('zlib').inflateSync(Buffer.from(b64, 'base64'));
  if (crypto.createHash('sha256').update(b).digest('hex') !== DECART_SHA) return null;
  return (decartBuf = b);
}


// Magic Hour photo try-on (free credits only, hard daily caps, never auto top-up)
const MH = 'https://api.magichour.ai';
const mhHeaders = () => ({ Authorization: 'Bearer ' + process.env.MAGICHOUR_API_KEY, 'content-type': 'application/json' });
let mhDay = '', mhUsed = 0; const mhIp = new Map();
function mhAllow(ip) {
  const d = new Date().toISOString().slice(0, 10);
  if (d !== mhDay) { mhDay = d; mhUsed = 0; mhIp.clear(); }
  if (mhUsed >= parseInt(process.env.MAGICHOUR_MAX_PER_DAY || '5', 10)) return false;
  const n = mhIp.get(ip) || 0; if (n >= 2) return false;
  mhIp.set(ip, n + 1); mhUsed++; return true;
}
const mhOn = () => !!process.env.MAGICHOUR_API_KEY && process.env.MAGICHOUR_DISABLED !== '1';
function mhDataUrl(s) {
  const m = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/.exec(s || '');
  if (!m) return null; const buf = Buffer.from(m[2], 'base64'); if (buf.length > 4 * 1024 * 1024) return null;
  return { ext: m[1] === 'jpeg' ? 'jpg' : 'png', buf };
}
async function mhUpload(img) {
  const r = await fetch(MH + '/v1/files/upload-urls', { method: 'POST', headers: mhHeaders(), body: JSON.stringify({ items: [{ type: 'image', extension: img.ext }] }) });
  if (!r.ok) throw new Error('upload-urls ' + r.status);
  const it = (await r.json()).items[0];
  const put = await fetch(it.upload_url, { method: 'PUT', body: img.buf });
  if (!put.ok) throw new Error('upload ' + put.status);
  return it.file_path;
}


// Product photos (lossy WebP with transparency, served under the .png names the page asks for), stored as compressed text parts
let photoMap = null;
function bingoPhoto(name) {
  if (!photoMap) {
    let b64 = '';
    for (let i = 1; ; i++) { const f = path.join(__dirname, 'bingo', 'photos.z64.' + i + '.txt'); if (!fs.existsSync(f)) break; b64 += fs.readFileSync(f, 'utf8').replace(/\s+/g, ''); }
    try { photoMap = JSON.parse(require('zlib').inflateSync(Buffer.from(b64, 'base64')).toString()); } catch (e) { photoMap = {}; }
  }
  return Object.prototype.hasOwnProperty.call(photoMap, name) ? Buffer.from(photoMap[name], 'base64') : null;
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x'), p = url.pathname;
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

    if (p === '/api/site' && req.method === 'GET') return send(res, 200, { settings: publicSettings(await getSettings()), products: await getProducts() });
    if (p === '/api/products' && req.method === 'GET') return send(res, 200, await getProducts());

    if (p === '/api/validate-code' && req.method === 'POST') {
      if (limited('vc' + ip, 60)) return send(res, 429, { error: 'محاولات كتير' });
      const b = await body(req); const S = await getSettings(), prods = await getProducts(); let sub = 0;
      for (const [id, q] of Object.entries(b.items || {})) { const pr = prods.find(x => String(x.id) === String(id)); if (pr) sub += pr.price * Math.max(0, Math.min(20, Math.floor(Number(q)) || 0)); }
      return send(res, 200, priceOrder(S, sub, b.code));
    }
    if (p === '/api/track' && req.method === 'POST') {
      if (limited('tr' + ip, 30)) return send(res, 429, { error: 'محاولات كتير' });
      const b = await body(req); const num = clean(b.num, 20).toUpperCase(), ph = clean(b.phone, 20).replace(/\s/g, '');
      const o = (await ordersAll()).find(x => x.num === num);
      if (!o || !ph || o.phone.slice(-4) !== ph.slice(-4)) return send(res, 404, { error: 'مفيش طلب بالبيانات دي' });
      return send(res, 200, { num: o.num, status: o.status, at: o.at, total: o.total, items: o.items.map(i => ({ name: i.name, qty: i.qty })) });
    }
    if (p === '/api/orders' && req.method === 'POST') {
      if (limited(ip)) return send(res, 429, { error: 'طلبات كتير، حاول بعد شوية' });
      const b = await body(req);
      const name = clean(b.name, 80), phone = clean(b.phone, 20).replace(/\s/g, ''), gov = clean(b.gov, 40),
        addr = clean(b.addr, 300), notes = clean(b.notes, 300), pay = clean(b.pay, 60);
      if (!name || !gov || !addr) return send(res, 400, { error: 'بيانات ناقصة' });
      if (!/^01[0-9]{9}$/.test(phone)) return send(res, 400, { error: 'رقم الموبايل غير صحيح' });
      const S = await getSettings();
      if (S.storeOpen === false) return send(res, 400, { error: S.closedMessage || 'المتجر مغلق حالياً' });
      if ((pay !== CASH && !S.payTransfer) || (pay === CASH && S.payCash === false)) return send(res, 400, { error: 'طريقة الدفع غير متاحة' });
      const prods = await getProducts(), items = []; let total = 0;
      for (const [id, q] of Object.entries(b.items || {})) {
        const pr = prods.find(x => String(x.id) === String(id)); const qty = Math.floor(Number(q));
        if (!pr || pr.stock === false || !(qty >= 1 && qty <= 20)) return send(res, 400, { error: 'منتج غير متاح' });
        items.push({ id: pr.id, name: pr.name, price: pr.price, qty }); total += pr.price * qty;
      }
      if (!items.length) return send(res, 400, { error: 'السلة فاضية' });
      const pr2 = priceOrder(S, total, b.code); total = pr2.total;
      const num = 'SO-' + (100000 + crypto.randomInt(900000));
      const o = { num, at: new Date().toISOString(), name, phone, gov, addr, pay, notes, items, total, subtotal: pr2.subtotal, discount: pr2.discount, shipping: pr2.shipping, code: pr2.code, status: 'new' };
      await orderAdd(o);
      notify(o, items);
      return send(res, 200, { ok: true, num });
    }

    if (p === '/api/admin/login' && req.method === 'POST') {
      if (limited('login' + ip, 15)) return send(res, 429, { error: 'محاولات كتير' });
      const b = await body(req);
      if (await passwordOk(String(b.password || '')))
        return send(res, 200, { ok: true }, { 'Set-Cookie': 'adm=' + makeToken() + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800' + (req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '') });
      return send(res, 401, { error: 'كلمة السر غلط' });
    }

    if (p.startsWith('/api/admin/')) {
      if (!isAdmin(req)) return send(res, 401, { error: 'غير مصرح' });
      if (p === '/api/admin/info') return send(res, 200, { storage: USE_DB ? 'db' : 'local', telegram: !!(TG_TOKEN && TG_CHAT) });
      if (p === '/api/admin/test-notify' && req.method === 'POST') {
        const st = await notify({ num: 'TEST', name: 'تجربة', phone: '-', gov: '-', addr: '-', pay: '-', total: 0, notes: 'ده اختبار، مش طلب حقيقي' }, [{ name: 'إشعار تجريبي', qty: 1 }]);
        return send(res, 200, { result: st });
      }
      if (p === '/api/admin/orders' && req.method === 'GET') return send(res, 200, (await ordersAll()).reverse());
      if (p === '/api/admin/status' && req.method === 'POST') {
        const b = await body(req);
        if (!['new', 'confirmed', 'shipped', 'delivered', 'canceled'].includes(b.status)) return send(res, 400, { error: 'خطأ' });
        return (await orderSetStatus(b.num, b.status)) ? send(res, 200, { ok: true }) : send(res, 400, { error: 'الطلب مش موجود' });
      }
      if (p === '/api/admin/password' && req.method === 'POST') {
        const b = await body(req);
        if (!(await passwordOk(String(b.current || '')))) return send(res, 400, { error: 'كلمة السر الحالية غلط' });
        const np = String(b.next || ''); if (np.length < 8) return send(res, 400, { error: 'كلمة السر الجديدة لازم 8 حروف على الأقل' });
        const salt = crypto.randomBytes(16).toString('hex'); await kvSet('admin', { salt, hash: sha(np, salt) });
        return send(res, 200, { ok: true });
      }
      if (p === '/api/admin/settings' && req.method === 'GET') return send(res, 200, await getSettings());
      if (p === '/api/admin/backup' && req.method === 'GET') {
        return send(res, 200, { exportedAt: new Date().toISOString(), settings: await getSettings(), products: await getProducts(), admin: undefined, orders: await ordersAll() },
          { 'Content-Disposition': 'attachment; filename="sihr-aloyoun-backup.json"' });
      }
      if (p === '/api/admin/settings' && req.method === 'POST') {
        const b = await body(req, 2500000);
        const cur = await getSettings();
        let ns; try { ns = sanitizeSettings(b); } catch (e) { return send(res, 400, { error: e.message }); }
        await kvSet('settings', Object.assign({}, cur, ns));
        return send(res, 200, { ok: true });
      }
      if (p === '/api/admin/product' && req.method === 'POST') { // إضافة أو تعديل
        const b = await body(req, 2500000), prods = await getProducts();
        let x = b.id ? prods.find(q => q.id === b.id) : null;
        if (!x) { x = { id: prods.reduce((m, q) => Math.max(m, q.id), 0) + 1, c1: '#c9a24b', c2: '#5b3a1a', stock: true, tag: null, old: null }; prods.push(x); }
        if (b.name !== undefined) { x.name = clean(b.name, 60); if (!x.name) return send(res, 400, { error: 'الاسم مطلوب' }); }
        if (b.notes !== undefined) x.notes = clean(b.notes, 200);
        if (b.cat !== undefined) x.cat = clean(b.cat, 30);
        if (b.tag !== undefined) x.tag = clean(b.tag, 20) || null;
        if (b.price !== undefined) { const n = Number(b.price); if (!(n > 0 && n < 1e6)) return send(res, 400, { error: 'سعر غلط' }); x.price = n; }
        if (b.old !== undefined) x.old = b.old ? Number(b.old) : null;
        if (b.stock !== undefined) x.stock = !!b.stock;
        if (b.image !== undefined) { if (!okImg(b.image)) return send(res, 400, { error: 'صورة غير صالحة أو كبيرة' }); x.image = b.image; }
        if (typeof x.price !== 'number') return send(res, 400, { error: 'السعر مطلوب' });
        await kvSet('products', prods); return send(res, 200, { ok: true, id: x.id });
      }
      if (p === '/api/admin/product-delete' && req.method === 'POST') {
        const b = await body(req); const prods = (await getProducts()).filter(q => q.id !== b.id);
        await kvSet('products', prods); return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'not found' });
    }

    if (p === '/api/decart-status' && req.method === 'GET') return send(res, 200, { enabled: !!process.env.DECART_API_KEY && process.env.DECART_DISABLED !== '1' });
    if (p === '/api/decart-token' && req.method === 'POST') {
      if (!process.env.DECART_API_KEY || process.env.DECART_DISABLED === '1') return send(res, 503, { error: 'disabled' });
      if (!decartAllow(ip)) return send(res, 429, { error: 'تم الوصول لحد التجارب اليوم' });
      const r = await fetch('https://api.decart.ai/v1/client/tokens', {
        method: 'POST',
        headers: { 'X-API-KEY': process.env.DECART_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ expiresIn: 60, allowedModels: ['lucy-vton-latest'], allowedOrigins: ['https://sihr-aloyoun.onrender.com'], constraints: { realtime: { maxSessionDuration: 30 } } })
      });
      if (!r.ok) return send(res, 502, { error: 'token failed ' + r.status });
      return send(res, 200, await r.json());
    }
    if (p === '/api/tryon-photo-status' && req.method === 'GET') return send(res, 200, { enabled: mhOn() });
    if (p === '/api/tryon-photo' && req.method === 'POST') {
      if (!mhOn()) return send(res, 503, { error: 'الميزة مقفولة حاليا' });
      const b = await body(req, 12 * 1024 * 1024);
      const person = mhDataUrl(b.person), garment = mhDataUrl(b.garment);
      if (!person || !garment) return send(res, 400, { error: 'صورة غير صالحة' });
      if (!mhAllow(ip)) return send(res, 429, { error: 'وصلت للحد اليومي للتجارب، جرب بكرة' });
      try {
        const [pp, gp] = await Promise.all([mhUpload(person), mhUpload(garment)]);
        const r = await fetch(MH + '/v1/ai-clothes-changer', { method: 'POST', headers: mhHeaders(),
          body: JSON.stringify({ name: 'bingo tryon', assets: { person_file_path: pp, garment_file_path: gp, garment_type: 'upper_body' } }) });
        const j = await r.json().catch(() => ({}));
        if (r.status === 402) return send(res, 503, { error: 'رصيد الخدمة خلص' });
        if (!r.ok) return send(res, 502, { error: j.message || ('خطأ ' + r.status) });
        return send(res, 200, { id: j.id });
      } catch (e) { return send(res, 502, { error: 'فشل الاتصال بالخدمة' }); }
    }
    { const mm = /^\/api\/tryon-photo\/([A-Za-z0-9_-]{6,64})$/.exec(p);
      if (mm && req.method === 'GET') {
        if (!mhOn()) return send(res, 400, { error: 'bad id' });
        try {
          const r = await fetch(MH + '/v1/image-projects/' + mm[1], { headers: mhHeaders() });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) return send(res, 502, { status: 'error', message: 'خطأ ' + r.status });
          return send(res, 200, { status: j.status, url: j.downloads && j.downloads[0] && j.downloads[0].url, message: j.error && j.error.message });
        } catch (e) { return send(res, 502, { status: 'error', message: 'فشل الاتصال' }); }
      } }
    if (p === '/tryon' || p === '/bingo') { res.writeHead(301, { Location: p + '/' }); return res.end(); }
    const appM = /^\/(tryon|bingo)\/(.*)$/.exec(p);
    if (appM) {
      const app = appM[1], rel = decodeURIComponent(appM[2]) || 'index.html';
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.task': 'application/octet-stream' };
      let buf = null;
      if (APPS[app][rel]) buf = await tryonAsset(app, rel);
      else if (app === 'bingo' && rel === 'lib/decart.bundle.js') buf = decartBundle();
      else if (app === 'bingo' && /^photos\/[A-Za-z0-9_.-]+$/.test(rel)) { buf = bingoPhoto(rel.slice(7)); if (buf && rel.endsWith('.png')) { res.writeHead(200, { 'Content-Type': 'image/webp', 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=86400' }); return res.end(buf); } }
      else {
        const root = path.join(__dirname, app), fp = path.normalize(path.join(root, rel));
        if (fp.startsWith(root + path.sep) && /\.(html|js)$/.test(fp) && fs.existsSync(fp) && fs.statSync(fp).isFile()) buf = fs.readFileSync(fp);
      }
      if (!buf) { res.writeHead(404); return res.end('Not found'); }
      const ext = path.extname(rel).toLowerCase();
      res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Content-Length': buf.length, 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400' });
      return res.end(buf);
    }
    const page = PAGES[p];
    if (!page) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
    fs.createReadStream(path.join(__dirname, page)).pipe(res);
  } catch (e) { console.error(e.message); try { if (e.code === 413) return send(res, 413, { error: 'الصورة كبيرة قوي' }); send(res, 500, { error: 'خطأ في السيرفر' }); } catch (_) {} }
}).listen(PORT, () => console.log('Store running on port ' + PORT));
