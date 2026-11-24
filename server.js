// متجر سحر العيون - سيرفر بدون مكتبات خارجية (Node 18+)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('s:' + ADMIN_PASSWORD).digest('hex');
if (!ADMIN_PASSWORD) console.warn('تحذير: ADMIN_PASSWORD غير مضبوط، لوحة الأدمن مقفولة.');

fs.mkdirSync(DATA_DIR, { recursive: true });
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
if (!fs.existsSync(PRODUCTS_FILE)) fs.copyFileSync(path.join(__dirname, 'products.default.json'), PRODUCTS_FILE);
if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, '[]');

const readJSON = f => JSON.parse(fs.readFileSync(f, 'utf8'));
function writeJSON(f, d) { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(d, null, 1)); fs.renameSync(t, f); }

const GOVS = null; // أي محافظة نصية مقبولة
const hits = new Map(); // rate limit
function limited(ip) {
  const now = Date.now(), a = (hits.get(ip) || []).filter(t => now - t < 3600e3);
  a.push(now); hits.set(ip, a); return a.length > 10;
}
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

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
  return m && validToken(m[1]);
}

function body(req) {
  return new Promise((res, rej) => {
    let d = ''; req.on('data', c => { d += c; if (d.length > 50000) { rej(new Error('big')); req.destroy(); } });
    req.on('end', () => { try { res(JSON.parse(d || '{}')); } catch (e) { rej(e); } });
  });
}
function send(res, code, obj, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(obj));
}

async function notify(o, items) {
  if (!TG_TOKEN || !TG_CHAT) return 'not-configured';
  const text = '🛍 طلب جديد - سحر العيون\nرقم: ' + o.num + '\nالاسم: ' + o.name + '\nالموبايل: ' + o.phone +
    '\nالمحافظة: ' + o.gov + '\nالعنوان: ' + o.addr + '\nالدفع: ' + o.pay + '\n' +
    items.map(i => '- ' + i.name + ' x' + i.qty).join('\n') + '\nالإجمالي: ' + o.total + ' ج.م' + (o.notes ? '\nملاحظات: ' + o.notes : '');
  try {
    const r = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text })
    });
    if (!r.ok) console.error('Telegram error', r.status);
    return r.ok ? 'sent' : 'telegram-error-' + r.status;
  } catch (e) { console.error('Telegram failed', e.message); return 'failed'; }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x'), p = url.pathname;
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

    if (p === '/api/products' && req.method === 'GET') return send(res, 200, readJSON(PRODUCTS_FILE));

    if (p === '/api/orders' && req.method === 'POST') {
      if (limited(ip)) return send(res, 429, { error: 'طلبات كتير، حاول بعد شوية' });
      const b = await body(req);
      const name = clean(b.name, 80), phone = clean(b.phone, 20).replace(/\s/g, ''), gov = clean(b.gov, 40),
        addr = clean(b.addr, 300), notes = clean(b.notes, 300), pay = clean(b.pay, 60);
      if (!name || !gov || !addr) return send(res, 400, { error: 'بيانات ناقصة' });
      if (!/^01[0-9]{9}$/.test(phone)) return send(res, 400, { error: 'رقم الموبايل غير صحيح' });
      const prods = readJSON(PRODUCTS_FILE), items = []; let total = 0;
      for (const [id, q] of Object.entries(b.items || {})) {
        const pr = prods.find(x => String(x.id) === String(id)); const qty = Math.floor(Number(q));
        if (!pr || pr.stock === false || !(qty >= 1 && qty <= 20)) return send(res, 400, { error: 'منتج غير متاح' });
        items.push({ id: pr.id, name: pr.name, price: pr.price, qty }); total += pr.price * qty;
      }
      if (!items.length) return send(res, 400, { error: 'السلة فاضية' });
      const orders = readJSON(ORDERS_FILE);
      let num; do { num = 'SO-' + (100000 + crypto.randomInt(900000)); } while (orders.some(o => o.num === num));
      const o = { num, at: new Date().toISOString(), name, phone, gov, addr, pay, notes, items, total, status: 'new' };
      orders.push(o); writeJSON(ORDERS_FILE, orders);
      notify(o, items);
      return send(res, 200, { ok: true, num });
    }

    if (p === '/api/admin/login' && req.method === 'POST') {
      if (limited('login' + ip)) return send(res, 429, { error: 'محاولات كتير' });
      const b = await body(req);
      const a = Buffer.from(String(b.password || '')), c = Buffer.from(ADMIN_PASSWORD);
      if (ADMIN_PASSWORD && a.length === c.length && crypto.timingSafeEqual(a, c))
        return send(res, 200, { ok: true }, { 'Set-Cookie': 'adm=' + makeToken() + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800' + (req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '') });
      return send(res, 401, { error: 'كلمة السر غلط' });
    }

    if (p.startsWith('/api/admin/')) {
      if (!isAdmin(req)) return send(res, 401, { error: 'غير مصرح' });
      if (p === '/api/admin/test-notify' && req.method === 'POST') {
        const items = [{ name: 'إشعار تجريبي', qty: 1 }];
        const st = await notify({ num: 'TEST', name: 'تجربة', phone: '-', gov: '-', addr: '-', pay: '-', total: 0, notes: 'ده اختبار، مش طلب حقيقي' }, items);
        return send(res, 200, { result: st });
      }
      if (p === '/api/admin/orders' && req.method === 'GET') return send(res, 200, readJSON(ORDERS_FILE).reverse());
      if (p === '/api/admin/status' && req.method === 'POST') {
        const b = await body(req), orders = readJSON(ORDERS_FILE), o = orders.find(x => x.num === b.num);
        if (!o || !['new', 'confirmed', 'shipped', 'delivered', 'canceled'].includes(b.status)) return send(res, 400, { error: 'خطأ' });
        o.status = b.status; writeJSON(ORDERS_FILE, orders); return send(res, 200, { ok: true });
      }
      if (p === '/api/admin/products' && req.method === 'POST') {
        const b = await body(req), prods = readJSON(PRODUCTS_FILE), x = prods.find(q => q.id === b.id);
        if (!x) return send(res, 400, { error: 'منتج غير موجود' });
        if (b.price != null) { const n = Number(b.price); if (!(n > 0 && n < 1e6)) return send(res, 400, { error: 'سعر غلط' }); x.price = n; }
        if (b.old !== undefined) x.old = b.old ? Number(b.old) : null;
        if (b.stock !== undefined) x.stock = !!b.stock;
        if (b.name) x.name = clean(b.name, 60);
        writeJSON(PRODUCTS_FILE, prods); return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'not found' });
    }

    // static
    let f = p === '/' ? '/index.html' : p === '/admin' ? '/admin.html' : p;
    const full = path.join(__dirname, path.basename(f));
    if (!['index.html','admin.html'].includes(path.basename(full)) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    fs.createReadStream(full).pipe(res);
  } catch (e) { console.error(e); try { send(res, 500, { error: 'خطأ في السيرفر' }); } catch (_) {} }
}).listen(PORT, () => console.log('Store running on port ' + PORT));
