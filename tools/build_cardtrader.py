"""Genera los datos del optimizador de compra (CardTrader) para One Piece.

Para cada set de Binder escribe landing/app/data/cardtrader/onepiece/<set>.json con:
  - las ofertas más baratas de cada carta (Near Mint o mejor, en inglés, sin firmar ni alterar),
  - los vendedores de esas ofertas (anónimos: solo país, si admiten CardTrader Zero y sus tarifas de envío a nuestro país).

Las cartas se emparejan por el ID de Cardmarket, que CardTrader incluye en cada blueprint.
Precios y envíos son los que ve la cuenta dueña del token (comprador en España).

Uso: CARDTRADER_TOKEN=... python -I tools/build_cardtrader.py
"""
import json
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

API = "https://api.cardtrader.com/api/v2"
TOKEN = os.environ.get("CARDTRADER_TOKEN", "").strip()
ROOT = Path(__file__).resolve().parent.parent
BINDER_DATA = ROOT / "landing" / "app" / "data" / "onepiece"
OUT = ROOT / "landing" / "app" / "data" / "cardtrader" / "onepiece"

ONE_PIECE = 15
LANGUAGES = {"en"}
CONDITIONS = {"Mint", "Near Mint"}
OFFERS_PER_CARD = 8
MAX_METHODS = 4
# CardTrader Zero a España (hub → casa, Amazon Shipping hasta 5 kg). Fuente: cardtrader.com/es/shipping_methods/zero
ZERO_SHIPPING_CENTS = 1490


def get(path, **params):
    url = API + path + ("?" + urllib.parse.urlencode(params) if params else "")
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {TOKEN}", "User-Agent": "Binder/0.1 (+https://binderapptcg.netlify.app)"})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 4:
                time.sleep(2 + attempt * 3)
                continue
            raise


class RateLimiter:
    def __init__(self, per_second):
        self.interval = 1 / per_second
        self.next = time.monotonic()
        self.lock = threading.Lock()

    def wait(self):
        with self.lock:
            now = time.monotonic()
            delay = self.next - now
            self.next = max(now, self.next) + self.interval
        if delay > 0:
            time.sleep(delay)


def offer_ok(o):
    p = o.get("properties_hash") or {}
    return (
        not o.get("graded")
        and not o.get("on_vacation")
        and (o.get("quantity") or 0) > 0
        and p.get("condition") in CONDITIONS
        and p.get("onepiece_language", "en") in LANGUAGES
        and not p.get("signed")
        and not p.get("altered")
    )


def compact_methods(methods):
    """Se queda con los métodos más baratos: tramos de peso, umbrales de envío gratis y máximo de carrito."""
    out = []
    for m in methods:
        tiers = [[c["from_grams"], c["to_grams"], c["price"]["cents"]] for c in m.get("shipping_method_costs") or []]
        if not tiers:
            continue
        out.append({
            "t": tiers,
            "fq": m.get("free_shipping_threshold_quantity"),
            "fp": (m.get("free_shipping_threshold_price") or {}).get("cents"),
            "max": (m.get("max_cart_subtotal_price") or {}).get("cents"),
            "trk": bool(m.get("tracked")),
            "d": m.get("max_estimate_shipping_days"),
        })
    out.sort(key=lambda m: min(t[2] for t in m["t"]))
    return out[:MAX_METHODS]


def main():
    if not TOKEN:
        print("Sin CARDTRADER_TOKEN: se omite CardTrader.")
        return
    sets = json.loads((BINDER_DATA / "sets.json").read_text(encoding="utf-8"))["sets"]

    # 1) Blueprints de todas las expansiones de One Piece → mapa idProduct de Cardmarket → blueprint
    expansions = [e for e in get("/expansions") if e.get("game_id") == ONE_PIECE]
    cm_to_bp, bp_expansion = {}, {}
    for e in expansions:
        for b in get("/blueprints/export", expansion_id=e["id"]):
            for cm in b.get("card_market_ids") or []:
                cm_to_bp.setdefault(cm, b["id"])
            bp_expansion[b["id"]] = e["id"]
        time.sleep(0.05)
    print(f"{len(expansions)} expansiones, {len(cm_to_bp)} IDs de Cardmarket emparejados")

    # 2) Qué blueprints necesitamos y de qué expansiones
    wanted = {}  # blueprint -> [binder card ids]
    per_set = {}
    for s in sets:
        data = json.loads((BINDER_DATA / f"{s['id']}.json").read_text(encoding="utf-8"))
        cards = {}
        for c in data["cards"]:
            bp = cm_to_bp.get(c.get("idProduct"))
            if bp:
                cards[c["id"]] = bp
                wanted.setdefault(bp, []).append(c["id"])
        per_set[s["id"]] = cards
    exp_needed = sorted({bp_expansion[bp] for bp in wanted})

    # 3) Ofertas del marketplace (una llamada por expansión, máx. 10/s)
    offers = {}
    for exp_id in exp_needed:
        market = get("/marketplace/products", expansion_id=exp_id)
        for bp, items in market.items():
            bp = int(bp)
            if bp not in wanted:
                continue
            good = sorted((o for o in items if offer_ok(o)), key=lambda o: o["price"]["cents"])
            offers[bp] = good[:OFFERS_PER_CARD]
        time.sleep(0.15)
    print(f"Ofertas para {len(offers)} de {len(wanted)} cartas")

    # 4) Métodos de envío de cada vendedor hacia nuestro país (máx. 200 llamadas / 10 s)
    sellers = {}
    for items in offers.values():
        for o in items:
            u = o["user"]
            sellers.setdefault(u["id"], u)
    def fetch_shipping(item):
        sid, u = item
        limiter.wait()
        try:
            return sid, compact_methods(get("/shipping_methods", username=u["username"]))
        except Exception:  # vendedor sin envíos a nuestro país, etc.
            return sid, []

    limiter = RateLimiter(per_second=15)   # límite de la API: 200 llamadas cada 10 s
    with ThreadPoolExecutor(max_workers=8) as pool:
        shipping = dict(pool.map(fetch_shipping, sellers.items()))
    print(f"{len(sellers)} vendedores con tarifas de envío")

    # 5) Vendedores anónimos en un archivo común (índice global) y un archivo de ofertas por set,
    #    para que el carrito pueda combinar cartas de varios sets con los mismos vendedores.
    OUT.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc).isoformat(timespec="minutes")
    idx, seller_list = {}, []
    for set_id, cards in per_set.items():
        out_offers = {}
        for card_id, bp in cards.items():
            rows = []
            for o in offers.get(bp, []):
                sid = o["user"]["id"]
                if not shipping.get(sid) and not o["user"].get("can_sell_via_hub"):
                    continue
                if sid not in idx:
                    idx[sid] = len(seller_list)
                    u = sellers[sid]
                    seller_list.append({
                        "c": u.get("country_code"),
                        "z": bool(u.get("can_sell_via_hub")),
                        "pro": u.get("user_type") == "pro",
                        "m": shipping.get(sid, []),
                    })
                rows.append([o["price"]["cents"], idx[sid], o.get("quantity") or 1])
            if rows:
                out_offers[card_id] = {"bp": bp, "o": rows}
        payload = {"updated": now, "cards": out_offers}
        (OUT / f"{set_id}.json").write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(f"  {set_id:12} {len(out_offers):4} cartas con oferta")
    common = {"updated": now, "currency": "EUR", "zeroShipping": ZERO_SHIPPING_CENTS,
              "languages": sorted(LANGUAGES), "sellers": seller_list}
    (OUT / "sellers.json").write_text(json.dumps(common, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(seller_list)} vendedores en sellers.json")


if __name__ == "__main__":
    try:
        main()
    except urllib.error.HTTPError as e:
        sys.exit(f"Error de la API de CardTrader: {e.code} {e.reason}")
