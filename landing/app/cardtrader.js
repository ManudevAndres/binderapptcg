// Binder — conexión con la cuenta de CardTrader del propio usuario.
// El token se guarda SOLO en este dispositivo (nunca en la nube de Binder) y las llamadas van directas
// del navegador a la API de CardTrader. Solo se usa para ver ofertas en vivo y añadir cartas al carrito:
// la compra la confirma siempre el usuario en cardtrader.com.

const CardTraderAccount = (() => {
  const API = "https://api.cardtrader.com/api/v2";
  const KEY = "ct-token";
  const CONDITIONS = new Set(["Mint", "Near Mint"]);
  // Vendedor "de confianza": profesional, envía por CardTrader Zero o tiene envío en 24 h
  const trusted = (u) => u.user_type === "pro" || u.can_sell_via_hub || u.one_day_ready;
  // Se acepta un vendedor no destacado solo si es al menos un 15 % más barato
  const TRUST_MARGIN = 0.85;

  let info = null;
  const token = () => store.get(KEY);

  async function call(path, { method = "GET", body = null } = {}) {
    const res = await fetch(API + path, {
      method,
      headers: { Authorization: "Bearer " + token(), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : null,
    });
    if (res.status === 401) throw new Error("El token de CardTrader no es válido o ha caducado.");
    if (res.status === 429) throw new Error("CardTrader pide ir más despacio; inténtalo en unos segundos.");
    if (!res.ok) throw new Error(`CardTrader respondió ${res.status}`);
    return res.json();
  }

  function offerOk(o, lang) {
    const p = o.properties_hash || {};
    const l = Object.entries(p).find(([k]) => k.endsWith("language"))?.[1] || "en";
    if (l !== lang || !CONDITIONS.has(p.condition) || p.signed || p.altered) return false;
    if (Object.entries(p).some(([k, v]) => (k.includes("reverse") || k.includes("first_edition")) && v === true)) return false;
    return !o.graded && !o.on_vacation && (o.quantity || 0) > 0;
  }

  // Mejor oferta calidad/precio: la más barata de un vendedor de confianza, salvo que otra sea mucho más barata
  function pickBest(offers, zero) {
    const list = offers.filter((o) => !zero || o.user.can_sell_via_hub).sort((a, b) => a.price.cents - b.price.cents);
    if (!list.length) return null;
    const bestTrusted = list.find((o) => trusted(o.user));
    if (!bestTrusted) return list[0];
    return list[0].price.cents <= bestTrusted.price.cents * TRUST_MARGIN ? list[0] : bestTrusted;
  }

  return {
    connected: () => !!token(),
    get info() { return info; },
    async connect(t) {
      store.set(KEY, t.trim());
      try { info = await call("/info"); return info; }
      catch (e) { store.remove(KEY); info = null; throw e; }
    },
    disconnect() { store.remove(KEY); info = null; },
    async load() { if (token() && !info) { try { info = await call("/info"); } catch { /* token caducado */ } } return info; },

    // Busca en vivo la mejor oferta de una carta (blueprint) en un idioma y la añade al carrito de CardTrader.
    async addBest(bp, lang, { zero = false, qty = 1 } = {}) {
      const market = await call(`/marketplace/products?blueprint_id=${bp}&language=${encodeURIComponent(lang)}`);
      const offers = (market[bp] || market[String(bp)] || []).filter((o) => offerOk(o, lang));
      const best = pickBest(offers, zero) || (zero ? null : pickBest(offers, false));
      if (!best) return null;
      await call("/cart/add", { method: "POST", body: { product_id: best.id, quantity: Math.min(qty, best.quantity), via_cardtrader_zero: zero && !!best.user.can_sell_via_hub } });
      return { price: best.price.cents, country: best.user.country_code, pro: best.user.user_type === "pro", zero: zero && !!best.user.can_sell_via_hub, trusted: trusted(best.user) };
    },
  };
})();
