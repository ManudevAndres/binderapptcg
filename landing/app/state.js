// Binder — datos del usuario: colección, listas personalizadas, carrito y preferencias.
// Cada perfil tiene sus propios datos: "invitado" (sin sesión, solo en este navegador) y uno por cuenta
// (copia local + nube, ver auth.js). Al entrar o salir se cambia de perfil; nunca se mezclan solos.
//
// owned: { cardId: { g, s, l } }           cartas que tengo (juego, set e idioma)
// meta:  { cardId: { g, s, sn, name, n, code, img, big, par, cm } }   datos para mostrarlas fuera de su set
// lists: [{ id, name, cards: [cardId], created }]
// cart:  { "cardId@idioma": cantidad }
// prefs: { lang: { pokemon: "es", onepiece: "en" } }   idioma por defecto de cada juego
// history: [{ d: "2026-10-29", v: valor €, n: cartas }]   una foto al día del valor de la colección
// alerts:  [{ id, card, l, below: €, created, hit: { price, at } | null }]   avisos de precio

const LANGS = {
  pokemon: ["es", "en", "fr", "de", "it", "pt"],   // las cartas japonesas son de sets distintos (catálogo aparte)
  onepiece: ["en", "jp", "fr"],
};
const LANG_NAMES = { es: "Español", en: "Inglés", fr: "Francés", de: "Alemán", it: "Italiano", pt: "Portugués", jp: "Japonés", kr: "Coreano", "zh-CN": "Chino" };
// País de la bandera de cada idioma (imágenes de flagcdn.com: Windows no pinta los emojis de banderas)
const LANG_CC = { es: "es", en: "gb", fr: "fr", de: "de", it: "it", pt: "pt", jp: "jp", kr: "kr", "zh-CN": "cn" };
const DEFAULT_LANG = { pokemon: "es", onepiece: "en" };

const State = (() => {
  let profile = "guest";
  let data = load(profile);
  const listeners = new Set();
  let saveTimer = null;

  function empty() {
    return { v: 3, owned: {}, meta: {}, lists: [], cart: {}, prefs: { lang: { ...DEFAULT_LANG } }, history: [], alerts: [], updated: 0 };
  }
  function keyOf(p) { return "state:" + p; }

  // Normaliza datos de versiones anteriores
  function upgrade(d) {
    if (!d) return empty();
    const out = { ...empty(), ...d, v: 3 };
    out.prefs = { lang: { ...DEFAULT_LANG, ...(d.prefs?.lang || {}) } };
    for (const [id, o] of Object.entries(out.owned)) if (!o.l) o.l = out.prefs.lang[o.g] || "en";
    const cart = {};
    for (const [k, q] of Object.entries(out.cart || {})) {
      if (k.includes("@")) cart[k] = q;
      else { const g = out.meta[k]?.g || "pokemon"; cart[k + "@" + (out.prefs.lang[g] || "en")] = q; }
    }
    out.cart = cart;
    return out;
  }

  function load(p) {
    const saved = store.get(keyOf(p));
    if (saved) return upgrade(saved);
    if (p === "guest") {
      const old = store.get("state");          // v2: un único estado sin perfiles
      if (old) { store.remove("state"); const d = upgrade(old); store.set(keyOf(p), d); return d; }
      return upgrade(migrateV1());
    }
    return empty();
  }

  // v1: "col:<set>" con los ids que tengo y "mysets" con el juego de cada set
  function migrateV1() {
    const d = empty();
    const mysets = store.get("mysets", {});
    for (const key of store.keys("col:")) {
      const s = key.slice(4);
      const g = mysets[s]?.game || (/^(OP|EB|PRB|ST)/.test(s) ? "onepiece" : "pokemon");
      for (const id of store.get(key, [])) {
        d.owned[id] = { g, s };
        d.meta[id] = { g, s, sn: mysets[s]?.name || s };
      }
      store.remove(key);
    }
    store.remove("mysets");
    return d;
  }

  function persist() { store.set(keyOf(profile), data); }
  function changed() {
    data.updated = Date.now();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 150);
    listeners.forEach((fn) => fn(data));
  }
  function swap(p, next) {
    clearTimeout(saveTimer);
    persist();
    profile = p;
    data = upgrade(next);
    persist();
    listeners.forEach((fn) => fn(data));
  }

  const listId = () => "l" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const cartKey = (id, l) => id + "@" + l;

  return {
    get data() { return data; },
    get profile() { return profile; },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    // Perfiles
    isEmpty: (d = data) => !Object.keys(d.owned).length && !d.lists.length && !Object.keys(d.cart).length,
    guestData: () => (profile === "guest" ? data : load("guest")),
    cachedAccount: (uid) => store.get(keyOf("u:" + uid)),
    useAccount(uid, accountData) { swap("u:" + uid, accountData || store.get(keyOf("u:" + uid))); },
    useGuest() { swap("guest", load("guest")); },
    clearGuest() { store.remove(keyOf("guest")); },
    snapshot: () => JSON.parse(JSON.stringify(data)),

    // Idioma
    lang: (g) => data.prefs.lang[g] || DEFAULT_LANG[g] || "en",
    setLang(g, l) { data.prefs.lang[g] = l; changed(); },

    // Guarda los datos de una carta para poder mostrarla en colección, listas y carrito.
    remember(card, g, set) {
      const m = data.meta[card.id] || {};
      data.meta[card.id] = {
        ...m, g, s: set.id, sn: set.name, name: card.name, n: card.n, code: card.code || null,
        img: card.img || null, big: card.big || card.img || null, par: !!card.parallel,
        cm: card.idProduct || m.cm || null,
      };
    },
    setCardmarketId(id, cm) { if (cm && data.meta[id] && data.meta[id].cm !== cm) { data.meta[id].cm = cm; changed(); } },

    // Colección
    has: (id) => !!data.owned[id],
    ownedLang: (id) => data.owned[id]?.l || null,
    setOwned(card, g, set, value, l = null) {
      this.remember(card, g, set);
      if (value) data.owned[card.id] = { g, s: set.id, l: l || data.owned[card.id]?.l || this.lang(g) };
      else delete data.owned[card.id];
      changed();
    },
    setManyOwned(cards, g, set, value) {
      for (const c of cards) {
        this.remember(c, g, set);
        if (value) data.owned[c.id] = { g, s: set.id, l: data.owned[c.id]?.l || this.lang(g) };
        else delete data.owned[c.id];
      }
      changed();
    },

    // Carrito (una línea por carta e idioma)
    cartQty: (id, l = null) => Object.entries(data.cart).reduce((n, [k, q]) => n + (k.split("@")[0] === id && (!l || k.endsWith("@" + l)) ? q : 0), 0),
    cartCount: () => Object.values(data.cart).reduce((a, b) => a + b, 0),
    addToCart(card, g, set, l, qty = 1) {
      if (set) this.remember(card, g, set);
      const k = cartKey(card.id, l || this.lang(g));
      data.cart[k] = Math.min(99, (data.cart[k] || 0) + qty);
      changed();
    },
    setCartQty(key, qty) {
      if (qty > 0) data.cart[key] = Math.min(99, qty); else delete data.cart[key];
      changed();
    },
    changeCartLang(key, l) {
      const [id] = key.split("@");
      const q = data.cart[key];
      delete data.cart[key];
      const k = cartKey(id, l);
      data.cart[k] = Math.min(99, (data.cart[k] || 0) + q);
      changed();
    },
    clearCart() { data.cart = {}; changed(); },

    // Listas personalizadas
    createList(name) {
      const l = { id: listId(), name: name.trim() || "Mi lista", cards: [], created: Date.now() };
      data.lists.push(l);
      changed();
      return l;
    },
    renameList(id, name) { const l = this.list(id); if (l && name.trim()) { l.name = name.trim(); changed(); } },
    deleteList(id) { data.lists = data.lists.filter((l) => l.id !== id); changed(); },
    list: (id) => data.lists.find((l) => l.id === id),
    inList: (listIdValue, cardId) => !!data.lists.find((l) => l.id === listIdValue)?.cards.includes(cardId),
    toggleInList(listIdValue, card, g, set) {
      const l = this.list(listIdValue);
      if (!l) return;
      if (set) this.remember(card, g, set);
      const i = l.cards.indexOf(card.id);
      if (i >= 0) l.cards.splice(i, 1); else l.cards.push(card.id);
      changed();
    },

    // Historial de valor (una entrada por día; la de hoy se actualiza)
    recordValue(v, n) {
      const d = new Date().toISOString().slice(0, 10);
      const last = data.history[data.history.length - 1];
      if (last?.d === d) { if (Math.abs(last.v - v) < 0.005 && last.n === n) return; last.v = v; last.n = n; }
      else data.history.push({ d, v, n });
      data.history = data.history.slice(-730);
      changed();
    },

    // Alertas de precio
    alertFor: (cardId, l) => data.alerts.find((a) => a.card === cardId && a.l === l),
    setAlert(card, g, set, l, below) {
      if (set) this.remember(card, g, set);
      const a = this.alertFor(card.id, l);
      if (a) { a.below = below; a.hit = null; }
      else data.alerts.push({ id: listId(), card: card.id, l, below, created: Date.now(), hit: null });
      changed();
    },
    removeAlert(id) { data.alerts = data.alerts.filter((a) => a.id !== id); changed(); },
    markAlert(id, price) {
      const a = data.alerts.find((x) => x.id === id);
      if (a && !a.hit) { a.hit = { price, at: Date.now() }; changed(); }
    },
    resetAlert(id) { const a = data.alerts.find((x) => x.id === id); if (a) { a.hit = null; changed(); } },

    // Une los datos de otro perfil (solo cuando el usuario lo pide)
    mergeFrom(other) {
      const o = upgrade(other);
      data.owned = { ...o.owned, ...data.owned };
      data.meta = { ...o.meta, ...data.meta };
      const lists = new Map(data.lists.map((l) => [l.id, l]));
      for (const l of o.lists) if (!lists.has(l.id)) lists.set(l.id, l);
      data.lists = [...lists.values()];
      for (const [k, q] of Object.entries(o.cart)) data.cart[k] = Math.min(99, (data.cart[k] || 0) + q);
      for (const a of o.alerts) if (!this.alertFor(a.card, a.l)) data.alerts.push(a);
      changed();
    },
  };
})();
