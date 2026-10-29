// Binder — interfaz: explorar sets, mi colección, listas, carrito y ficha de carta (lupa).
// Depende de data.js (GAMES, store, utilidades), state.js (State), optimizer.js y auth.js.

const CONCURRENCY = 6;

// ---------- Estado de la interfaz ----------
let gameId = store.get("game") || "pokemon";
let allSets = [];
let current = null;          // set abierto
let filter = "all";
let query = "";
let loadToken = 0;
const prices = new Map();    // cardId -> { price, idProduct } (precio de tendencia de Cardmarket)
const tiles = new Map();     // cardId -> { card, g, set } de las cartas que hay en pantalla
const game = () => GAMES[gameId];

// ---------- Utilidades ----------
const cents = (c) => fmt(c / 100);
const countryName = (() => {
  try { const dn = new Intl.DisplayNames(["es"], { type: "region" }); return (c) => (c ? dn.of(c) : "?"); }
  catch { return (c) => c || "?"; }
})();

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2200);
}

function priceLabel(p) {
  if (p === undefined) return `<span class="price">…</span>`;
  if (!p || p.price == null) return `<span class="price">sin precio</span>`;
  return `<span class="price${p.price >= 20 ? " hot" : ""}">${fmt(p.price)}</span>`;
}

const langName = (l) => LANG_NAMES[l] || l;
// Bandera del idioma como imagen (HTML)
const flag = (l) => LANG_CC[l]
  ? `<img class="flag-i" src="https://flagcdn.com/24x18/${LANG_CC[l]}.png" srcset="https://flagcdn.com/48x36/${LANG_CC[l]}.png 2x" width="18" height="13" alt="${langName(l)}" title="${langName(l)}">`
  : escapeHtml(l || "");

// Selector de idioma con banderas (botones)
function langPicker(g, value, attrs = "") {
  return `<span class="lang-pick" ${attrs}>${LANGS[g].map((l) =>
    `<button type="button" class="lp${l === value ? " on" : ""}" data-lang="${l}" title="${langName(l)}" aria-label="${langName(l)}" aria-pressed="${l === value}">${flag(l)}</button>`).join("")}</span>`;
}

// Carta con su idProduct de Cardmarket (para enlazar la carta exacta)
function withCm(card) {
  const cm = card.idProduct || prices.get(card.id)?.idProduct || State.data.meta[card.id]?.cm;
  if (cm && !State.data.meta[card.id]?.cm) State.setCardmarketId(card.id, cm);
  return cm ? { ...card, idProduct: cm } : card;
}

// Ofertas de CardTrader de una carta (para mostrar "desde X €" por idioma en la lupa)
async function cardTraderOffers(id, g, s) {
  try { return (await cardTraderData([{ g, s }])).cards[id] || null; } catch { return null; }
}

// Carta guardada en State.meta → objeto carta + set
function fromMeta(id) {
  const m = State.data.meta[id] || {};
  return {
    card: { id, name: m.name || id, n: m.n || "", code: m.code, img: m.img, big: m.big, parallel: m.par, idProduct: m.cm || null },
    g: m.g || State.data.owned[id]?.g || "pokemon",
    set: { id: m.s || State.data.owned[id]?.s, name: m.sn || m.s || "" },
  };
}

// Completa los datos de cartas que solo conocemos por id (p. ej. migradas de la versión anterior).
async function ensureMeta(ids) {
  const bySet = new Map();
  for (const id of ids) {
    const m = State.data.meta[id];
    if (m?.name && m?.img !== undefined) continue;
    const { g, set } = fromMeta(id);
    if (!set.id) continue;
    const k = g + "|" + set.id;
    if (!bySet.has(k)) bySet.set(k, { g, s: set.id, ids: [] });
    bySet.get(k).ids.push(id);
  }
  for (const { g, s, ids: list } of bySet.values()) {
    try {
      const data = await GAMES[g].set(s);
      for (const c of data.cards) if (list.includes(c.id)) State.remember(c, g, data);
    } catch { /* sin conexión */ }
  }
}

// Precio de una carta con datos incluidos (One Piece): tendencia + medias de 7 y 30 días
const priceOf = (c) => ({ price: c.price ?? null, idProduct: c.idProduct ?? null, p7: c.p7 ?? null, p30: c.p30 ?? null });

// Precios de cartas sueltas (colección, listas, carrito)
async function loadPricesFor(ids, onEach) {
  const queue = [];
  const opSets = new Map();
  for (const id of ids) {
    if (prices.has(id)) continue;
    const { g, set } = fromMeta(id);
    if (g === "onepiece") {
      if (!opSets.has(set.id)) opSets.set(set.id, []);
      opSets.get(set.id).push(id);
    } else queue.push(id);
  }
  for (const [s, list] of opSets) {
    try {
      const data = await GAMES.onepiece.set(s);
      for (const c of data.cards) if (list.includes(c.id)) { prices.set(c.id, priceOf(c)); onEach?.(c.id); }
    } catch { /* nada */ }
  }
  async function worker() {
    while (queue.length) {
      const id = queue.shift();
      prices.set(id, await GAMES.pokemon.price(id));
      onEach?.(id);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

// ---------- Tarjeta de carta ----------
// mode "toggle": tocar marca/desmarca "la tengo"; mode "open": tocar abre la lupa.
function cardTile(card, g, set, { mode = "toggle", sub = null } = {}) {
  tiles.set(card.id, { card, g, set });
  const has = State.has(card.id);
  const inCart = State.cartQty(card.id);
  const el = document.createElement("div");
  el.className = "c " + (has ? "have" : "miss") + (mode === "open" ? " open-mode" : "");
  el.dataset.id = card.id;
  el.innerHTML = `
    <div class="img-wrap">
      <button class="c-main" data-act="${mode}" aria-pressed="${has}" title="${mode === "toggle" ? (has ? "La tengo (toca para quitar)" : "Me falta (toca para marcar)") : "Ver carta"}">
        <div class="img">${card.img
          ? `<img loading="lazy" src="${card.img}" data-fallback="${card.imgFallback || ""}" alt="${escapeHtml(card.name)}">`
          : `<div class="noimg">${escapeHtml(card.name)}<br>#${escapeHtml(card.n)}</div>`}</div>
      </button>
      <span class="check" aria-hidden="true">✓</span>
      <span class="flag" title="${has ? langName(State.ownedLang(card.id)) : ""}">${has ? flag(State.ownedLang(card.id)) : ""}</span>
      ${card.parallel ? `<span class="tag">Paralela</span>` : ""}
      <div class="c-tools">
        <button class="tool" data-act="zoom" aria-label="Ver en grande" title="Ver en grande">🔍</button>
        <button class="tool${inCart ? " on" : ""}" data-act="cart" aria-label="Añadir al carrito" title="Añadir al carrito">🛒${inCart ? `<b>${inCart}</b>` : ""}</button>
      </div>
    </div>
    <div class="meta"><span class="name">${escapeHtml(card.name)}</span><span class="num">#${escapeHtml(card.code || card.n)}</span></div>
    ${sub ? `<div class="sub">${escapeHtml(sub)}</div>` : ""}
    ${priceLabel(prices.get(card.id))}`;
  const img = el.querySelector("img");
  if (img) img.onerror = () => {
    if (img.dataset.fallback) { img.src = img.dataset.fallback; img.dataset.fallback = ""; }
    else img.replaceWith(Object.assign(document.createElement("div"), { className: "noimg", textContent: card.name }));
  };
  return el;
}

function refreshTile(id) {
  document.querySelectorAll(`.c[data-id="${CSS.escape(id)}"]`).forEach((el) => {
    const has = State.has(id);
    el.classList.toggle("have", has);
    el.classList.toggle("miss", !has);
    el.querySelector(".c-main").setAttribute("aria-pressed", has);
    const fl = el.querySelector(".flag");
    fl.innerHTML = has ? flag(State.ownedLang(id)) : "";
    fl.title = has ? langName(State.ownedLang(id)) : "";
    const qty = State.cartQty(id);
    const cartBtn = el.querySelector('[data-act="cart"]');
    cartBtn.classList.toggle("on", qty > 0);
    cartBtn.innerHTML = "🛒" + (qty ? `<b>${qty}</b>` : "");
    const p = el.querySelector(".price");
    if (p) p.outerHTML = priceLabel(prices.get(id));
  });
}

// Un solo manejador para todas las cuadrículas
function gridClick(e, sequence) {
  const btn = e.target.closest("[data-act]");
  const el = e.target.closest(".c");
  if (!btn || !el) return;
  const t = tiles.get(el.dataset.id);
  if (!t) return;
  const act = btn.dataset.act;
  if (act === "toggle") {
    State.setOwned(t.card, t.g, t.set, !State.has(t.card.id));
    if ((filter === "have" && !State.has(t.card.id)) || (filter === "miss" && State.has(t.card.id))) el.remove();
    else refreshTile(t.card.id);
    if (current) updateSetStats();
  } else if (act === "cart") {
    const l = State.lang(t.g);
    State.addToCart(withCm(t.card), t.g, t.set, l);
    refreshTile(t.card.id);
    toast(`${t.card.name} (${langName(l).toLowerCase()}) añadida al carrito`);
  } else {
    openCard(t.card.id, sequence());
  }
}

// ---------- Lupa (ficha de carta) ----------
let modalSeq = [];
let modalId = null;
let modalLang = null;

function openCard(id, sequence = [id], lang = null) {
  modalSeq = sequence;
  modalId = id;
  modalLang = lang;
  renderModal();
  $("card-modal").hidden = false;
}

function renderModal() {
  const t = tiles.get(modalId) || fromMeta(modalId);
  const { g, set } = t;
  const card = withCm(t.card);
  const lang = modalLang || State.ownedLang(card.id) || State.lang(g);
  const big = card.big || card.img;
  $("cm-img").innerHTML = big
    ? `<img src="${big}" alt="${escapeHtml(card.name)}" data-fallback="${card.img || ""}">`
    : `<div class="noimg">${escapeHtml(card.name)}</div>`;
  const img = $("cm-img").querySelector("img");
  if (img) img.onerror = () => { if (img.dataset.fallback && img.src !== img.dataset.fallback) img.src = img.dataset.fallback; };
  $("cm-set").textContent = `${GAMES[g].name} · ${set.name || ""} · #${card.code || card.n}${card.parallel ? " · Paralela" : ""}`;
  $("cm-name").textContent = card.name;
  const p = prices.get(card.id);
  $("cm-price").innerHTML = p?.price != null
    ? `${fmt(p.price)} <small>tendencia Cardmarket (todos los idiomas)</small>`
    : `<small>Precio no disponible</small>`;
  if (!prices.has(card.id)) loadPricesFor([card.id], () => { if (modalId === card.id) renderModal(); });

  // Idioma: el de mi copia, o el que elija aquí (para marcarla o comprarla)
  $("cm-langs").innerHTML = LANGS[g].map((l) =>
    `<button class="chip-btn${l === lang ? " on" : ""}" data-lang="${l}" title="${langName(l)}">${flag(l)} ${langName(l)}</button>`).join("");
  $("cm-ct").innerHTML = "";
  $("cm-ct-add").hidden = true;
  const shownId = card.id;
  cardTraderOffers(card.id, g, set.id).then((ct) => {
    if (modalId !== shownId) return;
    const best = ct?.o?.[lang]?.[0];
    $("cm-ct").innerHTML = best
      ? `CardTrader en ${langName(lang).toLowerCase()}: desde <b>${cents(best[0])}</b> <a href="${cardTraderUrl(ct.bp)}" target="_blank" rel="noopener">ver ↗</a>`
      : ct ? `Sin ofertas en ${langName(lang).toLowerCase()} en CardTrader ahora mismo.` : "";
    if (ct?.bp) $("cm-links").innerHTML = links(ct.bp);
    const addBtn = $("cm-ct-add");
    addBtn.hidden = !ct?.bp;
    addBtn.dataset.bp = ct?.bp || "";
    addBtn.innerHTML = `⚡ Añadir a mi carrito de CardTrader ${flag(lang)}`;
  });

  const has = State.has(card.id);
  const ownLang = State.ownedLang(card.id);
  $("cm-owned").innerHTML = !has ? `Marcar que la tengo ${flag(lang)}` : ownLang === lang ? `✓ La tengo ${flag(lang)}` : `La tengo ${flag(ownLang)} · cambiar a ${flag(lang)}`;
  $("cm-owned").classList.toggle("on", has && ownLang === lang);
  const qty = State.cartQty(card.id, lang);
  $("cm-cart").innerHTML = qty ? `🛒 En el carrito (${qty}) ${flag(lang)} · añadir otra` : `🛒 Añadir al carrito ${flag(lang)}`;

  renderModalAlert(card, lang);

  const lists = State.data.lists;
  $("cm-lists").innerHTML = lists.map((l) =>
    `<button class="chip-btn${State.inList(l.id, card.id) ? " on" : ""}" data-list="${l.id}">${State.inList(l.id, card.id) ? "✓ " : "+ "}${escapeHtml(l.name)}</button>`
  ).join("") + `<button class="chip-btn new" data-list="__new">+ Nueva lista</button>`;

  const q = encodeURIComponent(`${card.name} ${card.code || card.n} ${set.name || ""}`.trim());
  const links = (bp) => `<span class="ml-title">Comprar ${flag(lang)}</span>
    <a href="${cardmarketUrl(card, g, lang)}" target="_blank" rel="noopener">Cardmarket ↗</a>`
    + (bp ? `<a href="${cardTraderUrl(bp)}" target="_blank" rel="noopener">CardTrader ↗</a>` : "")
    + `<a href="https://www.ebay.es/sch/i.html?_nkw=${q}" target="_blank" rel="noopener">eBay ↗</a>`
    + `<a href="https://es.wallapop.com/app/search?keywords=${q}" target="_blank" rel="noopener">Wallapop ↗</a>`;
  $("cm-links").innerHTML = links(null);

  const i = modalSeq.indexOf(modalId);
  $("cm-prev").hidden = i <= 0;
  $("cm-next").hidden = i < 0 || i >= modalSeq.length - 1;
}

function modalStep(d) {
  const i = modalSeq.indexOf(modalId) + d;
  if (i >= 0 && i < modalSeq.length) { modalId = modalSeq[i]; modalLang = null; renderModal(); }
}

function modalContext() {
  const t = tiles.get(modalId) || fromMeta(modalId);
  return { ...t, card: withCm(t.card), lang: modalLang || State.ownedLang(t.card.id) || State.lang(t.g) };
}

$("cm-owned").onclick = () => {
  const { card, g, set, lang } = modalContext();
  const has = State.has(card.id);
  if (has && State.ownedLang(card.id) === lang) State.setOwned(card, g, set, false);
  else State.setOwned(card, g, set, true, lang);
  refreshTile(card.id);
  if (current) updateSetStats();
  renderModal();
};
$("cm-cart").onclick = () => {
  const { card, g, set, lang } = modalContext();
  State.addToCart(card, g, set, lang);
  refreshTile(card.id);
  renderModal();
  toast(`Añadida al carrito (${langName(lang).toLowerCase()})`);
};
// Añadir al carrito real de CardTrader la mejor oferta calidad/precio (con el token del usuario)
function needCardTrader() {
  if (CardTraderAccount.connected()) return false;
  renderAccount();
  $("account-modal").hidden = false;
  toast("Conecta tu cuenta de CardTrader para añadir cartas a su carrito");
  return true;
}
function describeOffer(r) {
  return `${cents(r.price)} · vendedor de ${countryName(r.country)}${r.pro ? " (profesional)" : ""}${r.zero ? " · vía Zero" : ""}`;
}
$("cm-ct-add").onclick = async () => {
  if (needCardTrader()) return;
  const btn = $("cm-ct-add");
  const { card, lang } = modalContext();
  btn.disabled = true;
  btn.textContent = "Buscando la mejor oferta…";
  try {
    const r = await CardTraderAccount.addBest(Number(btn.dataset.bp), lang);
    if (r) toast(`${card.name} añadida a tu carrito de CardTrader: ${describeOffer(r)}`);
    else toast(`No hay ofertas de ${card.name} en ${langName(lang).toLowerCase()} ahora mismo`);
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = `⚡ Añadir a mi carrito de CardTrader ${flag(lang)}`;
  }
};
$("cm-langs").onclick = (e) => {
  const b = e.target.closest("[data-lang]");
  if (b) { modalLang = b.dataset.lang; renderModal(); }
};
$("cm-lists").onclick = (e) => {
  const b = e.target.closest("[data-list]");
  if (!b) return;
  const { card, g, set } = modalContext();
  let id = b.dataset.list;
  if (id === "__new") {
    const name = prompt("Nombre de la nueva lista");
    if (!name || !name.trim()) return;
    id = State.createList(name).id;
  }
  State.toggleInList(id, card, g, set);
  renderModal();
};
$("cm-img").onclick = (e) => { if (e.target.tagName === "IMG") e.target.classList.toggle("zoomed"); };
$("cm-prev").onclick = () => modalStep(-1);
$("cm-next").onclick = () => modalStep(1);

// ---------- Explorar: sets ----------
async function showSets(id) {
  const token = ++loadToken;
  gameId = id;
  store.set("game", id);
  current = null;
  document.querySelectorAll("#game-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.game === id));
  $("intro-title").textContent = `Elige un set de ${game().name}`;
  $("all-sets").innerHTML = `<p class="muted">Cargando sets…</p>`;
  try {
    const sets = await game().sets();
    if (token !== loadToken) return;
    allSets = sets;
    renderSets();
  } catch {
    if (token === loadToken) $("all-sets").innerHTML = `<p class="muted">No se pudieron cargar los sets. Revisa tu conexión.</p>`;
  }
}

function ownedBySet() {
  const counts = new Map();
  for (const o of Object.values(State.data.owned)) counts.set(o.s, (counts.get(o.s) || 0) + 1);
  return counts;
}

function setTile(s, g, have) {
  const b = document.createElement("a");
  b.className = "set-tile";
  b.href = `#/${g}/set/${encodeURIComponent(s.id)}`;
  const fallback = `<span class="fallback${s.code ? " code" : ""}">${escapeHtml(s.code || s.name)}</span>`;
  b.innerHTML = `
    <div class="logo-box">${s.logo ? `<img loading="lazy" src="${s.logo}" alt="">` : fallback}</div>
    <b>${escapeHtml(s.name)}</b>
    <small>${have ? `${have} / ${s.total} cartas` : `${s.total} cartas`}</small>
    ${have ? `<div class="progress"><i style="width:${Math.min(100, (have / s.total) * 100)}%"></i></div>` : ""}`;
  const img = b.querySelector("img");
  if (img) img.onerror = () => {
    if (img.src.includes("/es/")) { img.src = img.src.replace("/es/", "/en/"); return; }
    img.outerHTML = fallback;
  };
  return b;
}

// Selector "Idioma de mis cartas" (por juego) en Explorar y en cada set
function renderLangPrefs() {
  for (const id of ["lang-pref-sets", "lang-pref-set"]) {
    $(id).innerHTML = langPicker(gameId, State.lang(gameId), `data-pref="1" role="group" aria-label="Idioma de mis cartas"`);
  }
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-pref] [data-lang]");
  if (!b) return;
  State.setLang(gameId, b.dataset.lang);
  renderLangPrefs();
  toast(`Las cartas que marques serán en ${langName(b.dataset.lang).toLowerCase()}`);
});

function renderSets() {
  renderLangPrefs();
  const q = $("set-search").value.trim().toLowerCase();
  const list = $("all-sets");
  list.innerHTML = "";
  const shown = allSets.filter((s) => !q || s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q));
  if (!shown.length) list.innerHTML = `<p class="muted">No hay sets que coincidan.</p>`;
  // Primero los sets en los que ya tengo cartas
  const counts = ownedBySet();
  shown.sort((a, b) => ((counts.get(b.id) || 0) > 0) - ((counts.get(a.id) || 0) > 0));
  for (const s of shown.slice(0, 150)) list.appendChild(setTile(s, gameId, counts.get(s.id) || 0));
}

// ---------- Un set ----------
async function openSet(g, id) {
  const token = ++loadToken;
  gameId = g;
  $("back-sets").href = "#/" + g;
  $("cards").innerHTML = `<p class="muted">Cargando cartas…</p>`;
  $("set-name").textContent = "";
  $("set-meta").textContent = "";
  $("set-logo").hidden = true;

  let data;
  try { data = await game().set(id); }
  catch {
    if (token === loadToken) $("cards").innerHTML = `<p class="muted">No se pudo cargar el set. Revisa tu conexión e inténtalo de nuevo.</p>`;
    return;
  }
  if (token !== loadToken) return;

  current = data;
  renderLangPrefs();
  if (!game().price) for (const c of data.cards) prices.set(c.id, priceOf(c));
  document.title = `${data.name} — Binder`;
  $("set-name").textContent = data.name;
  $("set-meta").textContent = [...data.meta, `${data.cards.length} cartas`].filter(Boolean).join(" · ");
  const logo = $("set-logo");
  logo.onerror = () => { if (logo.src.includes("/es/")) logo.src = logo.src.replace("/es/", "/en/"); else logo.hidden = true; };
  if (data.logo) { logo.src = data.logo; logo.hidden = false; }

  renderSetCards();
  if (game().price) loadSetPrices(token);
}

function visibleSetCards() {
  const q = query.toLowerCase();
  return current.cards.filter((c) => {
    const has = State.has(c.id);
    if (filter === "have" && !has) return false;
    if (filter === "miss" && has) return false;
    return !q || c.name.toLowerCase().includes(q) || c.n.toLowerCase().includes(q);
  });
}

function renderSetCards() {
  const grid = $("cards");
  grid.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const c of visibleSetCards()) frag.appendChild(cardTile(c, gameId, current));
  grid.appendChild(frag);
  if (!grid.children.length) grid.innerHTML = `<p class="muted">No hay cartas en esta vista.</p>`;
  updateSetStats();
}

function updateSetStats() {
  if (!current) return;
  const total = current.cards.length;
  let have = 0, cost = 0, value = 0, missingPriced = 0, missingTotal = 0, loaded = 0;
  for (const c of current.cards) {
    const p = prices.get(c.id);
    if (p !== undefined) loaded++;
    if (State.has(c.id)) { have++; if (p?.price != null) value += p.price; }
    else { missingTotal++; if (p?.price != null) { cost += p.price; missingPriced++; } }
  }
  $("st-have").textContent = `${have} / ${total}`;
  $("st-miss").textContent = total - have;
  $("set-progress").style.width = (total ? (have / total) * 100 : 0) + "%";
  const loading = loaded < total;
  $("st-cost").textContent = loading && loaded === 0 ? "…" : fmt(cost);
  $("st-value").textContent = loading && loaded === 0 ? "…" : fmt(value);
  const noPrice = missingTotal - missingPriced;
  const when = game().pricesDate ? ` (${new Date(game().pricesDate).toLocaleDateString("es-ES")})` : ", actualizados a diario";
  $("price-status").textContent = loading
    ? `Cargando precios de Cardmarket… ${loaded} / ${total}`
    : `Precios de tendencia de Cardmarket${when}.${noPrice ? ` ${noPrice} carta(s) que te faltan no tienen precio y no cuentan en el total.` : ""}`;
}

async function loadSetPrices(token) {
  const queue = current.cards.map((c) => c.id).filter((id) => !prices.has(id));
  let done = 0;
  async function worker() {
    while (queue.length && token === loadToken) {
      const id = queue.shift();
      const p = await game().price(id);
      if (token !== loadToken) return;
      prices.set(id, p);
      refreshTile(id);
      if (++done % 8 === 0) updateSetStats();
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (token === loadToken) updateSetStats();
}

// Lista de faltantes del set
function missingCards() {
  return current.cards
    .filter((c) => !State.has(c.id))
    .map((c) => ({ ...c, price: prices.get(c.id)?.price ?? null, idProduct: c.idProduct || prices.get(c.id)?.idProduct || null }))
    .sort((a, b) => (b.price ?? -1) - (a.price ?? -1));
}

function openDrawer() {
  const list = missingCards();
  const total = list.reduce((s, c) => s + (c.price ?? 0), 0);
  $("drawer-sum").textContent = list.length
    ? `${list.length} cartas · ${fmt(total)} en total (precio de tendencia)`
    : "¡No te falta ninguna carta de este set! 🎉";
  $("miss-list").innerHTML = list.map((c) => `
    <li>
      ${c.img ? `<img loading="lazy" src="${c.img}" alt="">` : ""}
      <div class="mi"><b>${escapeHtml(c.name)}${c.parallel ? " (paralela)" : ""}</b><small>#${escapeHtml(c.code || c.n)} · ${escapeHtml(current.name)}</small></div>
      <div class="mp">${fmt(c.price)}<a href="${cardmarketUrl(c, gameId, State.lang(gameId))}" target="_blank" rel="noopener">Cardmarket ${flag(State.lang(gameId))} ↗</a></div>
    </li>`).join("");
  $("drawer").hidden = false;
}

function listAsText(cards, setName) {
  return cards.map((c) => `${c.qty || 1} ${c.name}${c.parallel ? " (paralela)" : ""} (${c.setName || setName}) #${c.code || c.n}${c.price != null ? ` - ${fmt(c.price)}` : ""}`).join("\n");
}

function listAsCsv() {
  const rows = [["cantidad", "nombre", "set", "numero", "paralela", "id_cardmarket", "precio_tendencia_eur"]];
  for (const c of missingCards()) {
    rows.push([1, c.name, current.name, c.code || c.n, c.parallel ? "si" : "no", c.idProduct ?? "", c.price != null ? String(c.price).replace(".", ",") : ""]);
  }
  return rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(";")).join("\r\n");
}

async function copy(text, msg) {
  try { await navigator.clipboard.writeText(text); toast(msg); }
  catch { toast("No se pudo copiar"); }
}

// ---------- Mi colección ----------
let colGame = "";

async function showCollection() {
  const ids = Object.keys(State.data.owned);
  $("col-cards").innerHTML = ids.length ? `<p class="muted">Cargando tu colección…</p>` : emptyState("Aún no tienes cartas marcadas.", "Explora un set y toca las cartas que tienes.", "#/explorar", "Explorar sets");
  if (!ids.length) {
    $("col-count").textContent = "0"; $("col-sets").textContent = "0"; $("col-value").textContent = fmt(0); $("col-delta").textContent = "–";
    $("portfolio").hidden = true;
    return;
  }
  await ensureMeta(ids);
  renderCollection();
  await loadPricesFor(ids, (id) => refreshTile(id));
  renderCollection(true);
}

// Valor de la colección hoy y hace 7 / 30 días (medias de Cardmarket), y cartas que más se mueven
function portfolioStats(ids) {
  let now = 0, d7 = 0, d30 = 0;
  const movers = [];
  for (const id of ids) {
    const p = prices.get(id);
    if (p?.price == null) continue;
    now += p.price;
    d7 += p.p7 ?? p.price;
    d30 += p.p30 ?? p.price;
    if (p.p30 >= 0.5) movers.push({ id, pct: (p.price - p.p30) / p.p30, diff: p.price - p.p30 });
  }
  movers.sort((a, b) => b.pct - a.pct);
  return { now, d7, d30, up: movers.filter((m) => m.pct > 0.02).slice(0, 5), down: movers.filter((m) => m.pct < -0.02).reverse().slice(0, 5) };
}

const pct = (x) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1).replace(".", ",")} %`;

// Gráfico de línea en SVG. points = [{ label, v, estimated }]
function lineChart(points) {
  const W = 560, H = 180, P = 28;
  const vs = points.map((p) => p.v);
  let min = Math.min(...vs), max = Math.max(...vs);
  if (max - min < 1) { min -= 1; max += 1; }
  const x = (i) => P + (i * (W - 2 * P)) / Math.max(1, points.length - 1);
  const y = (v) => H - P - ((v - min) / (max - min)) * (H - 2 * P);
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const up = vs[vs.length - 1] >= vs[0];
  const color = up ? "var(--ok)" : "var(--bad)";
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Evolución del valor de la colección">
    <path d="${path} L${x(points.length - 1)},${H - P} L${x(0)},${H - P} Z" fill="${color}" opacity=".12"/>
    <path d="${path}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round"/>
    ${points.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.v)}" r="4" fill="${color}"><title>${p.label}: ${fmt(p.v)}</title></circle>`).join("")}
    ${points.length <= 8 ? points.map((p, i) => `<text x="${x(i)}" y="${H - 6}" text-anchor="${i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}" class="chart-l">${escapeHtml(p.label)}</text>`).join("") : ""}
    <text x="${P}" y="14" class="chart-l">${fmt(max)}</text><text x="${P}" y="${H - P + 14}" class="chart-l" opacity="0">.</text>
  </svg>`;
}

function renderPortfolio(ids, record) {
  const s = portfolioStats(ids);
  $("portfolio").hidden = false;
  const delta = s.d30 ? (s.now - s.d30) / s.d30 : 0;
  $("col-delta").innerHTML = s.d30 ? `<span class="${delta >= 0 ? "up" : "down"}">${pct(delta)}</span>` : "–";
  if (record && s.now > 0) State.recordValue(Math.round(s.now * 100) / 100, ids.length);

  // Con pocas fotos diarias, se estima la tendencia con las medias de 30 y 7 días de Cardmarket
  const hist = State.data.history;
  let points, note;
  if (hist.length >= 3) {
    points = hist.slice(-60).map((h) => ({ label: new Date(h.d).toLocaleDateString("es-ES", { day: "numeric", month: "short" }), v: h.v }));
    note = "Una foto al día de tu colección";
  } else {
    points = [{ label: "hace 30 días", v: s.d30 }, { label: "hace 7 días", v: s.d7 }, { label: "hoy", v: s.now }];
    note = "Estimado con las medias de Cardmarket · tu historial real se irá llenando día a día";
  }
  $("col-chart").innerHTML = lineChart(points);
  $("col-chart-note").textContent = note;

  const row = (m) => {
    const { card } = fromMeta(m.id);
    return `<li data-id="${escapeHtml(m.id)}"><button class="mv" data-open="${escapeHtml(m.id)}">${card.img ? `<img src="${card.img}" alt="">` : ""}<span>${escapeHtml(card.name)}</span>
      <b class="${m.pct >= 0 ? "up" : "down"}">${pct(m.pct)}</b><small>${fmt(prices.get(m.id).price)}</small></button></li>`;
  };
  $("col-up").innerHTML = s.up.map(row).join("") || `<li class="muted tiny">Nada sube más de un 2 % ahora mismo.</li>`;
  $("col-down").innerHTML = s.down.map(row).join("") || `<li class="muted tiny">Nada baja más de un 2 % ahora mismo.</li>`;
}

function renderCollection(record = false) {
  if (location.hash !== "#/coleccion") return;
  const q = $("col-search").value.trim().toLowerCase();
  const sort = $("col-sort").value;
  const ids = Object.keys(State.data.owned);
  let items = ids.map(fromMeta);
  const sets = new Set(items.map((x) => x.g + x.set.id));
  const value = items.reduce((s, x) => s + (prices.get(x.card.id)?.price || 0), 0);
  $("col-count").textContent = items.length;
  $("col-sets").textContent = sets.size;
  $("col-value").textContent = fmt(value);
  renderPortfolio(ids, record);

  items = items.filter((x) => (!colGame || x.g === colGame) && (!q || x.card.name.toLowerCase().includes(q) || (x.set.name || "").toLowerCase().includes(q)));
  items.sort((a, b) =>
    sort === "name" ? a.card.name.localeCompare(b.card.name, "es")
    : sort === "set" ? (a.set.name || "").localeCompare(b.set.name || "", "es") || String(a.card.n).localeCompare(String(b.card.n), "es", { numeric: true })
    : (prices.get(b.card.id)?.price ?? -1) - (prices.get(a.card.id)?.price ?? -1));

  const grid = $("col-cards");
  grid.innerHTML = "";
  for (const x of items) grid.appendChild(cardTile(x.card, x.g, x.set, { mode: "open", sub: x.set.name }));
  if (!items.length) grid.innerHTML = `<p class="muted">No hay cartas que coincidan.</p>`;
}

// ---------- Alertas de precio ----------
// Precio actual de una carta en un idioma: la oferta más barata de CardTrader en ese idioma
// (envío aparte) o, si no hay datos, la tendencia de Cardmarket.
async function currentPrice(id, lang) {
  const { g, set } = fromMeta(id);
  const ct = await cardTraderOffers(id, g, set.id);
  const best = ct?.o?.[lang]?.[0];
  if (best) return { price: best[0] / 100, source: "CardTrader" };
  if (!prices.has(id)) await loadPricesFor([id]);
  const p = prices.get(id)?.price;
  return p != null ? { price: p, source: "Cardmarket" } : null;
}

async function checkAlerts() {
  for (const a of State.data.alerts) {
    if (a.hit) continue;
    const now = await currentPrice(a.card, a.l).catch(() => null);
    if (now && now.price <= a.below) {
      State.markAlert(a.id, now.price);
      const name = State.data.meta[a.card]?.name || a.card;
      toast(`🔔 ${name} ha bajado a ${fmt(now.price)}`);
      try { if (window.Notification?.permission === "granted") new Notification("Binder · alerta de precio", { body: `${name} (${langName(a.l)}) está a ${fmt(now.price)} en ${now.source}` }); }
      catch { /* sin notificaciones */ }
    }
  }
  updateBadge();
}

async function showAlerts() {
  const box = $("alert-list");
  const alerts = State.data.alerts;
  $("btn-notify").hidden = !window.Notification || Notification.permission === "granted";
  if (!alerts.length) {
    box.innerHTML = emptyState("No tienes alertas.", "Abre una carta con la lupa 🔍 y pon el precio al que quieres comprarla.", "#/explorar", "Explorar sets");
    return;
  }
  await ensureMeta(alerts.map((a) => a.card));
  box.innerHTML = alerts.map((a) => {
    const { card, g, set } = fromMeta(a.card);
    tiles.set(card.id, { card, g, set });
    return `<div class="alert-row${a.hit ? " hit" : ""}" data-alert="${a.id}">
      <button class="cl-img" data-open="${escapeHtml(a.card)}" aria-label="Ver carta">${card.img ? `<img loading="lazy" src="${card.img}" alt="">` : ""}</button>
      <div class="cl-info"><b>${flag(a.l)} ${escapeHtml(card.name)}</b><small>${escapeHtml(set.name || "")} · #${escapeHtml(card.code || card.n)}</small>
        <small>Avisar por debajo de <b>${fmt(a.below)}</b> · ahora <span data-now>…</span></small>
        ${a.hit ? `<small class="up">✓ Bajó a ${fmt(a.hit.price)} el ${new Date(a.hit.at).toLocaleDateString("es-ES")}</small>` : ""}</div>
      <div class="alert-actions">
        ${a.hit ? `<button class="btn small" data-buy>🛒 Al carrito</button><button class="btn-ghost small" data-reset>Volver a vigilar</button>` : ""}
        <button class="icon-btn" data-del aria-label="Borrar alerta">✕</button>
      </div>
    </div>`;
  }).join("");
  for (const a of alerts) {
    currentPrice(a.card, a.l).then((now) => {
      const el = box.querySelector(`[data-alert="${a.id}"] [data-now]`);
      if (el) el.textContent = now ? `${fmt(now.price)} (${now.source})` : "sin precio";
    });
  }
}

$("alert-list").onclick = (e) => {
  const row = e.target.closest("[data-alert]");
  if (!row) return;
  const a = State.data.alerts.find((x) => x.id === row.dataset.alert);
  if (!a) return;
  if (e.target.closest("[data-open]")) { openCard(a.card, State.data.alerts.map((x) => x.card), a.l); return; }
  if (e.target.closest("[data-del]")) { State.removeAlert(a.id); showAlerts(); return; }
  if (e.target.closest("[data-reset]")) { State.resetAlert(a.id); showAlerts(); return; }
  if (e.target.closest("[data-buy]")) {
    const { card, g } = fromMeta(a.card);
    State.addToCart(withCm(card), g, null, a.l);
    toast("Añadida al carrito");
  }
};
$("btn-notify").onclick = async () => {
  const p = await Notification.requestPermission();
  toast(p === "granted" ? "Te avisaremos también con notificaciones del navegador" : "Sin permiso para notificaciones");
  showAlerts();
};

// Formulario de alerta en la lupa
async function renderModalAlert(card, lang) {
  const a = State.alertFor(card.id, lang);
  const input = $("cm-alert-price");
  $("cm-alert-btn").textContent = a ? "Cambiar alerta" : "Crear alerta";
  $("cm-alert-msg").textContent = a ? (a.hit ? `✓ Alerta cumplida: bajó a ${fmt(a.hit.price)}` : `Alerta activa: te avisamos si baja de ${fmt(a.below)}.`) : "";
  if (a) { input.value = a.below; return; }
  input.value = "";
  const now = await currentPrice(card.id, lang).catch(() => null);
  if (now && modalId === card.id && !input.value) input.value = Math.max(0.01, Math.floor(now.price * 0.9 * 100) / 100);
}
$("cm-alert").onsubmit = (e) => {
  e.preventDefault();
  const { card, g, set, lang } = modalContext();
  const below = Number($("cm-alert-price").value);
  if (!(below > 0)) return;
  State.setAlert(card, g, set, lang, below);
  renderModalAlert(card, lang);
  toast(`Te avisaremos si baja de ${fmt(below)}`);
  checkAlerts();
};

function emptyState(title, text, href, label) {
  return `<div class="empty"><b>${title}</b><p>${text}</p><a class="btn small" href="${href}">${label}</a></div>`;
}

// ---------- Listas ----------
function showLists() {
  const box = $("lists");
  const lists = State.data.lists;
  box.innerHTML = lists.length ? "" : `<p class="muted">Todavía no tienes listas. Crea una arriba y añade cartas desde la lupa 🔍 de cualquier carta.</p>`;
  for (const l of lists) {
    const have = l.cards.filter((id) => State.has(id)).length;
    const a = document.createElement("a");
    a.className = "set-tile list-tile";
    a.href = "#/lista/" + l.id;
    const thumbs = l.cards.slice(0, 4).map((id) => State.data.meta[id]?.img).filter(Boolean);
    a.innerHTML = `
      <div class="thumbs">${thumbs.map((src) => `<img loading="lazy" src="${src}" alt="">`).join("") || `<span class="fallback">⭐</span>`}</div>
      <b>${escapeHtml(l.name)}</b>
      <small>${l.cards.length} cartas · tengo ${have}</small>
      ${l.cards.length ? `<div class="progress"><i style="width:${(have / l.cards.length) * 100}%"></i></div>` : ""}`;
    box.appendChild(a);
  }
}

let openListId = null;
async function showList(id) {
  const l = State.list(id);
  openListId = id;
  if (!l) { $("list-name").textContent = "Lista no encontrada"; $("list-cards").innerHTML = ""; $("list-meta").textContent = ""; return; }
  $("list-name").textContent = l.name;
  await ensureMeta(l.cards);
  renderList();
  await loadPricesFor(l.cards, (cid) => refreshTile(cid));
  renderList();
}

function renderList() {
  const l = State.list(openListId);
  if (!l || !location.hash.startsWith("#/lista/")) return;
  const have = l.cards.filter((id) => State.has(id)).length;
  const missCost = l.cards.filter((id) => !State.has(id)).reduce((s, id) => s + (prices.get(id)?.price || 0), 0);
  $("list-meta").textContent = l.cards.length
    ? `${l.cards.length} cartas · tengo ${have} · me faltan ${l.cards.length - have} (${fmt(missCost)} en Cardmarket)`
    : "";
  const grid = $("list-cards");
  grid.innerHTML = "";
  for (const id of l.cards) {
    const x = fromMeta(id);
    grid.appendChild(cardTile(x.card, x.g, x.set, { mode: "open", sub: x.set.name }));
  }
  if (!l.cards.length) grid.innerHTML = emptyState("Esta lista está vacía.", "Abre cualquier carta con la lupa 🔍 y pulsa el nombre de esta lista para añadirla.", "#/explorar", "Explorar sets");
}

// ---------- Carrito ----------
async function showCart() {
  const ids = [...new Set(Object.keys(State.data.cart).map((k) => k.split("@")[0]))];
  await ensureMeta(ids);
  renderCart();
  await loadPricesFor(ids, () => {});
  renderCart();
}

// Una línea por carta e idioma: { key: "id@idioma", lang, card, g, set, qty }
function cartLines() {
  return Object.entries(State.data.cart).map(([key, qty]) => {
    const [id, lang] = key.split("@");
    const x = fromMeta(id);
    return { ...x, card: withCm(x.card), key, lang, qty };
  });
}

function renderCart() {
  if (location.hash !== "#/carrito") return;
  const lines = cartLines();
  const box = $("cart-items");
  $("cart-tools").hidden = !lines.length;
  if (!lines.length) {
    box.innerHTML = emptyState("Tu carrito está vacío.", "Añade cartas con el botón 🛒 desde cualquier set, tu colección o tus listas.", "#/explorar", "Explorar sets");
    $("cart-summary").innerHTML = "";
    return;
  }
  box.innerHTML = lines.map(({ card, g, set, qty, key, lang }) => {
    tiles.set(card.id, { card, g, set });
    const p = prices.get(card.id);
    return `<div class="cart-line" data-key="${escapeHtml(key)}">
      <button class="cl-img" data-act="zoom" aria-label="Ver en grande">${card.img ? `<img loading="lazy" src="${card.img}" alt="">` : ""}</button>
      <div class="cl-info"><b>${escapeHtml(card.name)}${card.parallel ? " <em>(paralela)</em>" : ""}</b>
        <small>${GAMES[g].name} · ${escapeHtml(set.name || "")} · #${escapeHtml(card.code || card.n)}</small>
        <small>${p === undefined ? "…" : p?.price != null ? fmt(p.price) + " c/u en Cardmarket" : "sin precio"}</small>
        ${langPicker(g, lang, `data-cartlang role="group" aria-label="Idioma"`)}</div>
      <div class="qty"><button data-q="-1" aria-label="Quitar una">−</button><span>${qty}</span><button data-q="1" aria-label="Añadir una">+</button></div>
    </div>`;
  }).join("");

  const ref = lines.reduce((s, l) => s + (prices.get(l.card.id)?.price || 0) * l.qty, 0);
  const n = lines.reduce((s, l) => s + l.qty, 0);
  $("cart-summary").innerHTML = `
    <h2>Resumen</h2>
    <div class="sum-row"><span>${n} carta${n > 1 ? "s" : ""}</span><b>${fmt(ref)}</b></div>
    <p class="tiny muted">Suma de precios de tendencia de Cardmarket, sin envíos.</p>
    <button class="btn" id="btn-optimize">Calcular la compra más barata</button>
    <div id="opt-result"></div>`;
  $("btn-optimize").onclick = optimizeCart;
}

$("cart-items").onclick = (e) => {
  const line = e.target.closest(".cart-line");
  if (!line) return;
  const key = line.dataset.key;
  const [id, lang] = key.split("@");
  const lp = e.target.closest("[data-cartlang] [data-lang]");
  if (lp) { if (lp.dataset.lang !== lang) { State.changeCartLang(key, lp.dataset.lang); renderCart(); } return; }
  const q = e.target.closest("[data-q]");
  if (q) { State.setCartQty(key, (State.data.cart[key] || 0) + Number(q.dataset.q)); renderCart(); return; }
  if (e.target.closest('[data-act="zoom"]')) openCard(id, [...new Set(Object.keys(State.data.cart).map((k) => k.split("@")[0]))], lang);
};

async function optimizeCart() {
  const out = $("opt-result");
  out.innerHTML = `<p class="muted">Buscando la combinación más barata…</p>`;
  const lines = cartLines();
  const items = [];   // un "id@idioma" por copia
  for (const l of lines) for (let i = 0; i < l.qty; i++) items.push(l.key);
  const byId = Object.fromEntries(lines.map((l) => [l.key, l]));
  const cardOf = (key) => key.split("@")[0];

  // Cartas con ofertas de CardTrader en su idioma → optimizador; el resto → referencia Cardmarket
  let ct = null;
  try { ct = await cardTraderData(lines.map((l) => ({ g: l.g, s: l.set.id }))); }
  catch { ct = null; }
  const ctItems = ct ? items.filter((k) => Optimizer.offersFor(k, ct).length) : [];
  const direct = ct ? Optimizer.optimizeDirect(ctItems, ct) : null;
  const zero = ct ? Optimizer.optimizeZero(ctItems, ct) : null;

  const mixed = ct ? Optimizer.optimizeMixed(ctItems, ct) : null;

  const options = [];
  if (direct?.items.length) options.push({ key: "direct", label: "CardTrader · directo a vendedores", sum: direct.sum, cost: direct.cost, ship: direct.ship, n: direct.items.length, envios: direct.per.size, left: direct.missing });
  if (zero?.picks.length) options.push({ key: "zero", label: "CardTrader Zero · un solo envío", sum: zero.sum, cost: zero.cost, ship: zero.ship, n: zero.picks.length, envios: 1, left: zero.missing });
  // El combinado solo cubre las cartas del plan directo: se compara si cubre las mismas que el directo
  if (mixed && mixed.sum < Math.min(direct.sum, zero?.missing.length ? Infinity : zero.sum)) {
    options.push({ key: "mixed", label: "Combinado · vendedores + Zero", sum: mixed.sum, cost: mixed.cost, ship: mixed.ship, n: direct.items.length, envios: mixed.envios, left: mixed.missing });
  }
  // Lo que una opción no cubre se estima con Cardmarket; se comparan por el total de todo el carrito
  const notCt = items.filter((k) => !ctItems.includes(k));
  const cmOf = (keys) => keys.reduce((s, k) => s + (prices.get(cardOf(k))?.price || 0), 0);
  for (const o of options) o.total = o.sum / 100 + cmOf([...o.left, ...notCt]);
  options.sort((a, b) => a.total - b.total);
  const best = options[0];
  const leftover = best ? [...best.left, ...notCt] : items;
  const total = best ? best.total : cmOf(items);

  const row = (o, i) => `
    <button class="opt-row${i === 0 ? " best" : ""}" data-show="${o.key}">
      <div><b>${o.label}</b><small>${o.n} cartas · ${o.envios} envío${o.envios > 1 ? "s" : ""}${o.left.length ? ` · ${o.left.length} sin oferta` : ""}</small></div>
      <div class="opt-sum">${cents(o.sum)}<small>${cents(o.cost)} + ${cents(o.ship)} envío</small></div>
    </button>`;

  const itemRow = (key, price) => {
    const { card, set, lang } = byId[key];
    return `<div class="opt-item"><span>${flag(lang)} ${escapeHtml(card.name)}${card.parallel ? " <em>(paralela)</em>" : ""} <small>${escapeHtml(set.name || "")} #${escapeHtml(card.code || card.n)}</small></span>
      <span>${cents(price)} <a href="${cardTraderUrl(ct.cards[cardOf(key)].bp)}" target="_blank" rel="noopener">ver ↗</a></span></div>`;
  };
  const directDetail = (d = direct) => {
    const groups = new Map();
    d.plan.forEach((k, i) => {
      const [price, s] = d.offersOf[i][k];
      if (!groups.has(s)) groups.set(s, []);
      groups.get(s).push([d.items[i], price]);
    });
    let n = 0;
    return [...groups.entries()].sort((a, b) => b[1].length - a[1].length).map(([s, list]) => {
      const seller = ct.sellers[s];
      const sub = list.reduce((t, x) => t + x[1], 0);
      const ship = Optimizer.shippingCost(seller, list.length, sub);
      return `<div class="opt-group">
        <div class="opt-group-head"><b>Vendedor ${++n}</b> · ${escapeHtml(countryName(seller.c))}${seller.pro ? " · profesional" : ""}
          <span>${list.length} carta${list.length > 1 ? "s" : ""} · envío ${ship ? cents(ship) : "gratis"}</span></div>
        ${list.map(([key, price]) => itemRow(key, price)).join("")}
      </div>`;
    }).join("");
  };
  const zeroDetail = (z = zero) => `<div class="opt-group">
      <div class="opt-group-head"><b>CardTrader Zero</b> · todo llega en un paquete <span>envío ${cents(ct.zeroShipping)}</span></div>
      ${z.picks.map(([key, [price]]) => itemRow(key, price)).join("")}
    </div>`;
  const detailOf = (key) => key === "direct" ? directDetail() : key === "zero" ? zeroDetail() : zeroDetail(mixed.zero) + directDetail(mixed.direct);
  const leftoverDetail = () => leftover.length ? `<div class="opt-group">
      <div class="opt-group-head"><b>Cardmarket</b> · estimado con precio de tendencia <span>envíos no incluidos</span></div>
      ${leftover.map((key) => { const { card, g, set, lang } = byId[key]; return `<div class="opt-item"><span>${flag(lang)} ${escapeHtml(card.name)} <small>${escapeHtml(set.name || "")}</small></span>
        <span>${fmt(prices.get(card.id)?.price)} <a href="${cardmarketUrl(card, g, lang)}" target="_blank" rel="noopener">ver ↗</a></span></div>`; }).join("")}
    </div>` : "";

  out.innerHTML = `
    <div class="opt-hero">
      <span>Precio aproximado más barato</span>
      <b>${fmt(total)}</b>
      <small>${best ? `${best.label}, envíos incluidos` : "Precio de tendencia de Cardmarket"}${best && leftover.length ? ` + ${leftover.length} carta(s) en Cardmarket sin envíos` : ""}</small>
    </div>
    ${options.length ? `<div class="opt-rows">${options.map(row).join("")}</div>` : ""}
    ${ctItems.length ? `<button class="btn send-ct" id="btn-send-ct">⚡ Enviar a mi carrito de CardTrader</button>
      <p class="tiny muted" id="send-ct-msg">Añade a tu carrito de CardTrader la mejor oferta calidad/precio de cada carta, en su idioma. La compra la confirmas tú allí.</p>` : ""}
    <h3 class="opt-h">Dónde comprar cada carta</h3>
    <div id="opt-detail">${best ? detailOf(best.key) : ""}${leftoverDetail()}</div>
    <p class="muted tiny">${ct ? `Ofertas de CardTrader del ${new Date(ct.updated).toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" })}: en el idioma de cada línea, Near Mint o mejor, versión normal (sin reverse holo), envío a España. ` : ""}En Pokémon, por ahora solo hay ofertas de CardTrader para Escarlata y Púrpura y Megaevolución; el resto se estima con Cardmarket. Los precios pueden haber cambiado y no incluyen comisiones de pago. Para comprar, abre cada carta y elige la oferta del país indicado.</p>`;

  let chosen = best?.key;
  out.querySelectorAll("[data-show]").forEach((b) => {
    b.onclick = () => {
      out.querySelectorAll("[data-show]").forEach((x) => x.classList.toggle("best", x === b));
      chosen = b.dataset.show;
      $("opt-detail").innerHTML = detailOf(b.dataset.show) + leftoverDetail();
    };
  });

  // Enviar al carrito real de CardTrader, una carta tras otra (respetando el límite de la API)
  const send = $("btn-send-ct");
  if (send) send.onclick = async () => {
    if (needCardTrader()) return;
    const zeroKeys = chosen === "zero" ? new Set(ctItems) : chosen === "mixed" ? new Set(mixed.zero.picks.map(([k]) => k)) : new Set();
    const counts = new Map();
    for (const k of ctItems) counts.set(k, (counts.get(k) || 0) + 1);
    send.disabled = true;
    let ok = 0, fail = 0, spent = 0, i = 0;
    for (const [key, qty] of counts) {
      $("send-ct-msg").textContent = `Añadiendo ${++i} de ${counts.size}…`;
      try {
        const r = await CardTraderAccount.addBest(ct.cards[cardOf(key)].bp, key.split("@")[1], { zero: zeroKeys.has(key), qty });
        if (r) { ok += qty; spent += r.price * qty; } else fail += qty;
      } catch (e) {
        $("send-ct-msg").textContent = e.message;
        send.disabled = false;
        return;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    send.disabled = false;
    $("send-ct-msg").innerHTML = `Listo: ${ok} carta(s) añadidas a tu carrito de CardTrader por ${cents(spent)} (sin envío).${fail ? ` ${fail} ya no tenían ofertas.` : ""}
      <a href="https://www.cardtrader.com/es/cart" target="_blank" rel="noopener">Abrir mi carrito de CardTrader ↗</a>`;
  };
}

// ---------- Cuenta ----------
function renderAccount() {
  const user = Auth.user;
  $("btn-account").textContent = user ? "👤 " + (user.email || "Mi cuenta").split("@")[0] : "Entrar";
  const body = $("account-body");
  if (!Auth.enabled()) {
    body.innerHTML = `<h2 id="acc-title">Cuentas de usuario</h2>
      <p>Muy pronto podrás entrar con tu email y tener tu colección, listas y carrito en todos tus dispositivos.</p>
      <p class="muted tiny">De momento todo se guarda en este navegador.</p>`;
  } else if (user) {
    body.innerHTML = `<h2 id="acc-title">Mi cuenta</h2>
      <p>Has entrado como <b>${escapeHtml(user.email)}</b>. Tu colección, listas y carrito se guardan en la nube.</p>
      <button class="btn-ghost" id="btn-signout">Cerrar sesión</button>`;
    $("btn-signout").onclick = async () => { await Auth.signOut(); $("account-modal").hidden = true; toast("Sesión cerrada"); };
  } else {
    body.innerHTML = `<h2 id="acc-title">Entrar en Binder</h2>
      <p>Te enviamos un enlace a tu email para entrar, sin contraseñas. Cada cuenta tiene su propia colección, listas y carrito.</p>
      <form id="login-form" class="login-form">
        <input type="email" id="login-email" placeholder="tu@email.com" autocomplete="email" required>
        <button class="btn" type="submit">Enviarme el enlace</button>
      </form>
      <p class="tiny muted" id="login-msg"></p>`;
    $("login-form").onsubmit = async (e) => {
      e.preventDefault();
      const email = $("login-email").value.trim();
      $("login-msg").textContent = "Enviando…";
      try { await Auth.signIn(email); $("login-msg").textContent = "¡Listo! Revisa tu email (y la carpeta de spam) y pulsa el enlace."; }
      catch (err) { $("login-msg").textContent = "No se pudo enviar: " + err.message; }
    };
  }
  body.insertAdjacentHTML("beforeend", cardTraderSection());
  bindCardTraderSection();
}

// Conexión con CardTrader (token propio, solo en este dispositivo)
function cardTraderSection() {
  if (CardTraderAccount.connected()) {
    const name = CardTraderAccount.info?.name || "tu cuenta";
    return `<div class="ct-box"><h3>CardTrader conectado</h3>
      <p class="tiny">Conectado como <b>${escapeHtml(name)}</b> en este dispositivo. Puedes añadir cartas a tu carrito de CardTrader desde la lupa o el carrito.</p>
      <button class="btn-ghost small" id="btn-ct-off">Desconectar</button></div>`;
  }
  return `<div class="ct-box"><h3>Conectar CardTrader</h3>
    <p class="tiny">Para añadir cartas a tu carrito de CardTrader con un clic. Copia tu token en
      <a href="https://www.cardtrader.com/es/full_api_app" target="_blank" rel="noopener">cardtrader.com → API</a> y pégalo aquí.</p>
    <form id="ct-form" class="login-form">
      <input id="ct-token" type="password" placeholder="Token de CardTrader" autocomplete="off" required>
      <button class="btn small" type="submit">Conectar</button>
    </form>
    <p class="tiny muted" id="ct-msg">El token da acceso a tu cuenta de CardTrader: se guarda solo en este navegador, nunca en los servidores de Binder, y solo lo usamos para ver ofertas y llenar tu carrito. Nunca compra por ti.</p></div>`;
}
function bindCardTraderSection() {
  const off = $("btn-ct-off");
  if (off) off.onclick = () => { CardTraderAccount.disconnect(); renderAccount(); toast("CardTrader desconectado"); };
  const form = $("ct-form");
  if (form) form.onsubmit = async (e) => {
    e.preventDefault();
    $("ct-msg").textContent = "Comprobando…";
    try { await CardTraderAccount.connect($("ct-token").value); renderAccount(); toast("CardTrader conectado"); }
    catch (err) { $("ct-msg").textContent = err.message; }
  };
}

// ---------- Navegación ----------
const VIEWS = ["view-sets", "view-set", "view-collection", "view-lists", "view-list", "view-cart", "view-alerts"];
function showView(v, nav) {
  for (const id of VIEWS) $(id).hidden = id !== v;
  document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("on", a.dataset.nav === nav));
  window.scrollTo(0, 0);
}

function route() {
  const h = location.hash;
  $("card-modal").hidden = true;
  $("drawer").hidden = true;
  tiles.clear();
  let m;
  if ((m = h.match(/^#\/(?:(\w+)\/)?set\/(.+)$/))) {
    showView("view-set", "explorar");
    openSet(GAMES[m[1]] ? m[1] : "pokemon", decodeURIComponent(m[2]));
  } else if (h === "#/coleccion") {
    current = null; document.title = "Mi colección — Binder";
    showView("view-collection", "coleccion"); showCollection();
  } else if (h === "#/listas") {
    current = null; document.title = "Mis listas — Binder";
    showView("view-lists", "listas"); showLists();
  } else if ((m = h.match(/^#\/lista\/(.+)$/))) {
    current = null; document.title = "Lista — Binder";
    showView("view-list", "listas"); showList(m[1]);
  } else if (h === "#/carrito") {
    current = null; document.title = "Carrito — Binder";
    showView("view-cart", "carrito"); showCart();
  } else if (h === "#/alertas") {
    current = null; document.title = "Alertas — Binder";
    showView("view-alerts", "alertas"); showAlerts();
  } else {
    const g = h.match(/^#\/(\w+)$/)?.[1];
    document.title = "Binder — Explorar";
    showView("view-sets", "explorar");
    showSets(GAMES[g] ? g : gameId);
  }
}

function updateBadge() {
  const n = State.cartCount();
  $("cart-badge").hidden = !n;
  $("cart-badge").textContent = n;
  const hits = State.data.alerts.filter((a) => a.hit).length;
  $("alert-badge").hidden = !hits;
  $("alert-badge").textContent = hits;
}

// ---------- Eventos ----------
$("set-search").addEventListener("input", renderSets);
$("card-search").addEventListener("input", (e) => { query = e.target.value.trim(); renderSetCards(); });
document.querySelectorAll("#game-tabs button").forEach((b) => {
  b.onclick = () => { $("set-search").value = ""; location.hash = "#/" + b.dataset.game; };
});
document.querySelectorAll("#card-filter button").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll("#card-filter button").forEach((x) => x.classList.toggle("on", x === b));
    filter = b.dataset.filter;
    renderSetCards();
  };
});
$("cards").addEventListener("click", (e) => gridClick(e, () => visibleSetCards().map((c) => c.id)));
$("col-cards").addEventListener("click", (e) => gridClick(e, () => [...$("col-cards").querySelectorAll(".c")].map((x) => x.dataset.id)));
$("list-cards").addEventListener("click", (e) => gridClick(e, () => State.list(openListId)?.cards || []));

$("btn-all").onclick = () => { State.setManyOwned(current.cards, gameId, current, true); renderSetCards(); };
$("btn-none").onclick = () => {
  if (!confirm("¿Desmarcar todas las cartas de este set?")) return;
  State.setManyOwned(current.cards, gameId, current, false);
  renderSetCards();
};
$("btn-list").onclick = openDrawer;

// ---------- Escáner ----------
function scanMatched(found) {
  const c = found[0];
  const was = State.has(c.id);
  if (!was) State.setOwned(c, gameId, current, true);
  refreshTile(c.id);
  updateSetStats();
  if (navigator.vibrate) navigator.vibrate(60);
  const others = found.length > 1 ? ` <small class="muted">(hay ${found.length} versiones; si era otra, márcala en la cuadrícula)</small>` : "";
  $("scan-found").insertAdjacentHTML("afterbegin", `<div class="scan-hit">
    ${c.img ? `<img src="${c.img}" alt="">` : ""}<span><b>${escapeHtml(c.name)}</b> #${escapeHtml(c.code || c.n)} ${flag(State.ownedLang(c.id))}<br>
    <small>${was ? "Ya la tenías" : "✓ Añadida a tu colección"}</small>${others}</span>
    ${was ? "" : `<button class="btn-ghost small" data-undo="${escapeHtml(c.id)}">Deshacer</button>`}</div>`);
  $("scan-status").textContent = "¡Leída! Pasa a la siguiente carta.";
}
$("btn-scan").onclick = async () => {
  $("scan-modal").hidden = false;
  $("scan-found").innerHTML = "";
  $("scan-help").innerHTML = gameId === "onepiece"
    ? `Acerca la esquina de abajo a la derecha, donde pone el código (p. ej. <b>OP01-001</b>), al recuadro. Se marcan en ${flag(State.lang(gameId))} y en este set: <b>${escapeHtml(current.name)}</b>.`
    : `Acerca la esquina de abajo a la izquierda, donde pone el número (p. ej. <b>001/165</b>), al recuadro. Se marcan en ${flag(State.lang(gameId))} y en este set: <b>${escapeHtml(current.name)}</b>.`;
  if (!Scanner.supported()) { $("scan-status").textContent = "Este navegador no permite usar la cámara: sube una foto."; return; }
  $("scan-status").textContent = "Preparando la cámara y el lector (la primera vez tarda unos segundos)…";
  try {
    await Scanner.start($("scan-video"), current.cards, scanMatched);
    $("scan-status").textContent = "Buscando el número…";
  } catch (e) {
    $("scan-status").textContent = e.name === "NotAllowedError" ? "Sin permiso para la cámara. Puedes subir una foto." : "No se pudo abrir la cámara: " + e.message;
  }
};
$("scan-found").onclick = (e) => {
  const b = e.target.closest("[data-undo]");
  if (!b) return;
  const c = current.cards.find((x) => x.id === b.dataset.undo);
  if (c) { State.setOwned(c, gameId, current, false); refreshTile(c.id); updateSetStats(); }
  b.closest(".scan-hit").remove();
};
$("scan-file").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  $("scan-status").textContent = "Leyendo la foto…";
  const img = new Image();
  await new Promise((ok, ko) => { img.onload = ok; img.onerror = () => ko(new Error("No se pudo abrir la foto")); img.src = URL.createObjectURL(file); });
  try {
    const r = await Scanner.fromImage(img, current.cards);
    if (r.found.length) scanMatched(r.found);
    else $("scan-status").textContent = "No he encontrado el número en la foto. Prueba más cerca y con buena luz.";
  } catch (err) { $("scan-status").textContent = err.message; }
  URL.revokeObjectURL(img.src);
  e.target.value = "";
};
function closeScanner() { Scanner.stop(); $("scan-modal").hidden = true; }
$("scan-modal").addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeScanner(); });
$("btn-miss-cart").onclick = () => {
  const miss = current.cards.filter((c) => !State.has(c.id) && !State.cartQty(c.id));
  if (!miss.length) { toast("Ya tienes (o están en el carrito) todas las cartas"); return; }
  for (const c of miss) State.addToCart(withCm(c), gameId, current);
  current.cards.forEach((c) => refreshTile(c.id));
  toast(`${miss.length} cartas añadidas al carrito`);
};
$("btn-copy").onclick = () => copy(listAsText(missingCards(), current.name), "Lista copiada");
$("btn-csv").onclick = () => {
  const blob = new Blob(["﻿" + listAsCsv()], { type: "text/csv;charset=utf-8" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `faltantes-${current.id}.csv` });
  a.click();
  URL.revokeObjectURL(a.href);
};

document.querySelectorAll("#col-game button").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll("#col-game button").forEach((x) => x.classList.toggle("on", x === b));
    colGame = b.dataset.g;
    renderCollection();
  };
});
$("col-search").addEventListener("input", () => renderCollection());
$("col-sort").addEventListener("change", () => renderCollection());
$("portfolio").addEventListener("click", (e) => {
  const b = e.target.closest("[data-open]");
  if (b) openCard(b.dataset.open, [...$("portfolio").querySelectorAll("[data-open]")].map((x) => x.dataset.open));
});

$("new-list-form").onsubmit = (e) => {
  e.preventDefault();
  const l = State.createList($("new-list-name").value);
  $("new-list-name").value = "";
  location.hash = "#/lista/" + l.id;
};
$("btn-list-rename").onclick = () => {
  const l = State.list(openListId);
  const name = l && prompt("Nuevo nombre de la lista", l.name);
  if (name) { State.renameList(l.id, name); $("list-name").textContent = State.list(l.id).name; }
};
$("btn-list-delete").onclick = () => {
  const l = State.list(openListId);
  if (l && confirm(`¿Borrar la lista «${l.name}»? Las cartas siguen en tu colección.`)) { State.deleteList(l.id); location.hash = "#/listas"; }
};
$("btn-list-cart").onclick = () => {
  const l = State.list(openListId);
  const miss = (l?.cards || []).filter((id) => !State.has(id) && !State.cartQty(id));
  if (!miss.length) { toast("No hay cartas que te falten fuera del carrito"); return; }
  for (const id of miss) { const x = fromMeta(id); State.addToCart(x.card, x.g, null); }
  miss.forEach(refreshTile);
  toast(`${miss.length} cartas añadidas al carrito`);
};

$("btn-cart-copy").onclick = () => copy(listAsText(cartLines().map(({ card, set, qty }) => ({ ...card, qty, setName: set.name, price: prices.get(card.id)?.price })), ""), "Lista copiada");
$("btn-cart-clear").onclick = () => { if (confirm("¿Vaciar el carrito?")) { State.clearCart(); renderCart(); } };

$("btn-account").onclick = () => { renderAccount(); $("account-modal").hidden = false; };

for (const id of ["drawer", "card-modal", "account-modal"]) {
  $(id).addEventListener("click", (e) => { if (e.target.closest("[data-close]")) $(id).hidden = true; });
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { ["drawer", "card-modal", "account-modal"].forEach((id) => ($(id).hidden = true)); if (!$("scan-modal").hidden) closeScanner(); }
  if (!$("card-modal").hidden && e.key === "ArrowLeft") modalStep(-1);
  if (!$("card-modal").hidden && e.key === "ArrowRight") modalStep(1);
});
// Deslizar en la lupa (móvil)
(() => {
  let x0 = null;
  const p = $("card-modal");
  p.addEventListener("touchstart", (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  p.addEventListener("touchend", (e) => {
    if (x0 == null) return;
    const dx = e.changedTouches[0].clientX - x0;
    if (Math.abs(dx) > 50) modalStep(dx < 0 ? 1 : -1);
    x0 = null;
  });
})();

State.onChange(() => {
  updateBadge();
  if (location.hash === "#/listas") showLists();
});
Auth.onChange(() => { renderAccount(); route(); });
window.addEventListener("hashchange", route);

updateBadge();
renderAccount();
route();
Auth.init().catch((e) => console.warn("Login no disponible", e)).finally(() => setTimeout(checkAlerts, 1500));
CardTraderAccount.load();
