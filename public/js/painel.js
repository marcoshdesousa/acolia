/* Painel do profissional */
(async function () {
  'use strict';
  const { $, $$, api, ICONS, avatar, esc, toast, handleForm, logout, installApp, ufOptions, bindUfCity, maskPhone, fmtPhone,
    fmtDate, parseDate, copyText, confirmDialog, modal } = Acolia;

  const auth = await api('/api/auth/me').catch(() => ({}));
  if (auth.role !== 'professional') { location.replace('/entrar#profissional'); return; }
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
    form.price.value = me.price_cents != null ? (me.price_cents / 100).toFixed(2).replace('.', ',') : '';
    form.pix_key.value = me.pix_key;
    form.state.innerHTML = ufOptions(me.state, 'UF');
    form.city.value = me.city;
    form.has_clinic.checked = me.has_clinic;
    $('[data-clinic]').classList.toggle('hidden', !me.has_clinic);
    form.clinic_name.value = me.clinic_name;
    form.clinic_address.value = me.clinic_address;
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

  $('[data-photo-input]').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('photo', file);
    try { me = await api('/api/professional/photo', { method: 'POST', form: fd }); renderMe(); toast('Foto atualizada!'); } catch (ex) { toast(ex.message, 'error'); }
    e.target.value = '';
  });

  $('[data-preview]').addEventListener('click', (e) => {
    e.preventDefault();
    const p = { ...me, locked: false };
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
    const c = data.active;
    $('[data-new-call]').classList.toggle('hidden', !!c);
    if (c) {
      const link = `${location.origin}/atendimento?codigo=${c.patient_code}`;
      box.innerHTML = `<div class="card stack" style="border-color:var(--primary)">
        <div class="row between"><h2 style="margin:0">Atendimento em aberto</h2><span class="badge ok">Ativo</span></div>
        <div>Paciente: <b>${esc(c.patient_label)}</b></div>
        <div><div class="muted small" style="font-weight:700">CÓDIGO DO PACIENTE</div><div class="code-box">${esc(c.patient_code)}</div></div>
        <div class="row"><button class="btn secondary sm" data-copy-code>${ICONS.copy.replace('<svg', '<svg style="width:16px;height:16px"')} Copiar código</button>
          <button class="btn secondary sm" data-copy-link>${ICONS.copy.replace('<svg', '<svg style="width:16px;height:16px"')} Copiar link para o paciente</button></div>
        <div class="row">
          <a class="btn" href="/atendimento?codigo=${encodeURIComponent(me.code)}" target="_blank" rel="noopener">${ICONS.video.replace('<svg', '<svg style="width:20px;height:20px"')} Iniciar atendimento</a>
          <button class="btn danger" data-end>Finalizar atendimento</button>
        </div>
        <p class="small muted" style="margin:0">Na sala, você entra com o seu código único; o paciente, com o código dele. Sua câmera precisa ficar ligada durante todo o atendimento.</p>
      </div>`;
      $('[data-copy-code]', box).addEventListener('click', () => copyText(c.patient_code));
      $('[data-copy-link]', box).addEventListener('click', () => copyText(link));
      $('[data-end]', box).addEventListener('click', async () => {
        if (!await confirmDialog('Finalizar este atendimento? O código do paciente deixará de funcionar.', { okLabel: 'Finalizar', danger: true })) return;
        await api(`/api/calls/${c.id}/end`, { method: 'POST' });
        toast('Atendimento finalizado');
        loadCalls();
      });
    } else box.innerHTML = '';
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

  // ---------- Rotas ----------
  function route() {
    const [view, arg] = (location.hash.slice(1) || 'conversas').split('/');
    const v = ['conversas', 'atendimento', 'perfil', 'conta'].includes(view) ? view : 'conversas';
    $$('[data-view]').forEach((s) => s.classList.toggle('hidden', s.dataset.view !== v));
    $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === v));
    if (v === 'atendimento') loadCalls().catch((e) => toast(e.message, 'error'));
    if (v === 'conversas') {
      if (arg && chat.current?.id !== Number(arg)) chat.open(Number(arg));
      if (!arg && chat.current) chat.close();
    }
    document.body.style.overflow = v === 'conversas' ? 'hidden' : '';
  }
  window.addEventListener('hashchange', route);
  renderMe();
  route();
})();
