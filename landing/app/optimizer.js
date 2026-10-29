// Optimizador de compra: elige qué vendedores de CardTrader combinar para pagar lo mínimo
// sumando precio de las cartas y gastos de envío. Todo en céntimos.
//
// data = { sellers: [{ c, z, m: [{ t: [[desde_g, hasta_g, céntimos]], fq, fp, max }] }], cards: { id: { bp, o: [[céntimos, vendedor, cantidad]] } }, zeroShipping }

const GRAMS_PER_CARD = 2;     // CardTrader calcula ~2 g por carta suelta
const ENVELOPE_GRAMS = 10;

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

function total(plan, offersOf, sellers) {
  const per = new Map();
  let items = 0;
  plan.forEach((k, i) => {
    const [price, s] = offersOf[i][k];
    items += price;
    const g = per.get(s) || { n: 0, sub: 0 };
    g.n++; g.sub += price;
    per.set(s, g);
  });
  let ship = 0;
  for (const [s, g] of per) ship += shippingCost(sellers[s], g.n, g.sub);
  return { items, ship, sum: items + ship, per };
}

// Compra directa a vendedores: punto de partida "la más barata de cada carta" y mejora local
// (mover cartas de vendedor y cerrar vendedores) mientras baje el total.
function optimizeDirect(cardIds, data) {
  const sellers = data.sellers;
  const ids = [], offersOf = [];
  const missing = [];
  for (const id of cardIds) {
    const o = (data.cards[id]?.o || []).filter(([, s]) => (sellers[s].m || []).length);
    if (o.length) { ids.push(id); offersOf.push(o); } else missing.push(id);
  }
  if (!ids.length) return { ids, plan: [], offersOf, missing, ...total([], [], sellers) };

  let plan = offersOf.map(() => 0);
  let cur = total(plan, offersOf, sellers);

  for (let round = 0; round < 60; round++) {
    let improved = false;

    // 1) Mover una carta a otra oferta
    for (let i = 0; i < plan.length; i++) {
      for (let k = 0; k < offersOf[i].length; k++) {
        if (k === plan[i]) continue;
        const prev = plan[i];
        plan[i] = k;
        const t = total(plan, offersOf, sellers);
        if (t.sum < cur.sum) { cur = t; improved = true; } else plan[i] = prev;
      }
    }

    // 2) Cerrar un vendedor: pasar todas sus cartas a vendedores ya usados (o a su mejor alternativa)
    for (const s of [...cur.per.keys()]) {
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
      const t = total(trial, offersOf, sellers);
      if (t.sum < cur.sum) { plan = trial; cur = t; improved = true; }
    }

    if (!improved) break;
  }
  return { ids, plan, offersOf, missing, ...cur };
}

// CardTrader Zero: la oferta más barata de vendedores Zero para cada carta + un único envío desde el hub.
function optimizeZero(cardIds, data) {
  let items = 0;
  const picks = [], missing = [];
  for (const id of cardIds) {
    const best = (data.cards[id]?.o || []).find(([, s]) => data.sellers[s].z);
    if (best) { items += best[0]; picks.push([id, best]); } else missing.push(id);
  }
  const ship = picks.length ? data.zeroShipping : 0;
  return { items, ship, sum: items + ship, picks, missing };
}

window.Optimizer = { shippingCost, optimizeDirect, optimizeZero };
