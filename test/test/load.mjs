import fs from 'fs';
import * as C from '../core.js';
export function load(){
  const meta=JSON.parse(fs.readFileSync(new URL('../data/meta.json',import.meta.url)));
  const tb=fs.readFileSync(new URL('../data/terrain.bin',import.meta.url));
  const nb=fs.readFileSync(new URL('../data/nodata.bin',import.meta.url));
  const T=C.makeTerrain(new Uint8Array(tb),nb,meta);
  return {meta,T,proj:C.makeProj(meta)};
}
