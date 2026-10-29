// Binder — cuentas de usuario con Supabase (login por enlace mágico al email).
// Los datos del usuario (State) se guardan como un único documento JSON en la tabla user_data.
// Sin configurar (URL vacía), la app funciona igual y guarda todo solo en este navegador.

const SUPABASE_URL = "https://osaysgrdmdtpepgnruzd.supabase.co";
const SUPABASE_KEY = "sb_publishable_BdAC27xK56aqhwzyyOcGAQ_hQSRIuAi";   // clave pública "anon" / "publishable": es segura en el navegador gracias a RLS

const Auth = (() => {
  let client = null;
  let user = null;
  const listeners = new Set();
  let pushTimer = null;
  let syncing = false;

  const enabled = () => !!(SUPABASE_URL && SUPABASE_KEY);
  const notify = () => listeners.forEach((fn) => fn(user));

  function loadLib() {
    return new Promise((resolve, reject) => {
      if (window.supabase) return resolve();
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js";
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  async function pull() {
    const { data, error } = await client.from("user_data").select("data").eq("user_id", user.id).maybeSingle();
    if (error) throw error;
    return data?.data || null;
  }

  async function push() {
    if (!user) return;
    const { error } = await client.from("user_data").upsert({ user_id: user.id, data: State.snapshot(), updated_at: new Date().toISOString() });
    if (error) console.warn("No se pudo guardar en la nube", error.message);
  }

  // Al entrar se cambia al perfil de la cuenta. Lo guardado como invitado solo se pasa a la cuenta
  // si el usuario lo acepta (y entonces se borra del perfil de invitado).
  let pending = null;
  async function onSignedIn(u) {
    if (pending === u.id || user?.id === u.id) return;
    pending = u.id;
    syncing = true;
    try {
      let remote = null;
      try { remote = await pull(); } catch (e) { console.warn("No se pudo leer la nube", e.message); }
      const guest = State.guestData();
      user = u;
      State.useAccount(u.id, remote || State.cachedAccount(u.id));
      if (!State.isEmpty(guest)) {
        const extra = Object.keys(guest.owned).filter((id) => !State.data.owned[id]).length
          + guest.lists.filter((l) => !State.list(l.id)).length
          + Object.keys(guest.cart).filter((k) => !State.data.cart[k]).length;
        if (!extra) State.clearGuest();
        else if (confirm(`En este navegador tenías cartas, listas o carrito guardados sin cuenta.\n\n¿Quieres pasarlos a tu cuenta (${u.email})?\n\nSi dices que no, se quedan aparte y los verás al cerrar sesión.`)) {
          State.mergeFrom(guest);
          State.clearGuest();
        }
      }
      await push();
    } finally {
      syncing = false;
      pending = null;
      notify();
    }
  }

  State.onChange(() => {
    if (!user || syncing) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(push, 1200);
  });

  return {
    enabled,
    get user() { return user; },
    onChange(fn) { listeners.add(fn); },
    async init() {
      if (!enabled()) return;
      await loadLib();
      client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
      client.auth.onAuthStateChange((event, session) => {
        if (session?.user) onSignedIn(session.user);
        if (event === "SIGNED_OUT" && user) { user = null; State.useGuest(); notify(); }
      });
      const { data } = await client.auth.getSession();
      if (data.session?.user) onSignedIn(data.session.user);
    },
    async signIn(email) {
      const { error } = await client.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
      if (error) throw error;
    },
    async signOut() {
      await push();
      await client.auth.signOut();
      if (user) { user = null; State.useGuest(); notify(); }
    },
  };
})();
