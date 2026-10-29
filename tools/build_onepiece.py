"""Genera los datos de One Piece para Binder.

Junta el catálogo e imágenes de optcgapi.com con los precios diarios públicos de Cardmarket
y escribe un JSON por set en landing/app/data/onepiece/.

Uso:
    python -I tools/build_onepiece.py [carpeta_descargas]

Si no se pasa carpeta, descarga los archivos de Cardmarket a una carpeta temporal.
Pensado para ejecutarse una vez al día (más adelante, con GitHub Actions).
"""
import json
import re
import sys
import tempfile
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

CM_PRODUCTS = "https://downloads.s3.cardmarket.com/productCatalog/productList/products_singles_18.json"
CM_PRICES = "https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_18.json"
OPTCG = "https://optcgapi.com/api"
OUT = Path(__file__).resolve().parent.parent / "landing" / "app" / "data" / "onepiece"

CODE_RE = re.compile(r"\(([A-Z]{1,4}\d{0,2}-\d{3})\)")


def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Binder/0.1 (+https://comfy-selkie-06781b.netlify.app)"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode("utf-8"))


def load_cardmarket(folder):
    folder = Path(folder) if folder else Path(tempfile.mkdtemp(prefix="binder-cm-"))
    files = {}
    for name, url in (("op_products.json", CM_PRODUCTS), ("op_prices.json", CM_PRICES)):
        path = folder / name
        if not path.exists():
            print("Descargando", url)
            urllib.request.urlretrieve(url, path)
        files[name] = json.loads(path.read_text(encoding="utf-8"))
    return files["op_products.json"]["products"], files["op_prices.json"]


def index_cardmarket(products, price_guide):
    prices = {p["idProduct"]: p for p in price_guide["priceGuides"]}
    by_code = defaultdict(list)
    for p in products:
        m = CODE_RE.search(p["name"])
        if m:
            by_code[m.group(1)].append(p)
    # Expansión "de origen" de cada código = la del primer producto que se dio de alta con ese código.
    # Dentro de esa expansión, por orden de alta: normal, paralela 1, paralela 2…
    variants = {}
    for code, items in by_code.items():
        items.sort(key=lambda p: p["idProduct"])
        home = items[0]["idExpansion"]
        variants[code] = [p for p in items if p["idExpansion"] == home]
    return variants, prices


def price_of(entry):
    if not entry:
        return None
    for key in ("trend", "avg30", "avg"):
        v = entry.get(key)
        if v:
            return round(v, 2)
    return None


def main():
    products, price_guide = load_cardmarket(sys.argv[1] if len(sys.argv) > 1 else None)
    variants, prices = index_cardmarket(products, price_guide)
    OUT.mkdir(parents=True, exist_ok=True)

    sets = fetch_json(f"{OPTCG}/allSets/")
    index = []
    for order, s in enumerate(sets):
        sid = s["set_id"]
        try:
            raw = fetch_json(f"{OPTCG}/sets/{sid}/")
        except Exception as e:  # set sin cartas todavía o API caída
            print("  ! sin datos para", sid, e)
            continue
        cards, seen = [], set()
        for c in raw:
            img_id = c.get("card_image_id") or c["card_set_id"]
            if img_id in seen:
                continue
            seen.add(img_id)
            code = c["card_set_id"]
            m = re.search(r"_p(\d+)$", img_id)
            vidx = int(m.group(1)) if m else 0
            options = variants.get(code, [])
            cm = options[vidx] if vidx < len(options) else None
            cards.append({
                "id": img_id,
                "n": code.split("-", 1)[-1] + (f" P{vidx}" if vidx else ""),
                "code": code,
                "name": re.sub(r"\s*\(\d{3}\)", "", c["card_name"]).replace(" (Parallel)", ""),
                "rarity": c.get("rarity"),
                "parallel": bool(vidx),
                "image": c.get("card_image"),
                "price": price_of(prices.get(cm["idProduct"])) if cm else None,
                "idProduct": cm["idProduct"] if cm else None,
            })
        if not cards:
            continue
        cards.sort(key=lambda x: (x["code"], x["parallel"], x["id"]))
        meta = {"id": sid, "name": s["set_name"], "total": len(cards), "order": order}
        (OUT / f"{sid}.json").write_text(json.dumps({**meta, "cards": cards}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        priced = sum(1 for x in cards if x["price"] is not None)
        print(f"  {sid:12} {s['set_name'][:40]:40} {len(cards):4} cartas, {priced:4} con precio")
        index.append(meta)

    index.sort(key=lambda m: -m["order"])
    (OUT / "sets.json").write_text(json.dumps({
        "updated": datetime.now(timezone.utc).isoformat(timespec="minutes"),
        "pricesCreatedAt": price_guide.get("createdAt"),
        "sets": index,
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    print("Listo:", len(index), "sets en", OUT)


if __name__ == "__main__":
    main()
