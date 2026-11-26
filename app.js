import * as C from './core.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
let meta, T, proj, siteCell, hs;
const N = 1024;
const layerCache = {};

// ---------- boot ----------
// Terrain ships as base64 text chunks (data/terrain.b64.NN) plus a gzipped
// no-data mask, decoded here. See README for how to rebuild data/*.bin.
const b64 = (t) => Uint8Array.from(atob(t.trim()), (c) => c.charCodeAt(0));
async function loadData() {
  const parts = await Promise.all(Array.from({ length: 12 }, (_, i) =>
    fetch('data/terrain.b64.' + String(i).padStart(2, '0')).then((r) => r.text())));
  const chunks = parts.map(b64);
  const tb = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
  let o = 0; for (const c of chunks) { tb.set(c, o); o += c.length; }
  const gz = b64(await (await fetch('data/nodata.gz.b64')).text());
  const nb = await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  return [tb.buffer, nb];
}
async function boot() {
  meta = await (await fetch('data/meta.json')).json();
  const [tb, nb] = await loadData();
  T = C.makeTerrain(new Uint8Array(tb), new Uint8Array(nb), meta);
  proj = C.makeProj(meta);
  siteCell = proj.latLonToCell(C.SITE.lat, C.SITE.lon);
  hs = C.hillshade(T, 300, 20);
  initWorker(tb, nb);
  buildLayers();
  initTabs(); initLand(); initRove(); initData();
  $('#loading').remove();
  window.__ready = true;
}

let worker, workerReady = false, jobId = 0, pending = {};
function initWorker(tb, nb) {
  try {
    worker = new Worker('worker.js', { type: 'module' });
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'ready') { workerReady = true; roveOnReady(); }
      else if (pending[m.id]) { pending[m.id](m); delete pending[m.id]; }
    };
    worker.onerror = () => { worker = null; workerReady = true; roveOnReady(); };
    worker.postMessage({ type: 'init', terrain: tb.slice(0), nodata: nb.slice(0), meta });
  } catch (e) { worker = null; workerReady = true; }
}
function job(msg) { // run in worker, or inline as fallback
  return new Promise((res) => {
    const id = ++jobId; msg.id = id;
    if (worker) { pending[id] = res; worker.postMessage(msg); return; }
    setTimeout(() => {
      if (msg.type === 'reach') {
        const R = C.dijkstra(T, msg.start, 'shortest', msg.limit);
        res({ dist: R.dist, sum: C.reachSummary(T, R.dist), id });
      } else {
        const out = {};
        for (const mode of Object.keys(C.ROUTE_MODES)) {
          const R = C.dijkstra(T, msg.start, mode, msg.limit, msg.target);
          if (!Number.isFinite(R.dist[msg.target])) { out[mode] = null; continue; }
          const path = C.extractPath(R.prev, msg.target, T.w);
          out[mode] = { path, stats: C.routeStats(T, path) };
        }
        res({ out, id });
      }
    }, 20);
  });
}

// ---------- layers ----------
function makeCanvas() { const c = document.createElement('canvas'); c.width = N; c.height = N; return c; }
function hillImage() {
  const c = makeCanvas(), x = c.getContext('2d'), im = x.createImageData(N, N), d = im.data;
  for (let i = 0; i < N * N; i++) { const g = hs[i]; d[i * 4] = g * 1.0; d[i * 4 + 1] = g * 0.96; d[i * 4 + 2] = g * 0.88; d[i * 4 + 3] = 255; }
  return { c, x, im };
}
function slopeColor(s) { // returns [r,g,b]
  if (s < 4) return [47, 191, 113];
  if (s < 8) return [150 + (s - 4) * 25, 200, 80];
  if (s < 12) return [255, 209 - (s - 8) * 20, 102];
  return [255, 93, 115];
}
function buildLayers() {
  const base = hillImage();
  base.x.putImageData(base.im, 0, 0); layerCache.hill = base.c;
  // slope layer
  let L = hillImage();
  for (let i = 0; i < N * N; i++) { const col = slopeColor(T.slope[i]), a = 0.55; for (let k = 0; k < 3; k++) L.im.data[i * 4 + k] = L.im.data[i * 4 + k] * (1 - a) + col[k] * a; }
  L.x.putImageData(L.im, 0, 0); layerCache.slope = L.c;
  // hazard layer for landing: only highlights what matters
  L = hillImage();
  for (let i = 0; i < N * N; i++) {
    const s = T.slope[i]; let col = null, a = 0;
    if (s > 12) { col = [255, 93, 115]; a = 0.7; } else if (s > 8) { col = [255, 209, 102]; a = 0.45; } else { col = [47, 191, 113]; a = 0.16; }
    for (let k = 0; k < 3; k++) L.im.data[i * 4 + k] = L.im.data[i * 4 + k] * (1 - a) + col[k] * a;
  }
  L.x.putImageData(L.im, 0, 0); layerCache.haz = L.c;
}
function buildReachLayer(dist) {
  const L = hillImage(), d = L.im.data;
  for (let i = 0; i < N * N; i++) {
    const v = dist[i];
    if (Number.isFinite(v)) {
      const band = ((v / 250) | 0) % 2 ? 0.0 : 0.07, t = Math.min(1, v / 2200), a = 0.42 + band;
      const col = [76 + 150 * t, 201 - 90 * t, 240 - 150 * t];
      for (let k = 0; k < 3; k++) d[i * 4 + k] = d[i * 4 + k] * (1 - a) + col[k] * a;
    } else {
      const a = 0.5, col = [90, 14, 30];
      for (let k = 0; k < 3; k++) d[i * 4 + k] = d[i * 4 + k] * (1 - a) + col[k] * a;
    }
  }
  L.x.putImageData(L.im, 0, 0); return L.c;
}

// ---------- tabs ----------
function initTabs() {
  $$('nav button').forEach((b) => b.onclick = () => {
    $$('nav button').forEach((x) => x.classList.toggle('on', x === b));
    $$('.tab').forEach((t) => t.classList.toggle('on', t.id === 'tab-' + b.dataset.tab));
    if (b.dataset.tab === 'rove') { drawRove(); drawChart(); }
    if (b.dataset.tab === 'land') drawLandMap();
  });
}
function cellFromEvent(cv, e) {
  const r = cv.getBoundingClientRect();
  return [Math.max(0, Math.min(N - 1, (e.clientX - r.left) / r.width * N)), Math.max(0, Math.min(N - 1, (e.clientY - r.top) / r.height * N))];
}
function cellInfo(cx, cy) {
  const i = Math.round(cx), j = Math.round(cy), [la, lo] = proj.cellToLatLon(i, j);
  return { z: T.z[j * N + i], s: T.slope[j * N + i], lat: la, lon: lo, nd: T.nd[j * N + i] };
}
function infoText(cx, cy) {
  const q = cellInfo(cx, cy);
  return `${C.fmtLat(q.lat)} ${C.fmtLon(q.lon)} \u00b7 height ${q.z.toFixed(1)} m \u00b7 slope ${q.s.toFixed(1)}\u00b0${q.nd ? ' \u00b7 filled gap in the data' : ''}`;
}
function maxSlopeNear(cx, cy, rCells) {
  let m = 0;
  for (let dj = -rCells; dj <= rCells; dj++) for (let di = -rCells; di <= rCells; di++) {
    if (di * di + dj * dj > rCells * rCells) continue;
    const i = Math.round(cx) + di, j = Math.round(cy) + dj;
    if (i < 0 || j < 0 || i >= N || j >= N) continue;
    m = Math.max(m, T.slope[j * N + i]);
  }
  return m;
}
function compass(h) { return ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(h / 45) % 8]; }
function marker(x, cx, cy, color, label, r = 10) {
  x.save(); x.lineWidth = 3; x.strokeStyle = '#000'; x.beginPath(); x.arc(cx, cy, r + 1.5, 0, 7); x.stroke();
  x.strokeStyle = color; x.lineWidth = 3; x.beginPath(); x.arc(cx, cy, r, 0, 7); x.stroke();
  x.fillStyle = color; x.beginPath(); x.arc(cx, cy, 2.5, 0, 7); x.fill();
  if (label) { x.font = '700 22px system-ui'; x.lineWidth = 5; x.strokeStyle = '#000'; x.strokeText(label, cx + r + 6, cy + 7); x.fillStyle = color; x.fillText(label, cx + r + 6, cy + 7); }
  x.restore();
}

// ================= LAND =================
const land = { tx: 0, ty: 0, heading: 90, layer: 'hill', P: null, S: null, auto: false, warp: 1, keys: {}, touch: {}, running: false, last: null, zoomH: 200, camY: 0, landed: null };

function initLand() {
  land.tx = siteCell[0]; land.ty = siteCell[1];
  $('#siteline').textContent = `Shiv Shakti point ${C.fmtLat(C.SITE.lat)} ${C.fmtLon(C.SITE.lon)}`;
  const m1 = $('#map1');
  m1.addEventListener('pointerdown', (e) => { const [x, y] = cellFromEvent(m1, e); land.tx = x; land.ty = y; resetFlight(); });
  m1.addEventListener('pointermove', (e) => { const [x, y] = cellFromEvent(m1, e); $('#read1').textContent = infoText(x, y); });
  $('#heading').oninput = (e) => { land.heading = +e.target.value; resetFlight(); };
  $$('#layer1 button').forEach((b) => b.onclick = () => { land.layer = b.dataset.l; $$('#layer1 button').forEach((x) => x.classList.toggle('on', x === b)); $('#hazlegend').style.display = land.layer === 'haz' ? '' : 'none'; drawLandMap(); });
  $('#hazlegend').style.display = 'none';
  $('#resetsite').onclick = () => { land.tx = siteCell[0]; land.ty = siteCell[1]; resetFlight(); };
  $('#launch').onclick = launch;
  $('#auto').onclick = () => setAuto(!land.auto);
  $$('#warp button').forEach((b) => b.onclick = () => { land.warp = +b.dataset.w; $$('#warp button').forEach((x) => x.classList.toggle('on', x === b)); });
  addEventListener('keydown', (e) => keyEvent(e, true)); addEventListener('keyup', (e) => keyEvent(e, false));
  $$('#touch button').forEach((b) => {
    const k = b.dataset.k;
    const on = (e) => { e.preventDefault(); land.touch[k] = true; if (land.auto) setAuto(false); if (!land.running && !(land.S && land.S.done)) launch(); };
    const off = (e) => { e.preventDefault(); land.touch[k] = false; };
    b.addEventListener('pointerdown', on); b.addEventListener('pointerup', off); b.addEventListener('pointerleave', off); b.addEventListener('pointercancel', off);
  });
  resetFlight();
  requestAnimationFrame(frame);
}
function keyEvent(e, down) {
  if (!$('#tab-land').classList.contains('on')) return;
  const k = e.key.toLowerCase();
  const map = { arrowleft: 'L', a: 'L', arrowright: 'R', d: 'R', arrowup: 'T', w: 'T', ' ': 'T' };
  if (map[k]) { e.preventDefault(); land.keys[map[k]] = down; if (down && land.auto) setAuto(false); if (down && !land.running && !land.S?.done) launch(); }
  if (down && k === 'p') setAuto(!land.auto);
  if (down && k === 'enter' && (!land.running)) launch();
}
function setAuto(v) {
  land.auto = v; const b = $('#auto'); b.textContent = 'Autopilot: ' + (v ? 'on' : 'off'); b.classList.toggle('on', v);
  if (v && !land.running) launch();
}
function startState() { return C.newLander(land.P, { x: -800, vx: 26, alt: 600, vy: -5 }); }
function resetFlight() {
  land.P = C.makeProfile(T, land.tx, land.ty, land.heading, 1100);
  land.S = startState(); land.running = false; land.landed = null; $('#report').innerHTML = ''; $('#launch').textContent = 'Launch descent';
  $('#headingv').textContent = `${land.heading}\u00b0 (${compass(land.heading)})`;
  const q = cellInfo(land.tx, land.ty), near = maxSlopeNear(land.tx, land.ty, 5);
  const th = land.heading * Math.PI / 180, ex = land.tx - Math.sin(th) * 800 / 3, ey = land.ty + Math.cos(th) * 800 / 3;
  const outside = ex < 0 || ey < 0 || ex > N - 1 || ey > N - 1 || land.tx + Math.sin(th) * 1100 / 3 < 0 || land.tx + Math.sin(th) * 1100 / 3 > N - 1 || land.ty - Math.cos(th) * 1100 / 3 < 0 || land.ty - Math.cos(th) * 1100 / 3 > N - 1;
  $('#targetinfo').innerHTML = `Target: ${C.fmtLat(q.lat)} ${C.fmtLon(q.lon)}, height ${q.z.toFixed(1)} m. Steepest ground within 15 m: <b class="${near > 12 ? 'bad' : near > 8 ? 'warn' : 'good'}">${near.toFixed(1)}&deg;</b> (limit 12&deg;).` +
    (outside ? '<br><span class="warn">Part of this approach runs past the edge of the 3 km tile. Edge heights are repeated there.</span>' : '');
  drawLandMap(); drawSide(); updateHud();
}
function launch() {
  land.S = startState(); land.running = true; land.landed = null; land.last = null; $('#report').innerHTML = '';
  $('#launch').textContent = 'Restart descent';
}
function controls() {
  if (land.auto) return C.autopilot(land.S, land.P);
  const k = land.keys, t = land.touch;
  return { rot: ((k.R || t.R) ? 1 : 0) - ((k.L || t.L) ? 1 : 0), thrust: !!(k.T || t.T), throttle: 1 };
}
function frame(ts) {
  requestAnimationFrame(frame);
  if (!$('#tab-land').classList.contains('on')) { land.last = null; return; }
  if (land.running && !land.S.done) {
    if (land.last == null) land.last = ts;
    let dt = Math.min(0.1, (ts - land.last) / 1000); land.last = ts;
    let rem = dt * land.warp; const h = 1 / 60;
    while (rem > 1e-6 && !land.S.done) { const s = Math.min(h, rem); C.stepLander(land.S, land.P, controls(), s); rem -= s; }
    if (land.S.done) finish();
  }
  drawSide(); updateHud();
}
function updateHud() {
  const S = land.S, hgt = S.y - C.LANDER.footOffset - C.profileZ(land.P, S.x);
  const set = (id, v, cls) => { const e = $(id); e.textContent = v; e.className = cls || ''; };
  const L = C.LANDER.limits;
  set('#h-alt', Math.max(0, hgt).toFixed(0) + ' m');
  set('#h-vy', S.vy.toFixed(1) + ' m/s', hgt < 60 ? (Math.abs(S.vy) <= L.vy ? 'good' : 'bad') : '');
  set('#h-vx', S.vx.toFixed(1) + ' m/s', hgt < 60 ? (Math.abs(S.vx) <= L.vx ? 'good' : 'bad') : '');
  set('#h-ang', (Math.round(S.ang) || 0) + '\u00b0');
  set('#h-fuel', S.fuel.toFixed(0) + ' m/s', S.fuel < 25 ? 'bad' : '');
  set('#h-dist', Math.abs(S.x).toFixed(0) + ' m');
}
function finish() {
  const r = land.S.result; land.running = false; land.landed = r;
  const best = +(localStorage.getItem('ssl_best') || 0), n = +(localStorage.getItem('ssl_n') || 0) + 1, safe = +(localStorage.getItem('ssl_safe') || 0) + (r.kind === 'safe' ? 1 : 0);
  if (r.score > best) localStorage.setItem('ssl_best', r.score);
  localStorage.setItem('ssl_n', n); localStorage.setItem('ssl_safe', safe);
  const cls = r.kind === 'safe' ? 'good' : r.kind === 'hard' ? 'warn' : 'bad';
  let extra = '';
  if (r.vy !== undefined) extra = `<div class="small">Vertical ${Math.abs(r.vy).toFixed(2)} m/s &middot; sideways ${Math.abs(r.vx).toFixed(2)} m/s &middot; tilt to ground ${r.relTilt.toFixed(1)}&deg; &middot; ground slope ${r.slope.toFixed(1)}&deg; &middot; ${(r.fuelLeft * 100).toFixed(0)}% fuel left &middot; ${r.t.toFixed(0)} s</div>`;
  $('#report').innerHTML = `<div class="report"><h4 class="${cls}">${r.title}${r.kind === 'safe' ? ' &middot; ' + r.score + ' pts' : ''}</h4><div>${r.detail}</div>${extra}<div class="row"><button class="btn" id="again">Fly again</button>${r.kind !== 'lost' && r.kind !== 'crash' ? '<button class="btn alt" id="goRove">Send the rover out from here</button>' : ''}</div></div>`;
  $('#again').onclick = () => { launch(); };
  const g = $('#goRove'); if (g) g.onclick = () => { setRoveStartFromLanding(); $$('nav button')[1].click(); };
  const hist = $('#stats'); hist.textContent = `Your record: ${safe} soft landings in ${n} tries. Best score ${localStorage.getItem('ssl_best')}.`;
  drawLandMap();
}
function landingCell() {
  const P = land.P, x = land.S.x; return [P.cx + P.dx * x / T.cell, P.cy + P.dy * x / T.cell];
}
function drawLandMap() {
  const cv = $('#map1'), x = cv.getContext('2d');
  x.drawImage(layerCache[land.layer === 'haz' ? 'haz' : 'hill'], 0, 0);
  const P = land.P || C.makeProfile(T, land.tx, land.ty, land.heading, 1100), c = T.cell;
  const sx = P.cx + P.dx * -800 / c, sy = P.cy + P.dy * -800 / c, ex = P.cx + P.dx * 1100 / c, ey = P.cy + P.dy * 1100 / c;
  x.save(); x.setLineDash([14, 10]); x.lineWidth = 4; x.strokeStyle = '#000'; x.beginPath(); x.moveTo(sx, sy); x.lineTo(P.cx, P.cy); x.stroke();
  x.lineWidth = 2.5; x.strokeStyle = '#ffd166'; x.beginPath(); x.moveTo(sx, sy); x.lineTo(P.cx, P.cy); x.stroke(); x.restore();
  x.strokeStyle = 'rgba(255,209,102,.35)'; x.lineWidth = 2; x.beginPath(); x.moveTo(P.cx, P.cy); x.lineTo(ex, ey); x.stroke();
  marker(x, sx, sy, '#4cc9f0', 'start', 8);
  marker(x, P.cx, P.cy, '#ff9933', 'target', 12);
  const sc = [siteCell[0], siteCell[1]];
  if (Math.hypot(sc[0] - P.cx, sc[1] - P.cy) > 6) { x.fillStyle = 'rgba(255,255,255,.85)'; x.font = '600 20px system-ui'; x.fillText('\u2726 Shiv Shakti', sc[0] + 8, sc[1] + 6); }
  if (land.S && land.S.done && land.S.result && land.S.result.vy !== undefined) { const [lx, ly] = landingCell(); marker(x, lx, ly, land.S.result.kind === 'safe' ? '#2fbf71' : '#ff5d73', 'touchdown', 7); }
  // scale bar 500 m
  const sb = 500 / c; x.fillStyle = '#fff'; x.fillRect(30, N - 40, sb, 5); x.font = '600 20px system-ui'; x.fillText('500 m', 30, N - 50);
  // compass
  x.save(); x.translate(N - 60, 60); x.fillStyle = 'rgba(0,0,0,.5)'; x.beginPath(); x.arc(0, 0, 38, 0, 7); x.fill(); x.fillStyle = '#fff'; x.beginPath(); x.moveTo(0, -30); x.lineTo(9, 6); x.lineTo(-9, 6); x.fill(); x.font = '700 18px system-ui'; x.fillText('N', -7, 28); x.restore();
}
let stars = null;
function drawSide() {
  const cv = $('#side'), x = cv.getContext('2d'), W = cv.width, H = cv.height, S = land.S, P = land.P;
  if (!stars) { stars = []; let s = 5; for (let i = 0; i < 120; i++) { s = (s * 16807) % 2147483647; const a = s / 2147483647; s = (s * 16807) % 2147483647; stars.push([a * W, (s / 2147483647) * H * 0.95, 0.6 + a * 1.4]); } }
  const gz = C.profileZ(P, S.x), alt = Math.max(0, S.y - gz);
  const targetH = Math.max(110, Math.min(1000, alt * 1.5 + 70));
  land.zoomH += (targetH - land.zoomH) * 0.08;
  const sc = H / land.zoomH, camX = S.x, camYtarget = S.y - land.zoomH * 0.12;
  land.camY += (camYtarget - land.camY) * 0.15; if (!land.running) land.camY = camYtarget;
  const toX = (m) => W / 2 + (m - camX) * sc, toY = (m) => H / 2 - (m - land.camY) * sc;
  const sky = x.createLinearGradient(0, 0, 0, H); sky.addColorStop(0, '#02030a'); sky.addColorStop(1, '#0b1020'); x.fillStyle = sky; x.fillRect(0, 0, W, H);
  x.fillStyle = '#fff'; for (const s of stars) { x.globalAlpha = 0.4 + s[2] * 0.25; x.fillRect(s[0], s[1], s[2], s[2]); } x.globalAlpha = 1;
  // ground
  const x0 = camX - W / 2 / sc, x1 = camX + W / 2 / sc;
  x.beginPath(); x.moveTo(0, H);
  const stepPx = 2;
  for (let px = 0; px <= W; px += stepPx) { const m = camX + (px - W / 2) / sc; x.lineTo(px, toY(C.profileZ(P, m))); }
  x.lineTo(W, H); x.closePath();
  const gg = x.createLinearGradient(0, 0, 0, H); gg.addColorStop(0, '#6b6761'); gg.addColorStop(1, '#25231f'); x.fillStyle = gg; x.fill();
  x.strokeStyle = '#a9a39a'; x.lineWidth = 2; x.beginPath();
  for (let px = 0; px <= W; px += stepPx) { const m = camX + (px - W / 2) / sc, y = toY(C.profileZ(P, m)); px ? x.lineTo(px, y) : x.moveTo(px, y); } x.stroke();
  // hazard shading: ground steeper than 12 deg
  x.strokeStyle = '#ff5d73'; x.lineWidth = 5; x.beginPath(); let pen = false;
  for (let px = 0; px <= W; px += stepPx) { const m = camX + (px - W / 2) / sc; if (C.profileSlope(P, m) > 12) { const y = toY(C.profileZ(P, m)); pen ? x.lineTo(px, y) : x.moveTo(px, y); pen = true; } else pen = false; } x.stroke();
  // target flag
  const fx = toX(0), fy = toY(C.profileZ(P, 0));
  if (fx > -20 && fx < W + 20) { x.strokeStyle = '#fff'; x.lineWidth = 2; x.beginPath(); x.moveTo(fx, fy); x.lineTo(fx, fy - 44); x.stroke(); x.fillStyle = '#ff9933'; x.beginPath(); x.moveTo(fx, fy - 44); x.lineTo(fx + 28, fy - 37); x.lineTo(fx, fy - 30); x.fill(); x.fillStyle = '#fff'; x.font = '600 14px system-ui'; x.fillText('target', fx + 6, fy + 18); }
  // altitude ticks near lander
  // trail
  x.strokeStyle = 'rgba(255,209,102,.5)'; x.setLineDash([3, 6]); x.lineWidth = 2; x.beginPath(); S.trail.forEach((p, i) => i ? x.lineTo(toX(p[0]), toY(p[1])) : x.moveTo(toX(p[0]), toY(p[1]))); x.stroke(); x.setLineDash([]);
  // lander sprite
  const lx = toX(S.x), ly = toY(S.y), size = Math.max(sc * 3.4, 30);
  x.save(); x.translate(lx, ly); x.rotate((S.ang * Math.PI) / 180);
  const u = size / 30;
  if (S.throttle > 0.02 && !(S.done && S.result)) { const fl = (14 + 50 * S.throttle) * u * (0.85 + Math.random() * 0.3); const fg = x.createLinearGradient(0, 8 * u, 0, 8 * u + fl); fg.addColorStop(0, '#fff'); fg.addColorStop(0.3, '#ffcf6e'); fg.addColorStop(1, 'rgba(255,90,0,0)'); x.fillStyle = fg; x.beginPath(); x.moveTo(-6 * u, 8 * u); x.lineTo(6 * u, 8 * u); x.lineTo(0, 8 * u + fl); x.fill(); }
  x.strokeStyle = '#cfd6e6'; x.lineWidth = 2.5 * u; x.beginPath(); x.moveTo(-10 * u, 4 * u); x.lineTo(-19 * u, 17 * u); x.moveTo(10 * u, 4 * u); x.lineTo(19 * u, 17 * u); x.stroke();
  x.fillStyle = '#cfd6e6'; x.fillRect(-23 * u, 17 * u, 8 * u, 2.5 * u); x.fillRect(15 * u, 17 * u, 8 * u, 2.5 * u);
  x.fillStyle = '#e9ecf4'; x.beginPath(); x.moveTo(-11 * u, 8 * u); x.lineTo(-13 * u, -8 * u); x.lineTo(-6 * u, -13 * u); x.lineTo(6 * u, -13 * u); x.lineTo(13 * u, -8 * u); x.lineTo(11 * u, 8 * u); x.closePath(); x.fill();
  x.fillStyle = '#ff9933'; x.fillRect(-11 * u, -3 * u, 22 * u, 3 * u); x.fillStyle = '#fff'; x.fillRect(-11 * u, 0, 22 * u, 3 * u); x.fillStyle = '#2fbf71'; x.fillRect(-11 * u, 3 * u, 22 * u, 3 * u);
  x.fillStyle = '#4cc9f0'; x.fillRect(-3 * u, -9 * u, 6 * u, 4 * u);
  x.restore();
  // velocity arrow
  const vs = Math.hypot(S.vx, S.vy);
  if (!S.done && vs > 0.3) { const k = Math.min(70, vs * 3) / vs; x.strokeStyle = '#4cc9f0'; x.lineWidth = 3; x.beginPath(); x.moveTo(lx, ly); x.lineTo(lx + S.vx * k, ly - S.vy * k); x.stroke(); }
  // scale + height ruler
  const nice = [1, 2, 5, 10, 20, 50, 100, 200, 500].find((v) => v * sc > 60) || 500;
  x.fillStyle = '#fff'; x.fillRect(16, H - 24, nice * sc, 4); x.font = '600 14px system-ui'; x.fillText(nice + ' m', 16, H - 32);
  x.fillStyle = 'rgba(255,255,255,.7)'; x.fillText(`ground slope under lander ${C.profileSlope(P, S.x).toFixed(1)}\u00b0`, W - 250, 24);
  if (!land.running && !S.done) { x.fillStyle = 'rgba(0,0,0,.45)'; x.fillRect(W / 2 - 230, 28, 460, 58); x.fillStyle = '#fff'; x.font = '700 18px system-ui'; x.textAlign = 'center'; x.fillText('Press Launch, or any burn key, to start', W / 2, 55); x.font = '14px system-ui'; x.fillStyle = '#c8d0e2'; x.fillText('Start: 800 m before the target, 600 m up, moving toward it at 26 m/s', W / 2, 76); x.textAlign = 'left'; }
  if (S.done && S.result) { x.fillStyle = S.result.kind === 'safe' ? '#2fbf71' : S.result.kind === 'hard' ? '#ffd166' : '#ff5d73'; x.font = '800 26px system-ui'; x.textAlign = 'center'; x.fillText(S.result.title.toUpperCase(), W / 2, 50); x.textAlign = 'left'; }
}

// ================= ROVE =================
const rove = { layer: 'reach', start: null, dest: null, limit: 5, dist: null, reachCanvas: null, routes: null, vis: { shortest: true, balanced: true, gentle: true }, click: 'dest', chart: 'slope', jobTok: 0 };
function initRove() {
  rove.start = [siteCell[0], siteCell[1]];
  const m2 = $('#map2');
  m2.addEventListener('pointerdown', (e) => {
    const [x, y] = cellFromEvent(m2, e);
    if (rove.click === 'start' || e.shiftKey) { rove.start = [x, y]; rove.routes = null; runReach(); }
    else { rove.dest = [x, y]; runRoutes(); }
    drawRove();
  });
  m2.addEventListener('pointermove', (e) => { const [x, y] = cellFromEvent(m2, e); $('#read2').textContent = infoText(x, y); });
  $$('#layer2 button').forEach((b) => b.onclick = () => { rove.layer = b.dataset.l; $$('#layer2 button').forEach((x) => x.classList.toggle('on', x === b)); drawRove(); });
  $$('#clickmode button').forEach((b) => b.onclick = () => { rove.click = b.dataset.m; $$('#clickmode button').forEach((x) => x.classList.toggle('on', x === b)); });
  $$('#chartmode button').forEach((b) => b.onclick = () => { rove.chart = b.dataset.c; $$('#chartmode button').forEach((x) => x.classList.toggle('on', x === b)); drawChart(); });
  const lim = $('#limit');
  lim.oninput = () => { $('#limitv').innerHTML = (+lim.value) + '&deg;'; };
  lim.onchange = () => { rove.limit = +lim.value; runReach(); if (rove.dest) runRoutes(); };
  $('#usland').onclick = setRoveStartFromLanding;
  $('#usesite').onclick = () => { rove.start = [siteCell[0], siteCell[1]]; rove.routes = null; runReach(); if (rove.dest) runRoutes(); drawRove(); };
  $('#reachlegend').innerHTML = '<span><i style="background:#4cc9f0"></i>near</span><span><i style="background:#e6677c"></i>far (stripes every 250 m of driving)</span><span><i style="background:#5a0e1e"></i>cannot reach</span>';
  $('#reachsum').innerHTML = '<span class="small">Waiting for the routing engine&hellip;</span>';
}
function roveOnReady() { if (rove.start) runReach(); }
function setRoveStartFromLanding() {
  if (!land.landed || land.landed.vy === undefined) { rove.start = [siteCell[0], siteCell[1]]; }
  else { const [lx, ly] = landingCell(); rove.start = [Math.max(0, Math.min(N - 1, lx)), Math.max(0, Math.min(N - 1, ly))]; }
  rove.routes = null; runReach(); if (rove.dest) runRoutes(); drawRove();
}
const idx = (p) => Math.round(p[1]) * N + Math.round(p[0]);
async function runReach() {
  if (!workerReady) return;
  const tok = ++rove.jobTok; const box = $('#reachsum'); box.classList.add('busy');
  box.innerHTML = '<span class="small">Computing where the rover can drive&hellip;</span>';
  const startIdx = idx(rove.start);
  if (T.slope[startIdx] > rove.limit) { /* start is on ground steeper than the limit; allow it anyway by relaxing locally */ }
  const m = await job({ type: 'reach', start: startIdx, limit: rove.limit });
  if (tok !== rove.jobTok) return;
  rove.dist = m.dist; rove.reachCanvas = buildReachLayer(m.dist); box.classList.remove('busy');
  const s = m.sum, km2 = (s.areaM2 / 1e6).toFixed(2);
  box.innerHTML = `At <b>${rove.limit}&deg;</b> the rover can reach <b>${(s.frac * 100).toFixed(0)}%</b> of this ${(N * T.cell / 1000).toFixed(1)} km tile (${km2} km&sup2;). Farthest reachable point: <b>${s.farthest.toFixed(0)} m</b> of driving.`;
  drawRove();
}
let routeTok = 0;
async function runRoutes() {
  if (!workerReady) return;
  const tok = ++routeTok, box = $('#routes'); box.classList.add('busy'); box.textContent = 'Finding routes\u2026';
  const m = await job({ type: 'routes', start: idx(rove.start), target: idx(rove.dest), limit: rove.limit });
  if (tok !== routeTok) return;
  box.classList.remove('busy'); rove.routes = m.out; renderRoutes(); drawRove(); drawChart();
}
function renderRoutes() {
  const box = $('#routes'), R = rove.routes;
  const any = Object.values(R).some(Boolean);
  if (!any) { box.innerHTML = `<span class="bad"><b>No route at ${rove.limit}&deg;.</b></span> The destination is on ground steeper than the limit, or it is cut off by steep ground. Raise the limit or pick another spot.`; return; }
  let h = '<div style="overflow-x:auto"><table><tr><th>Route</th><th>Length</th><th>Steepest</th><th>Average</th><th>Climb</th></tr>';
  const best = Math.min(...Object.values(R).filter(Boolean).map((r) => r.stats.length));
  for (const [k, M] of Object.entries(C.ROUTE_MODES)) {
    const r = R[k];
    h += `<tr><td><label><input type="checkbox" data-r="${k}" ${rove.vis[k] ? 'checked' : ''}> <span class="dot" style="background:${M.color}"></span>${M.label}</label></td>` + (r ? `<td>${r.stats.length.toFixed(0)} m${r.stats.length - best > 0.5 ? ` <span class="small">(+${(r.stats.length - best).toFixed(0)})</span>` : ''}</td><td>${r.stats.maxSlope.toFixed(1)}&deg;</td><td>${r.stats.meanSlope.toFixed(1)}&deg;</td><td>${r.stats.gain.toFixed(0)} m</td>` : '<td colspan="4">no route</td>') + '</tr>';
  }
  h += '</table></div><div class="small" style="margin-top:6px">Length counts the up-and-down of the ground. Steepest and average are the cell slopes along the path. Shortest may cut across steeper patches that the gentler routes go around.</div>';
  box.innerHTML = h;
  $$('#routes input[data-r]').forEach((cb) => cb.onchange = () => { rove.vis[cb.dataset.r] = cb.checked; drawRove(); drawChart(); });
}
function drawRove() {
  const cv = $('#map2'), x = cv.getContext('2d');
  const layer = rove.layer === 'reach' && rove.reachCanvas ? rove.reachCanvas : rove.layer === 'slope' ? layerCache.slope : layerCache.hill;
  x.drawImage(layer, 0, 0);
  const R = rove.routes;
  if (R) for (const [k, M] of Object.entries(C.ROUTE_MODES)) {
    if (!R[k] || !rove.vis[k]) continue;
    x.lineJoin = 'round'; x.lineCap = 'round';
    x.strokeStyle = '#000'; x.lineWidth = 8; x.beginPath(); R[k].path.forEach((p, i) => i ? x.lineTo(p[0] + .5, p[1] + .5) : x.moveTo(p[0] + .5, p[1] + .5)); x.stroke();
    x.strokeStyle = M.color; x.lineWidth = 4.5; x.beginPath(); R[k].path.forEach((p, i) => i ? x.lineTo(p[0] + .5, p[1] + .5) : x.moveTo(p[0] + .5, p[1] + .5)); x.stroke();
  }
  marker(x, rove.start[0], rove.start[1], '#2fbf71', 'start', 10);
  if (rove.dest) marker(x, rove.dest[0], rove.dest[1], '#ff9933', 'destination', 10);
  const sb = 500 / T.cell; x.fillStyle = '#fff'; x.fillRect(30, N - 40, sb, 5); x.font = '600 20px system-ui'; x.fillText('500 m', 30, N - 50);
}
function drawChart() {
  const cv = $('#chart'), x = cv.getContext('2d'), W = cv.width, H = cv.height;
  x.fillStyle = '#0a0f19'; x.fillRect(0, 0, W, H);
  const R = rove.routes; const pad = { l: 62, r: 30, t: 14, b: 32 };
  if (!R || !Object.values(R).some(Boolean)) { x.fillStyle = '#93a0ba'; x.font = '16px system-ui'; x.fillText('Pick a destination to see the profile.', 20, H / 2); return; }
  const modes = Object.keys(C.ROUTE_MODES).filter((k) => R[k] && rove.vis[k]);
  if (!modes.length) return;
  const maxD = Math.max(...modes.map((k) => R[k].stats.prof[R[k].stats.prof.length - 1][0]));
  let lo = Infinity, hi = -Infinity;
  const series = (k) => rove.chart === 'slope' ? R[k].stats.prof.map((p, i) => [p[0], R[k].stats.slopes[i]]) : R[k].stats.prof.map((p) => [p[0], p[1] - R[k].stats.prof[0][1]]);
  modes.forEach((k) => series(k).forEach((p) => { lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); }));
  if (rove.chart === 'slope') { lo = 0; hi = Math.max(hi, rove.limit) * 1.1; } else { const m = (hi - lo) * 0.1 + 0.5; lo -= m; hi += m; }
  const X = (d) => pad.l + (d / maxD) * (W - pad.l - pad.r), Y = (v) => H - pad.b - ((v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  x.strokeStyle = '#243049'; x.fillStyle = '#93a0ba'; x.font = '15px system-ui'; x.lineWidth = 1;
  for (let i = 0; i <= 4; i++) { const v = lo + ((hi - lo) * i) / 4, y = Y(v); x.beginPath(); x.moveTo(pad.l, y); x.lineTo(W - pad.r, y); x.stroke(); x.fillText(v.toFixed(rove.chart === 'slope' ? 1 : 0) + (rove.chart === 'slope' ? '\u00b0' : ' m'), 4, y + 4); }
  for (let i = 0; i <= 4; i++) { const d = (maxD * i) / 4; x.fillText(d.toFixed(0) + ' m', Math.min(X(d) - 16, W - 56), H - 10); }
  if (rove.chart === 'slope') { x.strokeStyle = '#ff5d73'; x.setLineDash([6, 5]); x.beginPath(); x.moveTo(pad.l, Y(rove.limit)); x.lineTo(W - pad.r, Y(rove.limit)); x.stroke(); x.setLineDash([]); x.fillStyle = '#ff5d73'; x.fillText('limit', W - 60, Y(rove.limit) - 4); }
  for (const k of modes) { x.strokeStyle = C.ROUTE_MODES[k].color; x.lineWidth = 2; x.beginPath(); series(k).forEach((p, i) => i ? x.lineTo(X(p[0]), Y(p[1])) : x.moveTo(X(p[0]), Y(p[1]))); x.stroke(); }
}

// ================= DATA =================
function initData() {
  const [la0, lo0] = proj.cellToLatLon(0, 0), [la1, lo1] = proj.cellToLatLon(N - 1, N - 1);
  let mn = 1e9, mx = -1e9, sum = 0, over12 = 0, under5 = 0;
  for (let i = 0; i < N * N; i++) { mn = Math.min(mn, T.z[i]); mx = Math.max(mx, T.z[i]); sum += T.slope[i]; if (T.slope[i] > 12) over12++; if (T.slope[i] < 5) under5++; }
  const rows = [
    ['Product', 'LROC NAC DTM NAC_DTM_VIKRAMSITE1, version 1.9 (pre-landing model, made from images taken 3 Jul 2023)'],
    ['Grid', '3 m per cell. Full model is 7668 \u00d7 15895 cells.'],
    ['Projection', 'South polar stereographic, true scale at 69.3\u00b0S, central meridian 32.3\u00b0E, Moon sphere radius 1737.4 km'],
    ['Window used', `source columns ${meta.src_col0}\u2013${meta.src_col0 + N - 1}, rows ${meta.src_row0}\u2013${meta.src_row0 + N - 1} (${(N * meta.cell_m / 1000).toFixed(2)} km square)`],
    ['Window corners', `${C.fmtLat(la0)} ${C.fmtLon(lo0)} (top left) to ${C.fmtLat(la1)} ${C.fmtLon(lo1)} (bottom right)`],
    ['Height range', `${mn.toFixed(1)} to ${mx.toFixed(1)} m above the 1737.4 km sphere (${(mx - mn).toFixed(0)} m of relief across 3 km)`],
    ['Slope', `computed here over 12 m; median ${medianSlope().toFixed(1)}\u00b0; ${(under5 / (N * N) * 100).toFixed(0)}% of cells under 5\u00b0; ${(over12 / (N * N) * 100).toFixed(2)}% over 12\u00b0`],
    ['No-data cells', `${meta.nodata_cells.toLocaleString()} of ${(N * N).toLocaleString()} (${(meta.nodata_cells / (N * N) * 100).toFixed(2)}%), filled from neighbours`],
  ];
  $('#datakv').innerHTML = rows.map((r) => `<dt>${r[0]}</dt><dd>${r[1]}</dd>`).join('');
  $('#datanote').textContent = 'Heights are rounded to 2 mm for storage. Projection maths was checked against the corner latitudes and longitudes in the product label.';
}
function medianSlope() { const a = Float32Array.from(T.slope).sort(); return a[a.length >> 1]; }

boot().catch((e) => { $('#loading').textContent = 'Could not load terrain: ' + e.message; console.error(e); });
