"""Exploración de la API de CardTrader (solo lectura).

Imprime la estructura de los datos que necesita el optimizador: juegos, expansiones, blueprints,
ofertas del marketplace y métodos de envío. No imprime el token ni nombres de vendedores
(los logs de Actions de un repo público son visibles para cualquiera).

Uso: CARDTRADER_TOKEN=... python -I tools/cardtrader_explore.py
"""
import json
import os
import sys
import urllib.parse
import urllib.request

API = "https://api.cardtrader.com/api/v2"
TOKEN = os.environ.get("CARDTRADER_TOKEN", "").strip()


def get(path, **params):
    url = API + path + ("?" + urllib.parse.urlencode(params) if params else "")
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {TOKEN}", "User-Agent": "Binder/0.1"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def show(title, obj, limit=1500):
    print(f"\n=== {title} ===")
    print(json.dumps(obj, ensure_ascii=False, indent=1)[:limit])


def main():
    if not TOKEN:
        sys.exit("Falta CARDTRADER_TOKEN")
    info = get("/info")
    print("Autenticación OK. App:", info.get("name"), "| usuario id:", info.get("user_id"))

    games = get("/games")
    games = games.get("array", games)
    show("Juegos", [{"id": g["id"], "name": g["name"]} for g in games], 3000)
    by_name = {g["name"].lower(): g["id"] for g in games}
    op_id = next((v for k, v in by_name.items() if "one piece" in k), None)
    pk_id = next((v for k, v in by_name.items() if "pok" in k), None)
    print("One Piece game_id:", op_id, "| Pokémon game_id:", pk_id)

    expansions = get("/expansions")
    for gid, label in ((op_id, "One Piece"), (pk_id, "Pokémon")):
        exps = [e for e in expansions if e.get("game_id") == gid]
        print(f"\n{label}: {len(exps)} expansiones")
        show(f"Expansiones {label} (muestra)", [{"id": e["id"], "code": e["code"], "name": e["name"]} for e in exps[-40:]], 4000)

    op_exps = [e for e in expansions if e.get("game_id") == op_id]
    op01 = next((e for e in op_exps if "romance dawn" in e["name"].lower() and "op01" in e["code"].lower()), None) \
        or next((e for e in op_exps if "romance dawn" in e["name"].lower()), None)
    print("\nExpansión de prueba:", op01)
    if not op01:
        return

    bps = get("/blueprints/export", expansion_id=op01["id"])
    print(f"\nBlueprints en {op01['name']}: {len(bps)}")
    singles = [b for b in bps if "zoro" in b.get("name", "").lower()][:4] or bps[:4]
    show("Blueprints de ejemplo", singles, 5000)

    market = get("/marketplace/products", expansion_id=op01["id"])
    print(f"\nMarketplace: {len(market)} blueprints con ofertas; "
          f"{sum(len(v) for v in market.values())} ofertas en total")
    bp_id, offers = next(iter(market.items()))
    sample = []
    for o in offers[:3]:
        o = dict(o)
        user = dict(o.get("user", {}))
        user["username"] = "***"
        o["user"] = user
        sample.append(o)
    show(f"Ofertas de ejemplo (blueprint {bp_id})", sample, 5000)

    sellers = {o["user"]["username"]: o["user"] for v in market.values() for o in v}
    zero = sum(1 for u in sellers.values() if u.get("can_sell_via_hub"))
    countries = {}
    for u in sellers.values():
        countries[u.get("country_code")] = countries.get(u.get("country_code"), 0) + 1
    print(f"\nVendedores distintos: {len(sellers)} | con CardTrader Zero: {zero}")
    print("Por país:", dict(sorted(countries.items(), key=lambda x: -x[1])[:12]))

    username = next(iter(sellers))
    methods = get("/shipping_methods", username=username)
    show("Métodos de envío de un vendedor (anonimizado)", methods, 4000)


if __name__ == "__main__":
    main()
