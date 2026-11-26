import fs from 'fs';
import zlib from 'zlib';
import * as C from '../core.js';
export function load(){
  const meta=JSON.parse(fs.readFileSync(new URL('../data/meta.json',import.meta.url)));
  const tb=Buffer.concat(fs.readdirSync(new URL('../data/',import.meta.url)).filter(f=>f.startsWith('terrain.b64.')).sort().map(f=>Buffer.from(fs.readFileSync(new URL('../data/'+f,import.meta.url),'utf8'),'base64')));
  const nb=zlib.gunzipSync(Buffer.from(fs.readFileSync(new URL('../data/nodata.gz.b64',import.meta.url),'utf8'),'base64'));
  const T=C.makeTerrain(new Uint8Array(tb),nb,meta);
  return {meta,T,proj:C.makeProj(meta)};
}
