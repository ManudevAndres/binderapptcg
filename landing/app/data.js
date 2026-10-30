// Binder — acceso a datos de cartas y precios.
// Pokémon: cartas y precios de Cardmarket en vivo desde la API pública de TCGdex (https://tcgdex.dev).
// One Piece: datos en data/onepiece/ generados a diario por tools/build_onepiece.py
//            (catálogo de optcgapi.com + precios públicos diarios de Cardmarket).
// CardTrader: ofertas y envíos en data/cardtrader/ generados a diario por tools/build_cardtrader.py.

const DAY = 24 * 60 * 60 * 1000;
const PRICE_TTL = DAY;
const SET_TTL = 7 * DAY;
const TCGDEX = "https://api.tcgdex.net/v2/es";
// Copia de data/ que GitHub Actions actualiza a diario. Vacío = usar solo la copia publicada.
const DATA_REMOTE = "https://raw.githubusercontent.com/ManudevAndres/binderapptcg/main/landing/app/data/";
const DATA_LOCAL = "data/";

const $ = (id) => document.getElementById(id);
const eur = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" });
const fmt = (n) => (n == null ? "–" : eur.format(n));

const ic = (name) => `<svg class="i" aria-hidden="true"><use href="#i-${name}"/></svg>`;

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

// ---------- Almacenamiento local ----------
const store = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem("binder:" + key);
      return v == null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem("binder:" + key, JSON.stringify(value)); } catch { /* lleno o bloqueado */ }
  },
  remove(key) {
    try { localStorage.removeItem("binder:" + key); } catch { /* nada */ }
  },
  keys(prefix) {
    try { return Object.keys(localStorage).filter((k) => k.startsWith("binder:" + prefix)).map((k) => k.slice(7)); }
    catch { return []; }
  },
};

function cached(key, ttl) {
  const hit = store.get(key);
  return hit && Date.now() - hit.t < ttl ? hit.v : null;
}

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(res.status + " " + url);
  return res.json();
}

// Datos generados a diario: primero la copia de GitHub; si falla, la que va con la web.
const dailyCache = new Map();
function dailyData(path) {
  if (!dailyCache.has(path)) {
    const p = (async () => {
      if (DATA_REMOTE) {
        try { return await getJSON(DATA_REMOTE + path); } catch { /* sigue con la local */ }
      }
      return getJSON(DATA_LOCAL + path);
    })();
    p.catch(() => dailyCache.delete(path));
    dailyCache.set(path, p);
  }
  return dailyCache.get(path);
}

// ---------- Juegos ----------
// Cada juego sabe listar sus sets, cargar un set y (si hace falta) pedir el precio de una carta.
// Set: { id, name, logo, meta, cards: [{ id, n, name, img, big, imgFallback, price?, idProduct? }] }
const isPocket = (id) => /^(A\d|B\d|P-A)/i.test(id);   // TCG Pocket (juego de móvil), fuera

const GAMES = {
  pokemon: {
    name: "Pokémon",
    cardmarket: "Pokemon",
    async sets() {
      let sets = cached("sets:pokemon", DAY);
      if (!sets) {
        const raw = await getJSON(TCGDEX + "/sets");
        sets = raw
          .filter((s) => !isPocket(s.id) && (s.cardCount?.total || 0) > 0)
          .reverse()
          .map((s) => ({ id: s.id, name: s.name, logo: s.logo ? s.logo + ".png" : null, total: s.cardCount.total }));
        store.set("sets:pokemon", { t: Date.now(), v: sets });
      }
      return sets;
    },
    async set(id) {
      let data = cached("set:pokemon:" + id, SET_TTL);
      if (!data || !data.cards[0]?.big) {
        const raw = await getJSON(TCGDEX + "/sets/" + encodeURIComponent(id));
        data = {
          id: raw.id, name: raw.name, logo: raw.logo ? raw.logo + ".png" : null,
          meta: [raw.serie?.name, raw.releaseDate && new Date(raw.releaseDate).getFullYear()],
          cards: raw.cards.map((c) => ({
            id: c.id, n: c.localId, name: c.name,
            img: c.image ? c.image + "/low.webp" : null,
            big: c.image ? c.image + "/high.webp" : null,
            imgFallback: c.image ? c.image.replace("/es/", "/en/") + "/low.webp" : null,
          })),
        };
        store.set("set:pokemon:" + id, { t: Date.now(), v: data });
      }
      return data;
    },
    async price(cardId) {
      const hit = cached("p2:" + cardId, PRICE_TTL);
      if (hit !== null) return hit;
      try {
        const card = await getJSON(TCGDEX + "/cards/" + encodeURIComponent(cardId));
        const cm = card.pricing?.cardmarket;
        const v = cm
          ? { price: cm.trend ?? cm.avg30 ?? cm.avg ?? null, idProduct: cm.idProduct ?? null, p7: cm.avg7 ?? null, p30: cm.avg30 ?? null }
          : { price: null, idProduct: null };
        store.set("p2:" + cardId, { t: Date.now(), v });
        return v;
      } catch {
        return { price: null, idProduct: null };
      }
    },
    hasCardTrader: true,   // de momento solo Escarlata y Púrpura y Megaevolución
  },

  onepiece: {
    name: "One Piece",
    cardmarket: "OnePiece",
    async sets() {
      const idx = await dailyData("onepiece/sets.json");
      this.pricesDate = idx.pricesCreatedAt;
      return idx.sets.map((s) => ({ id: s.id, name: s.name, code: s.id.replace(/-EB\d+$/, ""), logo: null, total: s.total }));
    },
    async set(id) {
      if (!this.pricesDate) await this.sets().catch(() => {});   // para mostrar la fecha de los precios
      const raw = await dailyData("onepiece/" + encodeURIComponent(id) + ".json");
      const parallels = raw.cards.filter((c) => c.parallel).length;
      return {
        id: raw.id, name: raw.name, logo: null,
        meta: ["One Piece Card Game", parallels ? `incluye ${parallels} paralelas` : null],
        // Imagen limpia de CardTrader si la hay; la de optcgapi (con marca "SAMPLE") solo como respaldo
        cards: raw.cards.map((c) => (c.ctimg
          ? { ...c, img: "https://cardtrader.com" + c.ctimg.replace(/\/([^/]+)$/, "/preview_$1"), big: "https://cardtrader.com" + c.ctimg, imgFallback: c.image }
          : { ...c, img: c.image, big: c.image, imgFallback: null })),
      };
    },
    price: null,   // los precios ya vienen en los datos del set
    hasCardTrader: true,
  },
};

// Ofertas de CardTrader de varios sets y juegos juntas (vendedores comunes en sellers.json).
// sets = [{ g, s }]
async function cardTraderData(sets) {
  const common = await dailyData("cardtrader/sellers.json");
  const cards = {};
  const seen = new Set();
  for (const { g, s } of sets) {
    if (!GAMES[g]?.hasCardTrader || seen.has(g + "|" + s)) continue;
    seen.add(g + "|" + s);
    try { Object.assign(cards, (await dailyData(`cardtrader/${g}/${encodeURIComponent(s)}.json`)).cards); }
    catch { /* set sin datos todavía */ }
  }
  return { ...common, cards };
}

// Idiomas en los filtros de Cardmarket
const CM_LANG = { en: 1, fr: 2, de: 3, es: 4, it: 5, "zh-CN": 6, jp: 7, pt: 8, ru: 9, kr: 10 };

// Enlace a la carta concreta en Cardmarket (por su idProduct), filtrando idioma y Near Mint o mejor.
// Sin idProduct, búsqueda por nombre y número.
function cardmarketUrl(card, game, lang = null) {
  const base = `https://www.cardmarket.com/es/${GAMES[game].cardmarket}`;
  const filters = new URLSearchParams({ minCondition: "2" });
  if (lang && CM_LANG[lang]) filters.set("language", CM_LANG[lang]);
  if (card.idProduct) return `${base}/Products?idProduct=${card.idProduct}&${filters}`;
  const q = card.code ? `${card.name} ${card.code}` : `${card.name} ${card.n || ""}`.trim();
  return `${base}/Products/Search?searchString=${encodeURIComponent(q)}`;
}
const cardTraderUrl = (bp) => `https://www.cardtrader.com/es/cards/${bp}`;
