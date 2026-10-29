import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { PreviewPath } from '../core/toolpath.ts';
import type { Layer } from '../core/types.ts';

export const RUN_COLORS = ['#4fc3f7', '#ffb74d', '#81c784', '#e57373', '#ba68c8', '#fff176', '#4db6ac', '#f06292', '#a1887f', '#90a4ae', '#7986cb', '#aed581'];

export class Viewer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private extrude?: THREE.LineSegments;
  private travel?: THREE.LineSegments;
  private bottom?: THREE.LineSegments;
  /** Cumulative vertex counts (line-segment vertices) at the end of each segment. */
  private extrudeEnds: number[] = [];
  private travelEnds: number[] = [];

  private host: HTMLElement;

  constructor(host: HTMLElement) {
    this.host = host;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    host.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(150, -200, 150);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.scene.background = new THREE.Color('#1b1e24');
    const grid = new THREE.GridHelper(400, 40, 0x445, 0x334);
    grid.rotation.x = Math.PI / 2;
    this.scene.add(grid);
    this.scene.add(new THREE.AxesHelper(20));
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.renderer.setAnimationLoop(() => { this.controls.update(); this.renderer.render(this.scene, this.camera); });
  }

  private resize() {
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Replace the displayed toolpath. */
  setPaths(paths: PreviewPath[], bottomLayers: Layer[]) {
    for (const o of [this.extrude, this.travel, this.bottom]) if (o) { this.scene.remove(o); o.geometry.dispose(); }
    const ex: number[] = [], exc: number[] = [], tr: number[] = [];
    this.extrudeEnds = []; this.travelEnds = [];
    let segIdx = -1;
    const pushEnds = () => { this.extrudeEnds.push(ex.length / 3); this.travelEnds.push(tr.length / 3); };
    for (const p of paths) {
      while (segIdx < p.segment) { if (segIdx >= 0) pushEnds(); segIdx++; }
      const c = new THREE.Color(RUN_COLORS[p.runId % RUN_COLORS.length]);
      for (let i = 3; i < p.xyz.length; i += 3) {
        const target = p.kind === 'travel' ? tr : ex;
        target.push(p.xyz[i - 3], p.xyz[i - 2], p.xyz[i - 1], p.xyz[i], p.xyz[i + 1], p.xyz[i + 2]);
        if (p.kind !== 'travel') exc.push(c.r, c.g, c.b, c.r, c.g, c.b);
      }
    }
    pushEnds();
    const mk = (pos: number[], col?: number[], mat?: THREE.LineBasicMaterial) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      if (col) g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      return new THREE.LineSegments(g, mat ?? new THREE.LineBasicMaterial({ vertexColors: true }));
    };
    this.extrude = mk(ex, exc);
    this.travel = mk(tr, undefined, new THREE.LineBasicMaterial({ color: 0xff5252, transparent: true, opacity: 0.8 }));
    const bo: number[] = [];
    for (const l of bottomLayers) for (const loop of l.loops) {
      for (let i = 0; i < loop.pts.length; i++) {
        const a = loop.pts[i], b = loop.pts[(i + 1) % loop.pts.length];
        bo.push(a.x, a.y, l.z, b.x, b.y, l.z);
      }
    }
    this.bottom = mk(bo, undefined, new THREE.LineBasicMaterial({ color: 0x778899 }));
    this.scene.add(this.extrude, this.travel, this.bottom);

    const box = new THREE.Box3().setFromObject(this.extrude);
    if (!box.isEmpty()) {
      const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3()).length();
      this.controls.target.copy(c);
      this.camera.position.set(c.x + s * 0.8, c.y - s * 1.0, c.z + s * 0.7);
      this.camera.near = s / 1000; this.camera.far = s * 20; this.camera.updateProjectionMatrix();
    }
  }

  get segmentCount() { return this.extrudeEnds.length; }

  /** Show only segments [0, n). */
  showUpTo(n: number) {
    if (!this.extrude || !this.travel) return;
    const i = Math.min(Math.max(n, 1), this.extrudeEnds.length) - 1;
    if (i < 0) return;
    this.extrude.geometry.setDrawRange(0, this.extrudeEnds[i]);
    this.travel.geometry.setDrawRange(0, this.travelEnds[i]);
  }

  setTravelVisible(v: boolean) { if (this.travel) this.travel.visible = v; }
  setBottomVisible(v: boolean) { if (this.bottom) this.bottom.visible = v; }
}
