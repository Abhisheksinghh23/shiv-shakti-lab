import * as C from '../core.js';import {load} from './load.mjs';
import assert from 'assert';
const {meta,T,proj}=load();let pass=0;const ok=(c,m)=>{assert(c,m);pass++;console.log('ok -',m)};
// geodesy
const [cx,cy]=proj.latLonToCell(C.SITE.lat,C.SITE.lon);
ok(Math.abs(cx-511.5)<1.5&&Math.abs(cy-511.5)<1.5,'site lands at tile centre');
const [la,lo]=proj.cellToLatLon(Math.round(cx),Math.round(cy));
ok(Math.abs(la-C.SITE.lat)<2e-4&&Math.abs(lo-C.SITE.lon)<3e-4,'cell->lat/lon round trip');
// terrain
let mn=1e9,mx=-1e9;for(const v of T.z){mn=Math.min(mn,v);mx=Math.max(mx,v)}
ok(mn>=500&&mx<=580,`elevations plausible ${mn.toFixed(1)}..${mx.toFixed(1)} m`);
// lander on random targets
let seed=7;const rnd=()=>(seed=(seed*16807)%2147483647)/2147483647;
let safe=0,n=0,slopeFail=0,other=0;
for(let k=0;k<120;k++){
  const tx=150+rnd()*720,ty=150+rnd()*720,hd=rnd()*360;
  const P=C.makeProfile(T,tx,ty,hd,1100);
  const S=C.simulate(P,{x:-800,vx:20+rnd()*15,alt:400+rnd()*300});
  n++;const r=S.result;
  if(r.kind==='safe')safe++;else if(/ground slope/.test(r.detail)&&!/speed|tilt to/.test(r.detail))slopeFail++;else {other++;if(other<6)console.log('  other:',r.title,r.detail)}
}
console.log({n,safe,slopeFail,other});
ok(other===0,'autopilot fails only on genuinely steep touchdown ground');
ok(safe/n>0.85,'autopilot soft-lands >85% of random targets');
// routing
const start=Math.round(cy)*T.w+Math.round(cx);
for(const lim of [5,8,10,15]){
  const t0=performance.now();const R=C.dijkstra(T,start,'shortest',lim);const s=C.reachSummary(T,R.dist);
  console.log(`limit ${lim}: reach ${(s.frac*100).toFixed(1)}% farthest ${s.farthest.toFixed(0)} m, ${(performance.now()-t0).toFixed(0)} ms`);
}
const tgt=Math.round(cy-250)*T.w+Math.round(cx+300);
const paths={};
for(const m of Object.keys(C.ROUTE_MODES)){
  const t0=performance.now();const R=C.dijkstra(T,start,m,10,tgt);
  assert(Number.isFinite(R.dist[tgt]),'reachable');
  const p=C.extractPath(R.prev,tgt,T.w),st=C.routeStats(T,p);paths[m]=st;
  console.log(m,'len',st.length.toFixed(0),'max',st.maxSlope.toFixed(1),'mean',st.meanSlope.toFixed(2),'gain',st.gain.toFixed(0),(performance.now()-t0).toFixed(0)+'ms');
}
ok(paths.shortest.length<=paths.gentle.length+1e-3,'shortest route is not longer than gentlest');
ok(paths.gentle.meanSlope<=paths.shortest.meanSlope+1e-6,'gentlest route has lower mean slope');
const straight=Math.hypot(300,250)*3;ok(paths.shortest.length>=straight*0.99&&paths.shortest.length<straight*1.25,'shortest ~ straight-line distance');
// blocked target when limit tiny
const R2=C.dijkstra(T,start,'shortest',1,tgt);ok(!Number.isFinite(R2.dist[tgt]),'tiny slope limit blocks route');
console.log(pass,'checks passed');
// free fall must crash; hovering above ground stays flying
{const P=C.makeProfile(T,cx,cy,90,1100);const S=C.simulate(P,{},()=>({rot:0,thrust:false}));ok(S.result.kind==='crash'&&/vertical speed/.test(S.result.detail),'no burn means a crash');}
console.log('all done');
