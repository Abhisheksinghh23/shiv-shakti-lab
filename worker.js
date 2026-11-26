import * as C from './core.js';
let T = null;
self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') {
    T = C.makeTerrain(new Uint8Array(m.terrain), new Uint8Array(m.nodata), m.meta);
    self.postMessage({ type: 'ready' });
  } else if (m.type === 'reach') {
    const t0 = performance.now();
    const R = C.dijkstra(T, m.start, 'shortest', m.limit);
    const sum = C.reachSummary(T, R.dist);
    const dist = R.dist;
    self.postMessage({ type: 'reach', id: m.id, dist, sum, ms: performance.now() - t0 }, [dist.buffer]);
  } else if (m.type === 'routes') {
    const out = {};
    for (const mode of Object.keys(C.ROUTE_MODES)) {
      const R = C.dijkstra(T, m.start, mode, m.limit, m.target);
      if (!Number.isFinite(R.dist[m.target])) { out[mode] = null; continue; }
      const path = C.extractPath(R.prev, m.target, T.w);
      out[mode] = { path, stats: C.routeStats(T, path) };
    }
    self.postMessage({ type: 'routes', id: m.id, out });
  }
};
