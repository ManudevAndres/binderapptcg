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

// Carta guardada en State.meta → objeto carta + set
function fromMeta(id) {
  const m = State.data.meta[id] || {};
  return {
    card: { id, name: m.name || id, n: m.n || "", code: m.code, img: m.img, big: m.big, parallel: m.par },
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
      for (const c of data.cards) if (list.includes(c.id)) { prices.set(c.id, { price: c.price ?? null, idProduct: c.idProduct ?? null }); onEach?.(c.id); }
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
    State.addToCart(t.card, t.g, t.set);
    refreshTile(t.card.id);
    toast(`${t.card.name} añadida al carrito`);
  } else {
    openCard(t.card.id, sequence());
  }
}

// ---------- Lupa (ficha de carta) ----------
let modalSeq = [];
let modalId = null;

function openCard(id, sequence = [id]) {
  modalSeq = sequence;
  modalId = id;
  renderModal();
  $("card-modal").hidden = false;
}

function renderModal() {
  const t = tiles.get(modalId) || fromMeta(modalId);
  const { card, g, set } = t;
  const big = card.big || card.img;
  $("cm-img").innerHTML = big
    ? `<img src="${big}" alt="${escapeHtml(card.name)}" data-fallback="${card.img || ""}">`
    : `<div class="noimg">${escapeHtml(card.name)}</div>`;
  const img = $("cm-img").querySelector("img");
  if (img) img.onerror = () => { if (img.dataset.fallback && img.src !== img.dataset.fallback) img.src = img.dataset.fallback; };
  $("cm-set").textContent = `${GAMES[g].name} · ${set.name || ""} · #${card.code || card.n}${card.parallel ? " · Paralela" : ""}`;
  $("cm-name").textContent = card.name;
  const p = prices.get(card.id);
  $("cm-price").innerHTML = p?.price != null ? `${fmt(p.price)} <small>tendencia Cardmarket</small>` : `<small>Precio no disponible</small>`;
  if (!prices.has(card.id)) loadPricesFor([card.id], () => { if (modalId === card.id) renderModal(); });

  const has = State.has(card.id);
  $("cm-owned").textContent = has ? "✓ La tengo" : "Marcar que la tengo";
  $("cm-owned").classList.toggle("on", has);
  const qty = State.cartQty(card.id);
  $("cm-cart").textContent = qty ? `🛒 En el carrito (${qty}) · añadir otra` : "🛒 Añadir al carrito";

  const lists = State.data.lists;
  $("cm-lists").innerHTML = lists.map((l) =>
    `<button class="chip-btn${State.inList(l.id, card.id) ? " on" : ""}" data-list="${l.id}">${State.inList(l.id, card.id) ? "✓ " : "+ "}${escapeHtml(l.name)}</button>`
  ).join("") + `<button class="chip-btn new" data-list="__new">+ Nueva lista</button>`;

  $("cm-links").innerHTML = `<a href="${cardmarketUrl(card, g)}" target="_blank" rel="noopener">Buscar en Cardmarket ↗</a>`;

  const i = modalSeq.indexOf(modalId);
  $("cm-prev").hidden = i <= 0;
  $("cm-next").hidden = i < 0 || i >= modalSeq.length - 1;
}

function modalStep(d) {
  const i = modalSeq.indexOf(modalId) + d;
  if (i >= 0 && i < modalSeq.length) { modalId = modalSeq[i]; renderModal(); }
}

function modalContext() { return tiles.get(modalId) || fromMeta(modalId); }

$("cm-owned").onclick = () => {
  const { card, g, set } = modalContext();
  State.setOwned(card, g, set, !State.has(card.id));
  refreshTile(card.id);
  if (current) updateSetStats();
  renderModal();
};
$("cm-cart").onclick = () => {
  const { card, g, set } = modalContext();
  State.addToCart(card, g, set);
  refreshTile(card.id);
  renderModal();
  toast("Añadida al carrito");
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

function renderSets() {
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
  if (!game().price) for (const c of data.cards) prices.set(c.id, { price: c.price ?? null, idProduct: c.idProduct ?? null });
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
    .map((c) => ({ ...c, price: prices.get(c.id)?.price ?? null, idProduct: prices.get(c.id)?.idProduct ?? null }))
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
      <div class="mp">${fmt(c.price)}<a href="${cardmarketUrl(c, gameId)}" target="_blank" rel="noopener">Ver en Cardmarket ↗</a></div>
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
  if (!ids.length) { $("col-count").textContent = "0"; $("col-sets").textContent = "0"; $("col-value").textContent = fmt(0); return; }
  await ensureMeta(ids);
  renderCollection();
  await loadPricesFor(ids, (id) => refreshTile(id));
  renderCollection();
}

function renderCollection() {
  if (location.hash !== "#/coleccion") return;
  const q = $("col-search").value.trim().toLowerCase();
  const sort = $("col-sort").value;
  let items = Object.keys(State.data.owned).map(fromMeta);
  const sets = new Set(items.map((x) => x.g + x.set.id));
  const value = items.reduce((s, x) => s + (prices.get(x.card.id)?.price || 0), 0);
  $("col-count").textContent = items.length;
  $("col-sets").textContent = sets.size;
  $("col-value").textContent = fmt(value);

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
  const ids = Object.keys(State.data.cart);
  await ensureMeta(ids);
  renderCart();
  await loadPricesFor(ids, () => {});
  renderCart();
}

function cartLines() {
  return Object.entries(State.data.cart).map(([id, qty]) => ({ ...fromMeta(id), qty }));
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
  box.innerHTML = lines.map(({ card, g, set, qty }) => {
    tiles.set(card.id, { card, g, set });
    const p = prices.get(card.id);
    return `<div class="cart-line" data-id="${escapeHtml(card.id)}">
      <button class="cl-img" data-act="zoom" aria-label="Ver en grande">${card.img ? `<img loading="lazy" src="${card.img}" alt="">` : ""}</button>
      <div class="cl-info"><b>${escapeHtml(card.name)}${card.parallel ? " <em>(paralela)</em>" : ""}</b>
        <small>${GAMES[g].name} · ${escapeHtml(set.name || "")} · #${escapeHtml(card.code || card.n)}</small>
        <small>${p === undefined ? "…" : p?.price != null ? fmt(p.price) + " c/u en Cardmarket" : "sin precio"}</small></div>
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
  const id = line.dataset.id;
  const q = e.target.closest("[data-q]");
  if (q) { State.setCartQty(id, State.cartQty(id) + Number(q.dataset.q)); renderCart(); return; }
  if (e.target.closest('[data-act="zoom"]')) openCard(id, Object.keys(State.data.cart));
};

async function optimizeCart() {
  const out = $("opt-result");
  out.innerHTML = `<p class="muted">Buscando la combinación más barata…</p>`;
  const lines = cartLines();
  const items = [];   // un id por copia
  for (const l of lines) for (let i = 0; i < l.qty; i++) items.push(l.card.id);
  const byId = Object.fromEntries(lines.map((l) => [l.card.id, l]));

  // Cartas con datos de CardTrader (por ahora One Piece) → optimizador; el resto → referencia Cardmarket
  const ctItems = items.filter((id) => GAMES[byId[id].g].hasCardTrader);
  let ct = null;
  if (ctItems.length) {
    try { ct = await cardTraderData("onepiece", ctItems.map((id) => byId[id].set.id)); }
    catch { ct = null; }
  }
  const direct = ct ? Optimizer.optimizeDirect(ctItems, ct) : null;
  const zero = ct ? Optimizer.optimizeZero(ctItems, ct) : null;

  const options = [];
  if (direct?.items.length) options.push({ key: "direct", label: "CardTrader · directo a vendedores", sum: direct.sum, cost: direct.cost, ship: direct.ship, n: direct.items.length, envios: direct.per.size, left: direct.missing });
  if (zero?.picks.length) options.push({ key: "zero", label: "CardTrader Zero · un solo envío", sum: zero.sum, cost: zero.cost, ship: zero.ship, n: zero.picks.length, envios: 1, left: zero.missing });
  options.sort((a, b) => a.sum - b.sum);
  const best = options[0];

  // Lo que no se puede comprar en CardTrader se estima con Cardmarket
  const leftover = best ? [...best.left, ...items.filter((id) => !GAMES[byId[id].g].hasCardTrader)] : items;
  const cmLeft = leftover.reduce((s, id) => s + (prices.get(id)?.price || 0), 0);
  const total = (best ? best.sum / 100 : 0) + cmLeft;

  const row = (o, i) => `
    <button class="opt-row${i === 0 ? " best" : ""}" data-show="${o.key}">
      <div><b>${o.label}</b><small>${o.n} cartas · ${o.envios} envío${o.envios > 1 ? "s" : ""}${o.left.length ? ` · ${o.left.length} sin oferta` : ""}</small></div>
      <div class="opt-sum">${cents(o.sum)}<small>${cents(o.cost)} + ${cents(o.ship)} envío</small></div>
    </button>`;

  const itemRow = (id, price, bp) => {
    const { card, set } = byId[id];
    return `<div class="opt-item"><span>${escapeHtml(card.name)}${card.parallel ? " <em>(paralela)</em>" : ""} <small>${escapeHtml(set.name || "")} #${escapeHtml(card.code || card.n)}</small></span>
      <span>${cents(price)} <a href="${cardTraderUrl(bp)}" target="_blank" rel="noopener">ver ↗</a></span></div>`;
  };
  const directDetail = () => {
    const groups = new Map();
    direct.plan.forEach((k, i) => {
      const [price, s] = direct.offersOf[i][k];
      if (!groups.has(s)) groups.set(s, []);
      groups.get(s).push([direct.items[i], price]);
    });
    let n = 0;
    return [...groups.entries()].sort((a, b) => b[1].length - a[1].length).map(([s, list]) => {
      const seller = ct.sellers[s];
      const sub = list.reduce((t, x) => t + x[1], 0);
      const ship = Optimizer.shippingCost(seller, list.length, sub);
      return `<div class="opt-group">
        <div class="opt-group-head"><b>Vendedor ${++n}</b> · ${escapeHtml(countryName(seller.c))}${seller.pro ? " · profesional" : ""}
          <span>${list.length} carta${list.length > 1 ? "s" : ""} · envío ${ship ? cents(ship) : "gratis"}</span></div>
        ${list.map(([id, price]) => itemRow(id, price, ct.cards[id].bp)).join("")}
      </div>`;
    }).join("");
  };
  const zeroDetail = () => `<div class="opt-group">
      <div class="opt-group-head"><b>CardTrader Zero</b> · todo llega en un paquete <span>envío ${cents(ct.zeroShipping)}</span></div>
      ${zero.picks.map(([id, [price]]) => itemRow(id, price, ct.cards[id].bp)).join("")}
    </div>`;
  const leftoverDetail = () => leftover.length ? `<div class="opt-group">
      <div class="opt-group-head"><b>Cardmarket</b> · estimado con precio de tendencia <span>envíos no incluidos</span></div>
      ${leftover.map((id) => { const { card, g, set } = byId[id]; return `<div class="opt-item"><span>${escapeHtml(card.name)} <small>${escapeHtml(set.name || "")}</small></span>
        <span>${fmt(prices.get(id)?.price)} <a href="${cardmarketUrl(card, g)}" target="_blank" rel="noopener">ver ↗</a></span></div>`; }).join("")}
    </div>` : "";

  out.innerHTML = `
    <div class="opt-hero">
      <span>Precio aproximado más barato</span>
      <b>${fmt(total)}</b>
      <small>${best ? `${best.label}, envíos incluidos` : "Precio de tendencia de Cardmarket"}${best && leftover.length ? ` + ${leftover.length} carta(s) en Cardmarket sin envíos` : ""}</small>
    </div>
    ${options.length ? `<div class="opt-rows">${options.map(row).join("")}</div>` : ""}
    <h3 class="opt-h">Dónde comprar cada carta</h3>
    <div id="opt-detail">${best ? (best.key === "direct" ? directDetail() : zeroDetail()) : ""}${leftoverDetail()}</div>
    <p class="muted tiny">${ct ? `Ofertas de CardTrader del ${new Date(ct.updated).toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" })}: cartas en inglés, Near Mint o mejor, envío a España. ` : ""}Pokémon todavía no tiene ofertas de CardTrader: se estima con Cardmarket. Los precios pueden haber cambiado y no incluyen comisiones de pago. Para comprar, abre cada carta y elige la oferta del país indicado.</p>`;

  out.querySelectorAll("[data-show]").forEach((b) => {
    b.onclick = () => {
      out.querySelectorAll("[data-show]").forEach((x) => x.classList.toggle("best", x === b));
      $("opt-detail").innerHTML = (b.dataset.show === "direct" ? directDetail() : zeroDetail()) + leftoverDetail();
    };
  });
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
      <p>Te enviamos un enlace a tu email para entrar, sin contraseñas. Lo que tengas guardado en este navegador se une a tu cuenta.</p>
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
}

// ---------- Navegación ----------
const VIEWS = ["view-sets", "view-set", "view-collection", "view-lists", "view-list", "view-cart"];
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
$("btn-miss-cart").onclick = () => {
  const miss = current.cards.filter((c) => !State.has(c.id) && !State.cartQty(c.id));
  if (!miss.length) { toast("Ya tienes (o están en el carrito) todas las cartas"); return; }
  for (const c of miss) State.addToCart(c, gameId, current);
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
$("col-search").addEventListener("input", renderCollection);
$("col-sort").addEventListener("change", renderCollection);

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
  if (e.key === "Escape") ["drawer", "card-modal", "account-modal"].forEach((id) => ($(id).hidden = true));
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
Auth.init().catch((e) => console.warn("Login no disponible", e));
