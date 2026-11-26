# Shiv Shakti Lab

Land a spacecraft and drive a rover on **real lunar terrain** around the Chandrayaan-3 landing site (Shiv Shakti point, 69.373°S 32.319°E). Runs in the browser, no build step, no server code.

**This is an educational demo, not a mission planning tool.** The physics is simplified, and the terrain model came from images taken before the landing. Its 3 m cells cannot show rocks or small craters. The rover tab shows what a rover with an adjustable slope limit could reach. It does not replay the real Pragyan route.

## What is in it

1. **Land.** Pick a target on the map and an approach heading. Fly a powered descent in the vertical plane over the real terrain profile under that line, by hand or with the autopilot. Touchdown is scored against ISRO's published Chandrayaan-3 limits: at most 2 m/s down, 0.5 m/s sideways, ground slope up to 12 degrees. The demo also asks for a tilt of 12 degrees or less to the ground.
2. **Rove.** Set a steepness limit. The page shows everything a rover could reach from the landing point (Dijkstra over a 16-direction grid), then compares three routes to any destination you click: shortest, balanced and gentlest, with length, steepest slope, average slope and climb.
3. **Data and method.** The pipeline, the numbers, the limits.

## Data

LROC NAC DTM `NAC_DTM_VIKRAMSITE1` v1.9, 3 m per cell, south polar stereographic. `tools/extract_dem.py` reads the GeoTIFF directly and cuts a 1024 x 1024 cell tile (3.07 km) centred on the landing point. Heights are stored as 16-bit integers (2 mm steps) in `data/terrain.bin`; `data/nodata.bin` marks the 0.33 percent of cells that were filled.

The projection maths in `core.js` matches the corner latitudes and longitudes in the product label (`test/run.mjs` checks the landing point lands at the tile centre and the round trip is stable).

Credit: **NASA/GSFC/Arizona State University**. PDS data is public domain. See https://lroc.im-ldi.com/about/terms

## Run it

```
python3 -m http.server 8000   # then open http://localhost:8000
node test/run.mjs             # core checks: geodesy, autopilot, routing
```

## Files

- `core.js` terrain, projection, slope, lander physics, autopilot, routing
- `worker.js` runs the routing in a Web Worker
- `app.js`, `index.html`, `style.css` the interface
- `tools/extract_dem.py` how the tile was made

Not affiliated with ISRO or NASA.
