/* Painel do profissional */
(async function () {
  'use strict';
  const { $, $$, api, ICONS, avatar, esc, toast, handleForm, logout, installApp, ufOptions, bindUfCity, maskPhone, fmtPhone,
    fmtDate, parseDate, copyText, confirmDialog, modal, money } = Acolia;

  const auth = await api('/api/auth/me').catch((e) => ({ offline: e.status === 0 }));
  if (auth.offline) { window.addEventListener('online', () => location.reload(), { once: true }); return; } // sem internet: espera voltar
  if (auth.role !== 'professional') { location.replace(location.hash ? '/entrar?next=' + encodeURIComponent('/painel' + location.hash) + '#profissional' : '/'); return; }
  if (auth.account?.blocked) { Acolia.showBlocked(auth); return; } // bloqueado (admin ou assinatura vencida)
  if (auth.account?.needs_cpf) { Acolia.showNeedsCpf(auth); return; } // conta antiga sem CPF: informa para liberar
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
  // Plano: mostra o atual; com mais de um plano, o profissional troca aqui (a secretária não vê)
  function renderPlan() {
    const box = $('[data-plan-box]');
    if (!box) return;
    if (isSec) { $('[data-plan-row]')?.remove(); return; }
    const plans = cfg.plans || [];
    const cur = plans.find((x) => x.key === me.plan) || plans[0];
    if (plans.length < 2) { box.innerHTML = `<b>${esc(cur ? cur.label : '—')}</b>`; return; }
    box.innerHTML = `<select data-plan-sel aria-label="Plano">${plans.map((x) => `<option value="${esc(x.key)}" ${x.key === cur?.key ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select>`;
    $('[data-plan-sel]').addEventListener('change', async (e) => {
      try { await api('/api/professional/plan', { method: 'POST', body: { plan: e.target.value } }); me.plan = e.target.value; toast('Plano alterado!'); }
      catch (ex) { toast(ex.message, 'error'); renderPlan(); }
    });
  }
  renderPlan();
  // "Aceitar mensagens e agendamentos": salva na hora (a secretária não muda esta opção)
  if (isSec) $('[data-accepts-card]')?.remove();
  $('[data-accepts-messages]')?.addEventListener('change', async (e) => {
    const on = e.target.checked;
    if (!on && !await confirmDialog('Desligar as mensagens e os agendamentos? Seu perfil continua aparecendo e você continua publicando, mas os pacientes não conseguem mandar mensagem nova nem marcar consulta até você ligar de novo. Sua agenda fica guardada.', { okLabel: 'Desligar', title: 'Pausar atendimento' })) { e.target.checked = true; return; }
    try {
      await api('/api/professional/accepts-messages', { method: 'POST', body: { on } });
      me.accepts_messages = on;
      toast(on ? 'Pronto! Pacientes já podem mandar mensagem e marcar consulta.' : 'Mensagens e agendamentos pausados. Sua agenda ficou guardada.');
    } catch (ex) { e.target.checked = !on; toast(ex.message, 'error'); }
  });
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
    $('[data-accepts-messages]').checked = me.accepts_messages !== false;
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
    try {
      me = await api('/api/professional/photo', { method: 'POST', form: fd }); renderMe(); toast('Foto atualizada!');
      if (me.photo && $('[data-photo-banner]')) { $('[data-photo-banner]').remove(); Acolia.installBanner($('.panel-main')); }
    } catch (ex) { toast(ex.message, 'error'); }
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
  // Sem foto de perfil: aviso fixo para colocar (some quando colocar). Com foto: aviso de baixar o app.
  if (!isSec && !me.photo) {
    const ph = document.createElement('div');
    ph.className = 'notice warn push-banner';
    ph.dataset.photoBanner = '';
    ph.innerHTML = '<span class="grow"><b>Coloque a sua foto de perfil.</b> Perfis com foto passam mais confiança e aparecem melhor na vitrine.</span><button class="btn sm" type="button" data-add-photo>Colocar foto</button>';
    $('[data-add-photo]', ph).addEventListener('click', () => $('[data-photo-input]').click());
    $('.panel-main').prepend(ph);
  } else if (!isSec) Acolia.installBanner($('.panel-main'));
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
  window.AcoliaAgenda?.onChange(() => { loadMyPatients().catch(() => {}); loadFinance().catch(() => {}); }); // presencial confirmada entra na lista e no financeiro

  // ---------- Financeiro ----------
  const MONTHS_PT = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  const FIN_STATE = { recebido: ['Recebido', 'ok'], a_confirmar: ['A confirmar', 'warn'], reembolsado: ['Reembolsado', ''], nao_reembolsado: ['Não reembolsado', 'danger'] };
  const MANUAL_STATES = ['recebido', 'reembolsado', 'nao_reembolsado'];
  const FIN_WHY = {
    recebido: ['Recebido', 'Consultas pagas que aconteceram: online, quando a chamada terminou; presencial, quando você confirmou que aconteceu. Inclui os lançamentos que você fez à mão e marcou como recebido.'],
    a_confirmar: ['A confirmar', 'Consultas já pagas que ainda vão acontecer. Ainda podem ser remarcadas ou reembolsadas, por isso ficam separadas. Depois que acontecem, passam para Recebido.'],
    reembolsado: ['Reembolsado', 'Consultas não realizadas em que o paciente pediu o reembolso no prazo (ou você não pôde atender). Esse dinheiro voltou para o paciente.'],
    nao_reembolsado: ['Dinheiro não reembolsado', 'Consultas não realizadas em que o paciente perdeu o prazo de reembolso (por exemplo, não entrou na chamada ou faltou na presencial). O pagamento fica com você.'],
  };
  let finYm = null;
  let finTimer = null;
  const finQuery = () => {
    const qs = new URLSearchParams();
    const from = $('[data-fin-from]').value; const to = $('[data-fin-to]').value; const q = $('[data-fin-q]').value.trim();
    if (from || to) { if (from) qs.set('from', from); if (to) qs.set('to', to); } else if (finYm) qs.set('ym', finYm);
    if (q) qs.set('q', q);
    return qs.toString();
  };
  async function loadFinance() {
    if (!$('[data-finance]') || isSec) return;
    const d = await api(`/api/professional/finance?${finQuery()}`);
    finYm = d.ym;
    const ranged = !!($('[data-fin-from]').value || $('[data-fin-to]').value);
    const [y, m] = d.ym.split('-').map(Number);
    $('[data-fin-month]').textContent = ranged ? 'Período escolhido' : `${MONTHS_PT[m - 1].charAt(0).toUpperCase() + MONTHS_PT[m - 1].slice(1)} de ${y}`;
    const P = d.period;
    const tile = (k, cents, n) => `<div class="fin-tile ${k}"><span class="small">${FIN_STATE[k][0]} <button type="button" class="pause-q" data-fin-why="${k}" aria-label="O que é">?</button></span><b>${money(cents)}</b><small>${n} consulta${n === 1 ? '' : 's'}</small></div>`;
    $('[data-fin-grid]').innerHTML = tile('recebido', P.recebido_cents, P.realizadas) + tile('a_confirmar', P.a_confirmar_cents, P.a_confirmar)
      + tile('reembolsado', P.reembolsado_cents, P.reembolsos) + tile('nao_reembolsado', P.nao_reembolsado_cents, P.nao_reembolsados);
    $('[data-fin-counts]').innerHTML = `<span><b>${P.clientes}</b> cliente${P.clientes === 1 ? '' : 's'}</span><span><b>${P.realizadas}</b> consulta${P.realizadas === 1 ? '' : 's'} realizada${P.realizadas === 1 ? '' : 's'}</span><span><b>${P.reembolsos}</b> reembolso${P.reembolsos === 1 ? '' : 's'}</span>`;
    $('[data-fin-list]').innerHTML = d.items.length ? d.items.map((e) => `<tr>
      <td style="white-space:nowrap">${e.date.split('-').reverse().join('/')}</td>
      <td><b>${esc(e.name)}</b><div class="small muted">${e.kind === 'manual' ? `<span class="badge manual">Lançado à mão</span>${e.note ? ` ${esc(e.note)}` : ''}` : `Pela Acolia · ${e.modality === 'presencial' ? 'presencial' : 'online'}`}</div></td>
      <td style="white-space:nowrap">${esc(e.cpf || '—')}</td><td style="white-space:nowrap"><b>${money(e.amount_cents)}</b></td>
      <td><span class="badge ${FIN_STATE[e.state][1]}">${FIN_STATE[e.state][0]}</span>${e.kind === 'manual' ? `<div><button type="button" class="link-btn small" data-fin-reg="${esc(e.key.slice(1))}" data-cur="${e.state}">Registrar</button></div>` : ''}</td>
      <td><button type="button" class="icon-btn" data-fin-del="${esc(e.key)}" aria-label="Tirar este valor" title="Tirar da lista">${ICONS.trash}</button></td></tr>`).join('')
      : '<tr><td colspan="6" class="muted center">Nenhum valor neste período.</td></tr>';
  }
  if ($('[data-finance]') && !isSec) {
    const reloadFin = () => { clearTimeout(finTimer); finTimer = setTimeout(() => loadFinance().catch((e) => toast(e.message, 'error')), 250); };
    const shift = (n) => { const [y, m] = finYm.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); finYm = d.toISOString().slice(0, 7); $('[data-fin-from]').value = ''; $('[data-fin-to]').value = ''; reloadFin(); };
    // PDF com o mesmo filtro da tela (mês, período e busca)
    $('[data-fin-pdf]').addEventListener('click', (e) => { e.preventDefault(); location.href = `/api/professional/finance/report.pdf?${finQuery()}`; });
    $('[data-fin-prev]').addEventListener('click', () => shift(-1));
    $('[data-fin-next]').addEventListener('click', () => shift(1));
    $('[data-fin-from]').addEventListener('change', reloadFin);
    $('[data-fin-to]').addEventListener('change', reloadFin);
    $('[data-fin-q]').addEventListener('input', reloadFin);
    $('[data-fin-clear]').addEventListener('click', () => { $('[data-fin-from]').value = ''; $('[data-fin-to]').value = ''; $('[data-fin-q]').value = ''; reloadFin(); });
    $('[data-finance]').addEventListener('click', async (e) => {
      const w = e.target.closest('[data-fin-why]');
      if (w) { const [t, x] = FIN_WHY[w.dataset.finWhy]; modal({ title: t, html: `<p>${esc(x)}</p>`, actions: [{ label: 'Entendi' }] }); return; }
      const reg = e.target.closest('[data-fin-reg]');
      if (reg) {
        const st = await modal({
          title: 'Registrar como',
          html: '<p class="small muted" style="margin-top:0">Como fica este lançamento feito à mão?</p>',
          actions: MANUAL_STATES.map((k) => ({ label: FIN_STATE[k][0], value: k, class: k === reg.dataset.cur ? '' : 'secondary' })).concat([{ label: 'Cancelar', value: null, class: 'ghost' }]),
        });
        if (!st || st === reg.dataset.cur) return;
        try { await api(`/api/professional/finance/manual/${reg.dataset.finReg}/state`, { method: 'POST', body: { state: st } }); toast('Registrado!'); loadFinance(); } catch (ex) { toast(ex.message, 'error'); }
        return;
      }
      const del = e.target.closest('[data-fin-del]');
      if (del) {
        if (!await confirmDialog('Tirar este valor do financeiro? (Não muda a consulta nem o pagamento.)', { okLabel: 'Tirar', danger: true, title: 'Financeiro' })) return;
        try { await api('/api/professional/finance/remove', { method: 'POST', body: { key: del.dataset.finDel } }); toast('Valor tirado da lista.'); loadFinance(); } catch (ex) { toast(ex.message, 'error'); }
      }
    });
    $('[data-fin-add]').addEventListener('click', async () => {
      const ok = await modal({
        title: 'Lançar consulta',
        html: `<div class="form-error hidden" data-err></div>
          <div class="field"><label>Nome do paciente</label><input data-f="name" maxlength="120"></div>
          <div class="grid-2"><div class="field"><label>CPF (opcional)</label><input data-f="cpf" inputmode="numeric" placeholder="000.000.000-00"></div>
            <div class="field"><label>Data da consulta</label><input data-f="date" type="date" value="${new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10)}"></div></div>
          <div class="field"><label>Valor da consulta (R$)</label><input data-f="amount" inputmode="decimal" placeholder="Ex.: 150,00"></div>
          <div class="field"><label>Registrar como</label><div class="row" style="gap:8px;flex-wrap:wrap" role="radiogroup">
            ${MANUAL_STATES.map((k, i) => `<label class="chip-radio"><input type="radio" name="fin-state" value="${k}" ${i ? '' : 'checked'}> ${FIN_STATE[k][0]}</label>`).join('')}</div></div>
          <div class="field"><label>Observação (opcional)</label><input data-f="note" maxlength="200"></div>`,
        onOpen: (dlg) => Acolia.maskCpf($('[data-f="cpf"]', dlg)),
        actions: [{ label: 'Cancelar', value: false, class: 'secondary' }, { label: 'Lançar', handler: async (dlg) => {
          const v = (k) => $(`[data-f="${k}"]`, dlg).value;
          try { await api('/api/professional/finance/manual', { method: 'POST', body: { name: v('name'), cpf: v('cpf'), date: v('date'), amount: v('amount'), note: v('note'), state: $('[name="fin-state"]:checked', dlg).value } }); return true; }
          catch (ex) { const er = $('[data-err]', dlg); er.textContent = ex.message; er.classList.remove('hidden'); return false; }
        } }],
      });
      if (ok) { toast('Consulta lançada!'); loadFinance(); }
    });
    loadFinance().catch(() => {});
  }
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
  AcoliaClinics.setOpenPro(openPro); // profissionais da clínica: abre o perfil no painel
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
    const views = ['inicio', 'profissionais', 'clinicas', 'verpro', 'posts', 'conversas', 'atendimento', 'perfil', 'conta', ...(isSec ? [] : ['chamadas', 'financeiro'])];
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
    if (v === 'clinicas') AcoliaClinics.mountList($('[data-clinics-page]'));
    if (v === 'financeiro') loadFinance().catch((e) => toast(e.message, 'error'));
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
