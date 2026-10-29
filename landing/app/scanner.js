// Binder — escanear cartas con la cámara para marcarlas en el set abierto.
// Lee el número impreso abajo en la carta con OCR en el propio navegador (Tesseract.js, sin servidores):
//   Pokémon:  "001/165"   (número / total del set)
//   One Piece: "OP01-001" (código de la carta)

const Scanner = (() => {
  const TESSERACT = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
  let worker = null;
  let stream = null;
  let timer = null;
  let busy = false;
  let onMatch = null;
  let lastId = null;
  let flip = false;

  function loadLib() {
    return new Promise((resolve, reject) => {
      if (window.Tesseract) return resolve();
      const s = document.createElement("script");
      s.src = TESSERACT;
      s.onload = resolve;
      s.onerror = () => reject(new Error("No se pudo cargar el lector de texto"));
      document.head.appendChild(s);
    });
  }

  async function getWorker() {
    if (worker) return worker;
    await loadLib();
    worker = await Tesseract.createWorker("eng");
    await worker.setParameters({ tessedit_char_whitelist: "0123456789/-ABCDEFGHIJKLMNOPQRSTUVWXYZ " });
    return worker;
  }

  // Zonas a leer (fracciones de la imagen): en la cámara, el recuadro guía del centro;
  // en una foto de la carta entera, la franja de abajo donde va el número.
  const VIDEO_ZONE = { x0: 0.08, y0: 0.32, x1: 0.92, y1: 0.68 };
  const CARD_BOTTOM = { x0: 0, y0: 0.82, x1: 1, y1: 1 };
  const CORNER_LEFT = { x0: 0, y0: 0.88, x1: 0.5, y1: 1, bin: true };    // número de Pokémon
  const CORNER_RIGHT = { x0: 0.5, y0: 0.88, x1: 1, y1: 1, bin: true };   // código de One Piece
  const WHOLE = { x0: 0, y0: 0, x1: 1, y1: 1 };

  // Recorta la zona, la amplía y la pasa a blanco y negro con más contraste.
  // Con bin: umbral adaptado al brillo medio (texto claro sobre fondo de color → se invierte).
  function crop(source, w, h, z) {
    const sx = w * z.x0, sy = h * z.y0, sw = w * (z.x1 - z.x0), sh = h * (z.y1 - z.y0);
    const scale = Math.min(4, Math.max(1, 1600 / sw));
    const c = document.createElement("canvas");
    c.width = Math.round(sw * scale);
    c.height = Math.round(sh * scale);
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.filter = "grayscale(1) contrast(1.6)";
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, c.width, c.height);
    if (z.bin) {
      const img = ctx.getImageData(0, 0, c.width, c.height);
      const d = img.data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += d[i];
      const mean = sum / (d.length / 4);
      const dark = mean < 128;     // fondo oscuro → el texto es claro: invertir
      for (let i = 0; i < d.length; i += 4) {
        const on = dark ? d[i] > mean + 40 : d[i] < mean - 40;
        d[i] = d[i + 1] = d[i + 2] = on ? 0 : 255;
      }
      ctx.putImageData(img, 0, 0);
    }
    return c;
  }

  // Busca en el texto leído una carta del set. cards = [{ id, n, code }]
  function match(text, cards) {
    // Errores típicos del OCR: "0P01" por "OP01", "O" por "0" en los números; a veces pega la rareza detrás
    const t = text.toUpperCase().replace(/\b0P(?=\d)/g, "OP").replace(/(?<=\d)O|O(?=\d{2})/g, "0");
    const op = t.match(/(OP|EB|ST|PRB)\s?-?(\d{2})\s?-\s?(\d{3})/);
    if (op) {
      const code = `${op[1]}${op[2]}-${op[3]}`;
      const found = cards.filter((c) => (c.code || "").toUpperCase() === code);
      if (found.length) return found;
    }
    for (const m of t.matchAll(/(\d{1,3})\s?\/\s?(\d{2,3})/g)) {
      const n = Number(m[1]);
      const found = cards.filter((c) => Number(String(c.n).replace(/\D/g, "")) === n && !c.code);
      if (found.length) return found;
    }
    return [];
  }

  async function readImage(source, w, h, cards, zones) {
    const wk = await getWorker();
    let text = "";
    for (const z of zones) {
      const { data } = await wk.recognize(crop(source, w, h, z));
      text += data.text + "\n";
      const found = match(data.text, cards);
      if (found.length) return { text, found };
    }
    return { text, found: [] };
  }

  async function tick(video, cards) {
    if (busy || !video.videoWidth) return;
    busy = true;
    try {
      // Alterna la lectura normal y la binarizada (fondos de color)
      flip = !flip;
      const r = await readImage(video, video.videoWidth, video.videoHeight, cards, [flip ? VIDEO_ZONE : { ...VIDEO_ZONE, bin: true }]);
      if (r.found.length && r.found[0].id !== lastId) {
        lastId = r.found[0].id;
        onMatch?.(r.found);
        setTimeout(() => { lastId = null; }, 4000);   // permite volver a escanear la misma carta luego
      }
    } catch (e) {
      console.warn(e);
    } finally {
      busy = false;
    }
  }

  return {
    supported: () => !!navigator.mediaDevices?.getUserMedia,
    async start(video, cards, cb) {
      onMatch = cb;
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      video.srcObject = stream;
      await video.play();
      await getWorker();
      timer = setInterval(() => tick(video, cards), 900);
    },
    stop() {
      clearInterval(timer);
      timer = null;
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
    },
    // Para fotos subidas (o pruebas): lee una imagen ya cargada
    async fromImage(img, cards) {
      return readImage(img, img.naturalWidth, img.naturalHeight, cards, [CARD_BOTTOM, CORNER_LEFT, CORNER_RIGHT, WHOLE]);
    },
    preload: () => getWorker(),
  };
})();
