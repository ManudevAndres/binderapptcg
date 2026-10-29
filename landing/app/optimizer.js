// Optimizador de compra: elige qué vendedores de CardTrader combinar para pagar lo mínimo
// sumando precio de las cartas y gastos de envío. Todo en céntimos.
//
// data  = { sellers: [{ c, z, m: [{ t: [[desde_g, hasta_g, céntimos]], fq, fp, max }] }],
//          cards: { id: { bp, o: { idioma: [[céntimos, vendedor, cantidad]] } } }, zeroShipping }
// items = lista de "id@idioma"; uno repetido = varias copias de esa carta

const GRAMS_PER_CARD = 2;     // CardTrader calcula ~2 g por carta suelta
const ENVELOPE_GRAMS = 10;

function offersFor(key, data) {
  const [id, lang] = key.split("@");
  return data.cards[id]?.o?.[lang] || [];
}

// Coste de envío de un vendedor para n cartas con ese subtotal (Infinity si no envía).
function shippingCost(seller, n, subtotal) {
  if (!n) return 0;
  const grams = n * GRAMS_PER_CARD + ENVELOPE_GRAMS;
  let best = Infinity;
  for (const m of seller.m || []) {
    if (m.max != null && subtotal > m.max) continue;
    if ((m.fp != null && subtotal >= m.fp) || (m.fq != null && n >= m.fq)) return 0;
    const tier = m.t.find(([from, to]) => grams >= from && grams <= to) || (grams < m.t[0][0] ? m.t[0] : null);
    if (tier && tier[2] < best) best = tier[2];
  }
  return best;
}

function evaluate(plan, items, offersOf, sellers) {
  const per = new Map();
  const used = new Map();
  let cost = 0;
  for (let i = 0; i < plan.length; i++) {
    const [price, s, qty] = offersOf[i][plan[i]];
    const key = items[i] + "|" + plan[i];
    const u = (used.get(key) || 0) + 1;
    if (u > qty) return { sum: Infinity };          // no hay tantas copias en esa oferta
    used.set(key, u);
    cost += price;
    const g = per.get(s) || { n: 0, sub: 0 };
    g.n++; g.sub += price;
    per.set(s, g);
  }
  let ship = 0;
  for (const [s, g] of per) ship += shippingCost(sellers[s], g.n, g.sub);
  return { items: cost, ship, sum: cost + ship, per };
}

// Compra directa a vendedores: punto de partida "la más barata de cada carta" y mejora local
// (mover cartas de vendedor y cerrar vendedores) mientras baje el total.
function optimizeDirect(itemIds, data) {
  const sellers = data.sellers;
  const items = [], offersOf = [], missing = [];
  for (const id of itemIds) {
    const o = offersFor(id, data).filter(([, s]) => (sellers[s].m || []).length);
    if (o.length) { items.push(id); offersOf.push(o); } else missing.push(id);
  }
  if (!items.length) return { items, plan: [], offersOf, missing, items_: 0, ship: 0, sum: 0, cost: 0, per: new Map() };

  // Inicial: cada copia en la oferta más barata con existencias
  const plan = [];
  const used = new Map();
  items.forEach((id, i) => {
    let k = offersOf[i].findIndex(([, , q], kk) => (used.get(id + "|" + kk) || 0) < q);
    if (k < 0) k = 0;
    used.set(id + "|" + k, (used.get(id + "|" + k) || 0) + 1);
    plan.push(k);
  });
  let cur = evaluate(plan, items, offersOf, sellers);

  for (let round = 0; round < 60; round++) {
    let improved = false;

    // 1) Mover una copia a otra oferta
    for (let i = 0; i < plan.length; i++) {
      for (let k = 0; k < offersOf[i].length; k++) {
        if (k === plan[i]) continue;
        const prev = plan[i];
        plan[i] = k;
        const t = evaluate(plan, items, offersOf, sellers);
        if (t.sum < cur.sum) { cur = t; improved = true; } else plan[i] = prev;
      }
    }

    // 2) Cerrar un vendedor: pasar sus cartas a vendedores ya usados (o a su mejor alternativa)
    if (cur.per) for (const s of [...cur.per.keys()]) {
      const trial = plan.slice();
      let ok = true;
      for (let i = 0; i < trial.length && ok; i++) {
        if (offersOf[i][trial[i]][1] !== s) continue;
        let bestK = -1, bestP = Infinity;
        offersOf[i].forEach(([p, s2], k) => {
          if (s2 === s) return;
          const bonus = cur.per.has(s2) ? 0 : 1e6;   // prioriza vendedores que ya están en el carrito
          if (p + bonus < bestP) { bestP = p + bonus; bestK = k; }
        });
        if (bestK < 0) ok = false; else trial[i] = bestK;
      }
      if (!ok) continue;
      const t = evaluate(trial, items, offersOf, sellers);
      if (t.sum < cur.sum) { plan.splice(0, plan.length, ...trial); cur = t; improved = true; }
    }

    if (!improved) break;
  }
  return { items, plan, offersOf, missing, cost: cur.items, ship: cur.ship, sum: cur.sum, per: cur.per };
}

// CardTrader Zero: la oferta más barata de vendedores Zero para cada copia + un único envío desde el hub.
function optimizeZero(itemIds, data) {
  let cost = 0;
  const picks = [], missing = [];
  const used = new Map();
  for (const id of itemIds) {
    const offers = offersFor(id, data);
    const k = offers.findIndex(([, s, q], kk) => data.sellers[s].z && (used.get(id + "|" + kk) || 0) < q);
    if (k >= 0) {
      used.set(id + "|" + k, (used.get(id + "|" + k) || 0) + 1);
      cost += offers[k][0];
      picks.push([id, offers[k]]);
    } else missing.push(id);
  }
  const ship = picks.length ? data.zeroShipping : 0;
  return { cost, ship, sum: cost + ship, picks, missing };
}

// Combinado: parte del carrito directo a vendedores y parte por CardTrader Zero (un solo envío del hub).
// Parte del plan directo y pasa a Zero los vendedores cuyo lote sale más caro que comprarlo por Zero.
function optimizeMixed(itemIds, data) {
  const direct = optimizeDirect(itemIds, data);
  if (!direct.items.length) return null;
  const groups = new Map();
  direct.plan.forEach((k, i) => {
    const [price, s] = direct.offersOf[i][k];
    if (!groups.has(s)) groups.set(s, { items: [], cost: 0 });
    const g = groups.get(s);
    g.items.push(direct.items[i]);
    g.cost += price;
  });
  const toZero = [];
  for (const [s, g] of groups) {
    const ship = shippingCost(data.sellers[s], g.items.length, g.cost);
    const z = optimizeZero(g.items, data);
    if (!z.missing.length && z.cost < g.cost + ship) toZero.push({ items: g.items, saving: g.cost + ship - z.cost });
  }
  if (!toZero.length) return null;
  const zeroItems = toZero.flatMap((x) => x.items);
  const pending = new Map();
  for (const id of zeroItems) pending.set(id, (pending.get(id) || 0) + 1);
  const rest = direct.items.filter((id) => {
    const n = pending.get(id) || 0;
    if (n) { pending.set(id, n - 1); return false; }
    return true;
  });
  const zeroPart = optimizeZero(zeroItems, data);
  const directPart = optimizeDirect(rest, data);
  const sum = zeroPart.sum + directPart.sum;
  return { direct: directPart, zero: zeroPart, cost: zeroPart.cost + directPart.cost, ship: zeroPart.ship + directPart.ship, sum, missing: direct.missing, envios: directPart.per.size + 1 };
}

window.Optimizer = { shippingCost, optimizeDirect, optimizeZero, optimizeMixed, offersFor };
