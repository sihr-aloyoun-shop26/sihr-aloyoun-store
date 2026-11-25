// Garment prep (background removal + landmarks) and body-anchored drawing.
export function prepare(img, maxSide = 640) {
  const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(2, Math.round(img.naturalWidth * k)), h = Math.max(2, Math.round(img.naturalHeight * k));
  let cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  let x = cv.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0, w, h);
  const id = x.getImageData(0, 0, w, h), d = id.data;
  const A = (px, py) => d[(py * w + px) * 4 + 3];
  const hasAlpha = A(0, 0) < 10 && A(w - 1, 0) < 10 && A(0, h - 1) < 10 && A(w - 1, h - 1) < 10;
  const fg = new Uint8Array(w * h);
  if (hasAlpha) { for (let i = 0; i < w * h; i++) fg[i] = d[i * 4 + 3] > 20 ? 1 : 0; }
  else {
    // background colour = median of border pixels
    const r = [], g = [], b = [];
    const add = (px, py) => { const i = (py * w + px) * 4; r.push(d[i]); g.push(d[i + 1]); b.push(d[i + 2]); };
    for (let i = 0; i < w; i++) { add(i, 0); add(i, h - 1); } for (let j = 0; j < h; j++) { add(0, j); add(w - 1, j); }
    const cnt = new Map(); for (let i = 0; i < r.length; i++) { const key = (r[i] >> 4) * 256 + (g[i] >> 4) * 16 + (b[i] >> 4); cnt.set(key, (cnt.get(key) || 0) + 1); }
    let bk = 0, bc = -1; for (const [kk, v] of cnt) if (v > bc) { bc = v; bk = kk; }
    const br = ((bk >> 8) << 4) + 8, bg = (((bk >> 4) & 15) << 4) + 8, bb = ((bk & 15) << 4) + 8;
    const dist = i => Math.hypot(d[i * 4] - br, d[i * 4 + 1] - bg, d[i * 4 + 2] - bb);
    const thr = 42, bgm = new Uint8Array(w * h), q = new Int32Array(w * h); let qs = 0, qe = 0;
    const push = i => { if (!bgm[i] && dist(i) < thr) { bgm[i] = 1; q[qe++] = i; } };
    for (let i = 0; i < w; i++) { push(i); push((h - 1) * w + i); } for (let j = 0; j < h; j++) { push(j * w); push(j * w + w - 1); }
    while (qs < qe) { const i = q[qs++], px = i % w, py = (i / w) | 0; if (px > 0) push(i - 1); if (px < w - 1) push(i + 1); if (py > 0) push(i - w); if (py < h - 1) push(i + w); }
    for (let i = 0; i < w * h; i++) fg[i] = bgm[i] ? 0 : 1;
    // remove thin leaks / specks: erode then dilate (3x3)
    const er = new Uint8Array(w * h);
    for (let py = 1; py < h - 1; py++) for (let px = 1; px < w - 1; px++) { const i = py * w + px; er[i] = fg[i] && fg[i - 1] && fg[i + 1] && fg[i - w] && fg[i + w] ? 1 : 0; }
    const dl = new Uint8Array(w * h);
    for (let py = 1; py < h - 1; py++) for (let px = 1; px < w - 1; px++) { const i = py * w + px; dl[i] = er[i] || er[i - 1] || er[i + 1] || er[i - w] || er[i + w] ? 1 : 0; }
    for (let i = 0; i < w * h; i++) fg[i] = dl[i] && fg[i] ? 1 : 0;
  }
  // keep the largest connected component (drops a second item / stray shadow)
  const lab = new Int32Array(w * h); let best = 0, bestN = 0, n = 0; const st = new Int32Array(w * h);
  for (let s = 0; s < w * h; s++) if (fg[s] && !lab[s]) {
    n++; let sp = 0, cnt = 0; st[sp++] = s; lab[s] = n;
    while (sp) { const i = st[--sp]; cnt++; const px = i % w, py = (i / w) | 0;
      const nb = [px > 0 ? i - 1 : -1, px < w - 1 ? i + 1 : -1, py > 0 ? i - w : -1, py < h - 1 ? i + w : -1];
      for (const j of nb) if (j >= 0 && fg[j] && !lab[j]) { lab[j] = n; st[sp++] = j; } }
    if (cnt > bestN) { bestN = cnt; best = n; }
  }
  // alpha with a soft edge
  const al = new Float32Array(w * h); for (let i = 0; i < w * h; i++) al[i] = lab[i] === best ? 1 : 0;
  const al2 = new Float32Array(w * h);
  for (let py = 1; py < h - 1; py++) for (let px = 1; px < w - 1; px++) { const i = py * w + px; al2[i] = (al[i] * 4 + al[i - 1] + al[i + 1] + al[i - w] + al[i + w]) / 8; }
  let x0 = w, x1 = 0, y0 = h, y1 = 0; const rowW = new Int32Array(h);
  for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) { const i = py * w + px;
    d[i * 4 + 3] = hasAlpha ? Math.min(d[i * 4 + 3], al[i] ? 255 : 0) : Math.round(al2[i] * 255);
    if (al[i]) { rowW[py]++; if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py; } }
  x.putImageData(id, 0, 0);
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const out = document.createElement('canvas'); out.width = bw; out.height = bh; out.getContext('2d').drawImage(cv, x0, y0, bw, bh, 0, 0, bw, bh);
  // shoulder row = first row (below any hood) that reaches 75% of the max width
  let maxW = 0; for (let j = y0; j <= y1; j++) maxW = Math.max(maxW, rowW[j]);
  let sy = y0; for (let j = y0; j <= y1; j++) if (rowW[j] >= 0.75 * maxW) { sy = j; break; }
  // centre of the silhouette at the shoulder row
  let cl = w, cr = 0; for (let px = 0; px < w; px++) if (al[sy * w + px]) { if (px < cl) cl = px; if (px > cr) cr = px; }
  const G = { cv: out, W: bw, H: bh, shoulderY: sy - y0, rowW: Math.max(1, cr - cl + 1), cx: (cl + cr) / 2 - x0 };
  G.th = G.rowW * 0.33;
  const pad = Math.min(G.shoulderY, Math.round(G.rowW * 0.1)); G.pad = pad;
  const strip = (xa, xb) => {
    xa = Math.max(0, Math.floor(xa)); xb = Math.min(bw, Math.ceil(xb)); const sw2 = xb - xa; if (sw2 < 6) return null;
    const ya = G.shoulderY - pad, c2 = document.createElement('canvas'); c2.width = sw2; c2.height = bh - ya;
    const x2 = c2.getContext('2d', { willReadFrequently: true }); x2.drawImage(out, xa, ya, sw2, bh - ya, 0, 0, sw2, bh - ya);
    const dd = x2.getImageData(0, 0, sw2, c2.height).data; let last = 0, first = 1e9;
    for (let j = 0; j < c2.height; j++) { let hit = 0; for (let i = 0; i < sw2; i++) if (dd[(j * sw2 + i) * 4 + 3] > 40) { hit = 1; break; } if (hit) { last = j; if (j < first) first = j; } }
    if (last < pad + 8) return null;
    return { cv: c2, w: sw2, h: last + 1 };
  };
  G.slL = strip(0, G.cx - G.th);          // image-left strip = person's right arm
  G.slR = strip(G.cx + G.th, bw);         // image-right strip = person's left arm
  return G;
}
const F = { tee: { wf: 1.42, len: 1.15 }, hood: { wf: 1.55, len: 1.32 }, jacket: { wf: 1.55, len: 1.25 } };
let prev = null, prevYaw = 0, flt = [];
// One Euro filter: smooth when still, responsive when moving fast (low jitter, low lag)
class OneEuro { constructor(mc = 1.2, beta = 0.012, dc = 1) { this.mc = mc; this.b = beta; this.dc = dc; this.x = null; this.dx = 0; this.t = 0; }
  al(c, dt) { const r = 2 * Math.PI * c * dt; return r / (r + 1); }
  f(v, t) { if (this.x === null) { this.x = v; this.t = t; return v; } const dt = Math.max(1e-3, t - this.t); this.t = t;
    const d = (v - this.x) / dt; this.dx += this.al(this.dc, dt) * (d - this.dx); const c = this.mc + this.b * Math.abs(this.dx);
    this.x += this.al(c, dt) * (v - this.x); return this.x; } }
export function resetSmooth() { prev = null; flt = []; }
// L = pose landmarks (normalised), W/H canvas px. Returns false if the body is not usable.
export function drawGarment(ctx, video, L, W, H, g, type, g3, arms = true) {
  const pick = [11, 12, 23, 24, 0, 7, 8, 9, 10, 13, 14, 15, 16].map(i => L[i]);
  let pts = pick.map(p => ({ x: p.x * W, y: p.y * H }));
  const tnow = performance.now() / 1000; pts = pts.map((p, i) => { const f = (flt[i] = flt[i] || { x: new OneEuro(), y: new OneEuro() }); return { x: f.x.f(p.x, tnow), y: f.y.f(p.y, tnow) }; });
  prev = pts;
  const [ls, rs, lh, rh, nose, le, re, ml, mr, lel, rel, lwr, rwr] = pts;
  const sw = Math.hypot(ls.x - rs.x, ls.y - rs.y); if (sw < 20) return false;
  const smid = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
  const ex = { x: (ls.x - rs.x) / sw, y: (ls.y - rs.y) / sw };
  let ey = { x: -ex.y, y: ex.x }; // perpendicular, pointing down in image
  if (ey.y < 0) ey = { x: -ey.x, y: -ey.y };
  const hipOK = L[23].visibility > 0.5 && L[24].visibility > 0.5;
  let torso = 1.4 * sw;
  if (hipOK) { const hm = { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 }; torso = Math.hypot(hm.x - smid.x, hm.y - smid.y);
    const dx = (hm.x - smid.x) / torso, dy = (hm.y - smid.y) / torso; // lean, blended with the shoulder perpendicular
    ey = { x: ey.x * 0.5 + dx * 0.5, y: ey.y * 0.5 + dy * 0.5 }; const l = Math.hypot(ey.x, ey.y); ey = { x: ey.x / l, y: ey.y / l }; }
  const p = F[type] || F.tee;
  const sx = sw * p.wf / g.rowW;
  const sY = (torso * p.len) / Math.max(1, g.H - g.shoulderY);
  const ox = smid.x - ey.x * 0.12 * sw, oy = smid.y - ey.y * 0.12 * sw;
  let yaw = 0; if (L[11].z !== undefined) { const dz = (L[11].z - L[12].z) * W, dxp = Math.abs(ls.x - rs.x); yaw = Math.max(-1.1, Math.min(1.1, Math.atan2(dz, Math.max(dxp, 1)) * 0.9)); yaw = prevYaw = prevYaw * 0.7 + yaw * 0.3; }
  if (g3) { const cv3 = g3.render({ ex, ey, sx, sY, ox, oy, yaw }); if (cv3) ctx.drawImage(cv3, 0, 0, W, H); }
  else {
  const useArms = arms && (g.slL || g.slR);
  ctx.save();
  ctx.setTransform(ex.x * sx, ex.y * sx, ey.x * sY, ey.y * sY, ox, oy);
  ctx.translate(-g.cx, -g.shoulderY);
  if (useArms) { ctx.beginPath(); const cap = 0.12 * g.rowW;
    ctx.rect(g.cx - g.th, -10, 2 * g.th, g.H + 20); ctx.rect(g.cx - g.th - cap, -10, 2 * (g.th + cap), g.shoulderY + cap + 10); ctx.clip(); }
  ctx.drawImage(g.cv, 0, 0);
  ctx.restore();
  if (useArms) {
    const vis = i => L[i].visibility > 0.4;
    const sleeve = (st, S, E, Wr, ve, vw) => {
      if (!st) return;
      const hang = { x: ey.x, y: ey.y };
      if (!ve) { E = { x: S.x + hang.x * 0.8 * sw, y: S.y + hang.y * 0.8 * sw }; Wr = { x: E.x + hang.x * 0.7 * sw, y: E.y + hang.y * 0.7 * sw }; }
      else if (!vw) { const d = { x: (E.x - S.x), y: (E.y - S.y) }; Wr = { x: E.x + d.x * 0.85, y: E.y + d.y * 0.85 }; }
      const Ls = st.h - g.pad, k = sx;
      const seg = (srcY, srcH, A, B, ext) => {
        let dx = B.x - A.x, dy = B.y - A.y; const len = Math.hypot(dx, dy); if (len < 1) return; const ux = dx / len, uy = dy / len;
        let nx = -uy, ny = ux; if (nx * ex.x + ny * ex.y < 0) { nx = -nx; ny = -ny; }
        const tl = len + ext; // draw slightly past B so the joints overlap
        ctx.save(); ctx.setTransform(nx * k, ny * k, ux * tl / srcH, uy * tl / srcH, A.x - nx * k * st.w / 2, A.y - ny * k * st.w / 2);
        ctx.drawImage(st.cv, 0, srcY, st.w, srcH, 0, 0, st.w, srcH); ctx.restore(); };
      const padPx = g.pad * k, u1 = Math.hypot(E.x - S.x, E.y - S.y) || 1;
      const up = { x: (E.x - S.x) / u1, y: (E.y - S.y) / u1 };
      const S0 = { x: S.x - up.x * padPx, y: S.y - up.y * padPx };
      const upper = u1, lower = Math.hypot(Wr.x - E.x, Wr.y - E.y);
      if (Ls * k < 0.8 * upper) { const B = { x: S.x + up.x * Ls * k, y: S.y + up.y * Ls * k }; seg(0, st.h, S0, B, 0); }
      else { const tot = upper + lower * 1.05, split = Ls * upper / tot;
        seg(0, g.pad + split, S0, E, 3);
        const Wx = { x: E.x + (Wr.x - E.x) * 1.05, y: E.y + (Wr.y - E.y) * 1.05 };
        seg(g.pad + split, st.h - g.pad - split, E, Wx, 0); }
    };
    sleeve(g.slL, rs, rel, rwr, vis(14), vis(16));
    sleeve(g.slR, ls, lel, lwr, vis(13), vis(15));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  }
  // head and neck stay in front of the garment (hood sits behind the head)
  const ed = Math.max(20, Math.hypot(le.x - re.x, le.y - re.y));
  const mY = (ml.y + mr.y) / 2, top = (le.y + re.y) / 2 - 1.05 * ed, bot = mY + 0.45 * ed;
  const cx = (le.x + re.x) / 2, cy = (top + bot) / 2;
  ctx.save(); ctx.beginPath(); ctx.ellipse(cx, cy, ed * 0.95, (bot - top) / 2, Math.atan2(ex.y, ex.x), 0, Math.PI * 2); ctx.clip();
  ctx.drawImage(video, 0, 0, W, H); ctx.restore();
  return true;
}
