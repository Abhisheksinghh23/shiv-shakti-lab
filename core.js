// Shiv Shakti Lab core: terrain, geodesy, slope, routing, lander physics.
// Pure functions, no DOM. Used by app.js in the browser and by test/run.mjs in Node.

export const SITE = { lat: -69.3733, lon: 32.3191 }; // Shiv Shakti point, as published by ISRO
export const MOON_G = 1.62; // m/s^2, mean lunar surface gravity

// ---------- polar stereographic (south), matches the GeoTIFF GeoKeys of the LROC product ----------
export function makeProj(meta) {
  const R = meta.R, phic = (meta.lat_true * Math.PI) / 180, lam0 = (meta.lon0 * Math.PI) / 180;
  const k0 = (1 + Math.sin(-phic)) / 2;
  const fwd = (lat, lon) => {
    const p = (lat * Math.PI) / 180, l = (lon * Math.PI) / 180 - lam0;
    const rho = 2 * R * k0 * Math.tan(Math.PI / 4 + p / 2);
    return [rho * Math.sin(l), rho * Math.cos(l)];
  };
  const inv = (x, y) => {
    const rho = Math.hypot(x, y);
    const p = 2 * Math.atan(rho / (2 * R * k0)) - Math.PI / 2;
    return [(p * 180) / Math.PI, ((lam0 + Math.atan2(x, y)) * 180) / Math.PI];
  };
  const c = meta.cell_m;
  // cell centres: pixel (i,j) covers x0+i*c .. x0+(i+1)*c
  const cellToLatLon = (i, j) => inv(meta.x0 + (i + 0.5) * c, meta.y0 - (j + 0.5) * c);
  const latLonToCell = (lat, lon) => {
    const [x, y] = fwd(lat, lon);
    return [(x - meta.x0) / c - 0.5, (meta.y0 - y) / c - 0.5];
  };
  return { fwd, inv, cellToLatLon, latLonToCell };
}

// ---------- terrain ----------
export function makeTerrain(terrainBytes, nodataBytes, meta) {
  const w = meta.width, h = meta.height;
  const u16 = new Uint16Array(terrainBytes.buffer ? terrainBytes.buffer.slice(terrainBytes.byteOffset, terrainBytes.byteOffset + w * h * 2) : terrainBytes);
  const z = new Float32Array(w * h);
  for (let i = 0; i < z.length; i++) z[i] = u16[i] / meta.elev_scale + meta.elev_offset_m;
  const nd = nodataBytes ? new Uint8Array(nodataBytes) : new Uint8Array(w * h);
  const T = { w, h, z, nd, cell: meta.cell_m, meta };
  T.slope = computeSlope(T, 2);
  return T;
}

// Slope in degrees from central differences over +/-k cells (baseline 2*k*cell metres).
export function computeSlope(T, k = 2) {
  const { w, h, z, cell } = T, s = new Float32Array(w * h), d = 2 * k * cell;
  for (let j = 0; j < h; j++) {
    const j0 = Math.max(0, j - k), j1 = Math.min(h - 1, j + k);
    for (let i = 0; i < w; i++) {
      const i0 = Math.max(0, i - k), i1 = Math.min(w - 1, i + k);
      const gx = (z[j * w + i1] - z[j * w + i0]) / ((i1 - i0) * cell);
      const gy = (z[j1 * w + i] - z[j0 * w + i]) / ((j1 - j0) * cell);
      s[j * w + i] = (Math.atan(Math.hypot(gx, gy)) * 180) / Math.PI;
    }
  }
  return s;
}

export function hillshade(T, azDeg = 315, altDeg = 22) {
  const { w, h, z, cell } = T, out = new Uint8Array(w * h);
  const az = (azDeg * Math.PI) / 180, al = (altDeg * Math.PI) / 180;
  // light direction in (east, north, up); image rows go south
  const lx = Math.cos(al) * Math.sin(az), ly = Math.cos(al) * Math.cos(az), lz = Math.sin(al);
  for (let j = 0; j < h; j++) {
    const j0 = Math.max(0, j - 1), j1 = Math.min(h - 1, j + 1);
    for (let i = 0; i < w; i++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(w - 1, i + 1);
      const gx = (z[j * w + i1] - z[j * w + i0]) / ((i1 - i0) * cell); // dz/d east
      const gy = (z[j0 * w + i] - z[j1 * w + i]) / ((j1 - j0) * cell); // dz/d north (rows run south)
      const n = Math.sqrt(gx * gx + gy * gy + 1);
      const v = (-gx * lx - gy * ly + lz) / n;
      out[j * w + i] = Math.max(0, Math.min(255, v * 255 * 1.15));
    }
  }
  return out;
}

export function sampleZ(T, fx, fy) { // bilinear, fx/fy in cell coords (cell centres at integers)
  const { w, h, z } = T;
  fx = Math.max(0, Math.min(w - 1.001, fx)); fy = Math.max(0, Math.min(h - 1.001, fy));
  const i = Math.floor(fx), j = Math.floor(fy), a = fx - i, b = fy - j;
  const p = j * w + i;
  return z[p] * (1 - a) * (1 - b) + z[p + 1] * a * (1 - b) + z[p + w] * (1 - a) * b + z[p + w + 1] * a * b;
}
export function sampleSlope(T, fx, fy) {
  const i = Math.max(0, Math.min(T.w - 1, Math.round(fx))), j = Math.max(0, Math.min(T.h - 1, Math.round(fy)));
  return T.slope[j * T.w + i];
}

// Terrain profile through (cx,cy) along compass heading (deg, 0=north, 90=east). Distances in metres, 0 at target.
export function makeProfile(T, cx, cy, headingDeg, half = 1400, step = 3) {
  const th = (headingDeg * Math.PI) / 180, dx = Math.sin(th), dy = -Math.cos(th); // image y runs south
  const n = Math.floor((2 * half) / step) + 1, xs = new Float32Array(n), zs = new Float32Array(n), ss = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const d = -half + k * step, fx = cx + (dx * d) / T.cell, fy = cy + (dy * d) / T.cell;
    xs[k] = d; zs[k] = sampleZ(T, fx, fy); ss[k] = sampleSlope(T, fx, fy);
  }
  // clamp to terrain edge: report how far the profile stays inside the tile
  return { xs, zs, ss, step, half, n, dx, dy, cx, cy, heading: headingDeg };
}
export function profileZ(P, x) {
  const f = (x + P.half) / P.step;
  if (f <= 0) return P.zs[0];
  if (f >= P.n - 1) return P.zs[P.n - 1];
  const i = Math.floor(f), a = f - i;
  return P.zs[i] * (1 - a) + P.zs[i + 1] * a;
}
export function profileSlope(P, x) {
  const f = Math.max(0, Math.min(P.n - 1, Math.round((x + P.half) / P.step)));
  return P.ss[f];
}
// along-track ground angle (deg, positive = rising in direction of travel) over a 12 m baseline
export function profileTilt(P, x) {
  const dz = profileZ(P, x + 6) - profileZ(P, x - 6);
  return (Math.atan2(dz, 12) * 180) / Math.PI;
}

// ---------- lander ----------
export const LANDER = {
  aMax: 4.4,        // m/s^2 at full throttle (thrust-to-weight about 2.7 in lunar gravity)
  fuelDv: 260,      // m/s of delta-v available
  rotRate: 40,      // deg/s attitude rate
  maxTilt: 70,      // deg
  limits: { vy: 2.0, vx: 0.5, tilt: 12, slope: 12 }, // scoring limits, see README
  footOffset: 1.3,  // metres from the lander reference point to the foot pads
};

export function newLander(P, opts = {}) {
  const startAlt = opts.alt ?? 600, vx = opts.vx ?? 28, x = opts.x ?? -950;
  const y = profileZ(P, x) + startAlt;
  return { t: 0, x, y, vx, vy: opts.vy ?? -6, ang: 0, throttle: 0, fuel: LANDER.fuelDv, burned: 0, done: false, result: null, trail: [[x, y]] };
}

// controls: {rot:-1|0|1, thrust:bool, auto:bool}
export function stepLander(S, P, c, dt) {
  if (S.done) return S;
  const L = LANDER;
  // attitude
  S.ang += (c.rot || 0) * L.rotRate * dt;
  S.ang = Math.max(-L.maxTilt, Math.min(L.maxTilt, S.ang));
  // throttle ramps like a real throttleable engine
  const want = c.thrust && S.fuel > 0 ? (c.throttle ?? 1) : 0;
  const ramp = 3.0 * dt;
  S.throttle += Math.max(-ramp, Math.min(ramp, want - S.throttle));
  let a = S.throttle * L.aMax;
  if (S.fuel <= 0) a = 0;
  const burn = a * dt;
  if (burn > S.fuel) { a = S.fuel / dt; }
  S.fuel = Math.max(0, S.fuel - a * dt); S.burned += a * dt;
  const th = (S.ang * Math.PI) / 180;
  S.vx += a * Math.sin(th) * dt;
  S.vy += (a * Math.cos(th) - MOON_G) * dt;
  S.x += S.vx * dt; S.y += S.vy * dt; S.t += dt;
  if (Math.floor(S.t * 5) !== Math.floor((S.t - dt) * 5)) S.trail.push([S.x, S.y]);
  // contact
  const gz = profileZ(P, S.x);
  if (S.y - L.footOffset <= gz) touchdown(S, P, gz);
  else if (S.x < -P.half + 60 || S.x > P.half - 60) { S.done = true; S.result = { kind: 'lost', title: 'Left the map tile', detail: 'You flew out of the terrain tile.', score: 0 }; }
  else if (S.y - gz > 1400) { S.done = true; S.result = { kind: 'lost', title: 'Flew away', detail: 'Too high above the surface.', score: 0 }; }
  return S;
}

function touchdown(S, P, gz) {
  const L = LANDER.limits, ground = profileTilt(P, S.x), slope3d = profileSlope(P, S.x);
  const relTilt = Math.abs(S.ang - ground);
  const vyAbs = Math.abs(S.vy), vxAbs = Math.abs(S.vx);
  const tgtDist = Math.abs(S.x);
  const fails = [];
  if (vyAbs > L.vy) fails.push(`vertical speed ${vyAbs.toFixed(1)} m/s (limit ${L.vy})`);
  if (vxAbs > L.vx) fails.push(`sideways speed ${vxAbs.toFixed(1)} m/s (limit ${L.vx})`);
  if (relTilt > L.tilt) fails.push(`tilt to ground ${relTilt.toFixed(0)} deg (limit ${L.tilt})`);
  if (slope3d > L.slope) fails.push(`ground slope ${slope3d.toFixed(0)} deg (limit ${L.slope})`);
  S.done = true; S.y = gz + LANDER.footOffset;
  const fuelLeft = S.fuel / LANDER.fuelDv;
  const info = { vy: S.vy, vx: S.vx, relTilt, slope: slope3d, ground, dist: tgtDist, fuelLeft, t: S.t, ang: S.ang };
  if (!fails.length) {
    const score = Math.round(600 + 250 * fuelLeft + Math.max(0, 150 - tgtDist * 0.6));
    S.result = { kind: 'safe', title: 'Soft landing', detail: `Touched down ${tgtDist.toFixed(0)} m from the target with ${(fuelLeft * 100).toFixed(0)}% fuel left.`, score, ...info };
  } else {
    const hard = vyAbs <= 5 && vxAbs <= 2.5 && relTilt <= 25;
    S.result = { kind: hard ? 'hard' : 'crash', title: hard ? 'Hard landing' : 'Crash', detail: 'Outside limits: ' + fails.join('; ') + '.', score: hard ? 200 : 0, ...info };
  }
}

// Simple pilot assist: velocity-tracking PD in the vertical plane.
export function autopilot(S, P) {
  const g = MOON_G, A = LANDER.aMax;
  const xe = -S.x;
  // height above the highest ground within a lookahead window in the direction of travel
  const la = Math.max(30, Math.abs(S.vx) * 4);
  let gmax = profileZ(P, S.x);
  for (let d = 0; d <= la; d += 10) gmax = Math.max(gmax, profileZ(P, S.x + Math.sign(S.vx || 1) * d));
  const hh = S.y - LANDER.footOffset - profileZ(P, S.x);
  const hClear = S.y - LANDER.footOffset - gmax;
  // horizontal speed plan: decelerate to arrive over the target
  const ax_plan = 1.3;
  let vxd = Math.sign(xe) * Math.min(45, Math.sqrt(2 * ax_plan * Math.max(0, Math.abs(xe) - 4)));
  if (hh < 25) vxd = Math.max(-0.3, Math.min(0.3, xe * 0.05)) * (hh < 8 ? 0.2 : 1);
  // vertical plan
  const hh2 = Math.max(0, Math.min(hh, hClear + 15));
  const vyd = -Math.max(0.7, Math.min(40, Math.sqrt(2 * 0.9 * Math.max(0, hh2 - 2))));
  const axc = 1.6 * (vxd - S.vx);
  const ayc = g + 1.6 * (vyd - S.vy);
  let angT = (Math.atan2(axc, Math.max(0.5, ayc)) * 180) / Math.PI;
  angT = Math.max(-55, Math.min(55, angT));
  if (hh < 6) angT = 0;
  const rot = Math.max(-1, Math.min(1, (angT - S.ang) / 3));
  let thr = Math.hypot(axc, Math.max(0, ayc)) / A;
  // do not thrust hard sideways while badly tilted
  if (Math.abs(angT - S.ang) > 25) thr *= 0.3;
  const thrust = thr > 0.02;
  return { rot, thrust, throttle: Math.max(0, Math.min(1, thr)) };
}

export function simulate(P, opts = {}, ctrl = autopilot, dt = 1 / 30, maxT = 400) {
  const S = newLander(P, opts);
  while (!S.done && S.t < maxT) stepLander(S, P, ctrl(S, P), dt);
  if (!S.done) { S.done = true; S.result = { kind: 'lost', title: 'Timed out', detail: '', score: 0 }; }
  return S;
}

// ---------- rover routing ----------
const NB = [];
for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
  if (!dx && !dy) continue;
  if (Math.abs(dx) === 2 && Math.abs(dy) === 2) continue;
  if (Math.abs(dx) === 2 && Math.abs(dy) === 0) continue;
  if (Math.abs(dy) === 2 && Math.abs(dx) === 0) continue;
  NB.push([dx, dy]);
}
// 8 neighbours + 8 knight moves = 16 directions, reduces the bias of 8-way grids.

export const ROUTE_MODES = {
  shortest: { label: 'Shortest', color: '#ff5d73', w: 0, p: 1, desc: 'Fewest metres. Only avoids cells over the slope limit.' },
  balanced: { label: 'Balanced', color: '#ffd166', w: 2.5, p: 2, desc: 'Trades a few extra metres for gentler ground.' },
  gentle:   { label: 'Gentlest', color: '#4cc9f0', w: 14, p: 3, desc: 'Strongly avoids steep ground, even if the route gets long.' },
};

class Heap { // binary min-heap of (key, id) with parallel typed arrays
  constructor(cap) { this.k = new Float32Array(cap); this.v = new Int32Array(cap); this.n = 0; }
  push(key, val) {
    if (this.n >= this.k.length) { const nk = new Float32Array(this.k.length * 2), nv = new Int32Array(this.k.length * 2); nk.set(this.k); nv.set(this.v); this.k = nk; this.v = nv; }
    let i = this.n++; const k = this.k, v = this.v;
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v, topV = v[0], lk = k[--this.n], lv = v[this.n];
    let i = 0; const n = this.n;
    for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && k[c + 1] < k[c]) c++; if (k[c] >= lk) break; k[i] = k[c]; v[i] = v[c]; i = c; }
    k[i] = lk; v[i] = lv; return topV;
  }
}

// Dijkstra over the DEM grid. Returns {dist, prev, reached}. target: optional cell index for early exit.
// Cells above the slope limit (using the larger of the cell slope and the step slope) are blocked.
export function dijkstra(T, startIdx, mode, limitDeg, targetIdx = -1) {
  const { w, h, z, slope, cell } = T, N = w * h;
  const dist = new Float32Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1), done = new Uint8Array(N);
  const heap = new Heap(1 << 16);
  dist[startIdx] = 0; heap.push(0, startIdx);
  const M = ROUTE_MODES[mode] || mode;
  const tl = Math.tan((limitDeg * Math.PI) / 180);
  while (heap.n) {
    const u = heap.pop();
    if (done[u]) continue; done[u] = 1;
    if (u === targetIdx) break;
    const ux = u % w, uy = (u / w) | 0, du = dist[u];
    for (let q = 0; q < NB.length; q++) {
      const vx = ux + NB[q][0], vy = uy + NB[q][1];
      if (vx < 0 || vy < 0 || vx >= w || vy >= h) continue;
      const v = vy * w + vx; if (done[v]) continue;
      const sv = slope[v];
      if (sv > limitDeg) continue;
      const hd = Math.hypot(NB[q][0], NB[q][1]) * cell, dz = z[v] - z[u];
      const stepSlope = Math.abs(dz) / hd;
      if (stepSlope > tl) continue;
      const s = Math.max(sv, (Math.atan(stepSlope) * 180) / Math.PI);
      const len = Math.sqrt(hd * hd + dz * dz);
      const pen = M.w ? 1 + M.w * Math.pow(s / limitDeg, M.p) : 1;
      const nd = du + len * pen;
      if (nd < dist[v]) { dist[v] = nd; prev[v] = u; heap.push(nd, v); }
    }
  }
  return { dist, prev, done };
}

export function extractPath(prev, targetIdx, w) {
  const path = []; let u = targetIdx;
  while (u !== -1) { path.push([u % w, (u / w) | 0]); u = prev[u]; }
  return path.reverse();
}

export function routeStats(T, path) {
  let len = 0, flat = 0, gain = 0, maxS = 0, sumS = 0;
  const prof = [], slopes = [];
  let acc = 0;
  for (let k = 0; k < path.length; k++) {
    const [x, y] = path[k], zc = T.z[y * T.w + x], sl = T.slope[y * T.w + x];
    if (k > 0) {
      const [px, py] = path[k - 1], dz = zc - T.z[py * T.w + px], hd = Math.hypot(x - px, y - py) * T.cell;
      len += Math.sqrt(hd * hd + dz * dz); flat += hd; acc += hd; if (dz > 0) gain += dz;
    }
    prof.push([acc, zc]); slopes.push(sl); sumS += sl; if (sl > maxS) maxS = sl;
  }
  return { length: len, flat, gain, maxSlope: maxS, meanSlope: sumS / Math.max(1, path.length), prof, slopes, cells: path.length };
}

export function reachSummary(T, dist) {
  let n = 0, far = 0;
  for (let i = 0; i < dist.length; i++) if (Number.isFinite(dist[i])) { n++; if (dist[i] > far) far = dist[i]; }
  return { cells: n, areaM2: n * T.cell * T.cell, frac: n / dist.length, farthest: far };
}

export const fmtLat = (v) => Math.abs(v).toFixed(4) + '\u00b0' + (v < 0 ? 'S' : 'N');
export const fmtLon = (v) => Math.abs(v).toFixed(4) + '\u00b0' + (v < 0 ? 'W' : 'E');
