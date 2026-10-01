/* Clínicas (versão 1.3): perfil da clínica e "Clínicas perto de você" (ícone de hospital).
   Usado na página pública da clínica (site.com/<link>) e na aba Clínicas (app do paciente, painel do profissional e da clínica). */
(function () {
  'use strict';
  const { $, $$, api, esc, avatar, ICONS } = window.Acolia;
  const IC = {
    hospital: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 21V7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14"/><path d="M2 21h20M12 8v6M9 11h6M9 21v-3h6v3"/></svg>',
    pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s7-6 7-11a7 7 0 0 0-14 0c0 5 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>',
    steth: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3v5a4 4 0 0 0 8 0V3"/><path d="M10 12v3a5 5 0 0 0 10 0v-2"/><circle cx="20" cy="11" r="2"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  };
  const logoOf = (c, size = 'xl') => (c.logo ? `<span class="avatar ${size} clinic-logo"><img src="${esc(c.logo)}" alt=""></span>` : avatar(c.name, null, size));

  // Profissionais da clínica: abre o perfil (no app/painel pela função escolhida; fora, pelo link)
  let openProFn = null;
  const proHref = (p) => (p.slug ? `/${p.slug}` : `/profissional.html?id=${p.id}`);
  function membersHtml(c) {
    const list = c.professionals || [];
    if (!list.length) return '';
    return `<div class="card flat stack" style="margin-top:16px"><h3 style="margin:0">Profissionais que trabalham na clínica</h3>
      <div class="clinic-list">${list.map((p) => `<a class="card clinic-item" href="${esc(proHref(p))}" data-cv-pro="${p.id}">
        ${avatar(p.name, p.photo, 'md')}<span class="grow"><b>${esc(p.name)}</b><small class="muted">${esc(p.profession)}${p.registry ? ` · ${esc(p.registry)}` : ''}</small></span><span class="muted" aria-hidden="true">›</span></a>`).join('')}</div></div>`;
  }

  function render(c, { actions = '', next = '' } = {}) {
    const signup = `/cadastro-paciente${next ? `?next=${encodeURIComponent(next)}` : ''}`;
    const P = window.AcoliaProfile;
    // Publicações, seguidores e Seguir: igual ao perfil do profissional (a clínica publica pela linha autora)
    const sp = c.author_id ? { ...c, id: c.author_id } : null;
    const place = c.locked
      ? `<a class="lock-link" style="white-space:normal" href="${signup}">${IC.lock.replace('<svg', '<svg style="width:15px;height:15px;flex:none"')} Crie sua conta grátis para ver o endereço e o mapa</a>`
      : `<div><b>${esc(c.address)}</b><div class="muted">${esc(c.city)} - ${esc(c.state)}</div></div>
        ${c.map_embed ? `<div class="mini-map"><iframe src="${esc(c.map_embed)}" title="Mapa: ${esc(c.name)}" loading="lazy" referrerpolicy="no-referrer-when-downgrade" allowfullscreen></iframe></div>` : ''}
        ${c.maps_url ? `<a class="btn secondary sm" style="width:max-content" target="_blank" rel="noopener" href="${esc(c.maps_url)}">${IC.pin} Abrir no Google Maps</a>` : ''}`;
    return `<div class="card stack" data-clinic-id="${c.id}">
        <div class="row" style="align-items:flex-start;gap:20px;flex-wrap:wrap">
          ${logoOf(c)}
          <div class="grow" style="min-width:220px">
            <h1 style="font-size:1.6rem;margin-bottom:4px">${esc(c.name)}</h1>
            ${sp && P ? P.countsHtml(sp) : ''}
            <div class="muted" style="font-weight:700">${IC.hospital.replace('<svg', '<svg style="width:16px;height:16px;vertical-align:-3px"')} Clínica · ${esc(c.city)} - ${esc(c.state)}</div>
            ${window.Acolia.socialLinks(c.social)}
          </div>
          <div class="row">${sp && P ? P.followHtml(sp) : ''}${actions}</div>
        </div>
        ${c.bio ? `<div><h3>Sobre a clínica</h3><p style="white-space:pre-wrap;margin:0">${esc(c.bio)}</p></div>` : ''}
        ${c.has_doctors && c.doctors.length ? `<div><h3>${IC.steth.replace('<svg', '<svg style="width:18px;height:18px;vertical-align:-3px"')} Também tem médicos</h3>
          <div class="row" style="gap:6px;flex-wrap:wrap">${c.doctors.map((d) => `<span class="badge">${esc(d)}</span>`).join('')}</div></div>` : ''}
        ${sp && P ? P.postsHtml(sp, { next, signup }) : ''}
      </div>
      ${c.locked ? `<div class="notice info" style="margin-top:16px">${IC.lock.replace('<svg', '<svg style="width:18px;height:18px;vertical-align:-3px"')} Crie sua conta grátis para ver todas as publicações, o endereço e o mapa da clínica.
        <div class="row" style="margin-top:10px"><a class="btn sm" href="${signup}">Criar conta grátis</a><a class="btn secondary sm" href="/entrar${next ? `?next=${encodeURIComponent(next)}` : ''}">Já tenho conta</a></div></div>` : ''}
      ${membersHtml(c)}
      <div class="card flat stack" style="margin-top:16px"><h3>${IC.pin.replace('<svg', '<svg style="width:18px;height:18px;vertical-align:-3px"')} Localização</h3>${place}</div>`;
  }

  // Página cheia com Voltar (o voltar do celular também fecha)
  function fullPage(title) {
    const el = document.createElement('div');
    el.className = 'bio-page';
    el.setAttribute('role', 'dialog');
    el.innerHTML = `<div class="bio-head"><button type="button" class="icon-btn" data-cv-back aria-label="Voltar">${ICONS.back}</button><b data-cv-title>${esc(title)}</b></div><div class="bio-body" data-cv-body></div>`;
    document.body.appendChild(el);
    document.documentElement.classList.add('no-scroll');
    const close = () => { el.remove(); window.removeEventListener('popstate', onPop); if (!$('.bio-page')) document.documentElement.classList.remove('no-scroll'); };
    const onPop = () => close();
    history.pushState({ cv: 1 }, '');
    window.addEventListener('popstate', onPop);
    el.addEventListener('click', (e) => { if (e.target.closest('[data-cv-back]')) history.back(); });
    return { el, body: $('[data-cv-body]', el), setTitle: (t) => { $('[data-cv-title]', el).textContent = t; } };
  }

  // Liga Seguir, abrir publicação e "Ver todas" (precisa do social.js na página)
  function bind(container, c, { onNeedAccount } = {}) {
    if (c.author_id && window.AcoliaSocial) {
      AcoliaSocial.bindProfile(container, { ...c, id: c.author_id }, { onNeedAccount: onNeedAccount || (() => { location.href = `/cadastro-paciente?next=${encodeURIComponent(c.slug ? '/' + c.slug : location.pathname)}`; }) });
    }
    // "Ver todas": no app/painel o perfil da clínica está por cima (página cheia) — fecha e abre a página de publicações
    container.addEventListener('click', (e) => {
      const all = e.target.closest('[data-all-posts]');
      if (!all || c.locked || !$('.bio-page')) return;
      e.stopImmediatePropagation();
      const kind = all.dataset.allPosts === 'reel' ? 'reel' : 'photo';
      history.back();
      setTimeout(() => { location.hash = `posts/${c.author_id}/${kind}`; }, 80);
    }, true);
    container.addEventListener('click', (e) => {
      const a = e.target.closest('[data-cv-pro]');
      if (!a || !openProFn) return;
      e.preventDefault();
      const id = Number(a.dataset.cvPro);
      if ($('.bio-page')) history.back();
      setTimeout(() => openProFn(id), 60);
    });
  }

  async function openClinic(key) {
    const page = fullPage('Clínica');
    page.body.innerHTML = '<div class="spinner"></div>';
    try {
      const c = await api('/api/clinics/' + encodeURIComponent(key));
      page.setTitle(c.name);
      page.body.innerHTML = render(c, { next: c.slug ? '/' + c.slug : '' });
      bind(page.body, c);
    } catch (e) { page.body.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }

  // Aba "Clínicas" (separada dos profissionais): filtro por estado e município; começa pelo lugar da pessoa
  function mountList(host) {
    if (!host || host.dataset.mounted) return;
    host.dataset.mounted = '1';
    fillList({ body: host });
  }
  // "Clínicas perto de você" em página cheia (link de fora)
  function openList() { fillList(fullPage('Clínicas perto de você')); }
  async function fillList(page) {
    page.body.innerHTML = `<p class="muted" style="margin-top:0">Escolha o estado e, se quiser, o município. As do seu município aparecem primeiro.</p>
      <div class="grid-uf" style="margin-bottom:12px"><select data-cv-state aria-label="Estado"></select><input data-cv-city placeholder="Todos os municípios" aria-label="Município"></div>
      <div data-cv-list><div class="spinner"></div></div>`;
    const st = $('[data-cv-state]', page.body);
    const ct = $('[data-cv-city]', page.body);
    let first = true;
    async function load() {
      const qs = new URLSearchParams();
      if (!first) { qs.set('state', st.value || 'todos'); if (ct.value.trim()) qs.set('city', ct.value.trim()); }
      const d = await api('/api/clinics?' + qs);
      if (first) { st.innerHTML = window.Acolia.ufOptions(d.state || '', 'Todos os estados'); window.Acolia.bindUfCity(st, ct); ct.value = ''; first = false; }
      $('[data-cv-list]', page.body).innerHTML = d.items.length ? `<div class="clinic-list">${d.items.map((c) => `<button type="button" class="card clinic-item" data-cv-open="${c.slug || c.id}">
          ${logoOf(c, 'md')}<span class="grow"><b>${esc(c.name)}</b><small class="muted">${esc(c.city)} - ${esc(c.state)}${c.near ? ' · perto de você' : ''}</small>
          ${c.has_doctors ? '<small class="muted">Também tem médicos</small>' : ''}</span><span class="muted" aria-hidden="true">›</span></button>`).join('')}</div>`
        : '<div class="empty">Ainda não há clínicas cadastradas neste lugar.</div>';
    }
    let t = null;
    const reload = () => { clearTimeout(t); t = setTimeout(() => load().catch(() => {}), 300); };
    st.addEventListener('change', reload);
    ct.addEventListener('input', reload);
    page.body.addEventListener('click', (e) => { const b = e.target.closest('[data-cv-open]'); if (b) openClinic(b.dataset.cvOpen); });
    load().catch((e) => { $('[data-cv-list]', page.body).innerHTML = `<div class="empty">${esc(e.message)}</div>`; });
  }

  // Abrir o perfil de uma clínica a partir de uma publicação (chave = link ou número)
  function openByKey(key) {
    if ($('.app-shell, .panel-main, [data-clinics-page]')) return openClinic(key);
    location.href = /^\d+$/.test(String(key)) ? `/clinica-perfil.html?id=${key}` : `/${key}`;
  }
  window.AcoliaClinics = { render, bind, openClinic, openByKey, openList, mountList, IC, logoOf, setOpenPro: (fn) => { openProFn = fn; } };
})();
