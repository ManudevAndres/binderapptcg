"""Genera los datos del optimizador de compra (CardTrader) para One Piece y Pokémon.

Escribe en landing/app/data/cardtrader/:
  - sellers.json            vendedores anónimos (país, si admiten CardTrader Zero y sus tarifas de envío a nuestro país),
                            comunes a todos los juegos para poder juntar cartas de varios juegos en un mismo envío;
  - <juego>/<set>.json      las ofertas más baratas de cada carta de Binder en cada idioma
                            (Near Mint o mejor, versión normal, sin firmar ni alterar).

Las cartas se emparejan por el ID de Cardmarket, que CardTrader incluye en cada blueprint:
  - One Piece: el ID viene en los datos de Binder (tools/build_onepiece.py);
  - Pokémon: se pide a TCGdex carta a carta y se guarda en pokemon/_cm_ids.json para no repetirlo cada día.
Precios y envíos son los que ve la cuenta dueña del token (comprador en España).

Uso: CARDTRADER_TOKEN=... python -I tools/build_cardtrader.py
"""
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

API = "https://api.cardtrader.com/api/v2"
TCGDEX = "https://api.tcgdex.net/v2/es"
TOKEN = os.environ.get("CARDTRADER_TOKEN", "").strip()
ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "landing" / "app" / "data"
OUT = DATA / "cardtrader"

CT_GAME = {"onepiece": 15, "pokemon": 5}
POKEMON_SERIES = ["sv", "me"]          # Escarlata y Púrpura + Megaevolución
# Idiomas que guardamos por juego (códigos de CardTrader)
LANGUAGES = {"pokemon": ["es", "en", "fr", "de", "it", "pt"], "onepiece": ["en", "jp", "fr"]}
CONDITIONS = {"Mint", "Near Mint"}
OFFERS_PER_LANG = 5
MAX_METHODS = 4
# Expansiones de CardTrader en otros idiomas: no tienen cartas que vendan en inglés
SKIP_EXPANSION = re.compile(r"japanese|korean|chinese|thai|indonesian|\bjp\b|\bkr\b|\bcn\b", re.I)
# CardTrader Zero a España (hub → casa, Amazon Shipping hasta 5 kg). Fuente: cardtrader.com/es/shipping_methods/zero
ZERO_SHIPPING_CENTS = 1490
UA = "Binder/0.1 (+https://binderapptcg.netlify.app)"


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


ct_limit = RateLimiter(per_second=15)       # límite de la API: 200 llamadas cada 10 s
market_limit = RateLimiter(per_second=5)    # marketplace: máx. 10 por segundo


def fetch(url, headers=None):
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code in (429, 502, 503) and attempt < 4:
                time.sleep(2 + attempt * 3)
                continue
            raise


def ct(path, limiter=ct_limit, **params):
    limiter.wait()
    url = API + path + ("?" + urllib.parse.urlencode(params) if params else "")
    return fetch(url, {"Authorization": f"Bearer {TOKEN}"})


def pmap(fn, items, workers=8):
    with ThreadPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(fn, items))


# ---------- Cartas de Binder por juego: { set_id: { card_id: idProduct de Cardmarket } } ----------

def onepiece_cards():
    folder = DATA / "onepiece"
    sets = json.loads((folder / "sets.json").read_text(encoding="utf-8"))["sets"]
    out = {}
    for s in sets:
        data = json.loads((folder / f"{s['id']}.json").read_text(encoding="utf-8"))
        # Todas las cartas: las que no casen por ID de Cardmarket se intentan por número de colección
        out[s["id"]] = {c["id"]: c.get("idProduct") for c in data["cards"]}
    return out


def onepiece_collector(card_id):
    """EB01-001 → EB01-001; EB01-001_p1 → EB01-001a (así numera CardTrader las versiones alternativas)."""
    m = re.match(r"^(.+?)(?:_p(\d+))?$", card_id)
    code, p = m.group(1), int(m.group(2) or 0)
    return code + ("" if not p else chr(ord("a") + p - 1))


def pokemon_cards():
    cache_path = OUT / "pokemon" / "_cm_ids.json"
    cache = json.loads(cache_path.read_text(encoding="utf-8")) if cache_path.exists() else {}
    set_ids = []
    for serie in POKEMON_SERIES:
        set_ids += [s["id"] for s in fetch(f"{TCGDEX}/series/{serie}").get("sets", [])]
    sets = dict(zip(set_ids, pmap(lambda sid: fetch(f"{TCGDEX}/sets/{urllib.parse.quote(sid)}"), set_ids)))

    todo = [c["id"] for s in sets.values() for c in s.get("cards", []) if not cache.get(c["id"])]
    print(f"Pokémon: {len(sets)} sets, {len(todo)} cartas nuevas que buscar en TCGdex", flush=True)

    def cm_id(card_id):
        try:
            card = fetch(f"{TCGDEX}/cards/{urllib.parse.quote(card_id)}")
            return card_id, (card.get("pricing") or {}).get("cardmarket", {}).get("idProduct")
        except Exception:
            return card_id, None
    for card_id, cm in pmap(cm_id, todo, workers=16):
        if cm:
            cache[card_id] = cm
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(cache, separators=(",", ":"), sort_keys=True), encoding="utf-8")
    return {sid: {c["id"]: cache[c["id"]] for c in s.get("cards", []) if cache.get(c["id"])} for sid, s in sets.items()}


# ---------- Filtros y formato ----------

def offer_lang(o):
    p = o.get("properties_hash") or {}
    return next((v for k, v in p.items() if k.endswith("language")), "en")


def offer_ok(o):
    p = o.get("properties_hash") or {}
    if p.get("condition") not in CONDITIONS:
        return False
    if p.get("signed") or p.get("altered"):
        return False
    # Versión normal: fuera reverse holo y primeras ediciones
    if any(v for k, v in p.items() if ("reverse" in k or "first_edition" in k) and v is True):
        return False
    return not o.get("graded") and not o.get("on_vacation") and (o.get("quantity") or 0) > 0


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


# ---------- Proceso ----------

def offers_for_game(game, binder_sets, expansions):
    """Devuelve { set_id: { card_id: (blueprint, [ofertas]) } }."""
    exps = [e for e in expansions if e.get("game_id") == CT_GAME[game] and not SKIP_EXPANSION.search(e.get("name") or "")]
    wanted_cm = {cm for cards in binder_sets.values() for cm in cards.values() if cm}
    exp_code = {e["id"]: (e.get("code") or "").replace("-", "").lower() for e in exps}

    cm_to_bp, bp_exp, by_collector = {}, {}, {}

    def blueprints(e):
        try:
            return e["id"], ct("/blueprints/export", expansion_id=e["id"])
        except Exception:
            return e["id"], []
    for exp_id, bps in pmap(blueprints, exps):
        for b in bps:
            for cm in b.get("card_market_ids") or []:
                if cm in wanted_cm:
                    cm_to_bp.setdefault(cm, b["id"])
                    bp_exp[b["id"]] = exp_id
            cn = (b.get("fixed_properties") or {}).get("collector_number")
            if game == "onepiece" and cn:
                by_collector.setdefault(cn.upper(), []).append((exp_id, b["id"]))

    def bp_for(card_id, cm):
        if cm in cm_to_bp:
            return cm_to_bp[cm]
        if game != "onepiece":
            return None
        options = by_collector.get(onepiece_collector(card_id).upper(), [])
        prefix = card_id.split("-")[0].lower()           # p. ej. "eb01": mejor la expansión original
        options = sorted(options, key=lambda x: not exp_code[x[0]].startswith(prefix))
        if options:
            bp_exp[options[0][1]] = options[0][0]
            return options[0][1]
        return None

    card_bp = {sid: {cid: bp for cid, cm in cards.items() if (bp := bp_for(cid, cm))} for sid, cards in binder_sets.items()}
    total = sum(len(c) for c in binder_sets.values())
    print(f"{game}: {len(exps)} expansiones revisadas, {sum(len(c) for c in card_bp.values())} de {total} cartas emparejadas", flush=True)

    needed = sorted({bp_exp[bp] for cards in card_bp.values() for bp in cards.values()})
    print(f"{game}: descargando ofertas de {len(needed)} expansiones…", flush=True)
    wanted_bp = {bp for cards in card_bp.values() for bp in cards.values()}
    offers, sample_props, langs_seen = {}, None, {}

    def market(exp_id):
        try:
            return ct("/marketplace/products", limiter=market_limit, expansion_id=exp_id)
        except Exception as e:
            print("  ! marketplace", exp_id, e)
            return {}
    for result in pmap(market, needed, workers=4):
        for bp, items in result.items():
            bp = int(bp)
            if bp not in wanted_bp:
                continue
            if sample_props is None and items:
                sample_props = sorted(items[0].get("properties_hash", {}).keys())
            by_lang = {}
            for o in sorted((o for o in items if offer_ok(o)), key=lambda o: o["price"]["cents"]):
                lang = offer_lang(o)
                langs_seen[lang] = langs_seen.get(lang, 0) + 1
                if lang in LANGUAGES[game] and len(by_lang.setdefault(lang, [])) < OFFERS_PER_LANG:
                    by_lang[lang].append(o)
            offers[bp] = by_lang
    print(f"{game}: propiedades de ejemplo de una oferta: {sample_props}")
    print(f"{game}: idiomas vistos en las ofertas: {dict(sorted(langs_seen.items(), key=lambda x: -x[1]))}")
    print(f"{game}: ofertas válidas para {sum(1 for v in offers.values() if v)} de {len(wanted_bp)} cartas")

    return {sid: {cid: (bp, offers.get(bp, {})) for cid, bp in cards.items()} for sid, cards in card_bp.items()}


def main():
    if not TOKEN:
        print("Sin CARDTRADER_TOKEN: se omite CardTrader.")
        return
    expansions = ct("/expansions")
    per_game = {
        "onepiece": offers_for_game("onepiece", onepiece_cards(), expansions),
        "pokemon": offers_for_game("pokemon", pokemon_cards(), expansions),
    }

    # Tarifas de envío de cada vendedor hacia nuestro país (una vez por vendedor, para todos los juegos)
    sellers = {}
    for sets in per_game.values():
        for cards in sets.values():
            for _, by_lang in cards.values():
                for items in by_lang.values():
                    for o in items:
                        sellers.setdefault(o["user"]["id"], o["user"])

    def fetch_shipping(item):
        sid, u = item
        try:
            return sid, compact_methods(ct("/shipping_methods", username=u["username"]))
        except Exception:  # vendedor sin envíos a nuestro país, etc.
            return sid, []
    print(f"Descargando tarifas de envío de {len(sellers)} vendedores…", flush=True)
    shipping = dict(pmap(fetch_shipping, list(sellers.items())))
    print(f"{len(sellers)} vendedores con tarifas de envío")

    # Vendedores anónimos con índice global; un archivo de ofertas por juego y set
    now = datetime.now(timezone.utc).isoformat(timespec="minutes")
    idx, seller_list = {}, []
    for game, sets in per_game.items():
        folder = OUT / game
        folder.mkdir(parents=True, exist_ok=True)
        for set_id, cards in sets.items():
            out_offers = {}
            for card_id, (bp, by_lang) in cards.items():
                rows_by_lang = {}
                for lang, items in by_lang.items():
                    rows = []
                    for o in items:
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
                        rows_by_lang[lang] = rows
                # bp siempre, aunque no haya ofertas: sirve para enlazar la carta en CardTrader
                out_offers[card_id] = {"bp": bp, "o": rows_by_lang}
            (folder / f"{set_id}.json").write_text(json.dumps({"updated": now, "cards": out_offers}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(f"{game}: {sum(1 for s in sets.values() for _ in s)} cartas en {len(sets)} sets")

    common = {"updated": now, "currency": "EUR", "zeroShipping": ZERO_SHIPPING_CENTS,
              "languages": LANGUAGES, "sellers": seller_list}
    (OUT / "sellers.json").write_text(json.dumps(common, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    old = OUT / "onepiece" / "sellers.json"   # formato anterior
    if old.exists():
        old.unlink()
    print(f"{len(seller_list)} vendedores en sellers.json")


if __name__ == "__main__":
    try:
        main()
    except urllib.error.HTTPError as e:
        sys.exit(f"Error de la API: {e.code} {e.reason} ({e.url})")
