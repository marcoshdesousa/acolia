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
    horarios: 'Cadastre os dias e horários em que você atende (abaixo).',
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
  function rangeRow(dow, r = { start: '08:00', end: '12:00' }) {
    return `<div class="range-row" data-range data-dow="${dow}"><input type="time" data-s value="${esc(r.start)}" aria-label="Começa"><span>às</span><input type="time" data-e value="${esc(r.end)}" aria-label="Termina">
      <button type="button" class="icon-btn" data-rm aria-label="Tirar este horário" title="Tirar">✕</button></div>`;
  }

  function renderAgenda() {
    const s = settings;
    const byDay = (d) => s.hours.filter((h) => h.dow === d);
    const status = s.ready
      ? `<div class="notice ok small">✅ Sua agenda está <b>aberta</b>. ${s.next ? `Próximo horário livre: <b>${esc(s.next.label)} às ${esc(s.next.first)}</b>.` : 'Não há horário livre nos próximos 60 dias.'} Pagamento: <b>${s.mode === 'auto' ? 'Pix automático (Asaas)' : 'Pix manual pelo chat'}</b>.</div>`
      : `<div class="notice warn small"><b>Sua agenda ainda não aparece para os pacientes.</b> Falta:<ul style="margin:6px 0 0;padding-left:18px">${s.missing.map((m) => `<li>${MISSING[m]}</li>`).join('')}</ul></div>`;
    els.agenda.innerHTML = `<h2 style="margin:0">Minha agenda</h2>
      ${status}
      <div class="field" style="margin:0"><label for="ag-min">Duração de cada consulta</label>
        <select id="ag-min" data-min>${MINUTES.map((m) => `<option value="${m}" ${m === s.session_minutes ? 'selected' : ''}>${m} minutos</option>`).join('')}</select></div>
      <div><b>Dias e horários em que você atende online</b><div class="small muted">Os horários de consulta são criados um atrás do outro, do começo ao fim de cada faixa. Quem marca precisa de pelo menos ${s.rules.MIN_ADVANCE_MIN} minutos de antecedência.</div></div>
      <div class="week">${DAYS.map(([d, name]) => `<div class="week-day" data-day="${d}">
          <label class="check"><input type="checkbox" data-on ${byDay(d).length ? 'checked' : ''}> <b>${name}</b></label>
          <div class="ranges" data-ranges>${byDay(d).map((r) => rangeRow(d, r)).join('')}</div>
          <button type="button" class="btn sm ghost ${byDay(d).length ? '' : 'hidden'}" data-add>+ outro horário</button>
        </div>`).join('')}</div>
      <div class="row" style="gap:8px;flex-wrap:wrap"><button type="button" class="btn" data-save>Salvar agenda</button><button type="button" class="btn secondary sm" data-copy-mon>Copiar segunda para os dias úteis</button></div>
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
    $$('.week-day', root).forEach((day) => {
      const dow = Number(day.dataset.day);
      const ranges = $('[data-ranges]', day);
      const add = $('[data-add]', day);
      $('[data-on]', day).addEventListener('change', (e) => {
        if (e.target.checked && !ranges.children.length) ranges.insertAdjacentHTML('beforeend', rangeRow(dow) + rangeRow(dow, { start: '14:00', end: '18:00' }));
        if (!e.target.checked) ranges.innerHTML = '';
        add.classList.toggle('hidden', !e.target.checked);
      });
      add.addEventListener('click', () => ranges.insertAdjacentHTML('beforeend', rangeRow(dow, { start: '18:00', end: '20:00' })));
      ranges.addEventListener('click', (e) => {
        if (!e.target.closest('[data-rm]')) return;
        e.target.closest('[data-range]').remove();
        if (!ranges.children.length) { $('[data-on]', day).checked = false; add.classList.add('hidden'); }
      });
    });
    $('[data-copy-mon]', root).addEventListener('click', () => {
      const mon = $('.week-day[data-day="1"] [data-ranges]', root);
      if (!mon.children.length) { toast('Preencha a segunda-feira primeiro.', 'error'); return; }
      for (const d of [2, 3, 4, 5]) {
        const day = $(`.week-day[data-day="${d}"]`, root);
        $('[data-ranges]', day).innerHTML = [...$$('[data-range]', mon)].map((r) => rangeRow(d, { start: $('[data-s]', r).value, end: $('[data-e]', r).value })).join('');
        $('[data-on]', day).checked = true;
        $('[data-add]', day).classList.remove('hidden');
      }
      toast('Copiado para terça a sexta. Toque em "Salvar agenda".');
    });
    $('[data-save]', root).addEventListener('click', async (e) => {
      const btn = e.currentTarget; // (depois do await o evento já não guarda o botão)
      const hours = $$('[data-range]', root).map((r) => ({ dow: Number(r.dataset.dow), start: $('[data-s]', r).value, end: $('[data-e]', r).value }));
      btn.disabled = true;
      try {
        settings = await api('/api/agenda/settings', { method: 'PUT', body: { hours, session_minutes: Number($('[data-min]', root).value) } });
        toast('Agenda salva ✓', '', { top: true });
        renderAgenda();
      } catch (ex) { toast(ex.message, 'error'); btn.disabled = false; }
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
      <div class="notice ${p.key_ok ? 'ok' : 'warn'} small">${p.key_ok ? '✅ Conectado' : '⚠️ A chave guardada não abre mais: conecte de novo'}${p.account_name ? `: <b>${esc(p.account_name)}</b>` : ''} · ${p.env === 'teste' ? '<b>modo de teste</b> (Sandbox, dinheiro de mentira)' : 'conta real'}</div>
      <label class="check"><input type="checkbox" data-enabled ${p.enabled ? 'checked' : ''}> Usar o pagamento automático nas novas consultas</label>
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
      <li>Quando o Pix cai, a <b>consulta é marcada sozinha</b> e a chamada é criada automaticamente (o link aparece na conversa 10 minutos antes).</li>
      <li>O dinheiro vai <b>direto para a sua conta no Asaas</b>. A Acolia <b>não recebe</b> o dinheiro e <b>não cobra taxa</b> sobre a consulta. A taxa do Pix é a do próprio Asaas.</li>
      <li>Se o paciente cancelar no prazo (até 30 minutos antes), o <b>reembolso sai automático</b> da sua conta Asaas. Deixe saldo para isso.</li>
      <li>Só <b>Pix</b> (cai na hora). Não há cartão nem boleto.</li></ul>`],
    ['Passo 1 — Crie a sua conta no Asaas', `<ol class="policy-list">
      <li>Entre no site <b>asaas.com</b> (ou baixe o app <b>Asaas</b>).</li>
      <li>Toque em <b>Criar conta</b>. Pode ser com <b>CPF</b> (pessoa física) ou <b>CNPJ</b>.</li>
      <li>Preencha os seus dados e envie os documentos que o Asaas pedir.</li>
      <li>Espere a aprovação da conta pelo Asaas (eles avisam por e-mail).</li></ol>`],
    ['Passo 2 — Cadastre uma chave Pix no Asaas', `<ol class="policy-list">
      <li>No Asaas, abra o menu <b>Pix</b>.</li>
      <li>Vá em <b>Minhas chaves</b> (ou "Chaves Pix") e toque em <b>Cadastrar chave</b>.</li>
      <li>Pode ser uma <b>chave aleatória</b>. É nela que os pagamentos das consultas vão cair.</li></ol>
      <p class="small muted">Sem uma chave Pix cadastrada no Asaas, o QR Code da consulta não é gerado.</p>`],
    ['Passo 3 — Gere a sua chave de API', `<ol class="policy-list">
      <li>No Asaas, abra o menu da sua conta (seu nome ou a engrenagem) e entre em <b>Integrações</b>.</li>
      <li>Vá em <b>Chaves de API</b> e toque em <b>Gerar chave de API</b> (ou "Gerar nova chave").</li>
      <li><b>Copie a chave inteira.</b> Ela começa com <code>$aact_</code>. O Asaas mostra a chave uma vez só.</li>
      <li>Não mande essa chave para ninguém: ela dá acesso à sua conta. Aqui na Acolia ela fica guardada <b>criptografada</b> e só é usada para criar o Pix das consultas e fazer os reembolsos.</li></ol>
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
          wz.innerHTML = `<div class="wz-step">Tela ${STEPS.length + 1} de ${STEPS.length + 1}</div><h3 style="margin:4px 0 10px">Passo 4 — Cole a chave aqui</h3>
            <div class="form-error hidden" data-err></div>
            <div class="field"><label for="wz-key">Chave de API do Asaas</label><input id="wz-key" data-key autocomplete="off" spellcheck="false" placeholder="$aact_..."></div>
            <button type="button" class="btn block" data-save>Conectar</button>
            <p class="small muted">A Acolia confere a chave com o Asaas na hora.</p>`;
          $('[data-save]', wz).addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            const err = $('[data-err]', wz);
            err.classList.add('hidden');
            btn.disabled = true;
            try {
              settings = await api('/api/agenda/asaas', { method: 'POST', body: { key: $('[data-key]', wz).value } });
              dlg.close(); dlg.remove();
              render();
              toast(`Asaas conectado ✓${settings.payment.env === 'teste' ? ' (modo de teste)' : ''}`, '', { top: true });
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
