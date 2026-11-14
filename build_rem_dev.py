"""Merge research/*.json into data/rem-dev.js, attaching coordinates from data/transit.js."""

import glob
import json
import os
import re
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))

# Station order for prev/next navigation, grouped by branch.
ORDER = [
    ("Rive-Sud", ["Brossard", "Du Quartier", "Panama", "Île-des-Sœurs"]),
    ("Centre-ville", ["Centrale", "McGill", "Édouard-Montpetit", "Canora", "Ville-de-Mont-Royal"]),
    ("Saint-Laurent", ["Côte-de-Liesse", "Montpellier", "Du Ruisseau", "Bois-Franc"]),
    ("Deux-Montagnes", ["Sunnybrooke", "Pierrefonds-Roxboro", "Île-Bigras", "Sainte-Dorothée",
                        "Grand-Moulin", "Deux-Montagnes"]),
    ("Anse-à-l'Orme", ["Des Sources", "Fairview–Pointe-Claire", "Kirkland", "Anse-à-l'Orme"]),
    ("Aéroport", ["Marie-Curie"]),
]
ALIASES = {"garecentrale": "centrale"}
OVERRIDES = {
    "Marie-Curie": {"opened": None, "opening": "Opening targeted for late 2027"},
}


def norm(name):
    s = name.replace("œ", "oe").replace("Œ", "Oe")
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"[^a-z0-9]", "", s)
    return ALIASES.get(s, s)


def slug(name):
    s = name.replace("œ", "oe")
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


def main():
    with open(os.path.join(HERE, "data", "transit.js"), encoding="utf-8") as f:
        src = f.read()
    transit = json.loads(src[src.index("["): src.rindex("]") + 1])
    rem = next(l for l in transit if l["id"] == "rem")
    coords = {norm(s["name"]): (s["lat"], s["lon"]) for s in rem["stations"]}

    research = {}
    for path in sorted(glob.glob(os.path.join(HERE, "research", "group-*.json"))):
        with open(path, encoding="utf-8") as f:
            for entry in json.load(f):
                research[norm(entry["station"])] = entry

    stations, missing = [], []
    for branch, names in ORDER:
        for name in names:
            key = norm(name)
            r = research.get(key, {})
            lat, lon = coords.get(key, (r.get("lat"), r.get("lon")))
            if lat is None:
                missing.append(name)
                continue
            if not r:
                print("no research for", name)
            stations.append({
                "id": slug(name),
                "station": name,
                "branch": branch,
                "area": r.get("area"),
                "opened": r.get("opened"),
                "opening": r.get("opening"),
                "summary": r.get("summary"),
                "activity": r.get("activity", "low"),
                "stats": r.get("stats", []),
                "projects": r.get("projects", []),
                "plans": r.get("plans", []),
                "notes": r.get("notes"),
                "lat": lat,
                "lon": lon,
            })
            stations[-1].update(OVERRIDES.get(name, {}))

    extra = set(research) - {norm(n) for _, names in ORDER for n in names}
    if extra:
        print("research entries not in ORDER:", sorted(extra))
    if missing:
        print("skipped (no coordinates):", missing)

    out = {"stations": stations}
    with open(os.path.join(HERE, "data", "rem-dev.js"), "w", encoding="utf-8") as f:
        f.write("window.REM_DEV = " + json.dumps(out, ensure_ascii=False, indent=1) + ";\n")
    print(f"wrote data/rem-dev.js with {len(stations)} stations")


if __name__ == "__main__":
    main()
