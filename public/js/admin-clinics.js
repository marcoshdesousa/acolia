/* Admin: clínicas (versão 1.3) — aprovar (com a primeira senha), bloquear, mensalidade, editar e apagar */
(function () {
  'use strict';
  const { $, $$, api, esc, toast, modal, confirmDialog, copyText, fmtPhone, ufOptions, bindUfCity, maskPhone } = window.Acolia;
  const BADGE = { pendente: ['Aguardando', 'warn'], aprovado: ['Aprovada', 'ok'], recusado: ['Recusada', 'danger'], bloqueado: ['Bloqueada', 'danger'], excluido: ['Apagada', ''] };
  const badge = (st) => `<span class="badge ${BADGE[st]?.[1] || ''}">${BADGE[st]?.[0] || esc(st)}</span>`;
  const PAY = { pago: '<span class="badge ok">Pago</span>', pendente: '<span class="badge">Esperando</span>', reembolsado: '<span class="badge warn">Reembolsado</span>', cancelado: '<span class="badge">Cancelado</span>' };
  const br = (d) => (d ? d.split('-').reverse().join('/') : '—');
  let status = '';
  let timer = null;
  const ITEMS = new Map();

  async function load() {
    const qs = new URLSearchParams();
    if (status) qs.set('status', status);
    const q = $('[data-cq]').value.trim();
    if (q) qs.set('q', q);
    const { items } = await api('/api/admin/clinics?' + qs);
    items.forEach((c) => ITEMS.set(c.id, c));
    $('[data-crows]').innerHTML = items.length ? items.map((c) => `<tr>
        <td><div class="row" style="flex-wrap:nowrap">${window.AcoliaClinicsLogo(c)}<div><b>${esc(c.name)}</b><div class="small muted">${esc(c.email)} · <code>${esc(c.code)}</code></div></div></div></td>
        <td style="white-space:nowrap">${esc(c.doc || '—')}</td><td>${esc(c.city)} - ${esc(c.state)}</td><td>${badge(c.status)}${c.review_pending ? ' <span class="badge warn" title="Pagou o Pix e entrou direto: confira os dados">Conferir dados</span>' : ''}</td>
        <td>${c.status === 'aprovado' ? (c.visible ? `<span class="badge ok">Até ${br(c.subscription_until)}</span>` : `<span class="badge danger">Vencida ${br(c.subscription_until)}</span>`) : '—'}</td>
        <td><button class="btn secondary sm" data-copen="${c.id}">Gerenciar</button></td></tr>`).join('')
      : '<tr><td colspan="6" class="center muted">Nenhuma clínica encontrada.</td></tr>';
    $('[data-ccount]').textContent = `${items.length} resultado${items.length === 1 ? '' : 's'}`;
  }
  window.AcoliaClinicsLogo = (c) => (c.logo ? `<span class="avatar sm clinic-logo"><img src="${esc(c.logo)}" alt=""></span>` : window.Acolia.avatar(c.name, null, 'sm'));

  async function open(id) {
    const c = await api(`/api/admin/clinics/${id}`);
    const b = (st, label, cls = 'secondary') => `<button type="button" class="btn sm ${cls}" data-cset="${st}">${label}</button>`;
    let btns = '';
    if (c.status === 'pendente') btns = b('aprovado', 'Aprovar', '') + b('recusado', 'Recusar', 'danger');
    else if (c.status === 'aprovado') btns = b('bloqueado', 'Bloquear', 'danger');
    else if (c.status !== 'excluido') btns = b('aprovado', c.status === 'recusado' ? 'Aprovar' : 'Desbloquear', '');
    await modal({
      title: c.name,
      html: `<div class="row" style="margin-bottom:12px">${c.logo ? `<span class="avatar lg clinic-logo"><img src="${esc(c.logo)}" alt=""></span>` : ''}<div>${badge(c.status)} ${c.visible ? '<span class="badge primary">Aparece para os pacientes</span>' : ''}</div></div>
        ${c.review_pending ? `<div class="notice warn" style="margin-bottom:12px"><b>Pago, aguardando conferência.</b> Pagou o Pix no cadastro e a clínica foi liberada na hora. Confira os dados abaixo.
          <div class="row" style="margin-top:8px"><button type="button" class="btn sm" data-creview-ok>Conferido, está tudo certo</button>
          <button type="button" class="btn danger sm" data-creview-no>Dados errados: tirar o acesso</button></div></div>` : ''}
        <table class="kv-table" style="font-size:.9rem"><tbody>
          <tr><th>Código</th><td><code style="font-weight:800">${esc(c.code)}</code> <button type="button" class="btn ghost sm" data-ccopy>Copiar</button></td></tr>
          <tr><th>Link</th><td>${c.slug ? `<a href="/${esc(c.slug)}" target="_blank" rel="noopener">${esc(location.host)}/${esc(c.slug)}</a>` : '—'}</td></tr>
          <tr><th>Responsável</th><td>${esc(c.responsible)}</td></tr>
          <tr><th>${c.doc_type === 'cnpj' ? 'CNPJ' : 'CPF'}</th><td>${esc(c.doc || '—')}</td></tr>
          <tr><th>E-mail</th><td>${esc(c.email)}</td></tr>
          <tr><th>WhatsApp</th><td><a href="https://wa.me/${c.phone.length <= 11 ? '55' + c.phone : c.phone}" target="_blank" rel="noopener">${esc(fmtPhone(c.phone))}</a></td></tr>
          <tr><th>Endereço</th><td>${esc(c.address)}<div class="small muted">${esc(c.city)} - ${esc(c.state)}</div>${c.maps_url ? `<a class="small" href="${esc(c.maps_url)}" target="_blank" rel="noopener">Abrir no Google Maps</a>` : ''}</td></tr>
          <tr><th>Médicos</th><td>${c.has_doctors ? esc(c.doctors.join(' · ')) : 'Não'}</td></tr>
          ${c.responsible_cpf ? `<tr><th>CPF do proprietário</th><td>${esc(c.responsible_cpf)}</td></tr>` : ''}
          <tr><th>Plano</th><td>${esc(c.plan_label)}</td></tr>
          ${c.payments?.length ? `<tr><th>Pagamentos (Pix)</th><td>${c.payments.map((x) => `<div class="small">${esc(String(x.paid_at || x.created_at).slice(0, 10).split('-').reverse().join('/'))} · ${x.kind === 'cadastro' ? 'Cadastro' : 'Renovação'} · ${window.Acolia.money(x.amount_cents)} · ${PAY[x.status] || esc(x.status)}
            <div class="muted" style="word-break:break-all">SyncPay: ${esc(x.identifier || '—')}</div></div>`).join('')}</td></tr>` : ''}
          <tr><th>Cadastro</th><td>${esc(String(c.created_at).slice(0, 10).split('-').reverse().join('/'))}</td></tr>
        </tbody></table>
        ${c.status !== 'excluido' ? '<button type="button" class="btn sm" data-cedit style="margin-top:10px">Editar dados</button>' : ''}
        <h3 style="margin-top:16px">Situação</h3><div class="row">${btns}</div>
        ${c.status === 'aprovado' || c.status === 'bloqueado' ? `<h3 style="margin-top:16px">Mensalidade</h3>
          <div class="row"><button type="button" class="btn sm" data-cadd="30">+30 dias</button><button type="button" class="btn secondary sm" data-cadd="90">+90 dias</button>
          <input type="date" data-cuntil value="${c.subscription_until || ''}" style="width:auto;min-height:34px;padding:4px 8px"><button type="button" class="btn ghost sm" data-csetuntil>Definir data</button></div>
          <div class="row" style="margin-top:10px"><button type="button" class="btn ghost sm" data-creset>Gerar nova senha</button></div>` : ''}
        ${c.status !== 'excluido' ? '<h3 style="margin-top:16px">Apagar conta</h3><button type="button" class="btn danger sm" data-cdel>Apagar a clínica</button>' : ''}`,
      actions: [{ label: 'Fechar' }],
      onOpen: (dlg) => {
        const again = async () => { dlg.close(); dlg.remove(); await load(); open(id); };
        $('[data-ccopy]', dlg).addEventListener('click', () => copyText(c.code));
        $('[data-creview-ok]', dlg)?.addEventListener('click', async () => {
          try { await api(`/api/admin/clinics/${id}/review`, { method: 'POST', body: { ok: true } }); toast('Conferido.'); again(); } catch (ex) { toast(ex.message, 'error'); }
        });
        $('[data-creview-no]', dlg)?.addEventListener('click', async () => {
          const paid = (c.payments || []).find((x) => x.kind === 'cadastro' && x.status === 'pago');
          if (!await confirmDialog(`Tirar o acesso da clínica ${c.name}? Ela sai da plataforma e não consegue mais entrar. Depois, faça o reembolso do Pix pelo painel da SyncPay${paid ? ` (identificador ${paid.identifier})` : ''}.`, { okLabel: 'Tirar o acesso', danger: true })) return;
          try { await api(`/api/admin/clinics/${id}/review`, { method: 'POST', body: { ok: false } }); toast('Acesso retirado. Lembre de reembolsar pela SyncPay.'); again(); } catch (ex) { toast(ex.message, 'error'); }
        });
        $$('[data-cset]', dlg).forEach((x) => x.addEventListener('click', async () => {
          const st = x.dataset.cset;
          if (!await confirmDialog({ aprovado: 'Aprovar esta clínica?', recusado: 'Recusar o cadastro desta clínica?', bloqueado: 'Bloquear esta clínica? Ela entra, mas só vê a tela de bloqueio, e some para os pacientes.' }[st], { danger: st !== 'aprovado' })) return;
          try {
            const r = await api(`/api/admin/clinics/${id}/status`, { method: 'POST', body: { status: st } });
            if (r.new_password) {
              dlg.close(); dlg.remove();
              await modal({ title: 'Senha da clínica', html: `<p>Clínica aprovada! Mande esta senha pelo WhatsApp (${esc(fmtPhone(c.phone))}). Login: código ${esc(c.code)} ou e-mail ${esc(c.email)}. É uma senha de acesso único: no primeiro acesso a clínica cria a própria senha. Ela não fica guardada.</p><div class="code-box">${esc(r.new_password)}</div>`,
                actions: [{ label: 'Copiar', class: 'secondary', handler: () => { copyText(r.new_password); return false; } }, { label: 'Fechar' }] });
              await load(); return open(id);
            }
            toast('Situação atualizada'); again();
          } catch (ex) { toast(ex.message, 'error'); }
        }));
        $$('[data-cadd]', dlg).forEach((x) => x.addEventListener('click', async () => { await api(`/api/admin/clinics/${id}/subscription`, { method: 'POST', body: { add_days: Number(x.dataset.cadd) } }); toast('Mensalidade atualizada'); again(); }));
        $('[data-csetuntil]', dlg)?.addEventListener('click', async () => { await api(`/api/admin/clinics/${id}/subscription`, { method: 'POST', body: { until: $('[data-cuntil]', dlg).value } }); toast('Mensalidade atualizada'); again(); });
        $('[data-creset]', dlg)?.addEventListener('click', async () => {
          if (!await confirmDialog('Gerar uma nova senha para a clínica? A senha antiga deixa de funcionar.')) return;
          const r = await api(`/api/admin/clinics/${id}/reset-password`, { method: 'POST' });
          modal({ title: 'Nova senha', html: `<p>Senha de acesso único: no primeiro acesso a clínica cria a própria senha.</p><div class="code-box">${esc(r.password)}</div>`, actions: [{ label: 'Copiar', class: 'secondary', handler: () => { copyText(r.password); return false; } }, { label: 'Fechar' }] });
        });
        $('[data-cdel]', dlg)?.addEventListener('click', async () => {
          if (!await confirmDialog(`Apagar a clínica ${c.name}? Some tudo e o CPF/CNPJ fica livre. Não dá para desfazer.`, { danger: true, okLabel: 'Apagar' })) return;
          if (!await confirmDialog('Tem certeza?', { danger: true, okLabel: 'Sim, apagar' })) return;
          await api(`/api/admin/clinics/${id}/delete`, { method: 'POST' }); toast('Clínica apagada'); dlg.close(); dlg.remove(); load();
        });
        $('[data-cedit]', dlg)?.addEventListener('click', async () => { dlg.close(); dlg.remove(); if (await edit(c)) await load(); open(id); });
      },
    });
  }

  function edit(c) {
    const fld = (l, h) => `<div class="field"><label>${l}</label>${h}</div>`;
    return modal({
      title: 'Editar dados da clínica',
      html: `<div class="form-error hidden" data-err></div>
        ${fld('Nome da clínica', `<input data-f="name" value="${esc(c.name)}" maxlength="120">`)}
        <div class="grid-2">${fld('Responsável', `<input data-f="responsible" value="${esc(c.responsible)}" maxlength="120">`)}${fld('CNPJ (ou CPF)', `<input data-f="doc" value="${esc(c.doc || '')}">`)}</div>
        ${fld('CPF do proprietário', `<input data-f="owner_cpf" value="${esc(c.responsible_cpf || '')}" placeholder="000.000.000-00">`)}
        <div class="grid-2">${fld('E-mail', `<input data-f="email" value="${esc(c.email)}">`)}${fld('WhatsApp', `<input data-f="phone" value="${esc(fmtPhone(c.phone))}">`)}</div>
        ${fld('Estado e município', `<div class="grid-uf"><select data-f="state"></select><input data-f="city" value="${esc(c.city)}"></div>`)}
        ${fld('Endereço', `<input data-f="address" value="${esc(c.address)}" maxlength="250">`)}
        ${fld('Link do Google Maps', `<input data-f="maps_url" value="${esc(c.maps_url)}">`)}`,
      onOpen: (dlg) => { const f = (k) => $(`[data-f="${k}"]`, dlg); f('state').innerHTML = ufOptions(c.state, 'UF'); bindUfCity(f('state'), f('city')); maskPhone(f('phone')); },
      actions: [{ label: 'Cancelar', value: false, class: 'secondary' }, { label: 'Salvar alterações', handler: async (dlg) => {
        const body = {};
        for (const k of ['name', 'responsible', 'doc', 'owner_cpf', 'email', 'phone', 'state', 'city', 'address', 'maps_url']) body[k] = $(`[data-f="${k}"]`, dlg).value;
        try { await api(`/api/admin/clinics/${c.id}/edit`, { method: 'POST', body }); toast('Dados atualizados'); return true; }
        catch (ex) { const e = $('[data-err]', dlg); e.textContent = ex.message; e.classList.remove('hidden'); return false; }
      } }],
    });
  }

  function show(arg) {
    if (arg !== undefined) status = arg;
    $$('[data-cseg] button').forEach((x) => x.classList.toggle('active', x.dataset.v === status));
    load().catch((e) => toast(e.message, 'error'));
  }
  document.addEventListener('DOMContentLoaded', () => {});
  $('[data-cseg]')?.addEventListener('click', (e) => { const x = e.target.closest('button[data-v]'); if (x) { status = x.dataset.v; show(); } });
  $('[data-cq]')?.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => load().catch(() => {}), 300); });
  document.addEventListener('click', (e) => { const x = e.target.closest('[data-copen]'); if (x) open(Number(x.dataset.copen)); });
  window.AcoliaAdminClinics = { show };
  if ((location.hash.slice(1) || '').startsWith('clinicas')) show((location.hash.split('/')[1]) || '');
})();
