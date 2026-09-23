/* Mensagens de voz no estilo WhatsApp.
   - Grava em WAV (16 kHz, mono): toca em qualquer celular e computador (iPhone, Android, PC).
   - Mostra as barrinhas da voz ao vivo enquanto grava (crescem quando a pessoa fala mais alto).
   - Player com play/pausa, barrinhas que vão colorindo e o tempo. */
(function () {
  'use strict';
  const RATE = 16000;
  const BARS = 48;

  // ---------- Gravação ----------
  // Um único "motor de áudio" reaproveitado: a 2ª gravação em diante começa na hora
  let sharedCtx = null;
  function audioCtx() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!sharedCtx || sharedCtx.state === 'closed') sharedCtx = new Ctx();
    return sharedCtx;
  }

  class Recorder {
    constructor({ onLevel = () => {}, maxSecs = 300, onMax = () => {} } = {}) {
      this.onLevel = onLevel;
      this.maxSecs = maxSecs;
      this.onMax = onMax;
      this.chunks = [];
      this.levels = [];
      this.samples = 0;
    }

    static supported() {
      return !!(navigator.mediaDevices?.getUserMedia && (window.AudioContext || window.webkitAudioContext));
    }

    async start() {
      // Liga o motor ainda dentro do toque (o iPhone exige) e pede o microfone ao mesmo tempo
      this.ctx = audioCtx();
      const resumed = this.ctx.resume().catch(() => {});
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      await resumed;
      this.rate = this.ctx.sampleRate;
      this.src = this.ctx.createMediaStreamSource(this.stream);
      this.proc = this.ctx.createScriptProcessor(4096, 1, 1);
      this.proc.onaudioprocess = (e) => {
        const d = e.inputBuffer.getChannelData(0);
        this.chunks.push(new Float32Array(d));
        this.samples += d.length;
        let sum = 0;
        for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
        const level = Math.min(1, Math.sqrt(sum / d.length) * 4);
        this.levels.push(level);
        this.onLevel(level, this.seconds());
        if (this.seconds() >= this.maxSecs) this.onMax();
      };
      this.src.connect(this.proc);
      this.proc.connect(this.ctx.destination); // necessário para o processador rodar (sai em silêncio)
    }

    seconds() { return this.samples / (this.rate || 48000); }

    // Para a gravação e devolve { blob, secs, peaks }
    stop() {
      try { this.proc?.disconnect(); this.src?.disconnect(); } catch { /* ignora */ }
      if (this.proc) this.proc.onaudioprocess = null;
      this.stream?.getTracks().forEach((t) => t.stop());
      const secs = this.seconds();
      const pcm = downsample(this.chunks, this.samples, this.rate || 48000, RATE);
      return { blob: encodeWav(pcm, RATE), secs, peaks: peaksOf(this.levels) };
    }

    cancel() {
      try { this.proc?.disconnect(); this.src?.disconnect(); } catch { /* ignora */ }
      if (this.proc) this.proc.onaudioprocess = null;
      this.stream?.getTracks().forEach((t) => t.stop());
      this.chunks = [];
    }
  }

  function downsample(chunks, total, from, to) {
    const input = new Float32Array(total);
    let o = 0;
    for (const c of chunks) { input.set(c, o); o += c.length; }
    if (from === to) return input;
    const ratio = from / to;
    const out = new Float32Array(Math.floor(total / ratio));
    for (let i = 0; i < out.length; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(total, Math.floor((i + 1) * ratio));
      let sum = 0;
      for (let j = start; j < end; j++) sum += input[j];
      out[i] = sum / Math.max(1, end - start);
    }
    return out;
  }

  function encodeWav(pcm, rate) {
    const buf = new ArrayBuffer(44 + pcm.length * 2);
    const v = new DataView(buf);
    const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, pcm.length * 2, true);
    for (let i = 0; i < pcm.length; i++) {
      const s = Math.max(-1, Math.min(1, pcm[i]));
      v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  // Resume a voz em 48 barrinhas (dígitos 0-9) para desenhar a onda depois
  function peaksOf(levels) {
    if (!levels.length) return '';
    const out = [];
    const per = levels.length / BARS;
    let max = 0;
    const vals = [];
    for (let i = 0; i < BARS; i++) {
      const seg = levels.slice(Math.floor(i * per), Math.max(Math.floor(i * per) + 1, Math.floor((i + 1) * per)));
      const val = seg.length ? Math.max(...seg) : 0;
      vals.push(val);
      max = Math.max(max, val);
    }
    for (const val of vals) out.push(Math.round((max ? val / max : 0) * 9));
    return out.join('');
  }

  // ---------- Desenho das barrinhas ----------
  function barsHtml(peaks) {
    const p = (peaks && /^[0-9]+$/.test(peaks)) ? peaks : '3'.repeat(BARS);
    return [...p].map((d) => `<i style="height:${18 + Number(d) * 9}%"></i>`).join('');
  }

  function fmt(t) {
    t = Math.max(0, Math.floor(t || 0));
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  }

  // ---------- Player (um tocando por vez) ----------
  const PLAY = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15a1 1 0 0 0 1.5.9l12-7.5a1 1 0 0 0 0-1.8l-12-7.5A1 1 0 0 0 7 4.5z"/></svg>';
  const PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
  let current = null;

  function playerHtml({ src, secs, peaks, hint = false }) {
    const player = `<div class="vplayer" data-vsrc="${src}" data-vsecs="${Number(secs) || 0}">
      <button type="button" class="vplay" aria-label="Ouvir áudio">${PLAY}</button>
      <div class="vwave" role="slider" aria-label="Posição do áudio" tabindex="0">${barsHtml(peaks)}</div>
      <span class="vtime">${fmt(secs)}</span>
    </div>`;
    // Aviso miudinho embaixo do áudio enviado
    return hint ? `${player}<div class="vhint">Pode levar de 0 a 15 segundos para reproduzir.</div>` : player;
  }

  // O áudio toca direto do servidor (começa na hora, sem esperar baixar tudo) e o play()
  // é chamado no próprio toque — no iPhone isso evita ter que tocar duas vezes.
  // O mesmo áudio continua tocando mesmo se a conversa for redesenhada (chega mensagem nova etc.).
  const cache = new Map(); // src → { audio, el, paint }
  function audioFor(el) {
    const src = el.dataset.vsrc;
    let entry = cache.get(src);
    if (!entry) {
      const a = new Audio();
      a.preload = 'auto';
      a.src = src;
      entry = { audio: a, el };
      const total = () => (Number.isFinite(a.duration) && a.duration > 0 ? a.duration : Number(entry.el.dataset.vsecs) || 1);
      entry.paint = () => {
        if (!entry.el.isConnected) {
          const again = document.querySelector(`.vplayer[data-vsrc="${CSS.escape(src)}"]`);
          if (again) entry.el = again;
        }
        const bars = [...entry.el.querySelectorAll('.vwave i')];
        const on = Math.round(Math.min(1, a.currentTime / total()) * bars.length);
        bars.forEach((bar, i) => bar.classList.toggle('on', i < on));
        entry.el.querySelector('.vtime').textContent = fmt(!a.paused || a.currentTime > 0 ? a.currentTime : total());
        entry.el.classList.toggle('playing', !a.paused);
        entry.el.classList.toggle('loading', !a.paused && a.readyState < 3);
        entry.el.querySelector('.vplay').innerHTML = a.paused ? PLAY : PAUSE;
      };
      ['timeupdate', 'play', 'pause', 'playing', 'waiting', 'canplay'].forEach((ev) => a.addEventListener(ev, entry.paint));
      a.addEventListener('ended', () => { a.currentTime = 0; entry.paint(); });
      a.addEventListener('error', async () => {
        cache.delete(src);
        entry.el.classList.remove('playing', 'loading');
        entry.el.querySelector('.vplay').innerHTML = PLAY;
        let msg = 'Não foi possível tocar este áudio.';
        if (!src.startsWith('blob:')) {
          const r = await fetch(src, { method: 'HEAD', credentials: 'same-origin' }).catch(() => null);
          if (r && r.status === 404) msg = 'Este áudio foi apagado.';
        }
        (window.Acolia?.toast || alert)(msg, 'error');
      });
      cache.set(src, entry);
    }
    entry.el = el;
    el._paint = entry.paint;
    return entry.audio;
  }

  function toggle(el) {
    const a = audioFor(el);
    if (current && current !== a) current.pause();
    if (a.paused) {
      current = a;
      const p = a.play();
      el._paint();
      if (p) p.catch(() => {});
    } else a.pause();
  }

  async function seek(el, ev) {
    const wave = el.querySelector('.vwave');
    const r = wave.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
    try {
      const a = audioFor(el);
      const total = Number.isFinite(a.duration) && a.duration > 0 ? a.duration : Number(el.dataset.vsecs) || 0;
      a.currentTime = f * total;
      el._paint();
    } catch { /* ignora */ }
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.vplay');
    if (btn) return toggle(btn.closest('.vplayer'));
    const wave = e.target.closest('.vwave');
    if (wave) seek(wave.closest('.vplayer'), e);
  });

  function stopAll() { if (current) current.pause(); }

  window.AcoliaVoice = { Recorder, playerHtml, barsHtml, fmt, stopAll, BARS };
})();
