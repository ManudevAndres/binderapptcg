// Binder — datos del usuario: colección, listas personalizadas y carrito.
// Se guardan en el navegador y, si hay sesión iniciada, también en la nube (ver auth.js).
//
// owned: { cardId: { g, s } }              cartas que tengo (juego y set)
// meta:  { cardId: { g, s, sn, name, n, code, img, big, par } }   datos para mostrarlas fuera de su set
// lists: [{ id, name, cards: [cardId], created }]
// cart:  { cardId: cantidad }

const State = (() => {
  const KEY = "state";
  let data = load();
  const listeners = new Set();
  let saveTimer = null;

  function empty() {
    return { v: 2, owned: {}, meta: {}, lists: [], cart: {}, updated: 0 };
  }

  function load() {
    const saved = store.get(KEY);
    if (saved?.v === 2) return { ...empty(), ...saved };
    return migrate();
  }

  // Versión anterior: "col:<set>" con los ids que tengo y "mysets" con el juego de cada set.
  function migrate() {
    const d = empty();
    const mysets = store.get("mysets", {});
    for (const key of store.keys("col:")) {
      const s = key.slice(4);
      const g = mysets[s]?.game || (/^(OP|EB|PRB|ST)/.test(s) ? "onepiece" : "pokemon");
      for (const id of store.get(key, [])) {
        d.owned[id] = { g, s };
        d.meta[id] = { g, s, sn: mysets[s]?.name || s };
      }
    }
    d.updated = Date.now();
    store.set(KEY, d);
    return d;
  }

  function changed() {
    data.updated = Date.now();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => store.set(KEY, data), 150);
    listeners.forEach((fn) => fn(data));
  }

  const listId = () => "l" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  return {
    get data() { return data; },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    // Guarda los datos de una carta para poder mostrarla en colección, listas y carrito.
    remember(card, g, set) {
      const m = data.meta[card.id] || {};
      data.meta[card.id] = {
        ...m, g, s: set.id, sn: set.name, name: card.name, n: card.n, code: card.code || null,
        img: card.img || null, big: card.big || card.img || null, par: !!card.parallel,
      };
    },

    has: (id) => !!data.owned[id],
    setOwned(card, g, set, value) {
      this.remember(card, g, set);
      if (value) data.owned[card.id] = { g, s: set.id }; else delete data.owned[card.id];
      changed();
    },
    setManyOwned(cards, g, set, value) {
      for (const c of cards) {
        this.remember(c, g, set);
        if (value) data.owned[c.id] = { g, s: set.id }; else delete data.owned[c.id];
      }
      changed();
    },

    // Carrito
    cartQty: (id) => data.cart[id] || 0,
    cartCount: () => Object.values(data.cart).reduce((a, b) => a + b, 0),
    addToCart(card, g, set, qty = 1) {
      if (set) this.remember(card, g, set);
      data.cart[card.id] = Math.min(99, (data.cart[card.id] || 0) + qty);
      changed();
    },
    setCartQty(id, qty) {
      if (qty > 0) data.cart[id] = Math.min(99, qty); else delete data.cart[id];
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

    // Sustituye todo (al traer los datos de la nube) o mezcla con lo local.
    replace(next) { data = { ...empty(), ...next, v: 2 }; store.set(KEY, data); listeners.forEach((fn) => fn(data)); },
    merge(remote) {
      const merged = empty();
      merged.owned = { ...remote.owned, ...data.owned };
      merged.meta = { ...remote.meta, ...data.meta };
      const lists = new Map((remote.lists || []).map((l) => [l.id, l]));
      for (const l of data.lists) lists.set(l.id, l);
      merged.lists = [...lists.values()];
      merged.cart = { ...remote.cart, ...data.cart };
      data = merged;
      changed();
    },
    snapshot: () => JSON.parse(JSON.stringify(data)),
  };
})();
