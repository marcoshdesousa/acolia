/* Painel do administrador geral */
(async function () {
  'use strict';
  const { $, $$, api, ICONS, avatar, esc, toast, handleForm, logout, ufOptions, bindUfCity, maskPhone, fmtPhone, fmtDate,
    parseDate, money, modal, confirmDialog, copyText } = Acolia;

  $('[data-logo]').innerHTML = ICONS.logo;
  $$('[data-i]').forEach((el) => { el.outerHTML = ICONS[el.dataset.i]; });

  const auth = await api('/api/auth/me').catch(() => ({}));
  if (auth.role !== 'admin') {
    $('[data-login]').classList.remove('hidden');
    handleForm($('[data-login-form]'), async (d) => {
      await api('/api/auth/admin/login', { method: 'POST', body: d });
      location.reload();
    });
    return;
  }
  $('[data-app]').classList.remove('hidden');
  $('[data-bnav]').classList.remove('hidden');

  const cfg = await api('/api/config');
  let locations = {};

  const STATUS_BADGE = {
    pendente: '<span class="badge warn">Pendente</span>',
    aprovado: '<span class="badge ok">Aprovado</span>',
    recusado: '<span class="badge danger">Recusado</span>',
    restrito: '<span class="badge danger">Restrito</span>',
    bloqueado: '<span class="badge danger">Bloqueado</span>',
    ativo: '<span class="badge ok">Ativo</span>',
    excluido: '<span class="badge">Excluída pelo usuário</span>',
  };
  const fmtDT = (s) => parseDate(s).toLocaleDateString('pt-BR');
  const subBadge = (p) => {
    if (!p.subscription_until) return '<span class="badge">—</span>';
    const late = p.subscription_until < new Date().toISOString().slice(0, 10);
    return `<span class="badge ${late ? 'danger' : 'ok'}">${late ? 'Vencida ' : 'Até '}${fmtDate(p.subscription_until)}</span>`;
  };

  async function loadLocations() {
    locations = await api('/api/admin/locations');
    $$('[data-filter]').forEach((f) => {
      const cur = f.state.value;
      f.state.innerHTML = '<option value="">Todos os estados</option>' + Object.keys(locations).sort().map((uf) => `<option ${uf === cur ? 'selected' : ''}>${uf}</option>`).join('');
      fillCities(f);
    });
  }
  function fillCities(f) {
    const cur = f.city.value;
    const list = locations[f.state.value] || [];
    f.city.innerHTML = '<option value="">Todos os municípios</option>' + list.map((c) => `<option ${c === cur ? 'selected' : ''}>${esc(c)}</option>`).join('');
  }

  // ---------- Visão geral ----------
  async function loadStats() {
    const s = await api('/api/admin/stats');
    const tile = (n, l, href) => `<a class="card stat" href="${href}" style="text-decoration:none;color:inherit"><div class="n">${n}</div><div class="l">${l}</div></a>`;
    $('[data-stats]').innerHTML = [
      tile(s.pending, 'Aguardando aprovação', '#profissionais/pendente'),
      tile(s.visible, 'Profissionais na vitrine', '#profissionais/aprovado'),
      tile(s.overdue, 'Mensalidade vencida', '#profissionais/vencido'),
      tile(s.professionals, 'Profissionais (total)', '#profissionais'),
      tile(s.patients, 'Pacientes', '#pacientes'),
      tile(s.patients_blocked, 'Pacientes bloqueados', '#pacientes'),
      tile(s.conversations, 'Conversas iniciadas', '#inicio'),
    ].join('');
    $$('[data-pending]').forEach((el) => { el.textContent = s.pending || ''; });
    const st = s.storage;
    $('[data-storage]').innerHTML = st.permanent
      ? `<div class="notice ok">✓ Dados salvos de forma permanente — ${esc(st.label)}. Contas, logins, mensagens e fotos não se perdem em atualizações. (${s.patients} pacientes, ${s.professionals} profissionais, ${s.messages} mensagens guardadas)</div>`
      : `<div class="notice danger">Atenção: os dados estão numa pasta temporária do servidor e podem ser apagados em atualizações. No Render, confira se o disco está montado em /var/data e se a variável DATA_DIR=/var/data existe.</div>`;
    const pend = (await api('/api/admin/professionals?status=pendente')).items;
    $('[data-pending-list]').innerHTML = pend.length ? `<div class="table-wrap"><table><tbody>${pend.map(proRow).join('')}</tbody></table></div>`
      : '<p class="muted">Nenhum cadastro pendente. 🎉</p>';
  }

  // ---------- Profissionais ----------
  function proRow(p) {
    return `<tr>
      <td><div class="row" style="flex-wrap:nowrap">${avatar(p.name, p.photo, 'sm')}<div><b>${esc(p.name)}</b><div class="small muted">${esc(p.profession)} · ${esc(p.email)}</div></div></div></td>
      <td>${esc(p.registry)}</td>
      <td>${esc(p.city)} - ${esc(p.state)}</td>
      <td>${STATUS_BADGE[p.status] || esc(p.status)}</td>
      <td>${subBadge(p)}</td>
      <td><button class="btn secondary sm" data-pro="${p.id}">Gerenciar</button></td></tr>`;
  }

  async function loadList(kind) {
    const f = $(`[data-filter="${kind}"]`);
    const qs = new URLSearchParams([...new FormData(f).entries()].filter(([, v]) => v));
    const { items } = await api(`/api/admin/${kind}?${qs}`);
    const body = $(`[data-rows="${kind}"]`);
    if (kind === 'professionals') body.innerHTML = items.length ? items.map(proRow).join('') : '<tr><td colspan="6" class="center muted">Nenhum profissional encontrado.</td></tr>';
    else {
      body.innerHTML = items.length ? items.map((p) => `<tr>
        <td><div class="row" style="flex-wrap:nowrap">${avatar(p.name, p.photo, 'sm')}<div><b>${esc(p.name)}</b>${p.display_name ? `<div class="small muted">Exibe: ${esc(p.display_name)}</div>` : ''}</div></div></td>
        <td style="white-space:nowrap">${esc(p.cpf)} ${p.cpf_name_verified ? '<span class="badge ok" title="Nome conferido com a Receita">conferido</span>' : ''}</td>
        <td>${esc(p.city)} - ${esc(p.state)}</td>
        <td>${fmtDT(p.created_at)}</td>
        <td>${STATUS_BADGE[p.status]}</td>
        <td>${p.status === 'excluido' ? '' : `<div class="row">
          <button class="btn secondary sm" data-pat-status="${p.id}" data-to="${p.status === 'ativo' ? 'bloqueado' : 'ativo'}">${p.status === 'ativo' ? 'Bloquear' : 'Desbloquear'}</button>
          <button class="btn ghost sm" data-pat-reset="${p.id}" data-name="${esc(p.name)}">Gerar nova senha</button></div>`}</td></tr>`).join('')
        : '<tr><td colspan="6" class="center muted">Nenhum paciente encontrado.</td></tr>';
    }
    $(`[data-count="${kind}"]`).textContent = `${items.length} resultado${items.length === 1 ? '' : 's'}`;
  }

  $$('[data-filter]').forEach((f) => {
    f.addEventListener('submit', (e) => { e.preventDefault(); loadList(f.dataset.filter); });
    f.state.addEventListener('change', () => { f.city.value = ''; fillCities(f); loadList(f.dataset.filter); });
    f.city.addEventListener('change', () => loadList(f.dataset.filter));
    f.status.addEventListener('change', () => loadList(f.dataset.filter));
  });
  $$('[data-export]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    const f = $(`[data-filter="${a.dataset.export}"]`);
    const qs = new URLSearchParams([...new FormData(f).entries()].filter(([k, v]) => v && k !== 'status'));
    location.href = `/api/admin/export/${a.dataset.export}.csv?${qs}`;
  }));

  document.addEventListener('click', async (e) => {
    const pb = e.target.closest('[data-pro]');
    if (pb) return openPro(Number(pb.dataset.pro));
    const ps = e.target.closest('[data-pat-status]');
    if (ps) {
      const to = ps.dataset.to;
      if (!await confirmDialog(to === 'bloqueado' ? 'Bloquear este paciente? Ele não conseguirá mais entrar.' : 'Desbloquear este paciente?', { okLabel: to === 'bloqueado' ? 'Bloquear' : 'Desbloquear', danger: to === 'bloqueado' })) return;
      await api(`/api/admin/patients/${ps.dataset.patStatus}/status`, { method: 'POST', body: { status: to } });
      toast('Atualizado');
      loadList('patients');
    }
    const pr = e.target.closest('[data-pat-reset]');
    if (pr) {
      if (!await confirmDialog(`Gerar uma nova senha para ${pr.dataset.name}? A senha atual deixará de funcionar.`, { okLabel: 'Gerar' })) return;
      const r = await api(`/api/admin/patients/${pr.dataset.patReset}/reset-password`, { method: 'POST' });
      showSecret('Nova senha do paciente', r.password, 'Repasse esta senha ao paciente. Ele entra com o CPF e esta senha.');
    }
  });

  function showSecret(title, value, text) {
    return modal({
      title, html: `<p>${esc(text)}</p><div class="code-box">${esc(value)}</div>`,
      actions: [{ label: 'Copiar', class: 'secondary', handler: () => { copyText(value); return false; } }, { label: 'Fechar' }],
    });
  }

  async function openPro(id) {
    const p = await api(`/api/admin/professionals/${id}`);
    const pk = p.packages.map((k) => `${k.sessions} sessões: ${money(k.price_cents)}`).join(' · ');
    const btn = (status, label, cls = 'secondary') => `<button type="button" class="btn sm ${cls}" data-set="${status}">${label}</button>`;
    let statusBtns = '';
    if (p.status === 'pendente') statusBtns = btn('aprovado', 'Aprovar', '') + btn('recusado', 'Recusar', 'danger');
    else if (p.status === 'aprovado') statusBtns = btn('restrito', 'Restringir') + btn('bloqueado', 'Bloquear', 'danger');
    else if (p.status === 'excluido') statusBtns = '<span class="muted">Conta excluída pelo próprio profissional.</span>';
    else statusBtns = btn('aprovado', p.status === 'recusado' ? 'Aprovar' : 'Reativar', '') + (p.status !== 'bloqueado' ? btn('bloqueado', 'Bloquear', 'danger') : '');

    await modal({
      title: p.name,
      html: `
        <div class="row" style="margin-bottom:12px">${avatar(p.name, p.photo, 'lg')}<div>
          <div><b>${esc(p.profession)}</b> · ${esc(p.registry)}</div>
          <div class="small">${STATUS_BADGE[p.status]} ${p.visible ? '<span class="badge primary">Na vitrine</span>' : '<span class="badge">Fora da vitrine</span>'}</div>
        </div></div>
        <table style="font-size:.9rem"><tbody>
          <tr><th>Código único</th><td><code style="font-size:1.05rem;font-weight:800">${esc(p.code)}</code> <button type="button" class="btn ghost sm" data-copy-code>Copiar</button></td></tr>
          <tr><th>Nome na carteirinha</th><td>${esc(p.legal_name)}</td></tr>
          <tr><th>Registro</th><td><div class="row" style="gap:6px"><input data-registry value="${esc(p.registry)}" maxlength="40" style="width:auto;min-height:34px;padding:4px 8px">
            <button type="button" class="btn ghost sm" data-save-registry>Salvar</button></div>
            ${p.registry_verified ? '<span class="badge ok">Conferido no conselho</span>' : '<span class="badge warn">Conferir pela carteirinha</span>'}</td></tr>
          <tr><th>Carteirinha</th><td>${p.has_document
            ? (p.document_is_pdf ? `<a href="/api/admin/professionals/${p.id}/document" target="_blank" rel="noopener">Abrir PDF da carteirinha</a>`
              : `<a href="/api/admin/professionals/${p.id}/document" target="_blank" rel="noopener"><img src="/api/admin/professionals/${p.id}/document" alt="Carteirinha de ${esc(p.name)}" style="max-height:220px;border-radius:8px;border:1px solid var(--line)"></a>`)
            : '<span class="muted">Não enviada (cadastrado pela administração)</span>'}
            <div class="small muted">Confira se nome, número e estado batem com os dados acima antes de aprovar.</div></td></tr>
          <tr><th>E-mail</th><td>${esc(p.email)}</td></tr>
          <tr><th>WhatsApp</th><td><a href="https://wa.me/55${esc(p.phone)}" target="_blank" rel="noopener">${esc(fmtPhone(p.phone))}</a></td></tr>
          <tr><th>Local</th><td>${esc(p.city)} - ${esc(p.state)}${p.has_clinic ? `<div class="small">${esc(p.clinic_name)} — ${esc(p.clinic_address)}</div>` : '<div class="small muted">Somente online</div>'}</td></tr>
          <tr><th>Consulta</th><td>${p.price_cents != null ? money(p.price_cents) : '—'}${pk ? `<div class="small muted">${esc(pk)}</div>` : ''}</td></tr>
          <tr><th>Cadastro</th><td>${fmtDT(p.created_at)}</td></tr>
          <tr><th>Mensalidade</th><td>${subBadge(p)}</td></tr>
        </tbody></table>
        <h3 style="margin-top:16px">Situação</h3>
        <div class="row">${statusBtns}</div>
        <p class="small muted" style="margin-top:6px">Restrito: some da vitrine, mas ainda responde às conversas. Bloqueado: não consegue entrar.</p>
        <h3 style="margin-top:16px">Mensalidade</h3>
        <div class="row">
          <button type="button" class="btn sm" data-add="30">+30 dias</button>
          <button type="button" class="btn secondary sm" data-add="90">+90 dias</button>
          <button type="button" class="btn secondary sm" data-add="365">+1 ano</button>
          <input type="date" data-until value="${p.subscription_until || ''}" style="width:auto;min-height:34px;padding:4px 8px">
          <button type="button" class="btn ghost sm" data-set-until>Definir data</button>
        </div>
        <h3 style="margin-top:16px">Observações internas</h3>
        <textarea data-note rows="2" maxlength="1000">${esc(p.admin_note)}</textarea>
        <div class="row" style="margin-top:6px"><button type="button" class="btn secondary sm" data-save-note>Salvar observação</button>
          <button type="button" class="btn ghost sm" data-reset-pw>Gerar nova senha</button></div>`,
      actions: [{ label: 'Fechar' }],
      onOpen: (dlg) => {
        const refresh = async () => { dlg.close(); dlg.remove(); await reloadAll(); openPro(id); };
        $('[data-copy-code]', dlg).addEventListener('click', () => copyText(p.code));
        $('[data-save-registry]', dlg).addEventListener('click', async () => {
          try {
            await api(`/api/admin/professionals/${id}/registry`, { method: 'POST', body: { registry: $('[data-registry]', dlg).value } });
            toast('Registro atualizado');
          } catch (ex) { toast(ex.message, 'error'); }
        });
        $$('[data-set]', dlg).forEach((b) => b.addEventListener('click', async () => {
          const s = b.dataset.set;
          const msgs = { aprovado: 'Aprovar/reativar este profissional?', recusado: 'Recusar este cadastro?', restrito: 'Restringir? Ele sai da vitrine mas continua respondendo conversas.', bloqueado: 'Bloquear? Ele não conseguirá mais entrar.' };
          if (!await confirmDialog(msgs[s], { danger: s !== 'aprovado' })) return;
          await api(`/api/admin/professionals/${id}/status`, { method: 'POST', body: { status: s } });
          toast('Situação atualizada');
          refresh();
        }));
        $$('[data-add]', dlg).forEach((b) => b.addEventListener('click', async () => {
          await api(`/api/admin/professionals/${id}/subscription`, { method: 'POST', body: { add_days: Number(b.dataset.add) } });
          toast('Mensalidade atualizada');
          refresh();
        }));
        $('[data-set-until]', dlg).addEventListener('click', async () => {
          const v = $('[data-until]', dlg).value;
          await api(`/api/admin/professionals/${id}/subscription`, { method: 'POST', body: { until: v || null } });
          toast('Mensalidade atualizada');
          refresh();
        });
        $('[data-save-note]', dlg).addEventListener('click', async () => {
          await api(`/api/admin/professionals/${id}/note`, { method: 'POST', body: { note: $('[data-note]', dlg).value } });
          toast('Observação salva');
        });
        $('[data-reset-pw]', dlg).addEventListener('click', async () => {
          if (!await confirmDialog('Gerar nova senha para este profissional? A atual deixará de funcionar.')) return;
          const r = await api(`/api/admin/professionals/${id}/reset-password`, { method: 'POST' });
          showSecret('Nova senha do profissional', r.password, `Repasse ao profissional. Login: código ${p.code} ou e-mail ${p.email}.`);
        });
      },
    });
  }

  // ---------- Novo profissional ----------
  const nf = $('[data-new-pro]');
  nf.profession.innerHTML = cfg.professions.map((p) => `<option>${esc(p)}</option>`).join('');
  nf.state.innerHTML = ufOptions('', 'UF');
  bindUfCity(nf.state, nf.city);
  maskPhone(nf.phone);
  handleForm(nf, async (d, f) => {
    const r = await api('/api/admin/professionals', { method: 'POST', body: d });
    f.reset();
    await modal({
      title: 'Profissional cadastrado',
      html: `<p>Repasse os dados de acesso ao profissional:</p>
        <p class="small muted" style="margin:0">Código único (login e atendimentos)</p><div class="code-box">${esc(r.code)}</div>
        <p class="small muted" style="margin:12px 0 0">Senha</p><div class="code-box" style="font-size:1.4rem">${esc(r.password)}</div>`,
      actions: [{ label: 'Copiar tudo', class: 'secondary', handler: () => { copyText(`Código: ${r.code}\nSenha: ${r.password}`); return false; } }, { label: 'Fechar' }],
    });
    reloadAll();
  });

  // ---------- Conta ----------
  handleForm($('[data-pw-form]'), async (d, f) => {
    await api('/api/admin/password', { method: 'POST', body: d });
    f.reset();
    toast('Senha alterada!');
  });
  $('[data-logout]').addEventListener('click', () => logout('/admin'));

  // ---------- Rotas ----------
  async function reloadAll() {
    await loadLocations().catch(() => {});
    await loadStats().catch(() => {});
    const v = (location.hash.slice(1) || 'inicio').split('/')[0];
    if (v === 'profissionais') loadList('professionals');
    if (v === 'pacientes') loadList('patients');
  }

  async function route() {
    $$('dialog').forEach((d) => { d.close(); d.remove(); });
    const [view, arg] = (location.hash.slice(1) || 'inicio').split('/');
    const v = ['inicio', 'profissionais', 'pacientes', 'novo', 'conta'].includes(view) ? view : 'inicio';
    $$('[data-view]').forEach((s) => s.classList.toggle('hidden', s.dataset.view !== v));
    $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === v));
    try {
      if (v === 'inicio') await loadStats();
      if (v === 'profissionais') {
        const f = $('[data-filter="professionals"]');
        if (arg !== undefined) f.status.value = arg;
        await loadList('professionals');
      }
      if (v === 'pacientes') await loadList('patients');
    } catch (e) { toast(e.message, 'error'); }
  }
  window.addEventListener('hashchange', route);
  await loadLocations().catch(() => {});
  loadStats().catch(() => {});
  route();
})();
