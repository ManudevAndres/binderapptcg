// Binder — cuentas de usuario con Supabase (login por enlace mágico al email).
// Los datos del usuario (State) se guardan como un único documento JSON en la tabla user_data.
// Sin configurar (URL vacía), la app funciona igual y guarda todo solo en este navegador.

const SUPABASE_URL = "";
const SUPABASE_KEY = "";   // clave pública "anon" / "publishable": es segura en el navegador gracias a RLS

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

  async function onSignedIn(u) {
    user = u;
    notify();
    syncing = true;
    try {
      const remote = await pull();
      if (remote) State.merge(remote);
      await push();
    } catch (e) {
      console.warn("Sincronización fallida", e.message);
    } finally {
      syncing = false;
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
        if (session?.user && session.user.id !== user?.id) onSignedIn(session.user);
        if (event === "SIGNED_OUT") { user = null; notify(); }
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
    },
  };
})();
