import * as C from '../core.js';import {load} from './load.mjs';
const {meta,T,proj}=load();
const [cx,cy]=proj.latLonToCell(C.SITE.lat,C.SITE.lon);console.log('site cell',cx,cy, 'z',C.sampleZ(T,cx,cy));
console.log('corner', proj.cellToLatLon(0,0), proj.cellToLatLon(1023,1023));
for(const hd of [0,45,90,135,180,225,270,315]){
 const P=C.makeProfile(T,cx,cy,hd);
 let res={};
 for(const o of [{},{vx:20,alt:500},{vx:35,alt:900},{x:-1100,vx:40}]){
   const S=C.simulate(P,o);const r=S.result;
   res[r.kind]=(res[r.kind]||0)+1; if(r.kind!=='safe') console.log(hd,JSON.stringify(o),r.title,r.detail);
   else console.log(hd,JSON.stringify(o),'safe',r.score,r.fuelLeft.toFixed(2),r.dist.toFixed(0),S.t.toFixed(0));
 }
}
