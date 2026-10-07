#!/usr/bin/env python3
"""
make_geo_data.py: builds the GEO_DATA block embedded in index.html.

Sources (downloaded with `npm pack`, nothing is fetched at runtime):
  * world-atlas@2 countries-10m.json: Natural Earth 1:10m admin-0 (public domain), for
    coastlines and neighbouring countries.
  * indonesia-geodata json/indonesiaHigh.json (MIT): Indonesia's 38 provinces.

Usage:
  npm pack world-atlas@2 indonesia-geodata    # then extract both .tgz files
  python3 tools/make_geo_data.py <world-atlas/package> <indonesia-geodata/package> [index.html]

Rings are simplified (Douglas-Peucker), quantised to 0.001 deg, delta + zigzag + varint
encoded and stored as base64. Provincial borders are the edges two provinces share, stored as
open polylines ('pb'), so coastlines are never drawn twice.
"""
import base64, json, math, os, re, sys

WA, IDG = sys.argv[1], sys.argv[2]
TARGET = sys.argv[3] if len(sys.argv) > 3 else os.path.join(os.path.dirname(__file__), '..', 'index.html')
BOX = (82.0, 154.0, -22.0, 18.0)   # the dashboard paints 84-152 E, 20 S-16 N (detail inside 94-142 E, 11.5 S-6.5 N)
Q, TOL_IDN, TOL_OTHER, TOL_PROV = 1000, 0.003, 0.005, 0.008

def rdp(pts, eps):
    if len(pts) < 4: return pts
    keep = [False] * len(pts); keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (ax, ay), (bx, by) = pts[a], pts[b]
        dx, dy = bx - ax, by - ay; L = math.hypot(dx, dy) or 1e-12
        imax, dmax = -1, -1.0
        for i in range(a + 1, b):
            px, py = pts[i]
            d = abs(dy * (px - ax) - dx * (py - ay)) / L if (dx or dy) else math.hypot(px - ax, py - ay)
            if d > dmax: imax, dmax = i, d
        if dmax > eps: keep[imax] = True; stack += [(a, imax), (imax, b)]
    return [p for p, k in zip(pts, keep) if k]

def area(r): return abs(sum(r[i][0] * r[i - 1][1] - r[i - 1][0] * r[i][1] for i in range(len(r)))) / 2
def inbox(r):
    xs = [p[0] for p in r]; ys = [p[1] for p in r]
    if max(xs) - min(xs) > 180: return False   # wraps the 180th meridian (Fiji): far away anyway
    return max(xs) >= BOX[0] and min(xs) <= BOX[1] and max(ys) >= BOX[2] and min(ys) <= BOX[3]
def clip(r, box):
    # Sutherland-Hodgman against the box, so large neighbours (Australia, India) stay small
    x0, x1, y0, y1 = box
    def cut(pts, inside, inter):
        out = []
        for i in range(len(pts)):
            a, b = pts[i - 1], pts[i]
            if inside(b):
                if not inside(a): out.append(inter(a, b))
                out.append(b)
            elif inside(a): out.append(inter(a, b))
        return out
    ix = lambda xc: (lambda a, b: (xc, a[1] + (b[1] - a[1]) * (xc - a[0]) / (b[0] - a[0])))
    iy = lambda yc: (lambda a, b: (a[0] + (b[0] - a[0]) * (yc - a[1]) / (b[1] - a[1]), yc))
    for inside, inter in ((lambda p: p[0] >= x0, ix(x0)), (lambda p: p[0] <= x1, ix(x1)), (lambda p: p[1] >= y0, iy(y0)), (lambda p: p[1] <= y1, iy(y1))):
        if not r: break
        r = cut(r, inside, inter)
    return r
def zz(v): return (v << 1) ^ (v >> 63)
def pack(rings):
    b = bytearray()
    def vi(u):
        while u >= 0x80: b.append((u & 0x7f) | 0x80); u >>= 7
        b.append(u)
    vi(len(rings))
    for r in rings:
        q = [(round(x * Q), round(y * Q)) for x, y in r]
        vi(len(q)); px = py = 0
        for x, y in q: vi(zz(x - px)); vi(zz(y - py)); px, py = x, y
    return base64.b64encode(bytes(b)).decode()

topo = json.load(open(os.path.join(WA, 'countries-10m.json')))
sc, tr = topo['transform']['scale'], topo['transform']['translate']
arcs = []
for a in topo['arcs']:
    x = y = 0; pts = []
    for dx, dy in a: x += dx; y += dy; pts.append((x * sc[0] + tr[0], y * sc[1] + tr[1]))
    arcs.append(pts)
def ring(idx):
    pts = []
    for i in idx:
        seg = arcs[i] if i >= 0 else arcs[~i][::-1]
        pts += seg if not pts else seg[1:]
    return pts
idn, oth = [], []
for g in topo['objects']['countries']['geometries']:
    polys = g['arcs'] if g['type'] == 'MultiPolygon' else [g['arcs']] if g['type'] == 'Polygon' else []
    for poly in polys:
        r = ring(poly[0])
        if not inbox(r): continue
        r = clip(r, BOX)
        if len(r) < 4 or area(r) < 0.0012: continue
        mine = g.get('id') == '360'
        s = rdp(r, TOL_IDN if mine else TOL_OTHER)
        if len(s) >= 4: (idn if mine else oth).append(s)

prov = json.load(open(os.path.join(IDG, 'json', 'indonesiaHigh.json')))
# provincial borders: only the edges two provinces share (coasts are drawn from Natural Earth),
# chained into polylines and simplified
from collections import Counter, defaultdict
key = lambda p: (round(p[0], 5), round(p[1], 5))
seg = Counter()
names = []
for f in prov['features']:
    g = f['geometry']; polys = g['coordinates'] if g['type'] == 'MultiPolygon' else [g['coordinates']]
    best, lab = 0, None
    for poly in polys:
        r = [tuple(p) for p in poly[0]]; a = area(r)
        if a > best: best, lab = a, (sum(p[0] for p in r) / len(r), sum(p[1] for p in r) / len(r))
        for ring_ in poly:
            q = [key(p) for p in ring_]
            for u, v in zip(q, q[1:]):
                if u != v: seg[(u, v) if u < v else (v, u)] += 1
    names.append([f['properties']['NAME_ENG'], round(lab[0], 2), round(lab[1], 2)])
adj = defaultdict(list)
for (u, v), n in seg.items():
    if n >= 2: adj[u].append(v); adj[v].append(u)
used, lines = set(), []
def walk(a, b):
    line = [a, b]; used.add((a, b) if a < b else (b, a))
    while len(adj[b]) == 2:
        c = adj[b][0] if adj[b][1] == a else adj[b][1]
        e = (b, c) if b < c else (c, b)
        if e in used: break
        used.add(e); line.append(c); a, b = b, c
    return line
for u in list(adj):
    if len(adj[u]) != 2:
        for v in adj[u]:
            if ((u, v) if u < v else (v, u)) not in used: lines.append(walk(u, v))
for u in list(adj):                              # closed loops (an inland province)
    for v in adj[u]:
        if ((u, v) if u < v else (v, u)) not in used: lines.append(walk(u, v))
plines = [s_ for s_ in (rdp(l, TOL_PROV) for l in lines) if len(s_) >= 2]

data = {'q': Q, 'idn': pack(idn), 'oth': pack(oth), 'pb': pack(plines), 'names': names}
block = '/*<GEO-DATA>*/\nconst GEO_DATA = ' + json.dumps(data, separators=(',', ':'), ensure_ascii=False) + ';\n/*</GEO-DATA>*/'
html = open(TARGET, encoding='utf-8').read()
pat = re.compile(r'/\*<GEO-DATA>\*/.*?/\*</GEO-DATA>\*/', re.S)
if not pat.search(html): sys.exit('GEO-DATA markers not found in ' + TARGET)
open(TARGET, 'w', encoding='utf-8').write(pat.sub(lambda m: block, html))
print(f'GEO_DATA: {len(idn)} Indonesian + {len(oth)} other land rings, {len(plines)} province border lines, {len(block) / 1024:.0f} KB')
