/* Sala de atendimento — chamada de vídeo/voz 1:1 via WebRTC.
   Regras:
   - O profissional entra com o seu código único; o paciente com o código gerado para ele.
   - Profissional e paciente podem ligar/desligar a câmera e o microfone.
   - A chamada continua se a pessoa sair da tela (responder WhatsApp etc.): o vídeo vai
     para uma janelinha flutuante (picture-in-picture) quando o aparelho permite.
   - Quando o profissional finaliza, o código do paciente deixa de valer. */
(function () {
  'use strict';
  const { $, $$, api, ICONS, esc, avatar, toast, confirmDialog } = Acolia;
  ['[data-logo]', '[data-logo2]', '[data-logo3]'].forEach((s) => { $(s).innerHTML = ICONS.logo; });

  const S = {
    role: null, code: '', info: null, iceServers: [], socket: null, pc: null, local: null,
    micOn: true, camOn: true, pendingIce: [], startedAt: null, timer: null, ended: false,
  };

  const show = (step) => $$('[data-step]').forEach((el) => el.classList.toggle('hidden', el.dataset.step !== step));

  // ---------- 1. Código ----------
  const codeForm = $('[data-code-form]');
  const params = new URLSearchParams(location.search);
  if (params.get('codigo')) {
    codeForm.code.value = params.get('codigo').toUpperCase();
    history.replaceState(null, '', location.pathname); // não deixa o código no histórico
  }
  Acolia.handleForm(codeForm, async (d) => {
    const code = d.code.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const r = await api('/api/calls/resolve', { method: 'POST', body: { code } });
    S.role = r.role;
    S.code = code;
    S.info = r;
    S.iceServers = (await api('/api/config')).iceServers;
    prejoin();
  });

  // ---------- 2. Pré-entrada: câmera e microfone ----------
  async function getMedia(video) {
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: video ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } : false,
    });
  }

  async function prejoin() {
    show('prejoin');
    const p = S.info.professional;
    const host = S.role === 'host';
    $('[data-pro-info]').innerHTML = host
      ? `<h2>Atendimento com ${esc(S.info.call.patient_label)}</h2>`
      : `<div class="row" style="justify-content:center">${avatar(p.name, p.photo)}<div style="text-align:left"><b>${esc(p.name)}</b><div class="muted small">${esc(p.profession)} · ${esc(p.registry)}</div></div></div>`;
    const msg = $('[data-prejoin-msg]');
    const actions = $('[data-prejoin-actions]');
    if (!navigator.mediaDevices?.getUserMedia) {
      msg.innerHTML = '<div class="notice danger">Seu navegador não permite chamadas de vídeo. Use Chrome, Edge, Firefox ou Safari atualizados.</div>';
      return;
    }
    msg.innerHTML = '<p class="muted">Permita o acesso à câmera e ao microfone…</p>';
    try {
      S.local = await getMedia(true);
    } catch (e) {
      try {
        S.local = await getMedia(false);
        msg.innerHTML = '<div class="notice info">Câmera indisponível — você vai entrar só com voz.</div>';
      } catch {
        msg.innerHTML = '<div class="notice danger">Precisamos do seu microfone para o atendimento. Libere a permissão no navegador e tente de novo.</div>';
        actions.innerHTML = '<button class="btn" data-retry>Tentar de novo</button>';
        $('[data-retry]').onclick = prejoin;
        return;
      }
    }
    $('[data-preview]').srcObject = S.local;
    const hasVideo = S.local.getVideoTracks().length > 0;
    if (hasVideo) msg.innerHTML = '';
    actions.innerHTML = (hasVideo ? `<button class="btn" data-join-video>${ICONS.video.replace('<svg', '<svg style="width:20px;height:20px"')} ${host ? 'Iniciar com vídeo' : 'Entrar com vídeo'}</button>` : '')
      + `<button class="btn ${hasVideo ? 'secondary' : ''}" data-join-audio>${ICONS.mic.replace('<svg', '<svg style="width:20px;height:20px"')} ${host ? 'Iniciar só com voz' : 'Entrar só com voz'}</button>`;
    $('[data-join-video]')?.addEventListener('click', () => join());
    $('[data-join-audio]').onclick = () => { setCamera(false); join(); };
  }

  // ---------- Quem é quem (nome e foto para o avatar quando a câmera desliga) ----------
  const safePhoto = (u) => (typeof u === 'string' && u.startsWith('/uploads/') ? u : null);
  function myIdentity() {
    if (S.role === 'host') return { name: S.info.professional.name, photo: safePhoto(S.info.professional.photo) };
    return S.meIdentity || { name: S.info.call.patient_label, photo: null };
  }
  function peerIdentity() {
    if (S.peerIdentity) return S.peerIdentity;
    return S.role === 'host' ? { name: S.info.call.patient_label, photo: null } : { name: S.info.professional.name, photo: safePhoto(S.info.professional.photo) };
  }
  const myCamLive = () => S.camOn && S.local?.getVideoTracks().some((t) => t.enabled && t.readyState === 'live');

  // ---------- Janelinha flutuante (picture-in-picture) com os DOIS vídeos ----------
  // O navegador só põe UM vídeo na janelinha. Então desenhamos numa tela (canvas) a outra
  // pessoa grande e você pequeno no canto — com o avatar de quem estiver com a câmera
  // desligada — e é essa imagem que vai para a janelinha. O som continua normal.
  const remoteEl = () => $('#remoteVideo');
  const pipEl = () => $('#pipVideo');
  const PIP = { canvas: null, ctx: null, tick: null, fast: false, images: {} };
  const pipSupported = () => !!(document.pictureInPictureEnabled || pipEl().webkitSupportsPresentationMode);
  const inPip = () => !!document.pictureInPictureElement
    || pipEl().webkitPresentationMode === 'picture-in-picture' || remoteEl().webkitPresentationMode === 'picture-in-picture';

  function photoImage(url) {
    if (!url) return null;
    if (!PIP.images[url]) { const img = new Image(); img.src = url; PIP.images[url] = img; }
    const img = PIP.images[url];
    return img.complete && img.naturalWidth ? img : null;
  }

  // Fundo da marca + foto de perfil (ou as iniciais), igual ao WhatsApp com a câmera desligada
  function drawAvatar(ctx, x, y, w, h, who) {
    const g = ctx.createLinearGradient(x, y, x + w, y + h);
    g.addColorStop(0, '#3f5550');
    g.addColorStop(1, '#6f8a83');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
    const r = Math.min(w, h) * 0.24;
    const cx = x + w / 2;
    const cy = y + h / 2;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.closePath();
    const img = photoImage(who.photo);
    if (img) {
      ctx.clip();
      const s = Math.max((2 * r) / img.naturalWidth, (2 * r) / img.naturalHeight);
      ctx.drawImage(img, cx - (img.naturalWidth * s) / 2, cy - (img.naturalHeight * s) / 2, img.naturalWidth * s, img.naturalHeight * s);
    } else {
      ctx.fillStyle = '#e5ebe8';
      ctx.fill();
      ctx.fillStyle = '#3f5550';
      ctx.font = `800 ${Math.round(r * 0.9)}px Nunito, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(Acolia.initials ? Acolia.initials(who.name) : (who.name || '?').slice(0, 2).toUpperCase(), cx, cy + r * 0.05);
    }
    ctx.restore();
  }

  function drawVideo(ctx, v, x, y, w, h, mirror) {
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    const s = Math.max(w / vw, h / vh); // preenche o quadro (corta as sobras)
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    if (mirror) { ctx.translate(x + w, y); ctx.scale(-1, 1); x = 0; y = 0; }
    ctx.drawImage(v, x + (w - vw * s) / 2, y + (h - vh * s) / 2, vw * s, vh * s);
    ctx.restore();
  }

  function drawPip() {
    const { canvas, ctx } = PIP;
    const remote = remoteEl();
    const peerVideo = !S.peerCamOff && remote.videoWidth > 0 && S.pc?.connectionState === 'connected';
    // A janelinha acompanha o formato do vídeo da outra pessoa (em pé ou deitado)
    const portrait = peerVideo && remote.videoHeight > remote.videoWidth;
    const W = portrait ? 360 : 640;
    const H = portrait ? 640 : 360;
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    if (peerVideo) drawVideo(ctx, remote, 0, 0, W, H, false);
    else drawAvatar(ctx, 0, 0, W, H, peerIdentity());
    // Você, pequeno no canto
    const tw = Math.round(Math.min(W, H) * 0.34);
    const th = Math.round(tw * 4 / 3);
    const tx = W - tw - 10;
    const ty = H - th - 10;
    const local = $('#localVideo');
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,.9)';
    ctx.fillRect(tx - 2, ty - 2, tw + 4, th + 4);
    ctx.restore();
    if (myCamLive() && local.videoWidth > 0) drawVideo(ctx, local, tx, ty, tw, th, true);
    else drawAvatar(ctx, tx, ty, tw, th, myIdentity());
  }

  // Relógio num "worker": continua batendo mesmo com a aba em segundo plano
  function startPipClock(fps) {
    stopPipClock();
    const ms = Math.round(1000 / fps);
    try {
      const src = `let t=setInterval(()=>postMessage(0),${ms});onmessage=()=>{clearInterval(t)}`;
      PIP.tick = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      PIP.tick.onmessage = drawPip;
    } catch {
      PIP.tick = { interval: setInterval(drawPip, ms) };
    }
  }
  function stopPipClock() {
    if (!PIP.tick) return;
    if (PIP.tick.interval) clearInterval(PIP.tick.interval);
    else PIP.tick.terminate();
    PIP.tick = null;
  }

  // Prepara a imagem da janelinha desde o início (devagar), para ela abrir na hora
  function setupPipSource() {
    PIP.canvas = document.createElement('canvas');
    PIP.canvas.width = 640;
    PIP.canvas.height = 360;
    PIP.ctx = PIP.canvas.getContext('2d');
    drawPip();
    if (!PIP.canvas.captureStream) return false;
    const v = pipEl();
    v.srcObject = PIP.canvas.captureStream(24);
    v.play().catch(() => {});
    startPipClock(4);
    v.addEventListener('enterpictureinpicture', () => startPipClock(24));
    v.addEventListener('leavepictureinpicture', () => startPipClock(4));
    v.addEventListener('webkitpresentationmodechanged', () => startPipClock(inPip() ? 24 : 4));
    return true;
  }

  // A janelinha precisa ser pedida NA HORA do toque: nada de esperar outra coisa antes, senão o
  // Safari (iPhone) e alguns Android recusam. Se a imagem montada (os dois vídeos) não puder ir
  // para a janelinha, tenta o vídeo da outra pessoa direto (plano B).
  function enterPip({ fromTap = false } = {}) {
    if (S.ended || !PIP.canvas || inPip()) return;
    const v = pipEl();
    startPipClock(24);
    drawPip();
    if (v.paused) v.play().catch(() => {});
    const planB = () => {
      const r = remoteEl();
      try {
        if (r.requestPictureInPicture && r.readyState >= 1 && r.videoWidth) return r.requestPictureInPicture();
        if (r.webkitSupportsPresentationMode?.('picture-in-picture')) { r.webkitSetPresentationMode('picture-in-picture'); return Promise.resolve(); }
      } catch (e) { return Promise.reject(e); }
      return Promise.reject(new Error('sem janelinha'));
    };
    let p;
    try {
      if (v.webkitSupportsPresentationMode?.('picture-in-picture') && !document.pictureInPictureEnabled) {
        v.webkitSetPresentationMode('picture-in-picture'); // Safari antigo: é síncrono
        p = Promise.resolve();
      } else if (v.requestPictureInPicture && v.readyState >= 1) p = v.requestPictureInPicture();
      else p = planB();
    } catch { p = planB(); }
    p.catch(() => planB()).catch(() => {
      if (fromTap) toast('Seu navegador não abriu a janelinha. Se sair do site, a chamada continua só com áudio.', 'error');
    });
  }
  async function exitPip() {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (pipEl().webkitPresentationMode === 'picture-in-picture') pipEl().webkitSetPresentationMode('inline');
      else if (remoteEl().webkitPresentationMode === 'picture-in-picture') remoteEl().webkitSetPresentationMode('inline');
    } catch { /* ignora */ }
  }

  // ---------- Saiu do site ----------
  // Sem a janelinha: a câmera desliga (a outra pessoa vê a sua foto), mas o áudio continua —
  // você fala e escuta normalmente. Com a janelinha: tudo continua (câmera e vídeos).
  // Ao voltar, a câmera religa sozinha (se estava ligada antes).
  let bgTimer = null;
  function pauseCameraForBackground() {
    if (S.ended || !S.camOn || inPip() || document.visibilityState !== 'hidden') return;
    S.bgCamPaused = true;
    setCamera(false);
    renderControls();
    sendMediaState();
  }
  async function backToForeground() {
    clearTimeout(bgTimer);
    if (S.ended) return;
    remoteEl().play().catch(() => {});
    $('#remoteAudio').play().catch(() => {});
    $('#localVideo').play().catch(() => {});
    await ensureMic();
    const wantCam = S.bgCamPaused || (S.camOn && !S.local.getVideoTracks().some((t) => t.readyState === 'live'));
    S.bgCamPaused = false;
    if (wantCam) await cameraOn(true);
  }
  // O celular pode ter cortado o microfone enquanto estava fora: pega de novo e devolve para a chamada
  async function ensureMic() {
    if (S.local.getAudioTracks().some((t) => t.readyState === 'live')) return;
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const track = s.getAudioTracks()[0];
      track.enabled = S.micOn;
      S.local.getAudioTracks().forEach((t) => S.local.removeTrack(t));
      S.local.addTrack(track);
      const tr = S.pc?.getTransceivers().find((t) => t.receiver.track.kind === 'audio');
      if (tr) await tr.sender.replaceTrack(track);
    } catch { /* sem permissão agora */ }
  }

  function setupBackground() {
    const ok = setupPipSource();
    const v = pipEl();
    v.autoPictureInPicture = true; // Safari: entra sozinho na janelinha ao sair
    const ms = navigator.mediaSession;
    if (ms) {
      try { ms.metadata = new MediaMetadata({ title: 'Atendimento Acolia', artist: peerIdentity().name, artwork: [{ src: '/img/app-icon-512.png', sizes: '512x512', type: 'image/png' }] }); } catch { /* ignora */ }
      const on = (action, fn) => { try { ms.setActionHandler(action, fn); } catch { /* não suportado */ } };
      on('enterpictureinpicture', enterPip); // Chrome: janelinha automática ao trocar de app/aba
      on('togglemicrophone', () => $('[data-mic]').click());
      on('togglecamera', () => $('[data-cam]').click());
      on('hangup', () => $('[data-end]').click());
    }
    // Tentativa extra ao sair da tela (funciona em alguns navegadores)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        enterPip(); // alguns navegadores abrem a janelinha sozinhos ao sair
        clearTimeout(bgTimer);
        bgTimer = setTimeout(pauseCameraForBackground, 1200); // não abriu? desliga só a câmera
      } else backToForeground();
    });
    // Fechou a janelinha estando fora do site: aí a câmera desliga (o áudio continua)
    for (const el of [pipEl(), remoteEl()]) {
      el.addEventListener('leavepictureinpicture', () => { clearTimeout(bgTimer); bgTimer = setTimeout(pauseCameraForBackground, 300); });
      el.addEventListener('webkitpresentationmodechanged', () => { if (!inPip()) { clearTimeout(bgTimer); bgTimer = setTimeout(pauseCameraForBackground, 300); } });
    }
    const btn = $('[data-pip]');
    btn.classList.toggle('hidden', !ok || !pipSupported());
    btn.innerHTML = ICONS.pip;
    btn.addEventListener('click', () => (inPip() ? exitPip() : enterPip({ fromTap: true })));
  }

  // ---------- 3. Sala ----------
  function join() {
    show('call');
    document.body.classList.add('call-page');
    $('#localVideo').srcObject = S.local;
    const host = S.role === 'host';
    renderPeerIdentity();
    // Paciente logado: usa o nome e a foto do perfil dele no avatar (quando a câmera desliga)
    if (!host) {
      api('/api/auth/me').then((r) => {
        if (r.role !== 'patient') return;
        S.meIdentity = { name: r.user.display_name || r.user.name, photo: safePhoto(r.user.photo) };
        renderControls();
        sendMediaState();
      }).catch(() => {});
    }
    overlay(host ? 'Aguardando o paciente entrar…' : 'Aguardando o profissional…');

    renderControls();
    setupBackground();
    S.socket = io();
    S.socket.on('connect', () => {
      S.socket.emit('call:join', { code: S.code }, (r) => {
        if (r.error) return finish(r.error, true);
        status(r.peerPresent ? 'Conectando…' : 'Aguardando…');
        sendMediaState();
        if (host && r.peerPresent) startOffer();
      });
    });
    S.socket.on('call:peer-joined', () => { if (host) startOffer(); });
    S.socket.on('call:signal', onSignal);
    S.socket.on('call:media-state', showPeerFlags);
    S.socket.on('call:peer-left', () => {
      closePc();
      $('#remoteVideo').srcObject = null;
      $('#remoteAudio').srcObject = null;
      overlay(host ? 'O paciente saiu. Aguardando retornar…' : 'O profissional saiu. Aguardando retornar…');
      status('Aguardando…');
      stopTimer();
    });
    S.socket.on('call:ended', () => finish(host ? null : 'O profissional finalizou o atendimento.'));
    S.socket.on('call:replaced', () => finish('Você entrou neste atendimento em outra aba ou aparelho.', true));
    S.socket.on('disconnect', () => { if (!S.ended) status('Reconectando…'); });

    // Câmera do profissional desconectada: tenta religar
    if (host) S.local.getVideoTracks().forEach((t) => t.addEventListener('ended', reacquireHostCamera));
    window.addEventListener('beforeunload', () => S.socket?.emit('call:leave'));
  }

  function renderPeerIdentity() {
    const who = peerIdentity();
    $('[data-top-avatar]').innerHTML = avatar(who.name, who.photo, 'sm');
    $('[data-top-name]').textContent = who.name;
    $('[data-overlay-avatar]').innerHTML = avatar(who.name, who.photo, 'xl');
    $('[data-overlay-title]').textContent = who.name;
  }

  function overlay(sub) {
    const o = $('[data-overlay]');
    if (sub === null) { o.classList.add('hidden'); return; }
    o.classList.remove('hidden');
    $('[data-overlay-sub]').textContent = sub;
  }
  function status(t) { $('[data-top-status]').textContent = t; }

  function newPc() {
    closePc();
    const pc = new RTCPeerConnection({ iceServers: S.iceServers });
    S.pc = pc;
    S.pendingIce = [];
    pc.onicecandidate = (e) => { if (e.candidate) S.socket.emit('call:signal', { candidate: e.candidate }); };
    // Junta as faixas recebidas (áudio + vídeo) num único stream
    const remote = new MediaStream();
    $('#remoteVideo').srcObject = remote;
    pc.ontrack = (e) => {
      remote.getTracks().filter((t) => t.kind === e.track.kind).forEach((t) => remote.removeTrack(t));
      remote.addTrack(e.track);
      $('#remoteVideo').play().catch(() => {});
      // O som vai por um elemento de áudio próprio: o navegador pausa vídeos em segundo plano, áudio não
      if (e.track.kind === 'audio') {
        const a = $('#remoteAudio');
        a.srcObject = new MediaStream([e.track]);
        a.play().catch(() => {});
      }
    };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === 'connected') { status('Em atendimento'); overlay(S.peerCamOff ? 'Câmera desligada' : null); startTimer(); sendMediaState(); }
      if (st === 'disconnected') status('Conexão instável…');
      if (st === 'failed') {
        status('Falha na conexão');
        if (S.role === 'host') setTimeout(startOffer, 1000); // tenta de novo
      }
    };
    return pc;
  }

  function closePc() {
    if (S.pc) { S.pc.ontrack = null; S.pc.onicecandidate = null; S.pc.onconnectionstatechange = null; S.pc.close(); S.pc = null; }
  }

  // O profissional sempre inicia a negociação
  async function startOffer() {
    const pc = newPc();
    S.videoSender = null;
    S.local.getTracks().forEach((t) => {
      const sender = pc.addTrack(t, S.local);
      if (t.kind === 'video') S.videoSender = sender;
    });
    // Sem câmera agora: reserva o canal de vídeo para poder ligar depois sem renegociar
    if (!S.videoSender) S.videoSender = pc.addTransceiver('video', { direction: 'sendrecv' }).sender;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    S.socket.emit('call:signal', { description: pc.localDescription });
  }

  async function onSignal({ description, candidate }) {
    try {
      if (description) {
        if (description.type === 'offer') {
          const pc = newPc();
          await pc.setRemoteDescription(description);
          // Mantém áudio e vídeo em "sendrecv" para poder ligar/desligar a câmera sem renegociar
          const audio = S.local.getAudioTracks()[0] || null;
          const video = S.camOn ? (S.local.getVideoTracks()[0] || null) : null;
          for (const tr of pc.getTransceivers()) {
            const kind = tr.receiver.track.kind;
            tr.direction = 'sendrecv';
            await tr.sender.replaceTrack(kind === 'audio' ? audio : video);
            if (kind === 'video') S.videoSender = tr.sender;
          }
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          S.socket.emit('call:signal', { description: pc.localDescription });
        } else if (description.type === 'answer' && S.pc) {
          await S.pc.setRemoteDescription(description);
        }
        for (const c of S.pendingIce.splice(0)) await S.pc.addIceCandidate(c).catch(() => {});
      } else if (candidate && S.pc) {
        if (S.pc.remoteDescription) await S.pc.addIceCandidate(candidate).catch(() => {});
        else S.pendingIce.push(candidate);
      }
    } catch (e) {
      console.error(e);
    }
  }

  // ---------- Controles ----------
  function renderControls() {
    const host = S.role === 'host';
    const mic = $('[data-mic]');
    mic.innerHTML = S.micOn ? ICONS.mic : ICONS.micOff;
    mic.classList.toggle('off', !S.micOn);
    mic.setAttribute('aria-label', S.micOn ? 'Desligar microfone' : 'Ligar microfone');
    const cam = $('[data-cam]');
    const hasVideo = S.local.getVideoTracks().length > 0 || S.videoSender;
    cam.classList.toggle('hidden', !navigator.mediaDevices);
    cam.innerHTML = S.camOn ? ICONS.video : ICONS.videoOff;
    cam.classList.toggle('off', !S.camOn);
    cam.setAttribute('aria-label', S.camOn ? 'Desligar câmera' : 'Ligar câmera');
    cam.disabled = false;
    if (!hasVideo && !S.camOn) cam.title = 'Ligar câmera';
    $('[data-end]').innerHTML = `${ICONS.phoneEnd} ${host ? 'Finalizar atendimento' : 'Sair'}`;
    // Sua câmera desligada: no lugar da imagem (nada de tela preta), aparece a sua foto ou as suas iniciais
    const off = !myCamLive();
    $('#localVideo').classList.toggle('hidden', off);
    const tile = $('#localOff');
    tile.classList.toggle('hidden', !off);
    if (off) { const me = myIdentity(); tile.innerHTML = avatar(me.name, me.photo, 'lg'); }
  }

  $('[data-mic]').addEventListener('click', () => {
    S.micOn = !S.micOn;
    S.local.getAudioTracks().forEach((t) => { t.enabled = S.micOn; });
    renderControls();
    sendMediaState();
  });

  $('[data-cam]').addEventListener('click', async () => {
    S.bgCamPaused = false;
    if (S.camOn) setCamera(false);
    else await cameraOn(false);
    renderControls();
    sendMediaState();
  });

  async function cameraOn(quiet) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } });
      const track = s.getVideoTracks()[0];
      S.local.getVideoTracks().forEach((t) => { t.stop(); S.local.removeTrack(t); });
      S.local.addTrack(track);
      S.camOn = true;
      if (S.role === 'host') track.addEventListener('ended', reacquireHostCamera);
      if (S.videoSender) await S.videoSender.replaceTrack(track);
      $('#localVideo').srcObject = S.local;
    } catch {
      S.camOn = false;
      if (!quiet) toast('Não foi possível ligar a câmera.', 'error');
    }
    renderControls();
    sendMediaState();
  }

  // Desliga de verdade a câmera (a luz da câmera apaga)
  function setCamera(on) {
    if (on) return;
    S.camOn = false;
    S.local.getVideoTracks().forEach((t) => { t.stop(); S.local.removeTrack(t); });
    if (S.videoSender) S.videoSender.replaceTrack(null);
  }

  async function reacquireHostCamera() {
    if (!S.camOn || S.ended) return;
    if (document.visibilityState === 'hidden') return; // fora do site: religa quando a pessoa voltar
    overlay('Sua câmera foi desconectada. Reconectando…');
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true });
      const track = s.getVideoTracks()[0];
      S.local.getVideoTracks().forEach((t) => S.local.removeTrack(t));
      S.local.addTrack(track);
      track.addEventListener('ended', reacquireHostCamera);
      if (S.pc && S.videoSender) await S.videoSender.replaceTrack(track);
      $('#localVideo').srcObject = S.local;
      overlay(S.pc?.connectionState === 'connected' ? null : 'Aguardando…');
    } catch {
      overlay('Sua câmera está desligada. Religue-a para continuar o atendimento.');
      setTimeout(reacquireHostCamera, 3000);
    }
    renderControls();
  }

  function sendMediaState() {
    const me = myIdentity();
    S.socket?.emit('call:media-state', { mic: S.micOn, cam: S.camOn, name: me.name, photo: me.photo });
  }

  function showPeerFlags({ mic, cam, name, photo }) {
    S.peerCamOff = !cam;
    if (typeof name === 'string' && name.trim()) {
      S.peerIdentity = { name: name.trim().slice(0, 80), photo: safePhoto(photo) };
      renderPeerIdentity();
    }
    const f = [];
    if (!mic) f.push('<span>Microfone desligado</span>');
    if (!cam) f.push('<span>Câmera desligada</span>');
    $('[data-peer-flags]').innerHTML = f.join('');
    if (S.pc?.connectionState === 'connected') overlay(cam ? null : 'Câmera desligada');
  }

  $('[data-end]').addEventListener('click', async () => {
    if (S.role === 'host') {
      if (!await confirmDialog('Finalizar o atendimento? O código do paciente deixará de funcionar.', { okLabel: 'Finalizar', danger: true })) return;
      S.socket.emit('call:end');
      finish(null);
    } else {
      if (!await confirmDialog('Sair do atendimento? Você pode voltar com o mesmo código enquanto o profissional não finalizar.', { okLabel: 'Sair' })) return;
      S.socket.emit('call:leave');
      finish('Você saiu do atendimento. Enquanto o profissional não finalizar, é possível voltar com o mesmo código.', false, true);
    }
  });

  function startTimer() {
    if (S.timer) return;
    S.startedAt = Date.now();
    S.timer = setInterval(() => {
      const s = Math.floor((Date.now() - S.startedAt) / 1000);
      status(`Em atendimento · ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`);
    }, 1000);
  }
  function stopTimer() { clearInterval(S.timer); S.timer = null; }

  function finish(message, isError = false, canRejoin = false) {
    if (S.ended) return;
    S.ended = true;
    exitPip();
    stopPipClock();
    stopTimer();
    closePc();
    S.local?.getTracks().forEach((t) => t.stop());
    S.socket?.disconnect();
    document.body.classList.remove('call-page');
    show('ended');
    $('[data-ended-title]').textContent = isError ? 'Não foi possível continuar' : canRejoin ? 'Você saiu' : 'Atendimento finalizado';
    $('[data-ended-msg]').textContent = message || 'Atendimento finalizado. O código do paciente não pode mais ser usado.';
    const actions = $('[data-ended-actions]');
    if (S.role === 'host') actions.innerHTML = '<a class="btn" href="/painel#atendimento">Voltar ao painel</a>';
    else if (canRejoin) actions.innerHTML = '<button class="btn" data-rejoin>Voltar ao atendimento</button><a class="btn secondary" href="/">Início</a>';
    $('[data-rejoin]')?.addEventListener('click', () => { location.href = `/atendimento?codigo=${encodeURIComponent(S.code)}`; });
  }
})();
