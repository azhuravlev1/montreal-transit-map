"""Fetch Montreal Metro + REM from OpenStreetMap and build KML/KMZ files
for Google Earth and Google My Maps.

Usage: python3 build_transit.py            (fetch from Overpass, then build)
       python3 build_transit.py --offline  (rebuild from data/osm_raw.json)
"""

import json
import math
import os
import struct
import sys
import urllib.parse
import urllib.request
import zipfile
import zlib
from xml.sax.saxutils import escape

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
OUT = os.path.join(HERE, "output")
OVERPASS = "https://overpass-api.de/api/interpreter"

# One direction per line. REM uses two relations (both branches into Brossard);
# ways shared by the trunk are de-duplicated.
LINES = [
    {"id": "green",  "name": "Ligne 1 – Verte",  "relations": [58433],              "color": "#008E4F"},
    {"id": "orange", "name": "Ligne 2 – Orange", "relations": [270251],             "color": "#EF8122"},
    {"id": "yellow", "name": "Ligne 4 – Jaune",  "relations": [270252],             "color": "#FFE300"},
    {"id": "blue",   "name": "Ligne 5 – Bleue",  "relations": [270255],             "color": "#0083CA"},
    {"id": "rem",    "name": "REM",              "relations": [19668643, 19668926], "color": "#84BD00"},
]

MIN_SPACING_M = 15
TRACK_ROLES = {"", "forward", "backward"}

# Earth draws on satellite imagery, so lines are more opaque than the 0.55 spec
# (which assumes a light basemap); My Maps keeps the spec value.
VARIANTS = {
    "earth":  {"line_width": 5, "line_opacity": 0.85, "icon_scale": 0.55},
    "mymaps": {"line_width": 5, "line_opacity": 0.55, "icon_scale": 0.5},
}


def fetch():
    ids = ",".join(str(r) for line in LINES for r in line["relations"])
    query = f"""[out:json][timeout:120];
relation(id:{ids})->.r;
.r out geom;
node(r.r);
out body;"""
    req = urllib.request.Request(
        OVERPASS,
        data=urllib.parse.urlencode({"data": query}).encode(),
        headers={"User-Agent": "montreal-transit-kml/1.0"},
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        raw = json.load(resp)
    os.makedirs(DATA, exist_ok=True)
    with open(os.path.join(DATA, "osm_raw.json"), "w") as f:
        json.dump(raw, f)
    return raw


def dist_m(a, b):
    lat = math.radians((a[1] + b[1]) / 2)
    dx = math.radians(b[0] - a[0]) * math.cos(lat) * 6371000
    dy = math.radians(b[1] - a[1]) * 6371000
    return math.hypot(dx, dy)


def merge_chains(ways):
    """Greedily join ways that share endpoints into longer polylines."""
    chains = [list(w) for w in ways if len(w) >= 2]
    merged = True
    while merged:
        merged = False
        for i in range(len(chains)):
            for j in range(i + 1, len(chains)):
                a, b = chains[i], chains[j]
                if a[-1] == b[0]:
                    joined = a + b[1:]
                elif a[-1] == b[-1]:
                    joined = a + b[::-1][1:]
                elif a[0] == b[-1]:
                    joined = b + a[1:]
                elif a[0] == b[0]:
                    joined = b[::-1] + a[1:]
                else:
                    continue
                chains[i] = joined
                del chains[j]
                merged = True
                break
            if merged:
                break
    return chains


def bridge_gaps(chains, max_gap_m=300):
    """Join chains whose ends are close: OSM relations sometimes miss a short way."""
    chains = [list(c) for c in chains]
    joined = True
    while joined and len(chains) > 1:
        joined = False
        for i in range(len(chains)):
            for j in range(i + 1, len(chains)):
                a, b = chains[i], chains[j]
                options = [
                    (dist_m(a[-1], b[0]), lambda: a + b),
                    (dist_m(a[-1], b[-1]), lambda: a + b[::-1]),
                    (dist_m(a[0], b[-1]), lambda: b + a),
                    (dist_m(a[0], b[0]), lambda: b[::-1] + a),
                ]
                gap, make = min(options, key=lambda o: o[0])
                if gap <= max_gap_m:
                    chains[i] = make()
                    del chains[j]
                    joined = True
                    break
            if joined:
                break
    return chains


def simplify(chain):
    out = [chain[0]]
    for p in chain[1:-1]:
        if dist_m(out[-1], p) >= MIN_SPACING_M:
            out.append(p)
    out.append(chain[-1])
    return [[round(x, 5), round(y, 5)] for x, y in out]


def clean_name(name):
    for prefix in ("Station de métro ", "Station ", "Gare "):
        if name.startswith(prefix):
            name = name[len(prefix):]
    for suffix in (" Station", " station", " Subway", " (REM)", " REM"):
        if name.endswith(suffix):
            name = name[: -len(suffix)]
    return name.strip()


def build_data(raw):
    rels = {e["id"]: e for e in raw["elements"] if e["type"] == "relation"}
    nodes = {e["id"]: e for e in raw["elements"] if e["type"] == "node"}
    result = []
    for line in LINES:
        seen_ways, ways, stations, seen_names = set(), [], [], set()
        for rid in line["relations"]:
            rel = rels[rid]
            for m in rel["members"]:
                if m["type"] == "way" and m.get("role", "") in TRACK_ROLES and "geometry" in m:
                    if m["ref"] in seen_ways:
                        continue
                    seen_ways.add(m["ref"])
                    ways.append([(round(p["lon"], 7), round(p["lat"], 7)) for p in m["geometry"]])
                elif m["type"] == "node" and m.get("role", "").startswith("stop"):
                    n = nodes.get(m["ref"])
                    if not n:
                        continue
                    name = clean_name(n.get("tags", {}).get("name", ""))
                    if not name or name in seen_names:
                        continue
                    seen_names.add(name)
                    stations.append({"name": name, "lat": round(n["lat"], 5), "lon": round(n["lon"], 5)})
        segments = [simplify(c) for c in bridge_gaps(merge_chains(ways))]
        result.append({
            "id": line["id"], "name": line["name"], "kind": "metro",
            "color": line["color"], "segments": segments, "stations": stations,
        })
        print(f"{line['name']:<18} {len(segments):>3} segments, {len(stations):>3} stations")
    return result


def kml_color(hex_rgb, opacity):
    r, g, b = hex_rgb[1:3], hex_rgb[3:5], hex_rgb[5:7]
    return f"{round(opacity * 255):02x}{b}{g}{r}".lower()


def ring_png(hex_rgb, size=64, ring=0.22):
    """White disc with a coloured ring, anti-aliased, RGBA PNG."""
    cr, cg, cb = (int(hex_rgb[i:i + 2], 16) for i in (1, 3, 5))
    c = (size - 1) / 2
    r_out = size / 2 - 1
    r_in = r_out * (1 - ring)
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            d = math.hypot(x - c, y - c)
            a_out = max(0.0, min(1.0, r_out - d + 0.5))
            t_in = max(0.0, min(1.0, r_in - d + 0.5))
            r = round(255 * t_in + cr * (1 - t_in))
            g = round(255 * t_in + cg * (1 - t_in))
            b = round(255 * t_in + cb * (1 - t_in))
            row += bytes([r, g, b, round(255 * a_out)])
        rows.append(bytes(row))

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b""))


def build_kml(data, variant, icon_href=None):
    v = VARIANTS[variant]
    out = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<kml xmlns="http://www.opengis.net/kml/2.2">',
           "<Document>",
           "<name>Montréal – Métro + REM</name>",
           "<description>STM Metro lines 1, 2, 4, 5 and the REM. Data © OpenStreetMap contributors (ODbL).</description>"]
    for line in data:
        icon = icon_href(line) if icon_href else "http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png"
        icon_color = "" if icon_href else f"<color>{kml_color(line['color'], 1)}</color>"
        out.append(f"""<Style id="line-{line['id']}">
  <LineStyle><color>{kml_color(line['color'], v['line_opacity'])}</color><width>{v['line_width']}</width></LineStyle>
</Style>
<Style id="stn-{line['id']}">
  <IconStyle>{icon_color}<scale>{v['icon_scale']}</scale><Icon><href>{icon}</href></Icon><hotSpot x="0.5" y="0.5" xunits="fraction" yunits="fraction"/></IconStyle>
  <LabelStyle><scale>0</scale></LabelStyle>
</Style>""")

    for line in data:
        out.append(f"<Folder><name>{escape(line['name'])}</name>")
        out.append(f"<Placemark><name>{escape(line['name'])}</name><styleUrl>#line-{line['id']}</styleUrl><MultiGeometry>")
        for seg in line["segments"]:
            coords = " ".join(f"{x},{y}" for x, y in seg)
            out.append(f"<LineString><tessellate>1</tessellate><altitudeMode>clampToGround</altitudeMode><coordinates>{coords}</coordinates></LineString>")
        out.append("</MultiGeometry></Placemark>")
        for s in line["stations"]:
            out.append(f"<Placemark><name>{escape(s['name'])}</name><description>{escape(line['name'])}</description>"
                       f"<styleUrl>#stn-{line['id']}</styleUrl><Point><coordinates>{s['lon']},{s['lat']}</coordinates></Point></Placemark>")
        out.append("</Folder>")
    out += ["</Document>", "</kml>"]
    return "\n".join(out)


def main():
    if "--offline" in sys.argv:
        with open(os.path.join(DATA, "osm_raw.json")) as f:
            raw = json.load(f)
    else:
        raw = fetch()
    data = build_data(raw)
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(DATA, "transit.js"), "w") as f:
        f.write("window.TRANSIT = " + json.dumps(data, ensure_ascii=False) + ";\n")

    kmz_path = os.path.join(OUT, "Montreal-Metro-REM-Earth.kmz")
    with zipfile.ZipFile(kmz_path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("doc.kml", build_kml(data, "earth", lambda l: f"icons/{l['id']}.png"))
        for line in data:
            z.writestr(f"icons/{line['id']}.png", ring_png(line["color"]))

    kml_path = os.path.join(OUT, "Montreal-Metro-REM-MyMaps.kml")
    with open(kml_path, "w", encoding="utf-8") as f:
        f.write(build_kml(data, "mymaps"))
    print("wrote", kmz_path)
    print("wrote", kml_path)


if __name__ == "__main__":
    main()
