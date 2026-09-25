/* Perfil completo de um profissional */
(function () {
  'use strict';
  const { $$, esc, ICONS, avatar, money } = window.Acolia;
  const ic = (name, s = 18) => ICONS[name].replace('<svg', `<svg style="width:${s}px;height:${s}px;vertical-align:-4px"`);

  // 50 → "50 min", 60 → "1h", 90 → "1h30"
  function duration(min) {
    if (!min) return '';
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
  }

  // Perfil oficial Acolia Brasil: nome, Instagram, seguidores (pacientes e profissionais) e
  // todas as publicações. Sem consulta, valores, mensagem ou localização.
  function renderOfficial(p, { next = '' } = {}) {
    const n = (x) => Number(x || 0).toLocaleString('pt-BR');
    const signup = `/cadastro-paciente${next ? `?next=${encodeURIComponent(next)}` : ''}`;
    return `
      <div class="card stack official-profile">
        <div class="row" style="align-items:center;gap:20px;flex-wrap:wrap">
          <span class="official-avatar"><img src="${esc(p.photo)}" alt=""></span>
          <div class="grow" style="min-width:220px">
            <h1 style="font-size:1.6rem;margin-bottom:6px">${esc(p.name)} ${window.AcoliaSocial?.officialBadge || ''}</h1>
            <div class="pro-counts official-counts">
              <span><b>${n(p.posts_count)}</b> ${p.posts_count === 1 ? 'publicação' : 'publicações'}</span>
              <span><b>${n(p.followers_patients)}</b> ${p.followers_patients === 1 ? 'seguidor paciente' : 'seguidores pacientes'}</span>
              <span><b>${n(p.followers_professionals)}</b> ${p.followers_professionals === 1 ? 'seguidor profissional' : 'seguidores profissionais'}</span>
            </div>
            ${window.Acolia.socialLinks(p.social)}
          </div>
          <div class="row"><button type="button" class="btn ${p.following ? 'following' : ''}" data-follow>${p.following ? 'Seguindo' : 'Seguir'}</button></div>
        </div>
        <div><h3>Publicações</h3>
          <div class="pv-tabs" role="tablist"><button type="button" role="tab" class="active" data-of-tab="photo">${ic('grid', 20)} Publicações</button><button type="button" role="tab" data-of-tab="reel">${ic('reel', 20)} Vídeos</button></div>
          <div class="gallery-grid posts-grid" data-official-grid></div>
          <div class="spinner" data-official-loading></div><div data-official-end style="height:1px"></div></div>
      </div>
      ${p.locked ? `<div class="notice info" style="margin-top:16px">${ic('lock')} Crie sua conta grátis para ver todas as publicações, curtir e comentar.
        <div class="row" style="margin-top:10px"><a class="btn sm" href="${signup}">Criar conta grátis</a><a class="btn secondary sm" href="/entrar?next=${encodeURIComponent(next || '/acolia')}">Já tenho conta</a></div></div>` : ''}`;
  }

  const BIO_SHORT = 260; // acima disso (ou mais de 4 linhas), o "Sobre" aparece resumido com "Ler mais"
  const BIO_CACHE = new Map();
  const PRO_CACHE = new Map(); // perfis com agenda aberta (para o botão "Agendar consulta")

  // "Ler mais": abre uma página com a história completa, com botão Voltar (o voltar do celular também fecha)
  function openBio(pro) {
    const el = document.createElement('div');
    el.className = 'bio-page';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', `Sobre ${pro.name}`);
    el.innerHTML = `<div class="bio-head"><button type="button" class="icon-btn" data-bio-back aria-label="Voltar">${ICONS.back}</button><b>Sobre</b></div>
      <div class="bio-body">
        <div class="row" style="gap:14px;margin-bottom:18px">${avatar(pro.name, pro.photo, 'lg')}<div><div style="font-weight:800;font-size:1.2rem">${esc(pro.name)}</div><div class="muted">${esc(pro.profession || '')}</div></div></div>
        <p style="white-space:pre-wrap;line-height:1.65;margin:0">${esc(pro.bio)}</p>
        <button type="button" class="btn secondary" data-bio-back style="margin-top:24px">${ICONS.back} Voltar ao perfil</button>
      </div>`;
    document.body.appendChild(el);
    document.documentElement.classList.add('no-scroll');
    const close = () => { el.remove(); document.documentElement.classList.remove('no-scroll'); window.removeEventListener('popstate', onPop); };
    const onPop = () => close();
    history.pushState({ bio: 1 }, '');
    window.addEventListener('popstate', onPop);
    el.addEventListener('click', (e) => { if (e.target.closest('[data-bio-back]')) history.back(); });
  }
  document.addEventListener('click', (e) => {
    // "Dia disponível" no topo: desce até os valores, onde fica o botão de agendar
    const go = e.target.closest('[data-next-go]');
    if (go) {
      const scope = go.closest('[data-pro-id]')?.parentElement || document;
      const box = scope.querySelector('[data-values-anchor]');
      box?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      box?.querySelector('[data-book]')?.classList.add('pulse');
      setTimeout(() => box?.querySelector('[data-book]')?.classList.remove('pulse'), 1600);
      return;
    }
    const book = e.target.closest('[data-book]');
    if (book) {
      const pro = PRO_CACHE.get(Number(book.dataset.book));
      if (!pro) return;
      if (pro.locked) {
        if (window.AcoliaSpecialties) AcoliaSpecialties.needAccount('agendar sua consulta');
        else location.href = '/cadastro-paciente?next=' + encodeURIComponent(location.pathname);
      } else if (window.AcoliaAgenda) AcoliaAgenda.openBooking({ mode: 'book', pro });
      else location.href = `/app#perfil/${pro.id}`; // página pública aberta por quem tem conta: agenda pelo app
      return;
    }
    if (e.target.closest('[data-bio-locked]')) {
      if (window.AcoliaSpecialties) AcoliaSpecialties.needAccount('ler o texto completo');
      else location.href = '/cadastro-paciente?next=' + encodeURIComponent(location.pathname + location.hash);
      return;
    }
    const more = e.target.closest('[data-bio-more]');
    if (!more) return;
    const id = Number(more.closest('[data-pro-id]')?.dataset.proId);
    const pro = BIO_CACHE.get(id) || [...BIO_CACHE.values()].pop();
    if (pro) openBio(pro);
  });

  function render(p, { actions = '', next = '' } = {}) {
    if (p.official) return renderOfficial(p, { next });
    const specialties = (p.specialties || '').split(',').map((s) => s.trim()).filter(Boolean);
    const signup = `/cadastro-paciente${next ? `?next=${encodeURIComponent(next)}` : ''}`;
    // Selo "Crie conta para ver" (leva para o cadastro grátis e depois volta para este perfil)
    const lockLink = (text = 'Crie conta para ver') => `<a class="lock-link" href="${signup}">${ic('lock', 15)} ${esc(text)}</a>`;

    // ---------- Valores ----------
    // Plano de saúde: só o aviso de que aceita (qual plano e como funciona, o paciente pergunta pelo chat)
    const insurance = p.accepts_insurance ? `<div class="insurance">${ic('shield', 18)} <span><b>Aceita plano de saúde</b><br><span class="muted small">Pergunte ao profissional pelo chat quais planos e como funciona.</span></span></div>` : '';
    // Agenda: próximo dia livre e o botão de marcar (paciente; visitante é convidado a criar a conta).
    // Profissional vendo outro profissional não marca consulta.
    const nx = p.next_available;
    const canBook = !p.is_self && p.viewer_role !== 'professional';
    if (nx) PRO_CACHE.set(p.id, p);
    const agendaBox = nx
      ? `<div class="agenda-box"><div>${ic('calendar', 18)} Próximo horário livre: <b>${esc(nx.label)} às ${esc(nx.first)}</b></div>
          ${canBook ? `<button type="button" class="btn block" data-book="${p.id}">${ic('calendar', 18)} Agendar consulta</button>
          <span class="small muted">Escolha o dia e o horário e pague pelo Pix para confirmar. Pacotes: combine pelo chat.</span>` : ''}</div>`
      : p.test_only
        ? `<div class="small muted">🧪 Conta de teste: a agenda deste profissional só abre para o <b>Paciente Teste</b>. Entre com o Paciente Teste para marcar e pagar (pagamento simulado).</div>`
      : `<div class="small muted">A agenda online deste profissional está fechada no momento. ${canBook ? 'Mande uma mensagem para combinar.' : ''}</div>`;
    let values;
    if (p.locked) {
      values = `<div class="card flat stack">
          <h3>${ic('calendar')} Valores e sessões</h3>
          <div class="row between"><span>Sessão online</span>${lockLink()}</div>
          ${agendaBox}
          ${insurance}
        </div>`;
    } else {
      values = `<div class="card flat stack">
          <h3>${ic('calendar')} Valores</h3>
          ${p.price_presencial_cents != null && !p.price_same
            ? `<div class="price-rows"><div class="row between"><span>${ic('video', 16)} Sessão online</span><b class="price">${p.price_cents != null ? money(p.price_cents) : 'A combinar'}</b></div>
                <div class="row between"><span>${ic('home', 16)} Sessão presencial</span><b class="price">${money(p.price_presencial_cents)}</b></div></div>`
            : `<div><span class="price" style="font-size:1.5rem;font-weight:800">${p.price_cents != null ? money(p.price_cents) : 'A combinar'}</span> <span class="muted">por sessão ${p.price_presencial_cents != null ? 'online e presencial' : 'online'}</span></div>`}
          ${agendaBox}
          ${insurance}
        </div>`;
    }

    // ---------- Localização (cidade, endereço e mapa só com conta) ----------
    // Todos atendem online; alguns também presencial — as duas opções aparecem
    const modes = `<div class="feat-pills"><span class="feat online"><i>${ic('video', 15)}</i>Atende online</span>
        ${p.has_clinic ? `<span class="feat clinic"><i>${ic('clinic', 15)}</i>Atende presencial</span>` : ''}
        ${p.accepts_insurance ? `<span class="feat plan"><i>${ic('shield', 15)}</i>Aceita plano de saúde</span>` : ''}</div>`;
    let clinic = '';
    if (p.locked) clinic = '';
    else if (p.has_clinic) {
      clinic = `<div><b>${ic('clinic')} ${esc(p.clinic_name || 'Consultório presencial')}</b><div class="muted">${esc(p.clinic_address)}</div></div>
        ${p.map_embed ? `<div class="mini-map"><iframe src="${esc(p.map_embed)}" title="Mapa: ${esc(p.clinic_name || 'consultório')}" loading="lazy" referrerpolicy="no-referrer-when-downgrade" allowfullscreen></iframe></div>` : ''}
        ${p.maps_url ? `<a class="btn secondary sm" style="width:max-content" target="_blank" rel="noopener" href="${esc(p.maps_url)}">${ic('pin', 16)} Abrir no Google Maps</a>` : ''}`;
    }
    const location = `<div class="card flat stack">
        <h3>${ic('pin')} Localização</h3>
        <div>${p.locked ? lockLink('Crie conta para ver a localização') : `${esc(p.city)} - ${esc(p.state)}`}</div>
        ${modes}
        ${clinic}
      </div>`;

    // ---------- Sobre ----------
    let about = '';
    if (p.bio && p.locked) {
      // Visitante: vem só o começo do texto; o "Ler mais" pede conta
      about = `<div><h3>Sobre</h3><p class="bio-short">${esc(p.bio)}</p>
        ${p.bio_more ? `<button type="button" class="link-btn" data-bio-locked>Ler mais</button>` : ''}</div>`;
    } else if (p.bio) {
      const long = p.bio.length > BIO_SHORT || p.bio.split('\n').length > 4;
      about = `<div><h3>Sobre</h3><p class="bio-short${long ? ' clamp' : ''}">${esc(p.bio)}</p>
        ${long ? `<button type="button" class="link-btn" data-bio-more>Ler mais</button>` : ''}</div>`;
      BIO_CACHE.set(p.id, { name: p.name, bio: p.bio, photo: p.photo, profession: p.profession });
    }

    // ---------- Publicações: fotos e vídeos (Reels) em abas, 4 de cada ----------
    // "Ver todas as fotos" / "Ver todos os vídeos" abre a página com as duas abas.
    // Visitante: no máximo 2 abertas por aba (sem ampliar) e o resto com "Crie conta para ver"
    const total = p.posts_count ?? ((p.gallery || []).length + (p.gallery_hidden || 0));
    const photosTotal = p.photos_count ?? total;
    const reelsTotal = p.reels_count || 0;
    const play = `<span class="multi-ic" aria-hidden="true">${ICONS.play}</span>`;
    const lockedTiles = (n) => Array.from({ length: n }, () => `<a class="gallery-item gallery-locked" href="${signup}">${ic('lock', 20)}<span>Crie conta para ver</span></a>`).join('');
    const freeTile = (src, i, isReel) => `<button type="button" class="gallery-item" data-gallery-need-account="${esc(next || '')}" aria-label="Crie conta para ver"><img src="${esc(src)}" alt="${isReel ? 'Vídeo' : 'Foto'} ${i + 1} de ${esc(p.name)}" loading="lazy">${isReel ? play : ''}</button>`;
    const freeText = (x) => `<button type="button" class="gallery-item text-tile font-${esc(x.font || 'padrao')}" data-gallery-need-account="${esc(next || '')}" aria-label="Crie conta para ler"><span>${esc(x.caption || '')}</span></button>`;
    const tile = (x) => (window.AcoliaSocial ? window.AcoliaSocial.gridTile(x)
      : `<button type="button" class="gallery-item" data-post-open="${x.id}" aria-label="Abrir publicação"><img src="${esc(x.image)}" alt="" loading="lazy"></button>`);
    let gallery = '';
    if (total) {
      let photoTiles;
      let reelTiles;
      if (p.locked) {
        const photos = p.gallery || [];
        const reels = p.reels || [];
        photoTiles = photos.map((src, i) => (typeof src === 'object' ? freeText(src) : freeTile(src, i, false))).join('') + lockedTiles(Math.min(p.gallery_hidden || 0, 4 - photos.length));
        reelTiles = reels.map((src, i) => freeTile(src, i, true)).join('') + lockedTiles(Math.min(p.reels_hidden || 0, 4 - reels.length));
      } else {
        photoTiles = (p.gallery_posts || []).map(tile).join('');
        reelTiles = (p.reels_posts || []).map(tile).join('');
      }
      const empty = (t) => `<p class="muted small" style="grid-column:1/-1;margin:0">${t}</p>`;
      gallery = `<div><h3>Publicações</h3>
        <div class="pv-tabs" role="tablist">
          <button type="button" role="tab" class="active" data-pv-tab="photo" aria-label="Publicações" title="Publicações">${ic('grid', 22)}<span>${photosTotal}</span></button>
          <button type="button" role="tab" data-pv-tab="reel" aria-label="Vídeos" title="Vídeos">${ic('reel', 22)}<span>${reelsTotal}</span></button>
        </div>
        <div data-pv-pane="photo"><div class="gallery-grid" data-post-grid>${photoTiles || empty('Nenhuma publicação ainda.')}</div>
          ${photosTotal > 4 ? `<button type="button" class="btn secondary sm" data-all-posts="photo" style="margin-top:10px">${ic('image', 16)} Ver todas as publicações (${photosTotal})</button>` : ''}</div>
        <div data-pv-pane="reel" hidden><div class="gallery-grid" data-reel-grid>${reelTiles || empty('Nenhum vídeo ainda.')}</div>
          ${reelsTotal > 4 ? `<button type="button" class="btn secondary sm" data-all-posts="reel" style="margin-top:10px">${ic('reel', 16)} Ver todos os vídeos (${reelsTotal})</button>` : ''}</div>
      </div>`;
    }

    // Publicações e seguidores (só os números; "seguindo" não aparece) e botão Seguir
    const counts = `<div class="pro-counts"><span><b>${total}</b> ${total === 1 ? 'publicação' : 'publicações'}</span>
      <span><b data-followers>${p.followers_count || 0}</b> ${p.followers_count === 1 ? 'seguidor' : 'seguidores'}</span></div>`;
    const followBtn = p.is_self ? '' : `<button type="button" class="btn ${p.following ? 'following' : ''}" data-follow>${p.following ? 'Seguindo' : 'Seguir'}</button>`;

    return `
      <div class="card stack" data-pro-id="${p.id}">
        <div class="row" style="align-items:flex-start;gap:20px;flex-wrap:wrap">
          ${avatar(p.name, p.photo, 'xl')}
          <div class="grow" style="min-width:220px">
            <h1 style="font-size:1.6rem;margin-bottom:4px">${esc(p.name)}</h1>
            ${counts}
            <div class="muted" style="font-weight:700">${esc(p.profession)}</div>
            <div class="row" style="margin-top:6px;gap:6px">${p.registry ? `<span class="badge ok">${ic('badge', 15)} ${esc(p.registry)}</span>` : ''}
              ${p.session_minutes ? `<span class="badge">${ic('clock', 15)} Sessão de ${duration(p.session_minutes)}</span>` : ''}
              ${p.locked && p.has_session_minutes ? `<a class="lock-link" href="${signup}">${ic('clock', 15)} Duração: crie conta para ver</a>` : ''}</div>
            ${window.Acolia.socialLinks(p.social)}
            ${nx ? `<button type="button" class="next-chip" data-next-go>${ic('calendar', 16)} Dia disponível: <b>${esc(nx.label)}</b></button>` : ''}
            ${specialties.length ? `<div class="meta row" style="gap:6px;margin-top:10px">${window.AcoliaSpecialties ? AcoliaSpecialties.badges(p) : specialties.slice(0, 2).map((s) => `<span class="badge">${esc(s)}</span>`).join('')}</div>` : ''}
          </div>
          <div class="row">${followBtn}${actions}</div>
        </div>
        ${about}
        ${gallery}
      </div>
      ${p.locked ? `<div class="notice info" style="margin-top:16px">${ic('lock')} Crie sua conta grátis para ver valores, sessões, a localização, todas as fotos (e ampliar) e para mandar mensagem.
        <div class="row" style="margin-top:10px"><a class="btn sm" href="${signup}">Criar conta grátis</a><a class="btn secondary sm" href="/entrar?next=${encodeURIComponent(next || '/app#perfil/' + p.id)}">Já tenho conta</a></div></div>` : ''}
      <div class="grid-2" style="margin-top:16px;align-items:start" data-values-anchor>${values}${location}</div>`;
  }

  // Abas Fotos | Vídeos do perfil
  document.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-pv-tab]');
    if (!tab) return;
    const box = tab.closest('.pv-tabs').parentElement;
    $$('[data-pv-tab]', box).forEach((b) => b.classList.toggle('active', b === tab));
    $$('[data-pv-pane]', box).forEach((pane) => { pane.hidden = pane.dataset.pvPane !== tab.dataset.pvTab; });
  });

  // Toque numa foto da galeria abre em tamanho grande (só com conta)
  document.addEventListener('click', (e) => {
    const locked = e.target.closest('[data-gallery-need-account]');
    if (locked) {
      const next = locked.dataset.galleryNeedAccount;
      const q = next ? `?next=${encodeURIComponent(next)}` : '';
      window.Acolia.modal({
        title: 'Crie sua conta grátis',
        html: '<p>Para ampliar as fotos e ver a galeria completa, crie sua conta. É rápido e depois você volta direto para este perfil.</p>',
        actions: [{ label: 'Já tenho conta', value: 'entrar', class: 'secondary' }, { label: 'Criar conta', value: 'criar' }],
      }).then((v) => {
        if (v === 'criar') location.href = `/cadastro-paciente${q}`;
        if (v === 'entrar') location.href = `/entrar${q}`;
      });
      return;
    }
    const b = e.target.closest('[data-gallery-open]');
    if (!b) return;
    window.Acolia.modal({ title: 'Galeria', html: `<img src="${esc(b.dataset.galleryOpen)}" alt="" style="width:100%;border-radius:12px">`, actions: [{ label: 'Fechar' }] });
  });

  window.AcoliaProfile = { render, duration };
})();
