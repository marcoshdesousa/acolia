/* Perfil completo de um profissional */
(function () {
  'use strict';
  const { esc, ICONS, avatar, money } = window.Acolia;
  const ic = (name, s = 18) => ICONS[name].replace('<svg', `<svg style="width:${s}px;height:${s}px;vertical-align:-4px"`);

  // 50 → "50 min", 60 → "1h", 90 → "1h30"
  function duration(min) {
    if (!min) return '';
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
  }

  function render(p, { actions = '', next = '' } = {}) {
    const specialties = (p.specialties || '').split(',').map((s) => s.trim()).filter(Boolean);
    const signup = `/cadastro-paciente${next ? `?next=${encodeURIComponent(next)}` : ''}`;
    // Selo "Crie conta para ver" (leva para o cadastro grátis e depois volta para este perfil)
    const lockLink = (text = 'Crie conta para ver') => `<a class="lock-link" href="${signup}">${ic('lock', 15)} ${esc(text)}</a>`;

    // ---------- Valores ----------
    let values;
    if (p.locked) {
      const pk = p.package_sessions || [];
      values = `<div class="card flat stack">
          <h3>${ic('calendar')} Valores</h3>
          <div class="row between"><span>Sessão online</span>${lockLink()}</div>
          ${pk.map((n) => `<div class="row between"><span>Pacote de ${n} sessões</span>${lockLink()}</div>`).join('')}
        </div>`;
    } else {
      const pk = p.packages || [];
      values = `<div class="card flat stack">
          <h3>${ic('calendar')} Valores</h3>
          <div><span class="price" style="font-size:1.5rem;font-weight:800">${p.price_cents != null ? money(p.price_cents) : 'A combinar'}</span> <span class="muted">por sessão online</span></div>
          ${pk.length ? `<div><b>Pacotes</b><ul style="margin:6px 0 0;padding-left:20px">${pk.map((k) => `<li>${k.sessions} sessões por <b>${money(k.price_cents)}</b> <span class="muted small">(${money(Math.round(k.price_cents / k.sessions))}/sessão)</span>${k.description ? ` — ${esc(k.description)}` : ''}</li>`).join('')}</ul></div>` : ''}
        </div>`;
    }

    // ---------- Localização (visível para todos; endereço da clínica só com conta) ----------
    // Todos atendem online; alguns também presencial — as duas opções aparecem
    const modes = `<div class="row" style="gap:6px"><span class="badge ok">${ic('video', 15)} Atende online</span>
        ${p.has_clinic ? `<span class="badge ok">${ic('clinic', 15)} Atende presencial</span>` : ''}</div>`;
    let clinic = '';
    if (p.has_clinic && p.locked) clinic = `<div>${lockLink('Crie conta para ver o endereço e o mapa')}</div>`;
    else if (p.has_clinic) {
      clinic = `<div><b>${ic('clinic')} ${esc(p.clinic_name || 'Consultório presencial')}</b><div class="muted">${esc(p.clinic_address)}</div></div>
        ${p.map_embed ? `<div class="mini-map"><iframe src="${esc(p.map_embed)}" title="Mapa: ${esc(p.clinic_name || 'consultório')}" loading="lazy" referrerpolicy="no-referrer-when-downgrade" allowfullscreen></iframe></div>` : ''}
        ${p.maps_url ? `<a class="btn secondary sm" style="width:max-content" target="_blank" rel="noopener" href="${esc(p.maps_url)}">${ic('pin', 16)} Abrir no Google Maps</a>` : ''}`;
    }
    const location = `<div class="card flat stack">
        <h3>${ic('pin')} Localização</h3>
        <div>${esc(p.city)} - ${esc(p.state)}</div>
        ${modes}
        ${clinic}
      </div>`;

    // ---------- Sobre ----------
    let about = '';
    if (p.locked && p.has_bio) about = `<div><h3>Sobre</h3>${lockLink()}</div>`;
    else if (p.bio) about = `<div><h3>Sobre</h3><p style="white-space:pre-wrap">${esc(p.bio)}</p></div>`;

    // ---------- Publicações (só as 4 mais recentes; "Ver todas as fotos" abre a página de publicações) ----------
    // Visitante: no máximo 2 abertas (sem ampliar) e o resto com "Crie conta para ver"
    const total = p.posts_count ?? ((p.gallery || []).length + (p.gallery_hidden || 0));
    let gallery = '';
    if (total) {
      let tiles;
      if (p.locked) {
        const photos = p.gallery || [];
        const lockedTiles = Math.min(p.gallery_hidden || 0, 4 - photos.length);
        tiles = photos.map((src, i) => `<button type="button" class="gallery-item" data-gallery-need-account="${esc(next || '')}" aria-label="Crie conta para ampliar"><img src="${esc(src)}" alt="Foto ${i + 1} de ${esc(p.name)}" loading="lazy"></button>`).join('')
          + Array.from({ length: lockedTiles }, () => `<a class="gallery-item gallery-locked" href="${signup}">${ic('lock', 20)}<span>Crie conta para ver</span></a>`).join('');
      } else {
        tiles = (p.gallery_posts || []).map((x) => window.AcoliaSocial ? window.AcoliaSocial.gridTile(x)
          : `<button type="button" class="gallery-item" data-post-open="${x.id}" aria-label="Abrir publicação"><img src="${esc(x.image)}" alt="" loading="lazy"></button>`).join('');
      }
      const more = total > 4 ? `<button type="button" class="btn secondary sm" data-all-posts style="margin-top:10px">${ic('image', 16)} Ver todas as fotos (${total})</button>` : '';
      gallery = `<div><h3>Publicações</h3><div class="gallery-grid" data-post-grid>${tiles}</div>${more}</div>`;
    }

    // Seguidores / seguindo (só os números) e botão Seguir
    const counts = `<div class="pro-counts"><span><b>${total}</b> ${total === 1 ? 'publicação' : 'publicações'}</span>
      <span><b data-followers>${p.followers_count || 0}</b> seguidores</span><span><b>${p.following_count || 0}</b> seguindo</span></div>`;
    const followBtn = p.is_self ? '' : `<button type="button" class="btn ${p.following ? 'following' : ''}" data-follow>${p.following ? 'Seguindo' : 'Seguir'}</button>`;

    return `
      <div class="card stack">
        <div class="row" style="align-items:flex-start;gap:20px;flex-wrap:wrap">
          ${avatar(p.name, p.photo, 'xl')}
          <div class="grow" style="min-width:220px">
            <h1 style="font-size:1.6rem;margin-bottom:4px">${esc(p.name)}</h1>
            ${counts}
            <div class="muted" style="font-weight:700">${esc(p.profession)}</div>
            <div class="row" style="margin-top:6px;gap:6px"><span class="badge ok">${ic('badge', 15)} ${esc(p.registry)}</span>
              ${p.session_minutes ? `<span class="badge">${ic('clock', 15)} Sessão de ${duration(p.session_minutes)}</span>` : ''}
              ${p.locked && p.has_session_minutes ? `<a class="lock-link" href="${signup}">${ic('clock', 15)} Duração: crie conta para ver</a>` : ''}</div>
            ${p.instagram ? `<a class="insta-btn" href="https://www.instagram.com/${encodeURIComponent(p.instagram)}/" target="_blank" rel="noopener">${ic('instagram', 18)} @${esc(p.instagram)}</a>` : ''}
            ${specialties.length ? `<div class="meta row" style="gap:6px;margin-top:10px">${specialties.map((s) => `<span class="badge">${esc(s)}</span>`).join('')}</div>` : ''}
          </div>
          <div class="row">${followBtn}${actions}</div>
        </div>
        ${about}
        ${gallery}
      </div>
      ${p.locked ? `<div class="notice info" style="margin-top:16px">${ic('lock')} Crie sua conta grátis para ver valores, a duração da sessão, o endereço, o "Sobre", toda a galeria (e ampliar as fotos) e para mandar mensagem.
        <div class="row" style="margin-top:10px"><a class="btn sm" href="${signup}">Criar conta grátis</a><a class="btn secondary sm" href="/entrar?next=${encodeURIComponent(next || '/app#perfil/' + p.id)}">Já tenho conta</a></div></div>` : ''}
      <div class="grid-2" style="margin-top:16px;align-items:start">${values}${location}</div>`;
  }

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
