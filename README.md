# Binder

Web para coleccionistas de TCG: marca las cartas que tienes, mira cuánto cuesta completar cada set y exporta tu lista de faltantes.

🌐 https://binderapptcg.netlify.app · App: https://binderapptcg.netlify.app/app/

- `landing/` — la web publicada (landing + app en `landing/app/`). Se sube a Netlify.
- `landing/app/data/onepiece/` — datos y precios de One Piece, regenerados cada día.
- `tools/build_onepiece.py` — script que genera esos datos (optcgapi.com + precios públicos de Cardmarket).
- `.github/workflows/actualizar-precios.yml` — ejecuta el script cada día y guarda el resultado aquí.

Pokémon no necesita datos propios: la app consulta la API de TCGdex en vivo.
