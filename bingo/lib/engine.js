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
  return { cv: out, W: bw, H: bh, shoulderY: sy - y0, rowW: Math.max(1, cr - cl + 1), cx: (cl + cr) / 2 - x0 };
}
const F = { tee: { wf: 1.42, len: 1.15 }, hood: { wf: 1.55, len: 1.32 }, jacket: { wf: 1.55, len: 1.25 } };
let prev = null, prevYaw = 0;
export function resetSmooth() { prev = null; }
// L = pose landmarks (normalised), W/H canvas px. Returns false if the body is not usable.
export function drawGarment(ctx, video, L, W, H, g, type, g3) {
  const pick = [11, 12, 23, 24, 0, 7, 8, 9, 10].map(i => L[i]);
  let pts = pick.map(p => ({ x: p.x * W, y: p.y * H }));
  if (prev) { const sw0 = Math.hypot(prev[0].x - prev[1].x, prev[0].y - prev[1].y) || 1;
    pts = pts.map((p, i) => { const sp = Math.hypot(p.x - prev[i].x, p.y - prev[i].y); const a = Math.min(0.85, 0.3 + sp / (sw0 * 0.25)); return { x: prev[i].x * (1 - a) + p.x * a, y: prev[i].y * (1 - a) + p.y * a }; }); }
  prev = pts;
  const [ls, rs, lh, rh, nose, le, re, ml, mr] = pts;
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
  ctx.save();
  ctx.setTransform(ex.x * sx, ex.y * sx, ey.x * sY, ey.y * sY, ox, oy);
  ctx.translate(-g.cx, -g.shoulderY);
  ctx.drawImage(g.cv, 0, 0);
  ctx.restore(); }
  // head and neck stay in front of the garment (hood sits behind the head)
  const ed = Math.max(20, Math.hypot(le.x - re.x, le.y - re.y));
  const mY = (ml.y + mr.y) / 2, top = (le.y + re.y) / 2 - 1.05 * ed, bot = mY + 0.45 * ed;
  const cx = (le.x + re.x) / 2, cy = (top + bot) / 2;
  ctx.save(); ctx.beginPath(); ctx.ellipse(cx, cy, ed * 0.95, (bot - top) / 2, Math.atan2(ex.y, ex.x), 0, Math.PI * 2); ctx.clip();
  ctx.drawImage(video, 0, 0, W, H); ctx.restore();
  return true;
                                     }
