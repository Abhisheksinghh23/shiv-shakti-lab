"""Cut the demo tile out of the LROC NAC DTM (NAC_DTM_VIKRAMSITE1).

Usage: python3 tools/extract_dem.py NAC_DTM_VIKRAMSITE1.TIF data/
Needs numpy only. The GeoTIFF is read by hand: uncompressed float32, one row per strip.
Source: https://pds.lroc.im-ldi.com/data/LRO-L-LROC-5-RDR-V1.0/LROLRC_2001/DATA/SDP/NAC_DTM/VIKRAMSITE1/
Credit: NASA/GSFC/Arizona State University.
"""
import sys, json, math, struct
import numpy as np

tif, out = sys.argv[1], sys.argv[2]
raw = np.fromfile(tif, dtype="u1")
off = struct.unpack("<I", raw[4:8].tobytes())[0]
n = struct.unpack("<H", raw[off:off + 2].tobytes())[0]
tags = {}
for i in range(n):
    t, ty, c, v = struct.unpack("<HHII", raw[off + 2 + i * 12: off + 14 + i * 12].tobytes())
    tags[t] = (ty, c, v)
W, H = tags[256][2], tags[257][2]
strips = np.frombuffer(raw[tags[273][2]: tags[273][2] + 4 * H].tobytes(), "<u4")  # strips are not stored in row order
scale = struct.unpack("<3d", raw[tags[33550][2]: tags[33550][2] + 24].tobytes())[0]
tie = struct.unpack("<6d", raw[tags[33922][2]: tags[33922][2] + 48].tobytes())
x_ul, y_ul = tie[3], tie[4]  # projected metres of the top-left corner (pixel-is-area)
geo = struct.unpack("<8d", raw[tags[34736][2]: tags[34736][2] + 64].tobytes())
lat_true, lon0, R = geo[0], geo[1], geo[5]

# south polar stereographic, sphere
phic, lam0 = math.radians(lat_true), math.radians(lon0)
k0 = (1 + math.sin(-phic)) / 2
def fwd(lat, lon):
    p, l = math.radians(lat), math.radians(lon) - lam0
    rho = 2 * R * k0 * math.tan(math.pi / 4 + p / 2)
    return rho * math.sin(l), rho * math.cos(l)

SITE = (-69.3733, 32.3191)  # Shiv Shakti point
x, y = fwd(*SITE)
cx, cy = round((x - x_ul) / scale - 0.5), round((y_ul - y) / scale - 0.5)
half = 512
tile = np.empty((2 * half, 2 * half), "<f4")
for k, r in enumerate(range(cy - half, cy + half)):
    row = raw[strips[r]: strips[r] + 4 * W].view("<f4")
    tile[k] = row[cx - half: cx + half]
valid = tile > -1e30
filled = tile.copy(); filled[~valid] = np.nan
for _ in range(200):  # fill gaps from neighbours
    m = np.isnan(filled)
    if not m.any(): break
    p = np.pad(filled, 1, constant_values=np.nan)
    with np.errstate(all="ignore"):
        s = np.nanmean(np.stack([p[:-2, 1:-1], p[2:, 1:-1], p[1:-1, :-2], p[1:-1, 2:]]), axis=0)
    filled[m] = s[m]
lo = float(np.floor(filled.min()))
np.round((filled - lo) * 500).astype("<u2").tofile(out + "/terrain.bin")
(~valid).astype("u1").tofile(out + "/nodata.bin")
meta = dict(width=2 * half, height=2 * half, cell_m=scale, elev_offset_m=lo, elev_scale=500,
            x0=x_ul + (cx - half) * scale, y0=y_ul - (cy - half) * scale, R=R, lat_true=lat_true, lon0=lon0,
            src_col0=cx - half, src_row0=cy - half, nodata_cells=int((~valid).sum()))
json.dump(meta, open(out + "/meta.json", "w"), indent=1)
print(meta)
