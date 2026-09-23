/* Painel do profissional */
(async function () {
  'use strict';
  const { $, $$, api, ICONS, avatar, esc, toast, handleForm, logout, installApp, ufOptions, bindUfCity, maskPhone, fmtPhone,
    fmtDate, parseDate, copyText, confirmDialog, modal } = Acolia;

  const auth = await api('/api/auth/me').catch(() => ({}));
  if (auth.role !== 'professional') { location.replace(location.hash ? '/entrar?next=' + encodeURIComponent('/painel' + location.hash) + '#profissional' : '/'); return; }
  let me = auth.user;
  const cfg = await api('/api/config');

  $('[data-logo]').innerHTML = ICONS.logo;
  $$('[data-i]').forEach((el) => { el.outerHTML = ICONS[el.dataset.i]; });

  function renderLink() {
    const url = `${location.origin}/${me.slug}`;
    $('[data-my-link]').textContent = url;
    $('[data-open-link]').href = `/${me.slug}`;
    $('[data-origin]').textContent = `${location.host}/`;
    $('[data-slug-form]').slug.value = me.slug || '';
  }
  $('[data-copy-link]').addEventListener('click', () => copyText(`${location.origin}/${me.slug}`));
  $('[data-share-link]').addEventListener('click', async () => {
    const url = `${location.origin}/${me.slug}`;
    if (navigator.share) {
      try { await navigator.share({ title: `${me.name} — Acolia`, text: 'Agende sua consulta online comigo pela Acolia:', url }); } catch { /* cancelado */ }
    } else copyText(url);
  });
  handleForm($('[data-slug-form]'), async (d) => {
    me = await api('/api/professional/slug', { method: 'POST', body: d });
    renderLink();
    toast('Link atualizado! O link antigo deixou de funcionar.');
  });

  function renderMe() {
    renderLink();
    $('[data-me-avatar]').innerHTML = `<a href="#perfil" aria-label="Meu perfil">${avatar(me.name, me.photo, 'sm')}</a>`;
    $('[data-photo]').innerHTML = avatar(me.name, me.photo, 'lg');
    $('[data-my-code]').textContent = me.code;
    $('[data-my-code2]').textContent = me.code;
    $('[data-sub]').textContent = fmtDate(me.subscription_until);
    $('[data-visibility]').innerHTML = me.visible ? '<span class="badge ok">Visível para pacientes</span>'
      : me.status === 'restrito' ? '<span class="badge danger">Restrito pela administração</span>'
        : '<span class="badge warn">Oculto — mensalidade vencida</span>';
    const n = $('[data-status-notice]');
    if (me.visible) n.innerHTML = '';
    else n.innerHTML = `<div class="notice ${me.status === 'restrito' ? 'danger' : ''}" style="margin-bottom:16px">${me.status === 'restrito'
      ? 'Seu perfil está restrito pela administração e não aparece na vitrine. Você ainda pode responder às conversas existentes.'
      : 'Sua mensalidade está vencida e seu perfil não aparece na vitrine. Fale com a administração para renovar.'}</div>`;
  }

  // ---------- Perfil ----------
  const form = $('[data-profile-form]');
  form.profession.innerHTML = cfg.professions.map((p) => `<option>${esc(p)}</option>`).join('');
  maskPhone(form.phone);
  const pkBox = $('[data-packages]');

  function packageRow(pk = {}) {
    const div = document.createElement('div');
    div.className = 'row';
    div.style.flexWrap = 'nowrap';
    div.innerHTML = `
      <input data-pk-sessions type="number" min="2" max="100" placeholder="Sessões" aria-label="Quantidade de sessões" style="width:110px" value="${pk.sessions ?? ''}">
      <input data-pk-price inputmode="decimal" placeholder="Valor total (R$)" aria-label="Valor do pacote" class="grow" value="${pk.price_cents != null ? (pk.price_cents / 100).toFixed(2).replace('.', ',') : ''}">
      <input data-pk-desc placeholder="Observação (opcional)" aria-label="Observação" class="grow" maxlength="120" value="${esc(pk.description || '')}">
      <button type="button" class="icon-btn" aria-label="Remover pacote" title="Remover">✕</button>`;
    $('button', div).addEventListener('click', () => div.remove());
    pkBox.appendChild(div);
  }
  $('[data-add-package]').addEventListener('click', () => packageRow());
  $('[data-has-clinic]').addEventListener('change', (e) => $('[data-clinic]').classList.toggle('hidden', !e.target.checked));

  function fillProfile() {
    form.name.value = me.name;
    form.profession.value = me.profession;
    form.registry.value = me.registry;
    form.phone.value = fmtPhone(me.phone);
    form.specialties.value = me.specialties;
    form.bio.value = me.bio;
    form.session_minutes.value = me.session_minutes ? String(me.session_minutes) : '';
    form.instagram.value = me.instagram || '';
    form.price.value = me.price_cents != null ? (me.price_cents / 100).toFixed(2).replace('.', ',') : '';
    form.pix_key.value = me.pix_key;
    form.state.innerHTML = ufOptions(me.state, 'UF');
    form.city.value = me.city;
    form.has_clinic.checked = me.has_clinic;
    $('[data-clinic]').classList.toggle('hidden', !me.has_clinic);
    form.clinic_name.value = me.clinic_name;
    form.clinic_address.value = me.clinic_address;
    form.maps_url.value = me.maps_url || '';
    pkBox.innerHTML = '';
    me.packages.forEach(packageRow);
  }
  fillProfile();
  bindUfCity(form.state, form.city);
  form.city.value = me.city;

  handleForm(form, async (d) => {
    d.has_clinic = form.has_clinic.checked;
    d.packages = $$('.row', pkBox).map((r) => ({
      sessions: $('[data-pk-sessions]', r).value, price: $('[data-pk-price]', r).value, description: $('[data-pk-desc]', r).value,
    })).filter((p) => p.sessions || p.price);
    me = await api('/api/professional/profile', { method: 'PUT', body: d });
    renderMe();
    toast('Perfil salvo!');
  });

  // ---------- Minhas publicações (versão 1.2: substituem a galeria de 6 fotos) ----------
  async function loadMyPosts() {
    const box = $('[data-my-posts]');
    try {
      const data = await api(`/api/social/professionals/${me.id}/posts?limit=60`);
      box.innerHTML = data.items.length
        ? data.items.map(AcoliaSocial.gridTile).join('')
        : '<p class="muted small" style="grid-column:1/-1;margin:0">Você ainda não publicou nada.</p>';
    } catch (e) { box.innerHTML = `<p class="muted small">${esc(e.message)}</p>`; }
  }
  $('[data-my-posts]').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-post-open]');
    if (b) { await AcoliaSocial.openPost(Number(b.dataset.postOpen)); loadMyPosts(); }
  });
  loadMyPosts();

  $('[data-photo-input]').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('photo', await Acolia.shrinkImage(file));
    try { me = await api('/api/professional/photo', { method: 'POST', form: fd }); renderMe(); toast('Foto atualizada!'); } catch (ex) { toast(ex.message, 'error'); }
    e.target.value = '';
  });

  $('[data-preview]').addEventListener('click', (e) => {
    e.preventDefault();
    const p = { ...me, locked: false, gallery: (me.gallery || []).filter(Boolean) };
    modal({ title: 'Prévia do seu perfil', html: `<div style="zoom:.85">${AcoliaProfile.render(p)}</div>`, actions: [{ label: 'Fechar' }] })
      .then(() => {});
    $$('dialog').at(-1).style.maxWidth = 'min(900px, calc(100vw - 32px))';
  });

  // ---------- Conta ----------
  handleForm($('[data-pw-form]'), async (d, f) => {
    await api('/api/professional/password', { method: 'POST', body: d });
    f.reset();
    toast('Senha alterada!');
  });
  $('[data-logout]').addEventListener('click', () => logout('/'));
  AcoliaDeleteAccount($('[data-delete-account]'), '/api/professional/delete');
  $('[data-install-btn]').addEventListener('click', installApp);
  Acolia.setupNotifications($('.panel-main'));

  // ---------- Atendimento ----------
  async function loadCalls() {
    const data = await api('/api/calls');
    const box = $('[data-active-call]');
    const actives = data.actives || [];
    $('[data-new-call]').classList.toggle('hidden', actives.length >= data.max_active);
    $('[data-calls-left]').textContent = actives.length
      ? `Você tem ${actives.length} de ${data.max_active} atendimentos abertos.` : '';
    const small = (name) => ICONS[name].replace('<svg', '<svg style="width:16px;height:16px"');
    box.innerHTML = actives.map((c) => `<div class="card stack" style="border-color:var(--primary);margin-bottom:16px" data-call="${c.id}">
        <div class="row between"><h2 style="margin:0">Atendimento com ${esc(c.patient_label)}</h2><span class="badge ok">Aberto</span></div>
        <div><div class="muted small" style="font-weight:700">CÓDIGO DO PACIENTE</div><div class="code-box">${esc(c.patient_code)}</div></div>
        <div class="row"><button class="btn secondary sm" data-copy-code="${esc(c.patient_code)}">${small('copy')} Copiar código</button>
          <button class="btn secondary sm" data-copy-link="${esc(c.patient_code)}">${small('copy')} Copiar link para o paciente</button></div>
        <div class="row">
          <a class="btn" href="/atendimento?codigo=${encodeURIComponent(c.patient_code)}" target="_blank" rel="noopener">${ICONS.video.replace('<svg', '<svg style="width:20px;height:20px"')} Entrar na chamada</a>
          <button class="btn danger" data-end-call="${c.id}">Finalizar atendimento</button>
        </div>
      </div>`).join('');
    $$('[data-copy-code]', box).forEach((b) => b.addEventListener('click', () => copyText(b.dataset.copyCode)));
    $$('[data-copy-link]', box).forEach((b) => b.addEventListener('click', () => copyText(`${location.origin}/atendimento?codigo=${b.dataset.copyLink}`)));
    $$('[data-end-call]', box).forEach((b) => b.addEventListener('click', async () => {
      if (!await confirmDialog('Finalizar este atendimento? O código do paciente deixará de funcionar.', { okLabel: 'Finalizar', danger: true })) return;
      await api(`/api/calls/${b.dataset.endCall}/end`, { method: 'POST' });
      toast('Atendimento finalizado');
      loadCalls();
    }));
    $('[data-history]').innerHTML = data.items.length ? data.items.map((h) => `<tr>
      <td>${esc(h.patient_label)}</td><td><code>${esc(h.patient_code)}</code></td>
      <td>${parseDate(h.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</td>
      <td>${h.status === 'ativo' ? '<span class="badge ok">Ativo</span>' : '<span class="badge">Finalizado</span>'}</td></tr>`).join('')
      : '<tr><td colspan="4" class="muted center">Nenhum atendimento ainda.</td></tr>';
  }
  handleForm($('[data-new-call]'), async (d, f) => {
    await api('/api/calls', { method: 'POST', body: d });
    f.reset();
    toast('Código do paciente gerado!');
    loadCalls();
  });

  // ---------- Chat ----------
  const socket = io();
  const setUnread = (n) => $$('[data-unread]').forEach((el) => { el.textContent = n ? String(n) : ''; });
  const chat = AcoliaChat.mount($('[data-chat]'), {
    role: 'professional', me: () => me, socket, onUnreadChange: setUnread,
    onNavigate: (id) => { const h = id ? `#conversas/${id}` : '#conversas'; if (location.hash.startsWith('#conversas') && location.hash !== h) history.replaceState(null, '', h); },
  });

  // ---------- Início estilo Instagram e outros profissionais (versão 1.2) ----------
  const openPro = (id) => { location.hash = id === me.id ? 'perfil' : `verpro/${id}`; };
  AcoliaSocial.setContext({ role: 'professional', me, onOpenProfile: openPro, onAllPosts: (id, kind) => { location.hash = `posts/${id}/${kind || 'photo'}`; } });
  let home = null;
  let catalogMounted = false;

  async function showPro(id) {
    const box = $('[data-pro-view]');
    box.innerHTML = '<div class="spinner"></div>';
    try {
      const p = await api(`/api/professionals/${id}`);
      // Profissional não manda mensagem para profissional: só segue, curte e comenta
      box.innerHTML = AcoliaProfile.render(p);
      AcoliaSocial.bindProfile(box, p);
    } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }

  // ---------- Rotas ----------
  function route() {
    const [view, arg] = (location.hash.slice(1) || 'inicio').split('/');
    const v = ['inicio', 'profissionais', 'verpro', 'posts', 'conversas', 'atendimento', 'perfil', 'conta'].includes(view) ? view : 'inicio';
    $$('[data-view]').forEach((s) => s.classList.toggle('hidden', s.dataset.view !== v));
    $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === (v === 'verpro' || v === 'posts' ? 'profissionais' : v)));
    if (v === 'posts' && arg) AcoliaSocial.mountPostsPage($('[data-posts-page]'), Number(arg), { onBack: (id) => openPro(id) });
    if (v === 'inicio' && !home) {
      home = AcoliaSocial.mountHome($('[data-home]'), {
        role: 'professional', me, socket, onOpenProfile: openPro,
        onFindPros: () => { location.hash = 'profissionais'; },
        onUnread: (n) => $$('[data-home-badge]').forEach((el) => { el.textContent = n ? String(n) : ''; }),
      });
    }
    if (v === 'profissionais' && !catalogMounted) {
      catalogMounted = true;
      AcoliaCatalog.mount($('[data-catalog]'), { loggedIn: false, viewerRole: 'professional', profileHref: (p) => `#verpro/${p.id}` });
    }
    if (v === 'verpro' && arg) showPro(Number(arg));
    if (v === 'perfil') loadMyPosts(); // sempre atualizada (inclusive depois de publicar no Início)
    if (v === 'atendimento') loadCalls().catch((e) => toast(e.message, 'error'));
    if (v === 'conversas') {
      if (arg && chat.current?.id !== Number(arg)) chat.open(Number(arg));
      if (!arg && chat.current) chat.close();
    }
    document.body.style.overflow = v === 'conversas' ? 'hidden' : '';
  }
  // Casinha tocada estando no Início: volta ao topo e atualiza o feed
  $$('[data-nav="inicio"]').forEach((a) => a.addEventListener('click', (e) => {
    if (home && (location.hash || '#inicio').startsWith('#inicio')) { e.preventDefault(); home.toTop(); }
  }));
  window.addEventListener('hashchange', route);
  renderMe();
  route();
})();
