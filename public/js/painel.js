/* Painel do profissional */
(async function () {
  'use strict';
  const { $, $$, api, ICONS, avatar, esc, toast, handleForm, logout, installApp, ufOptions, bindUfCity, maskPhone, fmtPhone,
    fmtDate, parseDate, copyText, confirmDialog, modal } = Acolia;

  const auth = await api('/api/auth/me').catch((e) => ({ offline: e.status === 0 }));
  if (auth.offline) { window.addEventListener('online', () => location.reload(), { once: true }); return; } // sem internet: espera voltar
  if (auth.role !== 'professional') { location.replace(location.hash ? '/entrar?next=' + encodeURIComponent('/painel' + location.hash) + '#profissional' : '/'); return; }
  if (auth.account?.blocked) { Acolia.showBlocked(auth); return; } // bloqueado (admin ou assinatura vencida)
  let me = auth.user;
  // Versão 1.1.3: secretária usa este mesmo painel, com limites (ver js/secretary.js)
  const isSec = !!auth.secretary;
  const cfg = await api('/api/config');

  $('[data-logo]').innerHTML = ICONS.logo;
  $$('[data-i]').forEach((el) => { el.outerHTML = ICONS[el.dataset.i]; });

  function renderLink() {
    const url = `${location.origin}/${me.slug}`;
    $('[data-my-link]').textContent = url;
    $('[data-open-link]').href = `/${me.slug}`;
    if ($('[data-origin]')) $('[data-origin]').textContent = `${location.host}/`;
    if ($('[data-slug-form]')) $('[data-slug-form]').slug.value = me.slug || ''; // (a secretária não tem)
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
    if ($('[data-my-code]')) $('[data-my-code]').textContent = me.code || '';
    if ($('[data-my-code2]')) $('[data-my-code2]').textContent = me.code || '';
    // (a engrenagem da secretária não tem esses campos)
    if ($('[data-sub]')) $('[data-sub]').textContent = fmtDate(me.subscription_until);
    if ($('[data-visibility]')) $('[data-visibility]').innerHTML = me.visible ? '<span class="badge ok">Visível para pacientes</span>'
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
  // Consultório: com a opção marcada, nome, endereço e link do Google Maps são obrigatórios
  const syncClinic = () => {
    const on = form.has_clinic.checked;
    $('[data-clinic]').classList.toggle('hidden', !on);
    [form.clinic_name, form.clinic_address, form.maps_url].forEach((i) => { i.required = on; });
  };
  $('[data-has-clinic]').addEventListener('change', syncClinic);
  // Saiu do Meu perfil sem salvar: a parte do consultório volta a ser o que está salvo (a caixinha fecha)
  let lastHash = location.hash;
  window.addEventListener('hashchange', () => {
    const was = lastHash; lastHash = location.hash;
    if (!/^#perfil/.test(was) || /^#perfil/.test(location.hash)) return;
    const changed = form.has_clinic.checked !== !!me.has_clinic || (form.has_clinic.checked && (form.clinic_name.value !== (me.clinic_name || '') || form.clinic_address.value !== (me.clinic_address || '') || form.maps_url.value !== (me.maps_url || '')));
    if (!changed) return;
    form.has_clinic.checked = !!me.has_clinic;
    form.clinic_name.value = me.clinic_name || '';
    form.clinic_address.value = me.clinic_address || '';
    form.maps_url.value = me.maps_url || '';
    syncClinic();
    toast(me.has_clinic ? 'Os dados do consultório não foram salvos: voltaram para os anteriores.' : 'O consultório não foi salvo: a opção presencial ficou desmarcada. Para atender presencial, preencha tudo e toque em "Salvar perfil".');
  });
  // Valor da presencial: o mesmo da online ou diferente (aí o campo do valor aparece)
  const syncPres = () => $('[data-pres-diff]').classList.toggle('hidden', form.presencial_price.value !== 'diff');
  $$('input[name="presencial_price"]', form).forEach((r) => r.addEventListener('change', syncPres));

  // Especialidades: escolhe na lista (pode acrescentar e tirar; as 2 primeiras aparecem no perfil)
  const spPicker = AcoliaSpecialties.picker($('[data-sp-picker]', form), { name: 'specialties', hint: 'As <b>2 primeiras</b> aparecem no seu perfil; as outras ficam no botão <b>+</b>. Para mudar a ordem, tire e escolha de novo.' });
  function fillProfile() {
    form.name.value = me.name;
    form.profession.value = me.profession;
    form.registry.value = me.registry;
    form.registry.closest('.field').classList.toggle('hidden', !me.registry); // psicanalista, psicoterapeuta e terapeuta: sem conselho
    form.phone.value = fmtPhone(me.phone);
    form.email.value = me.email || '';
    spPicker.then((sp) => sp.set(AcoliaSpecialties.list(me.specialties)));
    form.bio.value = me.bio;
    $('[data-social-fields]', form).innerHTML = window.Acolia.socialFields(me.social_values);
    form.price.value = me.price_cents != null ? (me.price_cents / 100).toFixed(2).replace('.', ',') : '';
    form.state.innerHTML = ufOptions(me.state, 'UF');
    form.city.value = me.city;
    form.has_clinic.checked = me.has_clinic;
    form.accepts_insurance.checked = me.accepts_insurance;
    form.clinic_name.value = me.clinic_name;
    form.clinic_address.value = me.clinic_address;
    form.maps_url.value = me.maps_url || '';
    form.presencial_price.value = me.presencial_price || 'same';
    form.price_presencial.value = me.price_presencial_cents != null ? (me.price_presencial_cents / 100).toFixed(2).replace('.', ',') : '';
    syncPres();
    syncClinic();
  }
  fillProfile();
  // Secretária (só o profissional cria; fica logo depois da Localização)
  if (!isSec) window.AcoliaSecretary?.card($('[data-secretary-card]'));
  // Mensagens prontas (até 10), usadas no chat pelo "+"
  window.AcoliaQuick?.editor($('[data-quick-card]'));
  bindUfCity(form.state, form.city);
  form.city.value = me.city;

  handleForm(form, async (d) => {
    d.has_clinic = form.has_clinic.checked;
    if (d.has_clinic) {
      if (form.clinic_name.value.trim().length < 2) { form.clinic_name.focus(); throw new Error('Informe o nome da clínica (ou desmarque "Tenho consultório/clínica presencial").'); }
      if (form.clinic_address.value.trim().length < 5) { form.clinic_address.focus(); throw new Error('Informe o endereço completo da clínica (ou desmarque "Tenho consultório/clínica presencial").'); }
      if (!form.maps_url.value.trim()) { form.maps_url.focus(); throw new Error('Cole o link do Google Maps da clínica (no Google Maps: Compartilhar → Copiar link), ou desmarque "Tenho consultório/clínica presencial".'); }
    }
    d.specialties = (await spPicker).value();
    if (!d.specialties.length) throw new Error('Escolha pelo menos uma especialidade.');
    d.accepts_insurance = form.accepts_insurance.checked;
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
  window.addEventListener('acolia:posted', loadMyPosts); // terminou um envio em segundo plano

  $('[data-photo-input]').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('photo', await Acolia.shrinkImage(file, 640)); // foto de perfil aparece pequena: 640 px basta
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
  Acolia.renewBanner(auth, $('.panel-main')); // aviso: assinatura acabando (2 dias antes)

  // ---------- Atendimento ----------
  async function loadCalls() {
    const data = await api('/api/calls');
    const box = $('[data-active-call]');
    const actives = data.actives || [];
    box.innerHTML = actives.map((c) => `<div class="card stack" style="border-color:var(--primary);margin-bottom:16px" data-call="${c.id}">
        <div class="row between"><h2 style="margin:0">Chamada com ${esc(c.patient_label)}</h2><span class="badge ok">Aberta</span></div>
        ${isSec ? '<p class="small muted" style="margin:0">Só o profissional entra na chamada.</p>' : `<div class="row">
          <a class="btn" href="/atendimento?codigo=${encodeURIComponent(c.patient_code)}" target="_blank" rel="noopener">${ICONS.video.replace('<svg', '<svg style="width:20px;height:20px"')} Entrar na chamada</a>
          <button class="btn danger" data-end-call="${c.id}">Finalizar atendimento</button>
        </div>`}
      </div>`).join('');
    $$('[data-end-call]', box).forEach((b) => b.addEventListener('click', async () => {
      if (!await confirmDialog('Finalizar este atendimento? O código do paciente deixará de funcionar.', { okLabel: 'Finalizar', danger: true })) return;
      await api(`/api/calls/${b.dataset.endCall}/end`, { method: 'POST' });
      toast('Atendimento finalizado');
      loadCalls();
    }));
    // Situação de cada chamada: só "Consulta realizada" quando aconteceu de verdade
    const OUTCOME = {
      ativo: '<span class="badge ok">Aberta</span>',
      realizada: '<span class="badge ok">Consulta realizada</span>',
      profissional_ausente: '<span class="badge warn">Não aconteceu: profissional não entrou (reembolso)</span>',
      paciente_ausente: '<span class="badge warn">Não aconteceu: paciente não entrou</span>',
      nao_realizada: '<span class="badge">Não aconteceu</span>',
    };
    $('[data-history]').innerHTML = data.items.length ? data.items.map((h) => `<tr>
      <td>${esc(h.patient_label)}</td><td>${h.patient_code ? `<code>${esc(h.patient_code)}</code>` : '—'}</td>
      <td>${parseDate(h.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</td>
      <td>${OUTCOME[h.outcome] || OUTCOME[h.status === 'ativo' ? 'ativo' : 'nao_realizada']}</td></tr>`).join('')
      : '<tr><td colspan="4" class="muted center">Nenhum atendimento ainda.</td></tr>';
  }
  // Meus pacientes: os da Acolia entram sozinhos (consulta online); os de fora ele adiciona (presencial ou online).
  // Filtro por nome/CPF, modalidade e período; lixeira tira da lista; baixar em PDF.
  let patTimer = null;
  let patMod = '';
  let patItems = [];
  const patQuery = () => {
    const qs = new URLSearchParams();
    const q = $('[data-pat-q]').value.trim();
    if (q) qs.set('q', q);
    if (patMod) qs.set('modality', patMod);
    if ($('[data-pat-from]').value) qs.set('from', $('[data-pat-from]').value);
    if ($('[data-pat-to]').value) qs.set('to', $('[data-pat-to]').value);
    return qs.toString();
  };
  async function loadMyPatients() {
    const filtered = !!patQuery();
    const { items, totals, period } = await api(`/api/professional/patients?${patQuery()}`);
    patItems = items;
    $('[data-pat-list]').innerHTML = items.length ? items.map((p) => `<tr>
      <td><b>${esc(p.name)}</b>${p.kind === 'manual' ? '<div class="small muted">Adicionado por você</div>' : '<div class="small muted">Pela Acolia</div>'}</td>
      <td style="white-space:nowrap">${esc(p.cpf)}</td><td>${esc(p.birth_date)}</td>
      <td>${esc(p.place)}</td><td><span class="badge ${p.modality === 'online' ? 'ok' : ''}">${p.modality === 'online' ? 'Online' : 'Presencial'}</span></td>
      <td class="center">${p.consultas}</td><td>${esc(p.ultima)}</td>
      <td style="white-space:nowrap">${p.kind === 'manual' ? `<button type="button" class="icon-btn" data-pat-edit="${esc(p.key)}" aria-label="Editar ${esc(p.name)}" title="Editar">${ICONS.edit}</button>` : ''}<button type="button" class="icon-btn" data-pat-del="${esc(p.key)}" aria-label="Tirar ${esc(p.name)} da lista" title="Tirar da lista">${ICONS.trash}</button></td></tr>`).join('')
      : `<tr><td colspan="8" class="muted center">${filtered ? 'Nenhum paciente encontrado com esse filtro.' : 'Quando você fizer consultas pela Acolia, seus pacientes aparecem aqui. Atendeu fora? Toque em "Adicionar paciente".'}</td></tr>`;
    $('[data-pat-summary]').innerHTML = `<span class="small muted">Período: <b>${esc(period)}</b></span>
      <span class="pat-num"><b>${totals.patients}</b> paciente${totals.patients === 1 ? '' : 's'}</span>
      <span class="pat-num"><b>${totals.consultations}</b> consulta${totals.consultations === 1 ? '' : 's'}</span>`;
  }
  window.AcoliaAgenda?.onChange(() => { loadMyPatients().catch(() => {}); }); // presencial confirmada entra na lista
  const reloadPatients = () => { clearTimeout(patTimer); patTimer = setTimeout(() => loadMyPatients().catch((e) => toast(e.message, 'error')), 250); };
  $('[data-pat-q]').addEventListener('input', reloadPatients);
  $('[data-pat-from]').addEventListener('change', reloadPatients);
  $('[data-pat-to]').addEventListener('change', reloadPatients);
  $$('[data-pat-mod]').forEach((b) => b.addEventListener('click', () => {
    patMod = b.dataset.patMod;
    $$('[data-pat-mod]').forEach((x) => x.classList.toggle('on', x === b));
    reloadPatients();
  }));
  // Atalhos de período (datas do aparelho)
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  $$('[data-pat-range]').forEach((b) => b.addEventListener('click', () => {
    const now = new Date();
    let from = '';
    let to = '';
    if (b.dataset.patRange === 'month') { from = ymd(new Date(now.getFullYear(), now.getMonth(), 1)); to = ymd(new Date(now.getFullYear(), now.getMonth() + 1, 0)); }
    if (b.dataset.patRange === 'last') { from = ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)); to = ymd(new Date(now.getFullYear(), now.getMonth(), 0)); }
    if (b.dataset.patRange === 'year') { from = `${now.getFullYear()}-01-01`; to = `${now.getFullYear()}-12-31`; }
    $('[data-pat-from]').value = from;
    $('[data-pat-to]').value = to;
    $$('[data-pat-range]').forEach((x) => x.classList.toggle('on', x === b));
    reloadPatients();
  }));
  $$('[data-pat-export]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    const qs = patQuery();
    location.href = `/api/professional/patients.pdf${qs ? `?${qs}` : ''}`;
  }));
  // Adicionar / editar paciente atendido fora da Acolia
  async function patientForm(p) {
    const v = p?.raw || { modality: 'presencial', consultas: 1 };
    const today = ymd(new Date());
    await modal({
      title: p ? 'Editar paciente' : 'Adicionar paciente',
      html: `<p class="small muted" style="margin-top:0">Para pacientes que você atendeu fora da Acolia. Quem faz consulta pela Acolia entra na lista sozinho.</p>
        <div class="form-error hidden" data-err></div>
        <form class="stack" data-pf novalidate>
          <div class="field"><label>Nome completo</label><input name="name" required maxlength="120" value="${esc(v.name || '')}" autocomplete="off"></div>
          <div class="grid-2">
            <div class="field"><label>CPF</label><input name="cpf" required inputmode="numeric" placeholder="000.000.000-00" value="${esc(v.cpf || '')}"></div>
            <div class="field"><label>Data de nascimento</label><input name="birth_date" type="date" required max="${today}" value="${esc(v.birth_date || '')}"></div>
          </div>
          <div class="field"><label>Município</label><div class="grid-uf"><select name="state" aria-label="Estado" required>${Acolia.ufOptions(v.state || '')}</select><input name="city" required placeholder="Município" value="${esc(v.city || '')}"></div></div>
          <div class="field"><label>Atendimento</label><div class="row" style="gap:8px" role="radiogroup">
            <label class="chip-radio"><input type="radio" name="modality" value="presencial" ${v.modality !== 'online' ? 'checked' : ''}> Presencial</label>
            <label class="chip-radio"><input type="radio" name="modality" value="online" ${v.modality === 'online' ? 'checked' : ''}> Online</label></div></div>
          <div class="grid-2">
            <div class="field"><label>Consultas feitas</label><input name="consultas" type="number" min="1" max="9999" required value="${esc(String(v.consultas || 1))}"></div>
            <div class="field"><label>Data da última consulta</label><input name="last_date" type="date" required max="${today}" value="${esc(v.last_date || today)}"></div>
          </div>
        </form>`,
      onOpen: (dlg) => {
        const f = $('[data-pf]', dlg);
        Acolia.maskCpf(f.cpf);
        Acolia.bindUfCity(f.state, f.city);
        if (v.city) f.city.value = v.city;
        f.name.focus();
      },
      actions: [{ label: 'Cancelar', value: null, class: 'secondary' }, {
        label: p ? 'Salvar' : 'Adicionar',
        handler: async (dlg) => {
          const f = $('[data-pf]', dlg);
          const body = Object.fromEntries(new FormData(f));
          const err = $('[data-err]', dlg);
          try {
            await api(p ? `/api/professional/patients/manual/${p.id}` : '/api/professional/patients', { method: p ? 'PUT' : 'POST', body });
            toast(p ? 'Paciente atualizado ✓' : 'Paciente adicionado ✓');
            loadMyPatients();
            return true;
          } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); return false; }
        },
      }],
    });
  }
  $('[data-pat-add]').addEventListener('click', () => patientForm(null));
  $('[data-pat-list]').addEventListener('click', async (e) => {
    const ed = e.target.closest('[data-pat-edit]');
    if (ed) { patientForm(patItems.find((x) => x.key === ed.dataset.patEdit)); return; }
    const del = e.target.closest('[data-pat-del]');
    if (!del) return;
    const p = patItems.find((x) => x.key === del.dataset.patDel);
    if (!p) return;
    const msg = p.kind === 'manual'
      ? `Apagar ${p.name} da sua lista de pacientes?`
      : `Tirar ${p.name} da sua lista? Use para consultas de teste, por exemplo. Se você fizer uma nova consulta com ele(a) pela Acolia, ele(a) volta a aparecer.`;
    if (!await confirmDialog(msg, { okLabel: p.kind === 'manual' ? 'Apagar' : 'Tirar da lista', danger: true })) return;
    try {
      await api(p.kind === 'manual' ? `/api/professional/patients/manual/${p.id}` : `/api/professional/patients/${p.id}/hide`, { method: p.kind === 'manual' ? 'DELETE' : 'POST' });
      toast('Pronto ✓');
      loadMyPatients();
    } catch (ex) { toast(ex.message, 'error'); }
  });


  // ---------- Chat ----------
  const socket = io();
  socket.on('account:blocked', () => location.reload());
  const setUnread = (n) => $$('[data-unread]').forEach((el) => { el.textContent = n ? String(n) : ''; });
  // Consultas: aviso fixo da próxima consulta ("Ver" abre a página Consultas) e a agenda
  AcoliaAgenda.setContext({ role: 'professional', onGoChat: (id) => { location.hash = `conversas/${id}`; } });
  AcoliaAgenda.mountBar({ role: 'professional', socket, onSee: () => { location.hash = 'atendimento'; }, secretary: isSec ? { proName: me.name } : null });
  const agendaPro = AcoliaAgendaPro.mount({ appts: $('[data-appts]'), agenda: $('[data-agenda-card]'), asaas: $('[data-asaas-card]'), secretary: isSec });
  // Chamadas (câmera): só o profissional
  const callsPage = isSec ? null : AcoliaSecretary.mountCalls($('[data-calls-list]'));
  const chat = AcoliaChat.mount($('[data-chat]'), {
    secretary: isSec, // secretária: sem documentos
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
    const views = ['inicio', 'profissionais', 'verpro', 'posts', 'conversas', 'atendimento', 'perfil', 'conta', ...(isSec ? [] : ['chamadas'])];
    const v = views.includes(view) ? view : 'inicio';
    $$('[data-view]').forEach((s) => s.classList.toggle('hidden', s.dataset.view !== v));
    $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === (v === 'verpro' || v === 'posts' ? 'profissionais' : v)));
    if (v === 'posts' && arg) AcoliaSocial.mountPostsPage($('[data-posts-page]'), Number(arg), { onBack: (id) => openPro(id) });
    if (v === 'inicio' && home) home.refreshIfStale();
    if (v === 'inicio' && !home) {
      home = AcoliaSocial.mountHome($('[data-home]'), {
        role: 'professional', me, socket, onOpenProfile: openPro,
        onFindPros: () => { location.hash = 'profissionais'; },
        onUnread: (n) => $$('[data-home-badge]').forEach((el) => { el.textContent = n ? String(n) : ''; }),
      });
    }
    if (v === 'profissionais' && !catalogMounted) {
      catalogMounted = true;
      AcoliaCatalog.mount($('[data-catalog]'), { loggedIn: false, viewerRole: 'professional', excludeId: me.id, profileHref: (p) => `#verpro/${p.id}` });
    }
    if (v === 'verpro' && arg) showPro(Number(arg));
    if (v === 'chamadas') callsPage?.load();
    if (v === 'perfil') loadMyPosts(); // sempre atualizada (inclusive depois de publicar no Início)
    if (v === 'atendimento') { agendaPro.load(); loadCalls().catch((e) => toast(e.message, 'error')); loadMyPatients().catch((e) => toast(e.message, 'error')); }
    if (v === 'conversas') {
      if (arg === 'suporte') { if (!chat.current?.support) chat.openSupport(); } else if (arg && chat.current?.id !== Number(arg)) chat.open(Number(arg)); // Suporte Acolia: #…/suporte
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
  if (isSec) AcoliaSecretary.lockPanel(me);
  route();
})();
