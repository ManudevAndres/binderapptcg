// Binder — MVP de colección TCG.
// Pokémon: cartas y precios de Cardmarket en vivo desde la API pública de TCGdex (https://tcgdex.dev).
// One Piece: datos estáticos en data/onepiece/ generados por tools/build_onepiece.py
//            (catálogo de optcgapi.com + precios públicos diarios de Cardmarket).
// La colección se guarda en el navegador (localStorage) hasta que tengamos cuentas de usuario.

const DAY = 24 * 60 * 60 * 1000;
const PRICE_TTL = DAY;
const SET_TTL = 7 * DAY;
const CONCURRENCY = 6;
const TCGDEX = "https://api.tcgdex.net/v2/es";
// Copia de data/onepiece/ que GitHub Actions actualiza a diario. Vacío = usar solo la copia publicada.
const ONEPIECE_REMOTE = "https://raw.githubusercontent.com/ManudevAndres/binderapptcg/main/landing/app/data/onepiece/";
const ONEPIECE_LOCAL = "data/onepiece/";

const $ = (id) => document.getElementById(id);
const eur = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" });
const fmt = (n) => (n == null ? "–" : eur.format(n));

// ---------- Almacenamiento ----------
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

// Datos de One Piece: primero la copia diaria de GitHub; si falla, la que va con la web.
async function onePieceData(file) {
  if (ONEPIECE_REMOTE) {
    try { return await getJSON(ONEPIECE_REMOTE + file); } catch { /* sigue con la local */ }
  }
  return getJSON(ONEPIECE_LOCAL + file);
}

// ---------- Juegos ----------
// Cada juego sabe listar sus sets, cargar un set y (si hace falta) pedir el precio de una carta.
// Set: { id, name, logo, total, cards: [{ id, n, name, img, imgFallback, price?, idProduct? }] }
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
      if (!data) {
        const raw = await getJSON(TCGDEX + "/sets/" + encodeURIComponent(id));
        data = {
          id: raw.id, name: raw.name, logo: raw.logo ? raw.logo + ".png" : null,
          meta: [raw.serie?.name, raw.releaseDate && new Date(raw.releaseDate).getFullYear()],
          total: raw.cardCount.total,
          cards: raw.cards.map((c) => ({
            id: c.id, n: c.localId, name: c.name,
            img: c.image ? c.image + "/low.webp" : null,
            imgFallback: c.image ? c.image.replace("/es/", "/en/") + "/low.webp" : null,
          })),
        };
        store.set("set:pokemon:" + id, { t: Date.now(), v: data });
      }
      return data;
    },
    async price(cardId) {
      const hit = cached("p:" + cardId, PRICE_TTL);
      if (hit !== null) return hit;
      try {
        const card = await getJSON(TCGDEX + "/cards/" + encodeURIComponent(cardId));
        const cm = card.pricing?.cardmarket;
        const v = cm ? { price: cm.trend ?? cm.avg30 ?? cm.avg ?? null, idProduct: cm.idProduct ?? null } : { price: null, idProduct: null };
        store.set("p:" + cardId, { t: Date.now(), v });
        return v;
      } catch {
        return { price: null, idProduct: null };
      }
    },
  },

  onepiece: {
    name: "One Piece",
    cardmarket: "OnePiece",
    async sets() {
      const idx = await onePieceData("sets.json");
      this.pricesDate = idx.pricesCreatedAt;
      return idx.sets.map((s) => ({ id: s.id, name: s.name, code: s.id.replace(/-EB\d+$/, ""), logo: null, total: s.total }));
    },
    async set(id) {
      if (!this.pricesDate) await this.sets().catch(() => {});   // para mostrar la fecha de los precios
      const raw = await onePieceData(encodeURIComponent(id) + ".json");
      const parallels = raw.cards.filter((c) => c.parallel).length;
      return {
        id: raw.id, name: raw.name, logo: null,
        meta: ["One Piece Card Game", parallels ? `incluye ${parallels} paralelas` : null],
        total: raw.total,
        cards: raw.cards.map((c) => ({ ...c, img: c.image, imgFallback: null })),
      };
    },
    price: null,   // los precios ya vienen en los datos del set
  },
};

// ---------- Estado ----------
let gameId = "pokemon";
let allSets = [];
let current = null;          // set abierto
let owned = new Set();       // ids de cartas que tengo del set actual
let prices = {};             // cardId -> { price, idProduct } | null
let filter = "all";
let query = "";
let loadToken = 0;

const game = () => GAMES[gameId];

// ---------- Sets ----------
async function loadSets(id) {
  const token = ++loadToken;
  gameId = id;
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

function setTile(s, g, progress) {
  const b = document.createElement("button");
  b.className = "set-tile";
  const fallback = `<span class="fallback${s.code ? " code" : ""}">${escapeHtml(s.code || s.name)}</span>`;
  b.innerHTML = `
    <div class="logo-box">${s.logo ? `<img loading="lazy" src="${s.logo}" alt="">` : fallback}</div>
    <b>${escapeHtml(s.name)}</b>
    <small>${progress != null ? `${GAMES[g].name} · ${progress.have} / ${s.total} cartas` : `${s.total} cartas`}</small>
    ${progress != null ? `<div class="progress"><i style="width:${(progress.have / s.total) * 100}%"></i></div>` : ""}`;
  const img = b.querySelector("img");
  if (img) img.onerror = () => {
    if (img.src.includes("/es/")) { img.src = img.src.replace("/es/", "/en/"); return; }
    img.outerHTML = fallback;
  };
  b.onclick = () => { location.hash = `#/${g}/set/${encodeURIComponent(s.id)}`; };
  return b;
}

function renderSets() {
  const mine = store.get("mysets", {});
  const myBlock = $("my-sets");
  myBlock.innerHTML = "";
  const myIds = Object.keys(mine).filter((id) => store.get("col:" + id, []).length > 0);
  $("my-sets-block").hidden = myIds.length === 0;
  for (const id of myIds) {
    const s = mine[id];
    myBlock.appendChild(setTile(s, s.game || "pokemon", { have: store.get("col:" + id, []).length }));
  }

  const q = $("set-search").value.trim().toLowerCase();
  const list = $("all-sets");
  list.innerHTML = "";
  const shown = allSets.filter((s) => !q || s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q));
  if (!shown.length) list.innerHTML = `<p class="muted">No hay sets que coincidan.</p>`;
  for (const s of shown.slice(0, 120)) list.appendChild(setTile(s, gameId));
}

// ---------- Set ----------
async function openSet(g, id) {
  const token = ++loadToken;
  gameId = g;
  showView("set");
  $("cards").innerHTML = `<p class="muted">Cargando cartas…</p>`;
  $("set-name").textContent = "";
  $("set-meta").textContent = "";
  $("set-logo").hidden = true;

  let data;
  try {
    data = await game().set(id);
  } catch {
    if (token === loadToken) $("cards").innerHTML = `<p class="muted">No se pudo cargar el set. Revisa tu conexión e inténtalo de nuevo.</p>`;
    return;
  }
  if (token !== loadToken) return;

  current = data;
  owned = new Set(store.get("col:" + id, []));
  prices = {};
  if (!game().price) for (const c of data.cards) prices[c.id] = { price: c.price ?? null, idProduct: c.idProduct ?? null };
  document.title = `${data.name} — Binder`;

  $("set-name").textContent = data.name;
  $("set-meta").textContent = [...data.meta, `${data.cards.length} cartas`].filter(Boolean).join(" · ");
  const logo = $("set-logo");
  logo.onerror = () => { if (logo.src.includes("/es/")) logo.src = logo.src.replace("/es/", "/en/"); else logo.hidden = true; };
  if (data.logo) { logo.src = data.logo; logo.hidden = false; }

  renderCards();
  if (game().price) loadPrices(token);
}

function cardImg(c) {
  if (!c.img) return `<div class="noimg">${escapeHtml(c.name)}<br>#${escapeHtml(c.n)}</div>`;
  return `<img loading="lazy" src="${c.img}" data-fallback="${c.imgFallback || ""}" alt="${escapeHtml(c.name)}">`;
}

function priceLabel(p) {
  if (p === undefined) return `<span class="price">…</span>`;
  if (!p || p.price == null) return `<span class="price">sin precio</span>`;
  return `<span class="price${p.price >= 20 ? " hot" : ""}">${fmt(p.price)}</span>`;
}

function renderCards() {
  const grid = $("cards");
  grid.innerHTML = "";
  const q = query.toLowerCase();
  const frag = document.createDocumentFragment();
  for (const c of current.cards) {
    const has = owned.has(c.id);
    if (filter === "have" && !has) continue;
    if (filter === "miss" && has) continue;
    if (q && !c.name.toLowerCase().includes(q) && !c.n.toLowerCase().includes(q)) continue;
    const b = document.createElement("button");
    b.className = "c " + (has ? "have" : "miss");
    b.dataset.id = c.id;
    b.setAttribute("aria-pressed", has);
    b.title = has ? "La tengo (toca para quitar)" : "Me falta (toca para marcar)";
    b.innerHTML = `
      <div class="img">${cardImg(c)}</div>
      <span class="check">✓</span>
      ${c.parallel ? `<span class="tag">Paralela</span>` : ""}
      <div class="meta"><span class="name">${escapeHtml(c.name)}</span><span class="num">#${escapeHtml(c.n)}</span></div>
      ${priceLabel(prices[c.id])}`;
    frag.appendChild(b);
  }
  grid.appendChild(frag);
  if (!grid.children.length) grid.innerHTML = `<p class="muted">No hay cartas en esta vista.</p>`;
  grid.querySelectorAll("img").forEach((img) => {
    img.onerror = () => {
      if (img.dataset.fallback) { img.src = img.dataset.fallback; img.dataset.fallback = ""; }
      else img.replaceWith(Object.assign(document.createElement("div"), { className: "noimg", textContent: img.alt }));
    };
  });
  updateStats();
}

function toggle(id) {
  if (owned.has(id)) owned.delete(id); else owned.add(id);
  saveCollection();
  const el = document.querySelector(`.c[data-id="${CSS.escape(id)}"]`);
  if (el) {
    const has = owned.has(id);
    if ((filter === "have" && !has) || (filter === "miss" && has)) el.remove();
    else {
      el.className = "c " + (has ? "have" : "miss");
      el.setAttribute("aria-pressed", has);
    }
  }
  updateStats();
}

function saveCollection() {
  store.set("col:" + current.id, [...owned]);
  const mine = store.get("mysets", {});
  const s = allSets.find((x) => x.id === current.id);
  mine[current.id] = { id: current.id, name: current.name, logo: current.logo, code: s?.code, total: current.cards.length, game: gameId };
  store.set("mysets", mine);
}

function updateStats() {
  if (!current) return;
  const total = current.cards.length;
  const have = current.cards.filter((c) => owned.has(c.id)).length;
  let cost = 0, value = 0, missingPriced = 0, missingTotal = 0;
  for (const c of current.cards) {
    const p = prices[c.id]?.price;
    if (owned.has(c.id)) { if (p != null) value += p; }
    else { missingTotal++; if (p != null) { cost += p; missingPriced++; } }
  }
  $("st-have").textContent = `${have} / ${total}`;
  $("st-miss").textContent = total - have;
  $("set-progress").style.width = (total ? (have / total) * 100 : 0) + "%";
  const loaded = Object.keys(prices).length;
  const loading = loaded < total;
  $("st-cost").textContent = loading && loaded === 0 ? "…" : fmt(cost);
  $("st-value").textContent = loading && loaded === 0 ? "…" : fmt(value);
  const noPrice = missingTotal - missingPriced;
  const when = game().pricesDate ? ` (${new Date(game().pricesDate).toLocaleDateString("es-ES")})` : ", actualizados a diario";
  $("price-status").textContent = loading
    ? `Cargando precios de Cardmarket… ${loaded} / ${total}`
    : `Precios de tendencia de Cardmarket${when}.${noPrice ? ` ${noPrice} carta(s) que te faltan no tienen precio y no cuentan en el total.` : ""}`;
}

// ---------- Precios (solo juegos con precio en vivo) ----------
async function loadPrices(token) {
  const queue = current.cards.map((c) => c.id);
  let done = 0;
  const flush = () => { if (token === loadToken) updateStats(); };
  async function worker() {
    while (queue.length && token === loadToken) {
      const id = queue.shift();
      const p = await game().price(id);
      if (token !== loadToken) return;
      prices[id] = p;
      const el = document.querySelector(`.c[data-id="${CSS.escape(id)}"] .price`);
      if (el) el.outerHTML = priceLabel(p);
      if (++done % 8 === 0) flush();
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  flush();
}

// ---------- Lista de faltantes ----------
function missingCards() {
  return current.cards
    .filter((c) => !owned.has(c.id))
    .map((c) => ({ ...c, price: prices[c.id]?.price ?? null, idProduct: prices[c.id]?.idProduct ?? null }))
    .sort((a, b) => (b.price ?? -1) - (a.price ?? -1));
}

function cardmarketUrl(c) {
  const q = c.code ? `${c.name} ${c.code}` : c.name;
  return `https://www.cardmarket.com/es/${game().cardmarket}/Products/Search?searchString=${encodeURIComponent(q)}`;
}

function openDrawer() {
  const list = missingCards();
  const total = list.reduce((s, c) => s + (c.price ?? 0), 0);
  $("drawer-sum").textContent = list.length
    ? `${list.length} cartas · ${fmt(total)} en total (precio de tendencia)`
    : "¡No te falta ninguna carta de este set! 🎉";
  const ol = $("miss-list");
  ol.innerHTML = "";
  for (const c of list) {
    const li = document.createElement("li");
    li.innerHTML = `
      ${c.img ? `<img loading="lazy" src="${c.img}" alt="">` : ""}
      <div class="mi"><b>${escapeHtml(c.name)}${c.parallel ? " (paralela)" : ""}</b><small>#${escapeHtml(c.code || c.n)} · ${escapeHtml(current.name)}</small></div>
      <div class="mp">${fmt(c.price)}<a href="${cardmarketUrl(c)}" target="_blank" rel="noopener">Ver en Cardmarket ↗</a></div>`;
    ol.appendChild(li);
  }
  $("drawer").hidden = false;
}

function listAsText() {
  return missingCards()
    .map((c) => `1 ${c.name}${c.parallel ? " (paralela)" : ""} (${current.name}) #${c.code || c.n}${c.price != null ? ` - ${fmt(c.price)}` : ""}`)
    .join("\n");
}

function listAsCsv() {
  const rows = [["cantidad", "nombre", "set", "numero", "paralela", "id_cardmarket", "precio_tendencia_eur"]];
  for (const c of missingCards()) {
    rows.push([1, c.name, current.name, c.code || c.n, c.parallel ? "si" : "no", c.idProduct ?? "", c.price != null ? String(c.price).replace(".", ",") : ""]);
  }
  return rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(";")).join("\r\n");
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2200);
}

// ---------- Navegación ----------
function showView(v) {
  $("view-sets").hidden = v !== "sets";
  $("view-set").hidden = v !== "set";
  $("btn-home").hidden = v !== "set";
  window.scrollTo(0, 0);
}

function route() {
  const m = location.hash.match(/^#\/(?:(\w+)\/)?set\/(.+)$/);
  if (m) {
    const g = GAMES[m[1]] ? m[1] : "pokemon";
    openSet(g, decodeURIComponent(m[2]));
    return;
  }
  const g = location.hash.match(/^#\/(\w+)$/)?.[1];
  current = null;
  document.title = "Binder — Mi colección";
  showView("sets");
  loadSets(GAMES[g] ? g : gameId);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

// ---------- Eventos ----------
$("set-search").addEventListener("input", renderSets);
$("card-search").addEventListener("input", (e) => { query = e.target.value.trim(); renderCards(); });
$("btn-home").onclick = () => { location.hash = "#/" + gameId; };
document.querySelectorAll("#game-tabs button").forEach((b) => {
  b.onclick = () => { $("set-search").value = ""; location.hash = "#/" + b.dataset.game; };
});
$("cards").addEventListener("click", (e) => {
  const el = e.target.closest(".c");
  if (el) toggle(el.dataset.id);
});
document.querySelectorAll("#card-filter button").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll("#card-filter button").forEach((x) => x.classList.toggle("on", x === b));
    filter = b.dataset.filter;
    renderCards();
  };
});
$("btn-all").onclick = () => { current.cards.forEach((c) => owned.add(c.id)); saveCollection(); renderCards(); };
$("btn-none").onclick = () => {
  if (!confirm("¿Desmarcar todas las cartas de este set?")) return;
  owned.clear(); saveCollection(); renderCards();
};
$("btn-list").onclick = openDrawer;
$("drawer").addEventListener("click", (e) => { if (e.target.closest("[data-close]")) $("drawer").hidden = true; });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("drawer").hidden = true; });
$("btn-copy").onclick = async () => {
  try { await navigator.clipboard.writeText(listAsText()); toast("Lista copiada"); }
  catch { toast("No se pudo copiar"); }
};
$("btn-csv").onclick = () => {
  const blob = new Blob(["﻿" + listAsCsv()], { type: "text/csv;charset=utf-8" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `faltantes-${current.id}.csv` });
  a.click();
  URL.revokeObjectURL(a.href);
};
window.addEventListener("hashchange", route);

route();
