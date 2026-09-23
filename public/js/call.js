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

  // ---------- Chamada em segundo plano (janelinha flutuante) ----------
  // Ao sair da tela (WhatsApp, Instagram…) a chamada continua. Quando o navegador permite,
  // o vídeo da outra pessoa vai para uma janelinha flutuante (picture-in-picture).
  const remoteEl = () => $('#remoteVideo');
  const pipSupported = () => !!(document.pictureInPictureEnabled || remoteEl().webkitSupportsPresentationMode);

  async function enterPip() {
    const v = remoteEl();
    if (!v.srcObject || S.ended) return;
    try {
      if (document.pictureInPictureElement === v) return;
      if (v.requestPictureInPicture) await v.requestPictureInPicture();
      else if (v.webkitSetPresentationMode) v.webkitSetPresentationMode('picture-in-picture');
    } catch { /* o navegador não deixou (precisa de um toque) */ }
  }
  async function exitPip() {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (remoteEl().webkitPresentationMode === 'picture-in-picture') remoteEl().webkitSetPresentationMode('inline');
    } catch { /* ignora */ }
  }

  function setupBackground() {
    const v = remoteEl();
    v.autoPictureInPicture = true; // Safari (iPhone/iPad/Mac): entra sozinho na janelinha ao sair
    v.setAttribute('autopictureinpicture', '');
    const ms = navigator.mediaSession;
    if (ms) {
      try { ms.metadata = new MediaMetadata({ title: 'Atendimento Acolia', artist: $('[data-top-name]').textContent, artwork: [{ src: '/img/app-icon-512.png', sizes: '512x512', type: 'image/png' }] }); } catch { /* ignora */ }
      const on = (action, fn) => { try { ms.setActionHandler(action, fn); } catch { /* não suportado */ } };
      on('enterpictureinpicture', enterPip); // Chrome: janelinha automática ao trocar de app/aba
      on('togglemicrophone', () => $('[data-mic]').click());
      on('togglecamera', () => $('[data-cam]').click());
      on('hangup', () => $('[data-end]').click());
    }
    // Tentativa extra ao sair da tela (funciona em alguns navegadores)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') enterPip();
      else if (!S.ended) { v.play().catch(() => {}); $('#localVideo').play().catch(() => {}); }
    });
    const btn = $('[data-pip]');
    btn.classList.toggle('hidden', !pipSupported());
    btn.innerHTML = ICONS.pip;
    btn.addEventListener('click', () => (document.pictureInPictureElement ? exitPip() : enterPip()));
  }

  // ---------- 3. Sala ----------
  function join() {
    show('call');
    document.body.classList.add('call-page');
    $('#localVideo').srcObject = S.local;
    const host = S.role === 'host';
    const peerName = host ? S.info.call.patient_label : S.info.professional.name;
    const peerPhoto = host ? null : S.info.professional.photo;
    $('[data-top-avatar]').innerHTML = avatar(peerName, peerPhoto, 'sm');
    $('[data-top-name]').textContent = peerName;
    $('[data-overlay-avatar]').innerHTML = avatar(peerName, peerPhoto, 'xl');
    $('[data-overlay-title]').textContent = peerName;
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
    };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === 'connected') { status('Em atendimento'); overlay(S.peerCamOff ? 'Câmera desligada' : null); startTimer(); }
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
    $('#localVideo').classList.toggle('hidden', !S.local.getVideoTracks().some((t) => t.enabled && t.readyState === 'live'));
  }

  $('[data-mic]').addEventListener('click', () => {
    S.micOn = !S.micOn;
    S.local.getAudioTracks().forEach((t) => { t.enabled = S.micOn; });
    renderControls();
    sendMediaState();
  });

  $('[data-cam]').addEventListener('click', async () => {
    if (S.camOn) setCamera(false);
    else {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } });
        const track = s.getVideoTracks()[0];
        S.local.addTrack(track);
        S.camOn = true;
        if (S.role === 'host') track.addEventListener('ended', reacquireHostCamera);
        if (S.videoSender) await S.videoSender.replaceTrack(track);
        $('#localVideo').srcObject = S.local;
      } catch {
        toast('Não foi possível ligar a câmera.', 'error');
      }
    }
    renderControls();
    sendMediaState();
  });

  // Desliga de verdade a câmera (a luz da câmera apaga)
  function setCamera(on) {
    if (on) return;
    S.camOn = false;
    S.local.getVideoTracks().forEach((t) => { t.stop(); S.local.removeTrack(t); });
    if (S.videoSender) S.videoSender.replaceTrack(null);
  }

  async function reacquireHostCamera() {
    if (!S.camOn || S.ended) return;
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
    S.socket?.emit('call:media-state', { mic: S.micOn, cam: S.camOn });
  }

  function showPeerFlags({ mic, cam }) {
    S.peerCamOff = !cam;
    const f = [];
    if (!mic) f.push('<span>Microfone desligado</span>');
    if (!cam) f.push('<span>Câmera desligada</span>');
    $('[data-peer-flags]').innerHTML = f.join('');
    if (S.pc?.connectionState === 'connected') overlay(cam ? null : 'Câmera desligada — atendimento por voz');
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
