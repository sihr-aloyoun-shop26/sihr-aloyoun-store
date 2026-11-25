import * as THREE from './three.module.js';
// Garment photo wrapped around a rounded torso shell (front) with a darker back shell. Turns with body yaw and is lit.
export class Garment3D {
  constructor(W, H) {
    this.r = new THREE.WebGLRenderer({ alpha: true, antialias: true, premultipliedAlpha: true, preserveDrawingBuffer: true });
    this.r.setSize(W, H, false); this.r.setClearColor(0, 0);
    this.s = new THREE.Scene();
    this.cam = new THREE.OrthographicCamera(0, W, 0, -H, -3000, 3000); this.cam.position.z = 1500;
    this.s.add(new THREE.AmbientLight(0xffffff, 0.75));
    const dl = new THREE.DirectionalLight(0xffffff, 0.8); dl.position.set(-0.4, -0.6, 1); this.s.add(dl);
    this.root = new THREE.Group(); this.root.matrixAutoUpdate = false; this.s.add(this.root);
    this.inner = new THREE.Group(); this.root.add(this.inner);
  }
  set(g) {
    while (this.inner.children.length) { const m = this.inner.children[0]; m.geometry.dispose(); m.material.dispose(); this.inner.remove(m); }
    this.g = g;
    const tex = new THREE.CanvasTexture(g.cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
    const NX = 40, NY = 24, PHI = 1.15, depth = 0.34 * g.rowW; // depth = how round the torso is
    const pos = [], uv = [], idx = [];
    for (let j = 0; j <= NY; j++) for (let i = 0; i <= NX; i++) {
      const u = i / NX, v = j / NY, phi = (u - 0.5) * 2 * PHI;
      const x = (Math.sin(phi) / Math.sin(PHI)) * 0.5 * g.W;
      const z = (Math.cos(phi) - Math.cos(PHI)) / (1 - Math.cos(PHI)) * depth;
      pos.push(x + g.W / 2 - g.cx, v * g.H - g.shoulderY, z); uv.push(u, 1 - v);
    }
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) { const a = j * (NX + 1) + i, b = a + 1, c = a + NX + 1, d = c + 1; idx.push(a, c, b, b, c, d); }
    const mk = flip => { const geo = new THREE.BufferGeometry(); const p = pos.slice(); if (flip) for (let k = 2; k < p.length; k += 3) p[k] = -p[k] - 0 + 0;
      geo.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); geo.setIndex(idx); geo.computeVertexNormals(); return geo; };
    const front = new THREE.Mesh(mk(false), new THREE.MeshLambertMaterial({ map: tex, transparent: true, alphaTest: 0.35, side: THREE.DoubleSide }));
    const back = new THREE.Mesh(mk(true), new THREE.MeshLambertMaterial({ map: tex, color: 0x777777, transparent: true, alphaTest: 0.35, side: THREE.DoubleSide }));
    back.position.z = -depth * 0.9; front.position.z = depth * 0.0;
    this.inner.add(back); this.inner.add(front);
    // centre the pair around z=0 so it turns about the body axis
    this.inner.position.z = 0; front.position.z = depth * 0.5; back.position.z = -depth * 0.5 - depth * 0.1;
  }
  render(f) {
    if (!this.g) return null;
    const m = new THREE.Matrix4(); m.set(
      f.ex.x * f.sx, f.ey.x * f.sY, 0, f.ox,
      -f.ex.y * f.sx, -f.ey.y * f.sY, 0, -f.oy,
      0, 0, f.sx, 0,
      0, 0, 0, 1);
    this.root.matrix.copy(m); this.root.matrixWorldNeedsUpdate = true;
    this.inner.rotation.y = f.yaw;
    this.r.render(this.s, this.cam); return this.r.domElement;
  }
}
