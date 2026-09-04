// Hero artifact-band renderer: one scene, a replay of a real recorded robot
// run (see buildStataReplay below). Binary format: int8 x, int8 y, uint8 z,
// uint8 category per point (0 = ground/dim, 1 = structure/amber, 2 =
// vegetation/green — the shared LUT below, unchanged from the site's other
// point-cloud surfaces).
// Auto-rotates slowly; drag/touch scrubs rotation; hovering excites nearby
// points into a LiDAR-scan vibration and pauses idle auto-rotation.
// IO + tab-hidden gated. prefers-reduced-motion users get a still frame.
import { EXCITE_T_SCALE, EXCITE_AMP, EXCITE_RGB } from './excite';

export interface Cloud {
  n: number;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  cat: Uint8Array;
  phase: Float32Array;
  // Procedural/replay scenes rewrite their point positions each frame.
  update?: (tSec: number) => void;
  // Per-dataset framing: multiplies the base projection scale.
  zoom?: number;
  // Per-scene render hints; fall back to the globals tuned for ~10k-point
  // datasets. lut is a function of theme because the palette rebuilds on
  // theme flips — the scene memoizes it.
  lut?: (dark: boolean) => string[];
  sizes?: number[];
  // Detection-flash overlay: points [flashFrom, n) skip the bucketed pass
  // and draw in a bright top pass whose alpha/size follow flashF (0..1).
  flashFrom?: number;
  flashF?: number;
}

interface Scrubber {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  cloud: Cloud;
  rotation: number;
  autoRotate: boolean;
  // WCAG 2.2.2: a deliberate pick-up (drag) ends auto-rotation for good — a
  // motion-pref round-trip must not resurrect it.
  userPaused: boolean;
  motionOK: boolean;
  dragging: boolean;
  lastX: number;
  visible: boolean;
  isDark: boolean;
  // CSS size cached by a ResizeObserver so render never queries layout.
  cssW: number;
  cssH: number;
  lut: string[];
  exciteStyle: [string, string, string];
  // pointer-excite state (CSS px, canvas-local)
  px: number;
  py: number;
  hovering: boolean;
  // preallocated per-frame buffers (sized to the largest dataset)
  sx: Float32Array;
  sy: Float32Array;
  key: Uint8Array;
  bucketCount: Uint32Array;
  bucketStart: Uint32Array;
  order: Uint32Array;
  exciteIdx: Uint32Array;
  exciteF: Float32Array;
}

const N_BUCKETS = 96; // cat(3) × height(4) × depth(8)
const EXCITE_R = 64; // px
const EXCITE_CAP = 800;
const SIZES = [1.5, 1.5, 1.9]; // dot size per category

function detectDark(): boolean {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'dark') return true;
  if (attr === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

interface ReplayData {
  t_max_s: number;
  poses: [number, number, number, number][]; // [t_ds, x_i16, y_i16, sigma_cm]
  events: [number, number][]; // [t_ds, detector_index]
  detectors: string[];
  frame: { center: [number, number]; scale: number };
}

const POSE_SCALE = 32767;
const PLAY_S = 25; // the whole run always plays back in ~25s, whatever its real duration
const HOLD_S = 2; // pause on the completed trail with every event lit
const CYCLE_S = PLAY_S + HOLD_S;
const FLASH_DECAY_S = 0.8;

// Replay scene: a real AMCL run (PR2, MIT Stata Center dataset) — wall map
// (static), the robot's trajectory trail, a current-position marker with a
// heading tick (derived from consecutive trail positions; the wire format
// doesn't carry yaw), and the moments a fault detector fired. Walls are the
// dimmest LUT entry (cat 0), the trail is the primary color (cat 2), and the
// live marker + detector flashes share the existing amber (cat 1).
function buildStataReplay(walls: Cloud, replay: ReplayData): Cloud {
  const N_WALLS = walls.n;
  const N_TRAIL = replay.poses.length;
  const N_MARKER = 8;
  const N_HEAD = 5;
  const N_EVDOT = replay.events.length;
  const N_FLASH = 8;

  const TRAIL0 = N_WALLS;
  const MARKER0 = TRAIL0 + N_TRAIL;
  const HEAD0 = MARKER0 + N_MARKER;
  const EVDOT0 = HEAD0 + N_HEAD;
  const FLASH0 = EVDOT0 + N_EVDOT;
  const n = FLASH0 + N_FLASH;

  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const z = new Float32Array(n);
  const cat = new Uint8Array(n);
  const phase = new Float32Array(n);
  for (let i = 0; i < n; i++) phase[i] = Math.random() * Math.PI * 2;

  for (let i = 0; i < N_WALLS; i++) {
    x[i] = walls.x[i]!;
    y[i] = walls.y[i]!;
    z[i] = 0;
    cat[i] = 0;
  }
  cat.fill(2, TRAIL0, MARKER0); // trail
  cat.fill(1, MARKER0, n); // marker, heading tick, event dots, flash

  // Decode poses into the same normalized [-1, 1] frame as the walls.
  const px = new Float32Array(N_TRAIL);
  const py = new Float32Array(N_TRAIL);
  const pt = new Float32Array(N_TRAIL);
  for (let i = 0; i < N_TRAIL; i++) {
    const row = replay.poses[i]!;
    pt[i] = row[0]! / 10;
    px[i] = row[1]! / POSE_SCALE;
    py[i] = row[2]! / POSE_SCALE;
  }
  const eventT = replay.events.map((e) => e[0] / 10);

  // Largest idx with pt[idx] <= t, or -1.
  function findIdx(t: number): number {
    let lo = 0;
    let hi = N_TRAIL - 1;
    let res = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (pt[mid]! <= t) {
        res = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return res;
  }

  const MARKER_R = 0.018;
  const HEAD_LEN = 0.05;

  function paint(playheadS: number, holding: boolean) {
    const lastIdx = holding ? N_TRAIL - 1 : findIdx(playheadS);

    for (let i = 0; i < N_TRAIL; i++) {
      const gi = TRAIL0 + i;
      if (i <= lastIdx) {
        x[gi] = px[i]!;
        y[gi] = py[i]!;
      } else {
        x[gi] = 1e3;
        y[gi] = 1e3;
      }
      z[gi] = 0;
    }

    let curX = 0;
    let curY = 0;
    let hx = 1;
    let hy = 0;
    if (lastIdx >= 0) {
      curX = px[lastIdx]!;
      curY = py[lastIdx]!;
      const prevIdx = Math.max(0, lastIdx - 1);
      if (prevIdx !== lastIdx) {
        const dx = px[lastIdx]! - px[prevIdx]!;
        const dy = py[lastIdx]! - py[prevIdx]!;
        const d = Math.hypot(dx, dy);
        if (d > 1e-6) {
          hx = dx / d;
          hy = dy / d;
        }
      }
    }

    for (let k = 0; k < N_MARKER; k++) {
      const a = (k / N_MARKER) * Math.PI * 2;
      x[MARKER0 + k] = curX + Math.cos(a) * MARKER_R;
      y[MARKER0 + k] = curY + Math.sin(a) * MARKER_R;
      z[MARKER0 + k] = 0;
    }
    for (let k = 0; k < N_HEAD; k++) {
      const u = (k + 1) / N_HEAD;
      x[HEAD0 + k] = curX + hx * HEAD_LEN * u;
      y[HEAD0 + k] = curY + hy * HEAD_LEN * u;
      z[HEAD0 + k] = 0;
    }

    for (let e = 0; e < N_EVDOT; e++) {
      const gi = EVDOT0 + e;
      if (holding) {
        const idx = findIdx(eventT[e]!);
        const ei = idx >= 0 ? idx : 0;
        x[gi] = px[ei]!;
        y[gi] = py[ei]!;
      } else {
        x[gi] = 1e3;
        y[gi] = 1e3;
      }
      z[gi] = 0;
    }

    let flashF = 0;
    if (!holding) {
      for (const te of eventT) {
        if (te <= playheadS) {
          const f = 1 - (playheadS - te) / FLASH_DECAY_S;
          if (f > flashF) flashF = f;
        }
      }
    }
    for (let k = 0; k < N_FLASH; k++) {
      const gi = FLASH0 + k;
      if (flashF > 0) {
        const a = (k / N_FLASH) * Math.PI * 2;
        x[gi] = curX + Math.cos(a) * 0.012;
        y[gi] = curY + Math.sin(a) * 0.012;
      } else {
        x[gi] = 1e3;
        y[gi] = 1e3;
      }
      z[gi] = 0;
    }
    cloud.flashF = flashF;
  }

  const speed = replay.t_max_s / PLAY_S;
  const update = (t: number) => {
    const cyclePos = t % CYCLE_S;
    if (cyclePos < PLAY_S) paint(cyclePos * speed, false);
    else paint(replay.t_max_s, true);
  };

  const cloud: Cloud = { n, x, y, z, cat, phase, flashFrom: FLASH0, flashF: 0 };
  paint(replay.t_max_s, true); // reduced-motion tableau: full trail, every event lit
  cloud.update = update;
  return cloud;
}

async function loadWalls(url: string): Promise<Cloud> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`favela-scrubber: ${url} → ${r.status}`);
  const buf = await r.arrayBuffer();
  const view = new DataView(buf);
  const stride = 4; // int8 x, int8 y, uint8 z, uint8 cat
  const n = Math.floor(buf.byteLength / stride);
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const z = new Float32Array(n);
  const cat = new Uint8Array(n);
  const phase = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * stride;
    x[i] = view.getInt8(o) / 127;
    y[i] = view.getInt8(o + 1) / 127;
    z[i] = view.getUint8(o + 2) / 255;
    cat[i] = view.getUint8(o + 3);
    phase[i] = Math.random() * Math.PI * 2;
  }
  return { n, x, y, z, cat, phase };
}

async function loadReplay(url: string): Promise<ReplayData> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`favela-scrubber: ${url} → ${r.status}`);
  return r.json();
}

// Bucket colors evaluated at (height, depth) bucket centres — mirrors the
// previous per-point palette but lets a frame run on ≤96 fillStyle sets.
export function buildLut(dark: boolean, alphaScale = 1): string[] {
  const lut = new Array<string>(N_BUCKETS);
  for (let c = 0; c < 3; c++) {
    for (let hq = 0; hq < 4; hq++) {
      const h = (hq + 0.5) / 4;
      for (let dq = 0; dq < 8; dq++) {
        const t = (dq + 0.5) / 8;
        let r: number, g: number, b: number, a: number;
        // Alphas tuned for ~10k structure points: low enough that dense
        // fabric shades by overlap instead of saturating into a blob.
        if (dark) {
          if (c === 1) {
            a = 0.22 + t * 0.4;
            r = 255;
            g = 210 + Math.round(h * 30);
            b = 130 - Math.round(h * 30);
          } else if (c === 2) {
            a = 0.3 + t * 0.45;
            r = 52 + Math.round(h * 40);
            g = 211 + Math.round(h * 20);
            b = 153;
          } else {
            a = 0.16 + t * 0.45;
            r = 59 + Math.round(h * 60);
            g = 130 + Math.round(h * 80);
            b = 246 - Math.round(h * 30);
          }
        } else {
          if (c === 1) {
            a = 0.3 + t * 0.34;
            r = 196 - Math.round(h * 30);
            g = 86 + Math.round(h * 30);
            b = 30 + Math.round(h * 10);
          } else if (c === 2) {
            a = 0.42 + t * 0.4;
            r = 22 + Math.round(h * 20);
            g = 122 + Math.round(h * 45);
            b = 61 + Math.round(h * 15);
          } else {
            a = 0.45 + t * 0.4;
            r = 52 + Math.round(h * 18);
            g = 70 + Math.round(h * 24);
            b = 100 - Math.round(h * 16);
          }
        }
        a = Math.min(0.92, a * alphaScale);
        lut[c * 32 + (hq << 3) + dq] = `rgba(${r},${g},${b},${a.toFixed(3)})`;
      }
    }
  }
  return lut;
}

function applyTheme(s: Scrubber) {
  s.isDark = detectDark();
  s.lut = buildLut(s.isDark);
  const rgb = EXCITE_RGB[s.isDark ? 'dark' : 'light'];
  const alphas = s.isDark ? [0.95, 0.98, 0.95] : [0.92, 0.95, 0.95];
  s.exciteStyle = [0, 1, 2].map((c) => `rgba(${rgb[c]},${alphas[c]})`) as [string, string, string];
}

function render(s: Scrubber, now: number) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = s.cssW;
  const cssH = s.cssH;
  const targetW = Math.max(1, Math.round(cssW * dpr));
  const targetH = Math.max(1, Math.round(cssH * dpr));
  if (s.canvas.width !== targetW || s.canvas.height !== targetH) {
    s.canvas.width = targetW;
    s.canvas.height = targetH;
  }
  s.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  s.ctx.clearRect(0, 0, cssW, cssH);

  if (s.cloud.update && s.motionOK) s.cloud.update(now / 1000);

  const cx = cssW / 2;
  const cy = cssH * 0.55;
  const scale = Math.min(cssW, cssH) * 0.42 * (s.cloud.zoom ?? 1);
  const tilt = 0.62;
  const cosT = Math.cos(tilt);
  const sinT = Math.sin(tilt);
  const cosR = Math.cos(s.rotation);
  const sinR = Math.sin(s.rotation);

  const { n, x, y, z, cat } = s.cloud;
  const { sx, sy, key, bucketCount, bucketStart, order } = s;
  // Flash points project like the rest but skip the bucketed pass — they
  // draw in a dedicated top pass below.
  const nMain = s.cloud.flashFrom ?? n;

  bucketCount.fill(0);
  for (let i = 0; i < n; i++) {
    const rx = x[i]! * cosR - y[i]! * sinR;
    const rz = x[i]! * sinR + y[i]! * cosR;
    const syw = z[i]! * cosT - rz * sinT;
    const depth = z[i]! * sinT + rz * cosT;
    sx[i] = cx + rx * scale;
    sy[i] = cy - syw * scale * 0.7;
    if (i >= nMain) continue;
    let dq = (((depth + 1) * 0.5) * 8) | 0;
    if (dq > 7) dq = 7;
    else if (dq < 0) dq = 0;
    let hq = (z[i]! * 4) | 0;
    if (hq > 3) hq = 3;
    const k = cat[i]! * 32 + (hq << 3) + dq;
    key[i] = k;
    bucketCount[k]!++;
  }

  bucketStart[0] = 0;
  for (let k = 0; k < N_BUCKETS; k++) bucketStart[k + 1] = bucketStart[k]! + bucketCount[k]!;
  bucketCount.fill(0);
  for (let i = 0; i < nMain; i++) {
    const k = key[i]!;
    order[bucketStart[k]! + bucketCount[k]!++] = i;
  }

  // Far → near by depth bucket; coarse painter's order is plenty at dot scale.
  const lut = s.cloud.lut?.(s.isDark) ?? s.lut;
  const sizes = s.cloud.sizes ?? SIZES;
  let nExcite = 0;
  const wantExcite = s.hovering && !s.dragging && s.motionOK;
  for (let dq = 0; dq < 8; dq++) {
    for (let c = 0; c < 3; c++) {
      const size = sizes[c]!;
      for (let hq = 0; hq < 4; hq++) {
        const k = c * 32 + (hq << 3) + dq;
        const from = bucketStart[k]!;
        const to = bucketStart[k + 1]!;
        if (from === to) continue;
        s.ctx.fillStyle = lut[k]!;
        for (let j = from; j < to; j++) {
          const i = order[j]!;
          s.ctx.fillRect(sx[i]!, sy[i]!, size, size);
          if (wantExcite && nExcite < EXCITE_CAP) {
            const dx = sx[i]! - s.px;
            const dy = sy[i]! - s.py;
            const d2 = dx * dx + dy * dy;
            if (d2 < EXCITE_R * EXCITE_R) {
              s.exciteIdx[nExcite] = i;
              s.exciteF[nExcite] = 1 - Math.sqrt(d2) / EXCITE_R;
              nExcite++;
            }
          }
        }
      }
    }
  }

  // LiDAR-scan excite pass — points near the pointer vibrate and flash.
  if (nExcite > 0) {
    const t = now * EXCITE_T_SCALE;
    const { phase, cat: cats } = s.cloud;
    let prevCat = -1;
    for (let e = 0; e < nExcite; e++) {
      const i = s.exciteIdx[e]!;
      const f = s.exciteF[e]!;
      const c = cats[i]!;
      if (c !== prevCat) {
        s.ctx.fillStyle = s.exciteStyle[c]!;
        prevCat = c;
      }
      const amp = EXCITE_AMP * f;
      const jx = Math.sin(t + phase[i]!) * amp;
      const jy = Math.cos(t * 1.13 + phase[i]! * 1.7) * amp;
      const size = 1.6 + f * 1.0;
      s.ctx.fillRect(sx[i]! + jx, sy[i]! + jy, size, size);
    }
  }

  // Detection-flash pass: bright-amber excite style on top, intensity
  // envelope driving both alpha and size so the payoff blooms and fades.
  const flashF = s.cloud.flashF ?? 0;
  if (nMain < n && flashF > 0) {
    s.ctx.fillStyle = s.exciteStyle[1];
    s.ctx.globalAlpha = flashF;
    const size = 2.6 * (0.35 + 0.65 * flashF);
    const half = size * 0.5;
    for (let i = nMain; i < n; i++) s.ctx.fillRect(sx[i]! - half, sy[i]! - half, size, size);
    s.ctx.globalAlpha = 1;
  }
}

function attachInteraction(s: Scrubber) {
  // Rect cached per hover/drag gesture instead of per pointermove.
  let rect: DOMRect | null = null;
  const local = (e: PointerEvent) => {
    if (!rect) rect = s.canvas.getBoundingClientRect();
    s.px = e.clientX - rect.left;
    s.py = e.clientY - rect.top;
  };
  const onDown = (e: PointerEvent) => {
    rect = s.canvas.getBoundingClientRect();
    s.userPaused = true;
    s.autoRotate = false;
    s.dragging = true;
    s.lastX = e.clientX;
    s.canvas.setPointerCapture(e.pointerId);
    s.canvas.classList.add('is-dragging');
  };
  const onMove = (e: PointerEvent) => {
    local(e);
    s.hovering = true;
    if (!s.dragging) return;
    const dx = e.clientX - s.lastX;
    s.lastX = e.clientX;
    s.rotation += dx * 0.009;
  };
  const onUp = (e: PointerEvent) => {
    if (!s.dragging) return;
    s.dragging = false;
    try {
      s.canvas.releasePointerCapture(e.pointerId);
    } catch {}
    s.canvas.classList.remove('is-dragging');
  };
  const onLeave = () => {
    s.hovering = false;
    rect = null;
  };
  s.canvas.addEventListener('pointerdown', onDown);
  s.canvas.addEventListener('pointermove', onMove);
  s.canvas.addEventListener('pointerup', onUp);
  s.canvas.addEventListener('pointercancel', (e) => {
    onUp(e);
    onLeave();
  });
  s.canvas.addEventListener('pointerleave', onLeave);
}

export async function initFavelaScrubber(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return;

  const wallsUrl = canvas.dataset.walls;
  const replayUrl = canvas.dataset.replay;
  if (!wallsUrl || !replayUrl) return;

  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

  let cloud: Cloud;
  try {
    const [walls, replay] = await Promise.all([loadWalls(wallsUrl), loadReplay(replayUrl)]);
    cloud = buildStataReplay(walls, replay);
  } catch (err) {
    console.error(err);
    return;
  }

  const s: Scrubber = {
    canvas,
    ctx,
    cloud,
    rotation: 0.35,
    autoRotate: !reduceMotion.matches,
    userPaused: false,
    motionOK: !reduceMotion.matches,
    dragging: false,
    lastX: 0,
    visible: false, // stays false until the IO callback proves intersection
    isDark: false,
    cssW: canvas.clientWidth,
    cssH: canvas.clientHeight,
    lut: [],
    exciteStyle: ['', '', ''],
    px: -1e4,
    py: -1e4,
    hovering: false,
    sx: new Float32Array(cloud.n),
    sy: new Float32Array(cloud.n),
    key: new Uint8Array(cloud.n),
    bucketCount: new Uint32Array(N_BUCKETS),
    bucketStart: new Uint32Array(N_BUCKETS + 1),
    order: new Uint32Array(cloud.n),
    exciteIdx: new Uint32Array(EXCITE_CAP),
    exciteF: new Float32Array(EXCITE_CAP),
  };
  applyTheme(s);

  // Dirty flag: frames render only when something changed the picture.
  let needsRender = true;
  const ro = new ResizeObserver((entries) => {
    const r = entries[0]!.contentRect;
    s.cssW = r.width;
    s.cssH = r.height;
    needsRender = true;
  });
  ro.observe(canvas);

  reduceMotion.addEventListener?.('change', (e) => {
    s.autoRotate = !e.matches && !s.userPaused;
    s.motionOK = !e.matches;
    needsRender = true;
  });

  // Re-read the theme whenever it changes (toggle click or OS-pref flip).
  const retheme = () => {
    applyTheme(s);
    needsRender = true;
  };
  const themeObserver = new MutationObserver(retheme);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  const osDarkMq = window.matchMedia('(prefers-color-scheme: dark)');
  osDarkMq.addEventListener?.('change', retheme);

  attachInteraction(s);

  // IO state and tab visibility tracked separately: IO doesn't re-fire on
  // tab restore, so visible must be recomputed from both in both handlers.
  let ioVisible = false;
  let rafOn = false;
  let last = performance.now();
  let renderedRotation = NaN;
  const tick = (now: number) => {
    if (!s.visible) {
      rafOn = false; // loop parks off-screen; syncVisible restarts it
      return;
    }
    const dt = Math.min(now - last, 64);
    last = now;
    // The replay carries its own motion — damp the idle spin so it reads as
    // ambient, not competing choreography.
    if (s.autoRotate && !s.dragging && !s.hovering) s.rotation += dt * 0.00016 * (s.cloud.update ? 0.25 : 1);
    // Time-driven animation (replay playback, excite jitter) needs every
    // frame; otherwise render only when something changed the picture.
    const animating =
      s.motionOK && (s.cloud.update !== undefined || (s.hovering && !s.dragging));
    if (needsRender || animating || s.rotation !== renderedRotation) {
      render(s, now);
      renderedRotation = s.rotation;
      needsRender = false;
    }
    requestAnimationFrame(tick);
  };
  const syncVisible = () => {
    s.visible = ioVisible && !document.hidden;
    if (s.visible && !rafOn) {
      rafOn = true;
      last = performance.now(); // dt clamp alone can't absorb a long park
      needsRender = true; // e.g. a resize while parked
      requestAnimationFrame(tick);
    }
  };
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(
      (entries) => {
        ioVisible = entries[0]!.isIntersecting;
        syncVisible();
      },
      { threshold: 0.05 },
    );
    io.observe(canvas);
  } else {
    ioVisible = true;
    syncVisible();
  }
  document.addEventListener('visibilitychange', syncVisible);
}
