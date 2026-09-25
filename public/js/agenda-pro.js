/* Painel do profissional — Consultas: próximas consultas, minha agenda (horários, duração, horários
   fechados) e o pagamento automático pelo Asaas (com o passo a passo). */
(function () {
  'use strict';
  const { $, $$, esc, api, ICONS, avatar, money, toast, modal, confirmDialog } = window.Acolia;
  const G = window.AcoliaAgenda;
  const ic = (name, s = 18) => ICONS[name].replace('<svg', `<svg style="width:${s}px;height:${s}px"`);
  const DAYS = [[1, 'Segunda'], [2, 'Terça'], [3, 'Quarta'], [4, 'Quinta'], [5, 'Sexta'], [6, 'Sábado'], [0, 'Domingo']];
  const MINUTES = [30, 40, 45, 50, 60, 90, 120];
  const MISSING = {
    online: 'Ligue <b>"Disponível para atendimento online"</b> (logo acima).',
    horarios: 'Coloque os horários de início das consultas (abaixo) e toque em "Salvar agenda".',
    valor: 'Coloque o valor da consulta em <a href="#perfil">Meu perfil</a>.',
    pix: 'Cadastre a sua chave Pix em <a href="#perfil">Meu perfil</a> (pagamento manual) ou conecte o Asaas (pagamento automático, abaixo).',
  };

  let els = null;
  let settings = null;

  // ---------- Próximas consultas ----------
  async function renderAppts() {
    const box = els.appts;
    const list = await G.loadUpcoming();
    const cards = list.map((a) => `<div class="appt-item">
        <div class="row" style="gap:10px;align-items:flex-start;flex-wrap:nowrap">${avatar(a.patient.name, a.patient.photo, 'sm')}<div class="grow" style="min-width:0"><b>${esc(a.patient.name)}</b>
          <div class="small muted">${esc(a.when)} · ${a.minutes} min · ${a.price_cents != null ? money(a.price_cents) : ''} · ${a.mode === 'auto' ? 'Pix automático' : 'Pix manual'}</div><div style="margin-top:4px">${G.badge(a)}</div></div></div>
        ${a.status === 'confirmada' ? `<div class="small appt-left">Faltam <b data-cd="${esc(a.start_at)}">${G.countdown(Date.parse(a.start_at) - Date.now())}</b>${a.can.pro_cancel ? '' : ' · <span class="muted">com menos de 24 h você não pode mais desmarcar</span>'}</div>` : ''}
        <div class="bk-actions">${G.buttons(a, 'professional')}<button type="button" class="btn sm ghost" data-ag-act="chat" data-ag-id="${a.id}">${ic('chat', 16)} Conversa</button></div>
      </div>`).join('');
    box.innerHTML = `<div class="card stack"><div class="row between"><h2 style="margin:0">Próximas consultas</h2><button type="button" class="btn sm ghost" data-hist>Histórico</button></div>
      ${list.length ? `<div class="appt-list">${cards}</div>` : '<p class="muted" style="margin:0">Nenhuma consulta marcada ainda. Quando um paciente marcar pela sua agenda (ou você marcar pelo chat), ela aparece aqui.</p>'}</div>`;
    $('[data-hist]', box).addEventListener('click', openHistory);
  }

  async function openHistory() {
    const { items } = await api('/api/agenda/appointments?scope=all');
    modal({
      title: 'Histórico de consultas',
      html: items.length ? `<div class="table-wrap"><table><thead><tr><th>Paciente</th><th>Quando</th><th>Situação</th></tr></thead><tbody>${items.map((a) => `<tr><td>${esc(a.patient.name)}</td><td>${esc(a.when)}</td><td>${G.badge(a)}</td></tr>`).join('')}</tbody></table></div>`
        : '<p class="muted">Ainda não há consultas.</p>',
      actions: [{ label: 'Fechar' }],
    });
  }

  // ---------- Minha agenda ----------
  // ---------- Minha agenda ----------
  // Cada horário é o INÍCIO de uma consulta; o fim aparece sozinho (início + duração). "+ adicionar
  // horário" já sugere o próximo contando o descanso. Dá para empurrar para mais tarde (almoço, pausa),
  // mas nunca para antes do fim da anterior + descanso.
  const toMin = (t) => { const [h, m] = String(t || '').split(':').map(Number); return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null; };
  const toHHMM = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const startRow = (t) => `<div class="start-row" data-start-row><input type="time" data-start value="${esc(t)}" aria-label="Começa às" step="300"><span class="small muted">até <b data-end></b></span>
      <button type="button" class="icon-btn" data-rm aria-label="Tirar este horário" title="Tirar">✕</button></div>`;

  function renderAgenda() {
    const s = settings;
    const status = s.ready
      ? `<div class="notice ok small">✅ Pacientes já podem marcar. ${s.next ? `Próximo horário livre: <b>${esc(s.next.label)} às ${esc(s.next.first)}</b>.` : 'Não há horário livre nos próximos 60 dias.'} Pagamento: <b>${s.mode === 'auto' ? 'Pix automático (Asaas)' : 'Pix manual pelo chat'}</b>.</div>`
      : `<div class="notice warn small"><b>Os pacientes ainda não conseguem marcar.</b> Falta:<ul style="margin:6px 0 0;padding-left:18px">${s.missing.map((m) => `<li>${MISSING[m]}</li>`).join('')}</ul></div>`;
    els.agenda.innerHTML = `<h2 style="margin:0">Minha agenda</h2>
      <label class="switch-row"><span><b>Disponível para atendimento online</b><span class="small muted">Ligado, os pacientes marcam nos seus horários e pagam pelo Pix ${s.mode === 'auto' ? '(automático)' : '(pela conversa)'}. Desligado, ninguém marca.</span></span>
        <input type="checkbox" class="switch" data-online ${s.online ? 'checked' : ''} aria-label="Disponível para atendimento online"></label>
      ${status}
      <div class="grid-2">
        <div class="field" style="margin:0"><label for="ag-min">Duração de cada consulta</label>
          <select id="ag-min" data-min>${MINUTES.map((m) => `<option value="${m}" ${m === s.session_minutes ? 'selected' : ''}>${m} minutos</option>`).join('')}</select></div>
        <div class="field" style="margin:0"><label for="ag-break">Descanso entre as consultas</label>
          <select id="ag-break" data-break>${[0, 5, 10, 15, 20, 30].map((m) => `<option value="${m}" ${m === (s.break_minutes || 0) ? 'selected' : ''}>${m ? `${m} minutos` : 'Sem descanso'}</option>`).join('')}</select></div>
      </div>
      <div><b>Horários de início das consultas</b><div class="small muted">Coloque a hora em que <b>começa</b> cada consulta; o fim aparece sozinho. Em "+ adicionar horário" o próximo já vem contando o descanso. Você pode deixar para mais tarde (almoço, pausa), mas não para antes.</div></div>
      <div class="row" style="gap:8px;flex-wrap:wrap"><button type="button" class="btn secondary sm" data-commercial>Preencher horário comercial (seg. a sex.)</button><button type="button" class="btn secondary sm" data-copy-mon>Copiar segunda para os dias úteis</button></div>
      <div class="week">${DAYS.map(([d, name]) => { const list = s.starts[d] || []; return `<div class="week-day ${list.length ? 'closed' : ''}" data-day="${d}">
          <div class="wd-head"><label class="check"><input type="checkbox" data-on ${list.length ? 'checked' : ''}> <b>${name}</b></label>
            <button type="button" class="link-btn small wd-sum" data-toggle-day></button></div>
          <div class="ranges" data-ranges>${list.map(startRow).join('')}</div>
          <button type="button" class="btn sm ghost ${list.length ? '' : 'hidden'}" data-add>+ adicionar horário</button>
        </div>`; }).join('')}</div>
      <div class="form-error hidden" data-agerr></div>
      <button type="button" class="btn" data-save>Salvar agenda</button>
      <hr>
      <div><b>Fechar um horário</b><div class="small muted">Tem consulta presencial ou um compromisso? Feche o horário <b>antes</b> que alguém marque. Consulta já paga continua valendo: você precisa atender.</div></div>
      <div class="block-form">
        <input type="date" data-bdate aria-label="Dia">
        <label class="check small"><input type="checkbox" data-ball> Dia inteiro</label>
        <span class="row" style="gap:6px" data-btimes><input type="time" data-bfrom value="08:00" aria-label="De"><span>às</span><input type="time" data-bto value="12:00" aria-label="Até"></span>
        <input data-bnote maxlength="120" placeholder="Anotação (só você vê)">
        <button type="button" class="btn secondary sm" data-badd>Fechar horário</button>
      </div>
      ${s.blocks.length ? `<ul class="block-list">${s.blocks.map((b) => `<li><span>${b.date.split('-').reverse().join('/')} · ${b.from === '00:00' && (b.to === '00:00' || b.to === '24:00') ? 'dia inteiro' : `${b.from} às ${b.to}`}${b.note ? ` · <span class="muted">${esc(b.note)}</span>` : ''}</span><button type="button" class="icon-btn" data-bdel="${b.id}" aria-label="Reabrir este horário" title="Reabrir">✕</button></li>`).join('')}</ul>` : ''}`;

    const root = els.agenda;
    const dur = () => Number($('[data-min]', root).value);
    const brk = () => Number($('[data-break]', root).value);
    // Atualiza o "até" de cada linha e empurra para frente o que ficou cedo demais
    const fix = (day, changed) => {
      const rows = $$('[data-start-row]', day);
      let prevEnd = null;
      let pushed = false;
      rows.forEach((row) => {
        const input = $('[data-start]', row);
        let m = toMin(input.value);
        if (m === null) m = prevEnd !== null ? prevEnd + brk() : 8 * 60;
        const min = prevEnd !== null ? prevEnd + brk() : 0;
        if (m < min) { m = min; pushed = true; }
        if (m + dur() > 1440) m = Math.max(min, 1440 - dur());
        input.value = toHHMM(m);
        input.min = prevEnd !== null ? toHHMM(min) : '';
        $('[data-end]', row).textContent = toHHMM(m + dur());
        prevEnd = m + dur();
      });
      if (pushed && changed) toast(`Não dá para começar antes do fim da consulta anterior + descanso. Ajustei para ${changed.value}.`);
      // Resumo do dia (aparece com o dia fechado): "8 horários · 08:00 às 17:50 ▾"
      const sum = $('[data-toggle-day]', day);
      if (sum) {
        const starts = rows.map((r) => $('[data-start]', r).value);
        sum.textContent = starts.length ? `${starts.length} horário${starts.length > 1 ? 's' : ''} · ${starts[0]} às ${toHHMM(prevEnd)} ${day.classList.contains('closed') ? '▾ ver' : '▴ fechar'}` : '';
      }
    };
    const days = $$('.week-day', root);
    days.forEach((day) => {
      const ranges = $('[data-ranges]', day);
      const add = $('[data-add]', day);
      const addNext = () => {
        const last = [...$$('[data-start]', day)].pop();
        const next = last ? toMin(last.value) + dur() + brk() : 8 * 60;
        if (next + dur() > 1440) { toast('Não cabe outra consulta neste dia.', 'error'); return; }
        ranges.insertAdjacentHTML('beforeend', startRow(toHHMM(next)));
        fix(day);
      };
      $('[data-on]', day).addEventListener('change', (e) => {
        day.classList.remove('closed');
        if (e.target.checked && !ranges.children.length) addNext();
        if (!e.target.checked) ranges.innerHTML = '';
        add.classList.toggle('hidden', !e.target.checked);
      });
      add.addEventListener('click', () => { day.classList.remove('closed'); addNext(); });
      $('[data-toggle-day]', day).addEventListener('click', () => { day.classList.toggle('closed'); fix(day); });
      ranges.addEventListener('click', (e) => {
        if (!e.target.closest('[data-rm]')) return;
        e.target.closest('[data-start-row]').remove();
        if (!ranges.children.length) { $('[data-on]', day).checked = false; add.classList.add('hidden'); }
        fix(day);
      });
      ranges.addEventListener('change', (e) => { if (e.target.matches('[data-start]')) fix(day, e.target); });
      fix(day);
    });
    [$('[data-min]', root), $('[data-break]', root)].forEach((sel) => sel.addEventListener('change', () => days.forEach((d) => fix(d))));
    // Horário comercial: seg. a sex., das 08:00 ao meio-dia e das 14:00 às 18:00
    $('[data-commercial]', root).addEventListener('click', () => {
      for (const d of [1, 2, 3, 4, 5]) {
        const day = $(`.week-day[data-day="${d}"]`, root);
        const list = [];
        for (const [from, to] of [[480, 720], [840, 1080]]) {
          const first = list.length ? Math.max(from, list[list.length - 1] + dur() + brk()) : from;
          for (let m = first; m + dur() <= to; m += dur() + brk()) list.push(m);
        }
        $('[data-ranges]', day).innerHTML = list.map((m) => startRow(toHHMM(m))).join('');
        $('[data-on]', day).checked = true;
        $('[data-add]', day).classList.remove('hidden');
        day.classList.add('closed');
        fix(day);
      }
      toast('Horário comercial preenchido. Confira e toque em "Salvar agenda".');
    });
    $('[data-copy-mon]', root).addEventListener('click', () => {
      const mon = $('.week-day[data-day="1"]', root);
      const list = $$('[data-start]', mon).map((x) => x.value);
      if (!list.length) { toast('Preencha a segunda-feira primeiro.', 'error'); return; }
      for (const d of [2, 3, 4, 5]) {
        const day = $(`.week-day[data-day="${d}"]`, root);
        $('[data-ranges]', day).innerHTML = list.map(startRow).join('');
        $('[data-on]', day).checked = true;
        $('[data-add]', day).classList.remove('hidden');
        day.classList.add('closed');
        fix(day);
      }
      toast('Copiado para terça a sexta. Toque em "Salvar agenda".');
    });
    const save = async (extra = {}) => {
      const starts = {};
      days.forEach((day) => { const list = $$('[data-start]', day).map((x) => x.value).filter(Boolean); if (list.length) starts[day.dataset.day] = list; });
      return api('/api/agenda/settings', { method: 'PUT', body: { starts, session_minutes: dur(), break_minutes: brk(), ...extra } });
    };
    $('[data-save]', root).addEventListener('click', async (e) => {
      const btn = e.currentTarget; // (depois do await o evento já não guarda o botão)
      const err = $('[data-agerr]', root);
      err.classList.add('hidden');
      btn.disabled = true;
      try {
        settings = await save();
        toast('Agenda salva ✓', '', { top: true });
        renderAgenda();
      } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); btn.disabled = false; }
    });
    $('[data-online]', root).addEventListener('change', async (e) => {
      const on = e.target.checked;
      try {
        // Ligar já salva os horários que estão na tela
        settings = await save({ online: on });
        toast(on ? (settings.ready ? 'Agenda ligada: os pacientes já podem marcar ✓' : 'Ligado. Falta completar o que aparece no aviso.') : 'Agenda desligada: ninguém marca até você ligar de novo.', '', { top: true });
        renderAgenda();
      } catch (ex) { e.target.checked = !on; toast(ex.message, 'error'); }
    });
    $('[data-ball]', root).addEventListener('change', (e) => $('[data-btimes]', root).classList.toggle('hidden', e.target.checked));
    $('[data-badd]', root).addEventListener('click', async () => {
      try {
        const r = await api('/api/agenda/blocks', { method: 'POST', body: { date: $('[data-bdate]', root).value, all_day: $('[data-ball]', root).checked, from: $('[data-bfrom]', root).value, to: $('[data-bto]', root).value, note: $('[data-bnote]', root).value } });
        settings = r;
        toast(r.clash ? `Horário fechado. Atenção: já há ${r.clash} consulta(s) paga(s) nesse horário, e ela(s) continua(m) valendo.` : 'Horário fechado ✓');
        renderAgenda();
      } catch (ex) { toast(ex.message, 'error'); }
    });
    $$('[data-bdel]', root).forEach((b) => b.addEventListener('click', async () => {
      settings = await api(`/api/agenda/blocks/${b.dataset.bdel}`, { method: 'DELETE' });
      renderAgenda();
    }));
  }

  // ---------- Pagamento automático (Asaas) ----------
  function renderAsaas() {
    const p = settings.payment;
    const box = els.asaas;
    if (!p.connected) {
      box.innerHTML = `<h2 style="margin:0">${ic('pix', 22)} Pagamento automático pelo Pix (Asaas)</h2>
        <p style="margin:0">O paciente paga o Pix <b>dentro da Acolia</b> e a consulta é marcada sozinha. Se ele cancelar no prazo, o reembolso também é automático. O dinheiro cai <b>direto na sua conta Asaas</b>: a Acolia não recebe nem cobra taxa.</p>
        <p class="small muted" style="margin:0">Sem o Asaas, o pagamento é manual: o paciente pede a consulta, você manda a sua chave Pix na conversa e confirma quando o dinheiro cair.</p>
        <button type="button" class="btn" data-connect>Conectar meu Asaas (passo a passo)</button>`;
      $('[data-connect]', box).addEventListener('click', wizard);
      return;
    }
    box.innerHTML = `<h2 style="margin:0">${ic('pix', 22)} Pagamento automático pelo Pix (Asaas)</h2>
      <div class="notice ${p.key_ok ? 'ok' : 'warn'} small">${p.key_ok ? '✅ Conectado' : '⚠️ A chave guardada não abre mais: conecte de novo'}${p.account_name && p.env !== 'simulado' ? `: <b>${esc(p.account_name)}</b>` : ''} · ${p.env === 'simulado' ? '<b>Asaas simulado</b> (conta de teste, sem dinheiro)' : p.env === 'teste' ? '<b>Asaas Sandbox</b> (teste, dinheiro de mentira)' : 'conta real'}</div>
      <label class="check"><input type="checkbox" data-enabled ${p.enabled ? 'checked' : ''}> Usar o pagamento automático nas novas consultas</label>
      ${p.enabled ? '<p class="small" style="margin:0">As consultas pagas pelo Pix são <b>confirmadas sozinhas</b>, e os reembolsos no prazo também saem sozinhos.</p>' : ''}
      <p class="small muted" style="margin:0">Desligado, as novas consultas vão pelo Pix manual (a sua chave Pix na conversa).</p>
      <div class="row" style="gap:8px;flex-wrap:wrap"><button type="button" class="btn secondary sm" data-connect>Trocar a chave</button><button type="button" class="btn ghost sm danger-text" data-disconnect>Desconectar</button></div>`;
    $('[data-connect]', box).addEventListener('click', wizard);
    $('[data-enabled]', box).addEventListener('change', async (e) => {
      try { settings = await api('/api/agenda/asaas', { method: 'PUT', body: { enabled: e.target.checked } }); render(); toast(e.target.checked ? 'Pagamento automático ligado ✓' : 'Pagamento automático desligado'); } catch (ex) { toast(ex.message, 'error'); }
    });
    $('[data-disconnect]', box).addEventListener('click', async () => {
      if (!await confirmDialog('Desconectar o Asaas? As novas consultas passam a ser pagas pelo Pix manual.', { okLabel: 'Desconectar', danger: true })) return;
      try { settings = await api('/api/agenda/asaas', { method: 'DELETE' }); render(); toast('Asaas desconectado'); } catch (ex) { toast(ex.message, 'error'); }
    });
  }

  // Passo a passo: cada tela pede um print e só avança com "Sim, tirei print" (o ✕ fecha)
  const STEPS = [
    ['Como funciona', `<ul class="policy-list">
      <li>O paciente escolhe o dia e o horário na sua agenda e paga o <b>Pix dentro da Acolia</b> (QR Code ou "copia e cola").</li>
      <li>Quando o Pix cai na sua conta Asaas, a <b>consulta é confirmada sozinha</b>: você não precisa conferir nada. A chamada também é criada sozinha (o link aparece na conversa 10 minutos antes).</li>
      <li>O dinheiro vai <b>direto para a sua conta no Asaas</b>. A Acolia <b>não recebe</b> o dinheiro e <b>não cobra taxa</b> sobre a consulta. A tarifa do Pix é a do próprio Asaas.</li>
      <li>Se o paciente cancelar no prazo (até 30 minutos antes), o <b>reembolso sai automático</b> da sua conta Asaas. Deixe saldo para isso.</li>
      <li>Só <b>Pix</b> (cai na hora). Não há cartão nem boleto.</li>
      <li>São 4 passos: criar a conta, cadastrar uma chave Pix, gerar a chave de API e colar aqui.</li></ul>`],
    ['Passo 1 — Crie a sua conta no Asaas', `<ol class="policy-list">
      <li>Baixe o app <b>Asaas</b> (Play Store ou App Store) ou entre no site <b>asaas.com</b> e toque em <b>Criar conta grátis</b>.</li>
      <li>Escolha <b>pessoa física (CPF)</b> ou <b>pessoa jurídica (CNPJ)</b>. Preencha nome, e-mail e celular e crie uma senha.</li>
      <li>Confirme o e-mail e o celular com o código que o Asaas envia.</li>
      <li>Complete o cadastro (endereço e informações do seu trabalho: pode colocar que presta serviços de saúde/psicologia).</li>
      <li>Envie os documentos que o Asaas pedir (normalmente um documento com foto e uma selfie).</li>
      <li><b>Espere a aprovação da conta</b> (o Asaas avisa por e-mail; costuma levar poucos dias úteis). A conta só recebe Pix depois de aprovada.</li></ol>`],
    ['Passo 2 — Cadastre uma chave Pix no Asaas', `<ol class="policy-list">
      <li>No Asaas, abra o menu <b>Pix</b>.</li>
      <li>Toque em <b>Minhas chaves</b> e depois em <b>Cadastrar chave</b>.</li>
      <li>Escolha <b>Chave aleatória</b> (recomendado) ou use CPF, e-mail ou telefone, e confirme com o código de segurança.</li>
      <li>É nessa conta que os pagamentos das consultas vão cair.</li></ol>
      <p class="small muted">Sem uma chave Pix cadastrada no Asaas, o QR Code da consulta não é gerado.</p>`],
    ['Passo 3 — Gere a sua chave de API', `<ol class="policy-list">
      <li>Pelo <b>site do Asaas</b> (no computador é mais fácil), abra o menu e entre em <b>Integrações</b>.</li>
      <li>Vá em <b>Chaves de API</b> e toque em <b>Gerar chave de API</b>.</li>
      <li>Dê um nome para a chave (por exemplo, <b>Acolia</b>). Se pedir validade, escolha <b>sem validade</b> (ou a mais longa).</li>
      <li>Confirme com o código de segurança que o Asaas manda por SMS ou e-mail.</li>
      <li>A chave aparece na tela: ela começa com <code>$aact_prod_</code>. Toque em <b>Copiar</b>. <b>O Asaas mostra a chave uma vez só</b>: se perder, gere outra e troque aqui.</li>
      <li>Não mande essa chave para ninguém. Aqui na Acolia ela fica guardada <b>criptografada</b> e só é usada para criar o Pix das consultas e fazer os reembolsos.</li></ol>
      <p class="small muted">Use a chave da sua <b>conta real</b> do Asaas. Chave de conta de teste (Sandbox) não é aceita, porque não recebe dinheiro de verdade.</p>`],
  ];
  function wizard() {
    let i = 0;
    let asked = false;
    modal({
      title: 'Conectar o Asaas',
      html: '<div data-wz></div>',
      actions: [],
      onOpen: (dlg) => {
        const wz = $('[data-wz]', dlg);
        const paint = () => {
          if (i < STEPS.length) {
            const [t, body] = STEPS[i];
            wz.innerHTML = `<div class="wz-step">Tela ${i + 1} de ${STEPS.length + 1}</div><h3 style="margin:4px 0 10px">${t}</h3>${body}
              ${asked ? `<div class="wz-ask"><b>Você tirou print desta tela?</b><button type="button" class="btn" data-yes>Sim</button></div>`
                : `<p class="notice info small" style="margin-top:12px">📸 <b>Tire um print desta tela</b> para rever as informações depois.</p><button type="button" class="btn block" data-next>Avançar</button>`}`;
            $('[data-next]', wz)?.addEventListener('click', () => { asked = true; paint(); });
            $('[data-yes]', wz)?.addEventListener('click', () => { asked = false; i++; paint(); });
            return;
          }
          wz.innerHTML = `<div class="wz-step">Tela ${STEPS.length + 1} de ${STEPS.length + 1}</div><h3 style="margin:4px 0 10px">Passo 4 — Cole a chave e confirme</h3>
            <div class="form-error hidden" data-err></div>
            <div class="field"><label for="wz-key">Chave de API do Asaas</label><input id="wz-key" data-key autocomplete="off" spellcheck="false" placeholder="$aact_prod_..."></div>
            <button type="button" class="btn block" data-save>Conectar e confirmar</button>
            <p class="small muted">A Acolia confere a chave com o Asaas na hora. Depois de conectar, deixe marcado <b>"Usar o pagamento automático"</b>: a partir daí as consultas pagas pelo Pix são <b>confirmadas sozinhas</b>. Confira também se a sua <b>agenda</b> está aberta (horários e valor da consulta).</p>`;
          $('[data-save]', wz).addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            const err = $('[data-err]', wz);
            err.classList.add('hidden');
            btn.disabled = true;
            try {
              settings = await api('/api/agenda/asaas', { method: 'POST', body: { key: $('[data-key]', wz).value } });
              dlg.close(); dlg.remove();
              render();
              toast(`Asaas conectado ✓ Consultas confirmadas automaticamente${settings.payment.env !== 'producao' ? ' (teste)' : ''}`, '', { top: true });
            } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); btn.disabled = false; }
          });
        };
        paint();
      },
    });
  }

  function render() { renderAgenda(); renderAsaas(); }

  async function load() {
    try {
      settings = await api('/api/agenda/settings');
      render();
    } catch (e) { els.agenda.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
    renderAppts().catch(() => {});
  }

  function mount(opts) {
    els = opts;
    G.bindActions(els.appts, (id) => G.findAppt(id));
    G.onChange(() => { if (!els.appts.closest('.hidden')) renderAppts().catch(() => {}); });
    setInterval(() => $$('[data-cd]', els.appts).forEach((el) => { el.textContent = G.countdown(Date.parse(el.dataset.cd) - Date.now()); }), 30000);
    return { load };
  }

  window.AcoliaAgendaPro = { mount };
})();
