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
      location.replace('/'); // entrou: volta para a página inicial, com o botão "Entrar no administrativo"
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

  // Apagar conta pelo admin: dois avisos (sem precisar digitar CPF ou código da pessoa)
  async function confirmDelete(name) {
    const ask = (title, html, ok) => modal({ title, html, actions: [{ label: 'Não', value: false, class: 'secondary' }, { label: ok, value: true, class: 'danger' }] });
    if (!await ask('Apagar esta conta?', `<p>Você quer apagar a conta de <b>${esc(name || '')}</b>?</p>`, 'Sim')) return false;
    return !!await ask('Tem certeza?', '<p><b>Se apagar, já era.</b> Some tudo: dados, fotos, publicações, curtidas, comentários e o conteúdo das mensagens. Não dá para recuperar. A pessoa poderá criar uma conta nova depois.</p>', 'Sim, apagar');
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
      ? `<div class="notice ok">✓ Dados salvos de forma permanente — ${esc(st.label)}. Contas, logins, mensagens e fotos não se perdem em atualizações. (${s.patients} paciente${s.patients === 1 ? '' : 's'}, ${s.professionals} profissiona${s.professionals === 1 ? 'l' : 'is'}, ${s.messages} mensage${s.messages === 1 ? 'm guardada' : 'ns guardadas'})</div>`
      : `<div class="notice danger"><b>Atenção: os dados ainda não estão num disco permanente</b> (${esc(st.label)}). Contas criadas agora podem sumir na próxima atualização.<br>
          <b>Como resolver (uma vez só):</b> no Render, abra o serviço → <b>Disks</b> → <b>Add Disk</b> → Mount Path: <code>/var/data</code> → tamanho 1 GB → <b>Save</b>. O site encontra o disco sozinho e este aviso fica verde.</div>`;
    // Espaço usado no disco
    const u = s.usage;
    if (u) {
      const gb = (b) => (b / 1024 ** 3).toLocaleString('pt-BR', { maximumFractionDigits: b < 1024 ** 3 ? 3 : 2 });
      const mb = (b) => (!b ? '0' : b < 1024 ** 2 ? `${Math.max(1, Math.round(b / 1024))} KB` : b < 1024 ** 3 ? `${(b / 1024 ** 2).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB` : `${gb(b)} GB`);
      const total = u.disk?.total || 0;
      const usedDisk = total ? total - u.disk.free : u.used;
      const pct = total ? Math.min(100, Math.round((usedDisk / total) * 100)) : 0;
      const P = u.parts;
      const chip = (label, x) => `<span class="badge">${label}: <b>${mb(x.bytes)}</b>${x.count ? ` <span class="muted">(${x.count.toLocaleString('pt-BR')})</span>` : ''}</span>`;
      // No topo (sempre visível): quanto do disco já foi usado
      const pill = $('[data-disk-pill]');
      pill.classList.remove('hidden', 'warn', 'full');
      if (pct >= 80) pill.classList.add('full'); else if (pct >= 60) pill.classList.add('warn');
      pill.innerHTML = `<span class="disk-ic" aria-hidden="true"></span><span><b>${total ? `${gb(usedDisk)} de ${gb(total)} GB` : mb(u.used)}</b>${total ? ` <small>(${pct}%)</small>` : ''}</span>
        ${total ? `<span class="disk-mini"><i style="width:${Math.max(2, pct)}%"></i></span>` : ''}`;
      $('[data-storage]').insertAdjacentHTML('beforeend', `<div class="card usage-card" style="margin-top:10px">
          <div class="row between"><b>Espaço usado no disco</b><span>${total ? `<b>${gb(usedDisk)} GB</b> de ${gb(total)} GB (${pct}%)` : `<b>${mb(u.used)}</b>`}</span></div>
          ${total ? `<div class="usage-track ${pct >= 80 ? 'warn' : ''}"><i style="width:${Math.max(1, pct)}%"></i></div>` : ''}
          <div class="row" style="gap:6px;flex-wrap:wrap;margin-top:8px">${chip('Fotos', P.fotos)}${chip('Vídeos', P.videos)}${chip('Áudios do chat', P.audios)}${chip('Documentos', P.documentos)}${chip('Banco de dados', P.banco)}${P.envios.bytes ? chip('Envios em andamento', P.envios) : ''}</div>
          ${pct >= 80 ? '<p class="small" style="margin:8px 0 0;color:var(--danger)"><b>Disco quase cheio.</b> No Render: serviço → Disks → aumente o tamanho (os dados continuam).</p>' : ''}
        </div>`);
    }
    const pend = (await api('/api/admin/professionals?status=pendente')).items;
    $('[data-pending-list]').innerHTML = pend.length ? `<div class="table-wrap"><table><tbody>${pend.map(proRow).join('')}</tbody></table></div>`
      : '<p class="muted">Nenhum cadastro pendente. 🎉</p>';
  }

  // ---------- Limite de publicações por profissional ----------
  const limForm = $('[data-limits-form]');
  async function loadLimits() {
    const l = await api('/api/admin/limits');
    limForm.photo.value = l.photo;
    limForm.reel.value = l.reel;
  }
  limForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const photo = Number(limForm.photo.value);
    const reel = Number(limForm.reel.value);
    try {
      const prev = await api(`/api/admin/limits?photo=${photo}&reel=${reel}`);
      const w = prev.would_remove || { photo: 0, reel: 0 };
      if (w.photo || w.reel) {
        const parts = [w.photo ? `${w.photo} ${w.photo === 1 ? 'publicação de fotos' : 'publicações de fotos'}` : '', w.reel ? `${w.reel} ${w.reel === 1 ? 'vídeo' : 'vídeos'}` : ''].filter(Boolean).join(' e ');
        if (!await confirmDialog(`Com esse limite, vai ser apagado agora: ${parts}. São as publicações mais antigas de quem passou do limite (com os arquivos). Não dá para desfazer. Continuar?`, { okLabel: 'Salvar e apagar', danger: true, title: 'Diminuir o limite' })) return;
      }
      const r = await api('/api/admin/limits', { method: 'POST', body: { photo, reel } });
      toast(r.removed ? `Limite salvo — ${r.removed} ${r.removed === 1 ? 'publicação antiga apagada' : 'publicações antigas apagadas'}` : 'Limite salvo');
      loadStats().catch(() => {});
    } catch (ex) { toast(ex.message, 'error'); }
  });
  loadLimits().catch(() => {});

  // ---------- Profissionais ----------
  function proRow(p) {
    return `<tr>
      <td><div class="row" style="flex-wrap:nowrap">${avatar(p.name, p.photo, 'sm')}<div><b>${esc(p.name)}</b>${p.is_test ? ' <span class="badge warn">Teste</span>' : ''}<div class="small muted">${esc(p.profession)} · ${esc(p.email)}</div></div></div></td>
      <td>${esc(p.registry)}</td>
      <td>${esc(p.city)} - ${esc(p.state)}</td>
      <td>${p.status === 'excluido' ? '<span class="badge">Apagada</span>' : (STATUS_BADGE[p.status] || esc(p.status))}</td>
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
        <td><div class="row" style="flex-wrap:nowrap">${avatar(p.name, p.photo, 'sm')}<div><b>${esc(p.name)}</b>${p.is_test ? ' <span class="badge warn">Teste</span>' : ''}${p.display_name ? `<div class="small muted">Exibe: ${esc(p.display_name)}</div>` : ''}</div></div></td>
        <td style="white-space:nowrap">${esc(p.cpf)} ${p.cpf_name_verified ? '<span class="badge ok" title="Nome conferido com a Receita">conferido</span>' : ''}</td>
        <td>${esc(p.city)} - ${esc(p.state)}</td>
        <td>${fmtDT(p.created_at)}</td>
        <td>${p.status === 'excluido' ? '<span class="badge">Apagada</span>' : STATUS_BADGE[p.status]}</td>
        <td>${p.status === 'excluido' ? '' : `<div class="row">
          <button class="btn secondary sm" data-pat-status="${p.id}" data-to="${p.status === 'ativo' ? 'bloqueado' : 'ativo'}">${p.status === 'ativo' ? 'Bloquear' : 'Desbloquear'}</button>
          <button class="btn ghost sm" data-pat-reset="${p.id}" data-name="${esc(p.name)}">Gerar nova senha</button>
          <button class="btn danger sm" data-pat-del="${p.id}" data-name="${esc(p.name)}">Apagar conta</button></div>`}</td></tr>`).join('')
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
      if (!await confirmDialog(to === 'bloqueado' ? 'Bloquear este paciente? Ele entra, mas só vê a tela "Perfil bloqueado" (com o botão para falar com vocês no WhatsApp). Os dados ficam guardados.' : 'Desbloquear este paciente?', { okLabel: to === 'bloqueado' ? 'Bloquear' : 'Desbloquear', danger: to === 'bloqueado' })) return;
      await api(`/api/admin/patients/${ps.dataset.patStatus}/status`, { method: 'POST', body: { status: to } });
      toast('Atualizado');
      loadList('patients');
    }
    const pd = e.target.closest('[data-pat-del]');
    if (pd) {
      if (!await confirmDelete(pd.dataset.name)) return;
      try {
        await api(`/api/admin/patients/${pd.dataset.patDel}/delete`, { method: 'POST' });
        toast('Conta apagada');
      } catch (ex) { toast(ex.message, 'error'); }
      reloadAll();
    }
    const tb = e.target.closest('[data-test-accounts]');
    if (tb) {
      const r = await api('/api/admin/test-accounts', { method: 'POST' });
      const made = r.created.professional || r.created.patient;
      const txt = `Profissional — login: ${r.professional.login} · senha: ${r.professional.password}\nPaciente — CPF: ${r.patient.cpf} · senha: ${r.patient.password}`;
      modal({
        title: made ? 'Contas de teste criadas' : 'As contas de teste já existem',
        html: `<p class="small muted" style="margin:0">Profissional (entra com o código)</p>
          <div class="code-box" style="font-size:1.1rem">${esc(r.professional.login)} / ${esc(r.professional.password)}</div>
          <p class="small muted" style="margin:12px 0 0">Paciente (entra com o CPF)</p>
          <div class="code-box" style="font-size:1.1rem">${esc(r.patient.cpf)} / ${esc(r.patient.password)}</div>`,
        actions: [{ label: 'Copiar tudo', class: 'secondary', handler: () => { copyText(txt); return false; } }, { label: 'Fechar' }],
      });
      reloadAll();
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

    // Psicanalista, psicoterapeuta e terapeuta não têm conselho: sem registro nem carteirinha para conferir
    const council = ['Psicólogo(a)', 'Neuropsicólogo(a)', 'Psiquiatra'].includes(p.profession);
    await modal({
      title: p.name,
      html: `
        <div class="row" style="margin-bottom:12px">${avatar(p.name, p.photo, 'lg')}<div>
          <div><b>${esc(p.profession)}</b>${p.registry ? ` · ${esc(p.registry)}` : ''}</div>
          <div class="small">${STATUS_BADGE[p.status]}${p.is_test ? ' <span class="badge warn">Teste</span>' : ''} ${p.visible ? '<span class="badge primary">Na vitrine</span>' : '<span class="badge">Fora da vitrine</span>'}</div>
        </div></div>
        <table style="font-size:.9rem"><tbody>
          <tr><th>Código único</th><td><code style="font-size:1.05rem;font-weight:800">${esc(p.code)}</code> <button type="button" class="btn ghost sm" data-copy-code>Copiar</button></td></tr>
          <tr><th>Link</th><td>${p.slug ? `<a href="/${esc(p.slug)}" target="_blank" rel="noopener">${esc(location.host)}/${esc(p.slug)}</a>` : '—'}</td></tr>
          <tr><th>Nome na carteirinha</th><td>${esc(p.legal_name)}</td></tr>
          ${p.plan ? `<tr><th>Plano escolhido</th><td>${esc(p.plan)}</td></tr>` : ''}
          ${council || p.registry ? `<tr><th>Registro</th><td><div class="row" style="gap:6px"><input data-registry value="${esc(p.registry)}" maxlength="40" style="width:auto;min-height:34px;padding:4px 8px">
            <button type="button" class="btn ghost sm" data-save-registry>Salvar</button></div>
            ${p.registry_verified ? '<span class="badge ok">Conferido no conselho</span>' : '<span class="badge warn">Conferir pela carteirinha</span>'}</td></tr>` : ''}
          <tr><th>Carteirinha</th><td>${p.has_document
            ? (p.document_is_pdf ? `<a href="/api/admin/professionals/${p.id}/document" target="_blank" rel="noopener">Abrir PDF da carteirinha</a>`
              : `<a href="/api/admin/professionals/${p.id}/document" target="_blank" rel="noopener"><img src="/api/admin/professionals/${p.id}/document" alt="Carteirinha de ${esc(p.name)}" style="max-height:220px;border-radius:8px;border:1px solid var(--line)"></a>`)
            : `<span class="muted">${council ? 'Não enviada (cadastrado pela administração)' : 'Não precisa (profissão sem conselho: sem CRP/CRM)'}</span>`}
            ${council ? '<div class="small muted">Confira se nome, número e estado batem com os dados acima antes de aprovar.</div>' : ''}</td></tr>
          <tr><th>E-mail</th><td>${esc(p.email)}</td></tr>
          <tr><th>WhatsApp</th><td><a href="https://wa.me/55${esc(p.phone)}" target="_blank" rel="noopener">${esc(fmtPhone(p.phone))}</a></td></tr>
          <tr><th>Local</th><td>${esc(p.city)} - ${esc(p.state)}<div class="small muted">Atende online${p.has_clinic ? ' e presencial' : ''}</div>${p.has_clinic ? `<div class="small">${esc(p.clinic_name)} — ${esc(p.clinic_address)}</div>` : ''}</td></tr>
          <tr><th>Especialidades</th><td>${esc((p.specialties || '').split(',').map((x) => x.trim()).filter(Boolean).join(' · ') || '—')}</td></tr>
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
          <button type="button" class="btn ghost sm" data-reset-pw>Gerar nova senha</button></div>
        ${p.status !== 'excluido' ? `<h3 style="margin-top:16px">Apagar conta</h3>
          <p class="small muted" style="margin:0 0 8px">Apaga tudo: dados, fotos, publicações, reels, stories, curtidas, comentários e o conteúdo das mensagens que ele mandou. Não dá para desfazer. Ele pode criar uma conta nova depois.</p>
          <button type="button" class="btn danger sm" data-del-test>Apagar conta</button>` : ''}`,
      actions: [{ label: 'Fechar' }],
      onOpen: (dlg) => {
        const refresh = async () => { dlg.close(); dlg.remove(); await reloadAll(); openPro(id); };
        $('[data-copy-code]', dlg).addEventListener('click', () => copyText(p.code));
        $('[data-save-registry]', dlg)?.addEventListener('click', async () => {
          try {
            await api(`/api/admin/professionals/${id}/registry`, { method: 'POST', body: { registry: $('[data-registry]', dlg).value } });
            toast('Registro atualizado');
          } catch (ex) { toast(ex.message, 'error'); }
        });
        $$('[data-set]', dlg).forEach((b) => b.addEventListener('click', async () => {
          const s = b.dataset.set;
          const msgs = { aprovado: 'Aprovar/reativar este profissional?', recusado: 'Recusar este cadastro?', restrito: 'Restringir? Ele sai da vitrine mas continua respondendo conversas.', bloqueado: 'Bloquear? Ele entra, mas só vê a tela "Perfil bloqueado" (com o botão para falar com vocês). Sai da vitrine e os dados ficam guardados.' };
          if (!await confirmDialog(msgs[s], { danger: s !== 'aprovado' })) return;
          const r = await api(`/api/admin/professionals/${id}/status`, { method: 'POST', body: { status: s } });
          toast('Situação atualizada');
          // Primeira aprovação de quem se cadastrou pelo site: a senha aparece uma vez para mandar no WhatsApp
          if (r.new_password) {
            dlg.close(); dlg.remove();
            await showSecret('Senha do profissional', r.new_password, `Cadastro aprovado! Mande esta senha para o profissional pelo WhatsApp (${fmtPhone(p.phone)}). Login: código ${p.code} ou e-mail ${p.email}. Ela não fica guardada: se ele esquecer, gere uma nova.`);
          }
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
        const del = $('[data-del-test]', dlg);
        if (del) del.addEventListener('click', async () => {
          if (!await confirmDelete(p.name)) return;
          await api(`/api/admin/professionals/${id}/delete`, { method: 'POST' });
          toast('Conta apagada');
          dlg.close(); dlg.remove(); reloadAll();
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
  // Registro só para quem tem conselho (igual ao cadastro pelo site): CRP para psicólogo e
  // neuropsicólogo, CRM para psiquiatra. Psicanalista, psicoterapeuta e terapeuta não têm.
  const REG = {
    'Psicólogo(a)': ['CRP', 'Ex.: CRP 06/12345'], 'Neuropsicólogo(a)': ['CRP', 'Ex.: CRP 06/12345'], Psiquiatra: ['CRM', 'Ex.: CRM-SP 123456'],
  };
  const syncReg = () => {
    const r = REG[nf.profession.value];
    $('[data-n-reg-field]', nf).classList.toggle('hidden', !r);
    $('[data-n-no-reg]', nf).classList.toggle('hidden', !!r);
    nf.registry.required = !!r;
    if (!r) nf.registry.value = '';
    else {
      $('[data-n-reg-label]', nf).textContent = r[0];
      nf.registry.placeholder = r[1];
      $('[data-n-reg-hint]', nf).textContent = `${r[0]} válido e do mesmo estado do profissional.`;
    }
  };
  nf.profession.addEventListener('change', syncReg);
  syncReg();
  const nSp = AcoliaSpecialties.picker($('[data-n-sp]', nf), { name: 'specialties' });
  handleForm(nf, async (d, f) => {
    d.specialties = (await nSp).value();
    if (!d.specialties.length) throw new Error('Escolha pelo menos uma especialidade.');
    const r = await api('/api/admin/professionals', { method: 'POST', body: d });
    f.reset();
    (await nSp).set([]);
    syncReg();
    await modal({
      title: 'Profissional cadastrado',
      html: `<p>Repasse os dados de acesso ao profissional:</p>
        <p class="small muted" style="margin:0">Código único (login e atendimentos)</p><div class="code-box">${esc(r.code)}</div>
        <p class="small muted" style="margin:12px 0 0">Senha</p><div class="code-box" style="font-size:1.4rem">${esc(r.password)}</div>`,
      actions: [{ label: 'Copiar tudo', class: 'secondary', handler: () => { copyText(`Código: ${r.code}\nSenha: ${r.password}`); return false; } }, { label: 'Fechar' }],
    });
    reloadAll();
  });

  // ---------- Perfil oficial Acolia Brasil ----------
  // A administração publica fotos (1 a 10 por publicação), vê as curtidas e comentários,
  // apaga comentários e publicações. Não vê o feed nem segue ninguém.
  let offPosts = [];
  let offOffset = 0;
  const offGrid = $('[data-official-posts]');
  function offTile(p) {
    if (p.kind === 'text') {
      return `<button type="button" class="gallery-item text-tile font-${esc(p.font || 'padrao')}" data-off-post="${p.id}" aria-label="Abrir texto"><span>${esc(p.caption.slice(0, 160))}</span>
      <span class="off-stats">♥ ${p.likes} · 💬 ${p.comments}</span></button>`;
    }
    return `<button type="button" class="gallery-item ${p.kind === 'reel' ? 'is-reel' : ''}" data-off-post="${p.id}" aria-label="Abrir publicação"><img src="${esc(p.image)}" alt="" loading="lazy">${p.kind === 'reel' ? `<span class="multi-ic" aria-hidden="true">${ICONS.play}</span>` : ''}
      <span class="off-stats">♥ ${p.likes} · 💬 ${p.comments}</span></button>`;
  }
  async function loadOfficial(reset = true) {
    if (reset) { offPosts = []; offOffset = 0; offGrid.innerHTML = ''; }
    const d = await api(`/api/admin/official?offset=${offOffset}`);
    const pr = d.profile;
    const n = (x) => Number(x || 0).toLocaleString('pt-BR');
    $('[data-official-head]').innerHTML = `<div class="row" style="gap:16px;flex-wrap:wrap">
        <span class="official-avatar" style="width:84px;height:84px"><img src="${esc(pr.photo)}" alt=""></span>
        <div class="grow"><h2 style="margin:0 0 6px">${esc(pr.name)} ${AcoliaSocial.officialBadge}</h2>
          <div class="pro-counts official-counts"><span><b>${n(pr.posts_count)}</b> ${pr.posts_count === 1 ? 'publicação' : 'publicações'}</span>
            <span><b>${n(pr.followers_patients)}</b> ${pr.followers_patients === 1 ? 'seguidor paciente' : 'seguidores pacientes'}</span>
            <span><b>${n(pr.followers_professionals)}</b> ${pr.followers_professionals === 1 ? 'seguidor profissional' : 'seguidores profissionais'}</span></div>
          <small class="muted">Contam só contas ativas: paciente bloqueado ou que excluiu a conta e profissional com a licença vencida saem da contagem.</small></div></div>`;
    const ig = $('[data-official-ig]').instagram;
    if (document.activeElement !== ig) ig.value = pr.instagram ? '@' + pr.instagram : '';
    offPosts.push(...d.items);
    offOffset += d.items.length;
    offGrid.insertAdjacentHTML('beforeend', d.items.map(offTile).join(''));
    if (!offPosts.length) offGrid.innerHTML = '<p class="muted" style="grid-column:1/-1">Nenhuma publicação ainda. Toque em "Nova publicação" para começar.</p>';
    $('[data-official-more]').classList.toggle('hidden', !d.has_more);
  }
  $('[data-official-more]').addEventListener('click', () => loadOfficial(false).catch((e) => toast(e.message, 'error')));
  $('[data-official-text]').addEventListener('click', () => AcoliaSocial.openNewText(() => loadOfficial(), { base: '/api/admin/official/texts', title: 'Novo texto da Acolia Brasil' }));
  $('[data-official-new]').addEventListener('click', () => AcoliaSocial.openNewPost(() => loadOfficial(), { base: '/api/admin/official/posts', title: 'Nova publicação da Acolia Brasil' }));
  // Vídeo (reel) da Acolia Brasil: até 2 minutos, qualquer tamanho. O aparelho lê a duração e tira
  // a capa (se não conseguir, usa uma capa padrão) e o envio vai em pedaços, com a barrinha de progresso.
  $('[data-official-reel]').addEventListener('click', () => {
    let file = null;
    let metaP = null;
    modal({
      title: 'Novo vídeo da Acolia Brasil',
      html: `<div class="form-error hidden" data-err></div>
        <label class="btn secondary block" style="margin-bottom:10px">Escolher vídeo<input type="file" accept="video/*" data-file hidden></label>
        <div class="small muted" data-info>Até 2 minutos · ideal em pé (1080 × 1920)</div>
        <video data-prev playsinline muted controls class="hidden" style="width:100%;max-height:360px;border-radius:12px;margin-top:10px;background:#000"></video>
        <div class="up-bar hidden" data-bar style="height:8px;border-radius:4px;background:var(--surface-2);margin-top:12px;overflow:hidden"><i style="display:block;height:100%;width:0;background:var(--primary)"></i></div>
        <div class="field" style="margin-top:12px"><label>Descrição</label><textarea data-cap rows="3"></textarea></div>`,
      actions: [{ label: 'Cancelar', value: null, class: 'secondary' }, {
        label: 'Publicar',
        handler: async (dlg) => {
          const err = $('[data-err]', dlg);
          const info = $('[data-info]', dlg);
          const fail = (m) => { err.textContent = m; err.classList.remove('hidden'); btns.forEach((b) => { b.disabled = false; }); return false; };
          const btns = $$('.dlg-actions .btn', dlg);
          err.classList.add('hidden');
          if (!file) return fail('Escolha um vídeo.');
          btns.forEach((b) => { b.disabled = true; });
          info.textContent = 'Preparando o vídeo…';
          const meta = await metaP; // espera a leitura do vídeo terminar (não dá mais "escolha um vídeo")
          if (meta.duration && meta.duration > 121) return fail(`O vídeo pode ter no máximo 2 minutos. Este tem ${Math.floor(meta.duration / 60)}:${String(Math.round(meta.duration % 60)).padStart(2, '0')}.`);
          const bar = $('[data-bar]', dlg); bar.classList.remove('hidden');
          try {
            const s0 = await api('/api/admin/official/uploads', { method: 'POST', body: { mime: file.type || 'video/mp4', size: file.size } });
            let got = 0;
            const CH = 4 * 1024 * 1024;
            while (got < file.size) {
              const chunk = file.slice(got, Math.min(file.size, got + CH));
              let r;
              for (let tries = 0; ; tries++) {
                try {
                  const res = await fetch(`/api/admin/official/uploads/${s0.id}?offset=${got}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: chunk, credentials: 'same-origin' });
                  r = await res.json();
                  if (res.status === 409 || res.ok) break;
                  throw new Error(r.error || 'Falha no envio.');
                } catch (e) { if (tries >= 4) throw e; await new Promise((ok) => setTimeout(ok, 1500 * (tries + 1))); }
              }
              got = r.received;
              bar.firstChild.style.width = `${Math.round((got / file.size) * 100)}%`;
              info.textContent = `Enviando… ${Math.round((got / file.size) * 100)}% — não feche esta janela.`;
            }
            const fd = new FormData();
            fd.append('photo', meta.poster, 'capa.jpg');
            fd.append('caption', $('[data-cap]', dlg).value);
            if (meta.duration) fd.append('duration', String(Math.round(meta.duration * 10) / 10));
            await api(`/api/admin/official/uploads/${s0.id}/finish`, { method: 'POST', form: fd });
          } catch (e) { return fail(e.message || 'Não foi possível enviar o vídeo. Tente de novo.'); }
          toast('Vídeo publicado!'); loadOfficial();
          return true;
        },
      }],
      onOpen: (dlg) => {
        AcoliaSocial.charCount($('[data-cap]', dlg), AcoliaSocial.CAPTION_MAX);
        const v = $('[data-prev]', dlg);
        $('[data-file]', dlg).addEventListener('change', (e) => {
          const f = e.target.files[0];
          if (!f) return;
          file = f;
          $('[data-err]', dlg).classList.add('hidden');
          $('[data-info]', dlg).textContent = `${(f.size / 1048576).toFixed(1)} MB · preparando…`;
          v.src = URL.createObjectURL(f); v.classList.remove('hidden');
          v.onerror = () => v.classList.add('hidden'); // navegador sem prévia desse formato: publica assim mesmo
          metaP = AcoliaSocial.readVideo(f).then((m) => {
            if (file === f) $('[data-info]', dlg).textContent = `${m.duration ? `${Math.round(m.duration)} s · ` : ''}${(f.size / 1048576).toFixed(1)} MB · pronto para publicar`;
            return m;
          });
        });
      },
    });
  });
  handleForm($('[data-official-ig]'), async (d) => {
    await api('/api/admin/official/instagram', { method: 'POST', body: d });
    toast('Instagram salvo!');
    await loadOfficial();
  });
  offGrid.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-off-post]');
    if (!b) return;
    const p = offPosts.find((x) => x.id === Number(b.dataset.offPost));
    let comments = [];
    try { comments = (await api(`/api/admin/official/posts/${p.id}/comments`)).items; } catch (ex) { toast(ex.message, 'error'); return; }
    const cHtml = (c) => `<li class="comment" data-c="${c.id}">${avatar(c.author.name, c.author.photo, 'sm')}
        <div class="grow"><div class="c-head"><b>${esc(c.author.name)}</b> ${c.author.subtitle ? `<small class="muted">${esc(c.author.subtitle)}</small>` : ''}</div>
          <div class="c-body">${esc(c.body)}</div><small class="muted">${esc(Acolia.timeAgo(c.created_at))}</small></div>
        <button type="button" class="icon-btn" data-del-c="${c.id}" aria-label="Apagar comentário" title="Apagar">${ICONS.trash}</button></li>`;
    const v = await modal({
      title: 'Publicação',
      html: `${p.kind === 'text' ? '' : `<div class="off-imgs">${p.images.map((src) => `<img src="${esc(src)}" alt="">`).join('')}</div>`}
        ${p.caption ? `<p class="${p.kind === 'text' ? `text-post font-${esc(p.font || 'padrao')}` : ''}" style="white-space:pre-wrap">${esc(p.caption)}</p>` : ''}
        <p class="muted small">${p.likes} ${p.likes === 1 ? 'curtida' : 'curtidas'} · ${comments.length} ${comments.length === 1 ? 'comentário' : 'comentários'}</p>
        <h3 style="margin-top:12px">Comentários</h3>
        <ul class="comments" data-clist>${comments.length ? comments.map(cHtml).join('') : '<li class="muted small">Nenhum comentário.</li>'}</ul>`,
      actions: [{ label: 'Apagar publicação', value: 'del', class: 'danger' }, { label: 'Fechar' }],
      onOpen: (dlg) => {
        $('[data-clist]', dlg).addEventListener('click', async (ev) => {
          const del = ev.target.closest('[data-del-c]');
          if (!del || !await confirmDialog('Apagar este comentário?', { okLabel: 'Apagar', danger: true, title: 'Apagar comentário' })) return;
          try {
            await api(`/api/admin/official/comments/${del.dataset.delC}`, { method: 'DELETE' });
            del.closest('li').remove();
            p.comments = Math.max(0, p.comments - 1);
            toast('Comentário apagado');
          } catch (ex) { toast(ex.message, 'error'); }
        });
      },
    });
    if (v === 'del' && await confirmDialog('Apagar esta publicação? Ela some do perfil da Acolia Brasil e do feed de todos.', { okLabel: 'Apagar', danger: true, title: 'Apagar publicação' })) {
      try { await api(`/api/admin/official/posts/${p.id}`, { method: 'DELETE' }); toast('Publicação apagada'); } catch (ex) { toast(ex.message, 'error'); }
    }
    loadOfficial().catch(() => {});
  });

  // ---------- Conta ----------
  handleForm($('[data-pw-form]'), async (d, f) => {
    await api('/api/admin/password', { method: 'POST', body: d });
    f.reset();
    toast('Senha alterada!');
  });
  $('[data-logout]').addEventListener('click', () => logout('/'));

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
    const v = ['inicio', 'profissionais', 'pacientes', 'novo', 'acolia', 'conta'].includes(view) ? view : 'inicio';
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
      if (v === 'acolia') await loadOfficial();
    } catch (e) { toast(e.message, 'error'); }
  }
  window.addEventListener('hashchange', route);
  await loadLocations().catch(() => {});
  loadStats().catch(() => {});
  route();
})();
