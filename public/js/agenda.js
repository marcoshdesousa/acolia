/* Agenda e consultas (paciente e profissional): calendário, pagamento por Pix dentro da Acolia,
   cartões da consulta no chat, "Ver" (remarcar/cancelar) e o aviso fixo com a contagem regressiva.
   O dinheiro vai direto para a conta do profissional — a Acolia só liga as pontas. */
(function () {
  'use strict';
  const { $, $$, esc, api, ICONS, avatar, money, toast, modal, confirmDialog, copyText } = window.Acolia;
  const ic = (name, s = 20) => ICONS[name].replace('<svg', `<svg style="width:${s}px;height:${s}px"`);
  const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  const WD = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
  let ctx = { role: null, onGoChat: null, onOpenAppts: null };
  const setContext = (o) => { ctx = { ...ctx, ...o }; };

  // Diferença entre o relógio do aparelho e o do servidor (contagens certas mesmo com o celular adiantado)
  let skew = 0;
  const syncClock = (serverIso) => { if (serverIso) skew = Date.parse(serverIso) - Date.now(); };
  const now = () => Date.now() + skew;

  function countdown(ms) {
    if (ms <= 0) return 'agora';
    const m = Math.floor(ms / 60000);
    const d = Math.floor(m / 1440);
    const h = Math.floor((m % 1440) / 60);
    const mm = m % 60;
    if (d) return `${d} dia${d > 1 ? 's' : ''}${h ? ` e ${h} h` : ''}`;
    if (h) return `${h} h ${String(mm).padStart(2, '0')} min`;
    if (m) return `${mm} min`;
    return `${Math.ceil(ms / 1000)} s`;
  }
  const mmss = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

  const STATUS = {
    aguardando_pagamento: ['Aguardando pagamento', 'warn'],
    aguardando_pix: ['Esperando a chave Pix', 'warn'],
    pagamento_recusado: ['Pagamento não aprovado', 'danger'],
    confirmada: ['Consulta marcada', 'ok'],
    aguardando_paciente: ['Profissional não poderá atender', 'warn'],
    reembolso_pendente: ['Reembolso em andamento', 'warn'],
    reembolsada: ['Reembolsada', ''],
    cancelada: ['Cancelada', ''],
    expirada: ['Tempo esgotado', ''],
    concluida: ['Concluída', ''],
    paciente_ausente: ['Paciente não entrou', 'danger'],
    nao_realizada: ['Não aconteceu', ''],
  };
  const badge = (a) => { const [t, c] = STATUS[a.status] || [a.status, '']; return `<span class="badge ${c}">${esc(t)}</span>`; };

  // ---------- Política (aparece antes de pagar, com "Li e aceito") ----------
  function policyHtml(rules) {
    const r = rules || { CUTOFF_MIN: 30, PAY_MIN: 10, PRO_PIX_MIN: 5, PRO_GRACE_MIN: 3, PRO_CANCEL_H: 24 };
    return `<ul class="policy-list">
      <li>O pagamento é <b>só por Pix</b> e confirma a consulta. Você tem <b>${r.PAY_MIN} minutos</b> para pagar; depois disso o horário é liberado.</li>
      <li>Cada paciente marca <b>uma consulta por dia</b>.</li>
      <li>Você pode <b>remarcar uma vez</b> ou <b>cancelar com reembolso</b> até <b>${r.CUTOFF_MIN} minutos antes</b>. Com ${r.CUTOFF_MIN} minutos ou menos, não dá mais para remarcar nem pedir reembolso.</li>
      <li>Se você <b>não entrar na chamada</b> até ${r.PRO_GRACE_MIN} minutos depois do horário, a chamada é encerrada e o valor <b>não é devolvido</b>.</li>
      <li>Se o profissional não puder atender, ele avisa até ${r.PRO_CANCEL_H} horas antes e <b>você escolhe</b>: reembolso ou remarcar.</li>
      <li>Se o profissional <b>não entrar na chamada</b> até ${r.PRO_GRACE_MIN} minutos depois do horário, você recebe <b>100% de volta</b>.</li>
      <li>O dinheiro vai direto para a conta do profissional. A Acolia não recebe nem cobra taxa sobre a consulta.</li>
      <li><b>Consulta presencial:</b> é no consultório do profissional (o endereço e o mapa vão na conversa). As regras de pagamento, remarcar e cancelar são as mesmas; não há chamada de vídeo.</li>
    </ul><a href="/politica-agendamento" target="_blank" rel="noopener" class="small">Ler a política completa</a>`;
  }

  // Cartão de escolha (online/presencial, Pix/convênio): ícone, nome em cima e o valor embaixo
  const optCard = ({ attr, on, icon, title, sub, off = false }) => `<button type="button" class="opt ${on && !off ? 'on' : ''} ${off ? 'off' : ''}" ${off ? 'disabled aria-disabled="true"' : attr} role="radio" aria-checked="${on && !off}">
      <span class="opt-ic">${ic(icon, 22)}</span><span class="opt-txt"><b>${esc(title)}</b><small>${esc(sub)}</small></span>
      <span class="opt-check">${ic('check', 14)}</span></button>`;

  // ---------- Página cheia (calendário, pagamento) com Voltar ----------
  function fullPage(title) {
    const el = document.createElement('div');
    el.className = 'bio-page agenda-page';
    el.setAttribute('role', 'dialog');
    el.innerHTML = `<div class="bio-head"><button type="button" class="icon-btn" data-ag-back aria-label="Voltar">${ICONS.back}</button><b data-ag-title>${esc(title)}</b></div>
      <div class="bio-body" data-ag-body></div>`;
    document.body.appendChild(el);
    document.documentElement.classList.add('no-scroll');
    const listeners = [];
    const close = () => {
      if (!el.isConnected) return;
      el.remove();
      document.documentElement.classList.remove('no-scroll');
      window.removeEventListener('popstate', onPop);
      listeners.forEach((f) => f());
    };
    const onPop = () => close();
    history.pushState({ agenda: 1 }, '');
    window.addEventListener('popstate', onPop);
    el.addEventListener('click', (e) => { if (e.target.closest('[data-ag-back]')) history.back(); });
    return {
      el, body: $('[data-ag-body]', el), setTitle: (t) => { $('[data-ag-title]', el).textContent = t; },
      // Fecha e só depois continua (o "voltar" do navegador é assíncrono)
      close: () => new Promise((done) => {
        if (!el.isConnected) return done();
        listeners.push(() => setTimeout(done, 30));
        if (history.state?.agenda) history.back(); else close();
      }),
      onClose: (f) => listeners.push(f),
    };
  }

  // ---------- Marcar / remarcar / propor ----------
  // opts: { mode: 'book'|'reschedule'|'propose', pro, appt, conversationId, patientId, peerName, me, reschedulePro }
  async function openBooking(opts) {
    const mode = opts.mode || 'book';
    const proId = mode === 'propose' ? opts.me.id : mode === 'reschedule' ? opts.appt.professional.id : opts.pro.id;
    const proName = mode === 'propose' ? opts.me.name : mode === 'reschedule' ? opts.appt.professional.name : opts.pro.name;
    const page = fullPage(mode === 'reschedule' ? 'Remarcar consulta' : mode === 'propose' ? 'Agendar consulta' : 'Agendar consulta');
    const extra = new URLSearchParams();
    if (mode === 'propose') extra.set('patient_id', opts.patientId);
    if (mode === 'reschedule') extra.set('exclude', opts.appt.id);
    let ym = null;
    let sel = null; // { start, label, date, dayLabel }
    let info = null;
    let rules = null;
    // Versão 1.2.1: online ou presencial (se o profissional atende no consultório) e, quando o
    // profissional marca pelo chat, Pix ou convênio (plano de saúde, sem cobrança pela Acolia)
    let modality = opts.appt?.modality || 'online';
    let billing = 'pix';
    let placeChecked = false;
    // Valor conforme a modalidade (a presencial pode custar diferente)
    const priceOf = (m) => (m === 'presencial' && info?.price_presencial_cents != null ? info.price_presencial_cents : info?.price_cents);
    const priceNow = () => priceOf(modality);
    // Opção indisponível: sem agenda ou (ao remarcar trocando o tipo) com valor diferente do já pago
    const modOff = (m) => {
      if (m === 'online' ? info.online === false : !info.presencial_open) return mode === 'reschedule' && m === opts.appt.modality ? '' : 'Sem agenda';
      if (mode === 'reschedule' && m !== opts.appt.modality && opts.appt.billing !== 'convenio' && priceOf(m) !== opts.appt.price_cents) return 'Valor diferente';
      return '';
    };

    async function loadMonth() {
      page.body.innerHTML = '<div class="spinner"></div>';
      try {
        info = await api(`/api/agenda/pro/${proId}/month?${ym ? `ym=${ym}&` : ''}${extra}`);
      } catch (e) { page.body.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
      ym = info.ym;
      // As duas opções aparecem (a presencial só para quem tem endereço); a que está desligada fica
      // apagada com "Sem agenda". Começa na que estiver aberta.
      if (mode !== 'reschedule') {
        if (info.online === false && info.presencial_open) modality = 'presencial';
        if (!info.presencial_open) modality = 'online';
      }
      renderMonth();
    }

    function renderMonth() {
      const [y, m] = ym.split('-').map(Number);
      const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
      const minYm = info.today.slice(0, 7);
      const maxYm = info.max_date.slice(0, 7);
      const pt = info.patient;
      const head = mode === 'propose' ? `<div class="card flat pat-data"><div class="small muted" style="font-weight:700">PACIENTE</div><b>${esc(pt?.name || opts.peerName || 'Paciente')}</b>
            ${pt ? `<div class="small muted">CPF ${esc(pt.cpf)}${pt.birth_date ? ` · nascimento ${esc(pt.birth_date)}` : ''}${pt.place ? ` · ${esc(pt.place)}` : ''}</div>` : ''}</div>`
        : mode === 'reschedule' ? `<p class="muted" style="margin-top:0">Consulta atual: <b>${esc(opts.appt.when)}</b> (${opts.appt.modality === 'presencial' ? 'presencial' : 'online'}). Escolha o novo dia e horário${info.presencial ? ' e, se quiser, troque entre online e presencial' : ''}.${opts.appt.status === 'confirmada' ? ' <b>Você só pode remarcar uma vez.</b>' : ''}</p>`
          : `<div class="row" style="gap:12px;margin-bottom:12px">${avatar(proName, opts.pro.photo, 'md')}<div><b>${esc(proName)}</b><div class="muted small">${esc(opts.pro.profession || '')}</div></div></div>`;
      const loc = info.presencial;
      const off = { online: modOff('online'), presencial: modOff('presencial') };
      const choices = `
        ${loc ? `<div class="opt-label">Tipo de consulta</div>
          <div class="opt-grid" role="radiogroup" aria-label="Tipo de consulta">
            ${optCard({ attr: 'data-mod="online"', on: modality === 'online', off: !!off.online, icon: 'video', title: 'Online', sub: off.online || (info.price_cents != null ? money(info.price_cents) : 'Videochamada') })}
            ${optCard({ attr: 'data-mod="presencial"', on: modality === 'presencial', off: !!off.presencial, icon: 'home', title: 'Presencial', sub: off.presencial || (priceOf('presencial') != null ? money(priceOf('presencial')) : 'No consultório') })}
          </div>
          ${mode === 'reschedule' && (off.online === 'Valor diferente' || off.presencial === 'Valor diferente') ? '<p class="small muted opt-note">A outra opção tem outro valor. Para trocar para ela, cancele esta consulta e marque de novo.</p>' : ''}
          ${modality === 'presencial' && info.presencial_open ? `<div class="opt-place">${ic('pin', 18)}<span>${loc.name ? `<b>${esc(loc.name)}</b> · ` : ''}${esc(loc.address)}<br><span class="muted">${esc(loc.place)}</span></span></div>` : ''}` : ''}
        ${mode === 'propose' && info.insurance ? `<div class="opt-label">Pagamento</div>
          <div class="opt-grid" role="radiogroup" aria-label="Pagamento">
            ${optCard({ attr: 'data-bill="pix"', on: billing === 'pix', icon: 'pix', title: 'Pix', sub: 'O paciente paga aqui' })}
            ${optCard({ attr: 'data-bill="convenio"', on: billing === 'convenio', icon: 'shield', title: 'Convênio', sub: 'Plano de saúde' })}
          </div>
          ${billing === 'convenio' ? '<p class="small muted opt-note">Pelo convênio nada é cobrado pela Acolia: a consulta já fica agendada e o paciente acerta com o plano de saúde.</p>' : ''}` : ''}
        ${mode === 'book' && info.insurance ? `<div class="ins-card"><span class="ins-ic">${ic('shield', 20)}</span>
            <div><b>Vai usar plano de saúde?</b><p class="small">Não marque por aqui: converse antes com ${esc(proName.split(' ')[0])} pelo chat. Se o seu plano for aceito, ele(a) marca a consulta pelo convênio para você.</p>
            <button type="button" class="btn sm secondary" data-ins-chat>${ic('chat', 16)} Mandar mensagem</button></div></div>` : ''}`;
      // Agenda fechada (online e presencial desligados): as opções aparecem apagadas e o aviso
      if (!(mode === 'propose' ? info.agenda_ok : info.ready)) {
        page.body.innerHTML = `${head}${choices}<div class="empty-agenda">${ic('calendar', 28)}<b>Sem agenda disponível</b><p class="muted">${mode === 'propose' ? 'Abra a sua agenda primeiro: em <b>Consultas → Minha agenda</b>, ligue o atendimento online ou presencial e cadastre os horários (e confira o valor e a forma de receber).' : 'Este profissional não está com a agenda aberta no momento. Mande uma mensagem para combinar.'}</p>${mode === 'book' ? `<button type="button" class="btn secondary sm" data-ins-chat>${ic('chat', 16)} Mandar mensagem</button>` : ''}</div>`;
        $$('[data-ins-chat]', page.body).forEach((b) => b.addEventListener('click', async () => {
          try { const c = await api('/api/chat/conversations', { method: 'POST', body: { professional_id: proId } }); await page.close(); goChat(c.id); } catch (ex) { toast(ex.message, 'error'); }
        }));
        return;
      }
      page.body.innerHTML = `${head}${choices}
        <div class="cal">
          <div class="cal-head"><button type="button" class="icon-btn" data-prev aria-label="Mês anterior" ${ym <= minYm ? 'disabled' : ''}>‹</button>
            <b>${MONTHS[m - 1][0].toUpperCase() + MONTHS[m - 1].slice(1)} ${y}</b>
            <button type="button" class="icon-btn" data-next aria-label="Próximo mês" ${ym >= maxYm ? 'disabled' : ''}>›</button></div>
          <div class="cal-grid">${WD.map((d) => `<span class="cal-wd">${d}</span>`).join('')}${'<span></span>'.repeat(firstDow)}${info.days.map((d) => {
            const n = Number(d.date.slice(8));
            const on = d.free > 0;
            // Dia em que o paciente já tem consulta (uma por dia): marcado e, ao tocar, explica
            if (d.taken) return `<button type="button" class="cal-day taken ${sel?.date === d.date ? 'sel' : ''}" data-taken="${d.date}" aria-label="${n}, já tem consulta neste dia">${n}</button>`;
            return `<button type="button" class="cal-day ${on ? 'on' : ''} ${d.date === info.today ? 'today' : ''} ${sel?.date === d.date ? 'sel' : ''}" data-day="${d.date}" ${on ? '' : 'disabled'} aria-label="${n}${on ? `, ${d.free} horário(s) livre(s)` : ', sem horário'}">${n}</button>`;
          }).join('')}</div>
          <p class="small muted cal-legend"><span class="cal-dot"></span> dias com horário livre · ${info.minutes} min por consulta · ${billing === 'convenio' ? 'convênio' : priceNow() != null ? money(priceNow()) : ''}</p>
          ${info.days.some((d) => d.taken) ? `<p class="small cal-taken-note"><span class="cal-dot taken"></span> ${mode === 'propose' ? 'Este paciente já tem consulta neste dia' : 'Você já tem consulta neste dia'}: cada paciente marca <b>uma consulta por dia</b>.</p>` : ''}
        </div>
        <div data-slots></div>
        <div class="ag-foot" data-foot></div>`;
      $$('[data-mod]', page.body).forEach((b) => b.addEventListener('click', () => { modality = b.dataset.mod; placeChecked = false; renderMonth(); }));
      $$('[data-bill]', page.body).forEach((b) => b.addEventListener('click', () => { billing = b.dataset.bill; renderMonth(); }));
      $('[data-ins-chat]', page.body)?.addEventListener('click', async () => {
        try {
          const c = await api('/api/chat/conversations', { method: 'POST', body: { professional_id: proId } });
          await page.close();
          goChat(c.id);
        } catch (ex) { toast(ex.message, 'error'); }
      });
      $('[data-prev]', page.body).addEventListener('click', () => { ym = shiftYm(ym, -1); sel = null; loadMonth(); });
      $('[data-next]', page.body).addEventListener('click', () => { ym = shiftYm(ym, 1); sel = null; loadMonth(); });
      $$('[data-day]', page.body).forEach((b) => b.addEventListener('click', () => pickDay(b.dataset.day)));
      $$('[data-taken]', page.body).forEach((b) => b.addEventListener('click', () => {
        const d = info.days.find((x) => x.date === b.dataset.taken);
        sel = null;
        $$('[data-day], [data-taken]', page.body).forEach((x) => x.classList.toggle('sel', x === b));
        $('[data-slots]', page.body).innerHTML = `<div class="notice warn small">${mode === 'propose' ? 'Este paciente já tem' : 'Você já tem'} uma consulta marcada para <b>${esc(d.taken.when)}</b>${d.taken.with ? ` com ${esc(d.taken.with)}` : ''}. Cada paciente marca uma consulta por dia: ${mode === 'propose' ? 'escolha outro dia' : 'marque para outro dia'}.</div>`;
        renderFoot();
      }));
      if (!info.days.some((d) => d.free > 0)) $('[data-slots]', page.body).innerHTML = '<p class="muted center">Nenhum horário livre neste mês. Toque em › para ver o próximo.</p>';
      if (sel) pickDay(sel.date, true);
      renderFoot();
    }

    async function pickDay(date, keep) {
      $$('[data-day]', page.body).forEach((b) => b.classList.toggle('sel', b.dataset.day === date));
      const box = $('[data-slots]', page.body);
      box.innerHTML = '<div class="spinner"></div>';
      let d;
      try { d = await api(`/api/agenda/pro/${proId}/day?date=${date}&${extra}`); } catch (e) { box.innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }
      if (!keep || sel?.date !== date) sel = sel?.date === date ? sel : { date, dayLabel: d.label };
      box.innerHTML = `<h3 class="slots-title">${esc(d.label)}</h3>${d.slots.length ? `<div class="slots">${d.slots.map((s) => `<button type="button" class="slot ${sel?.start === s.start ? 'sel' : ''}" data-slot="${s.start}" data-label="${s.label}">${s.label}</button>`).join('')}</div>`
        : '<p class="muted">Os horários deste dia já foram ocupados. Escolha outro dia.</p>'}`;
      $$('[data-slot]', box).forEach((b) => b.addEventListener('click', () => {
        sel = { date, dayLabel: d.label, start: b.dataset.slot, label: b.dataset.label };
        $$('[data-slot]', box).forEach((x) => x.classList.toggle('sel', x === b));
        renderFoot();
      }));
      renderFoot();
      box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    function renderFoot() {
      const foot = $('[data-foot]', page.body);
      if (!foot) return;
      foot.innerHTML = sel?.start
        ? `<div class="ag-sum"><b>${esc(sel.dayLabel)} às ${esc(sel.label)}</b><span class="muted small">${info.minutes} min · ${billing === 'convenio' ? 'convênio' : priceNow() != null ? money(priceNow()) : ''} · ${modality}</span></div>
           <button type="button" class="btn" data-go>Avançar</button>`
        : '<span class="muted small">Escolha um dia e um horário.</span>';
      $('[data-go]', foot)?.addEventListener('click', confirmStep);
    }

    async function confirmStep() {
      if (!rules) { try { rules = (await api('/api/agenda/appointments')).rules; } catch { /* usa o padrão */ } }
      page.setTitle(mode === 'reschedule' ? 'Confirmar remarcação' : 'Confirmar consulta');
      const when = `${sel.dayLabel} às ${sel.label}`;
      const loc = modality === 'presencial' ? (info.presencial || opts.appt?.location) : null;
      page.body.innerHTML = `<div class="card stack">
          <div class="row" style="gap:12px">${ic(modality === 'presencial' ? 'home' : 'video', 26)}<div><b style="font-size:1.1rem">${esc(when)}</b><div class="muted small">${esc(proName)} · ${info.minutes} min · consulta ${modality === 'presencial' ? 'presencial' : 'online'}</div></div></div>
          ${loc ? `<div class="opt-place">${ic('pin', 18)}<span>${loc.name ? `<b>${esc(loc.name)}</b> · ` : ''}${esc(loc.address)}<br><span class="muted">${esc(loc.place)}</span></span></div>` : ''}
          ${mode === 'reschedule' ? `<p class="small" style="margin:0">${modality !== opts.appt.modality ? `<b>A consulta passa a ser ${modality}.</b> ` : ''}${opts.appt.billing === 'convenio' ? 'A consulta continua pelo convênio.' : 'O valor que você já pagou continua valendo para o novo horário.'}</p>`
            : billing === 'convenio' ? '<div class="row between"><span>Pagamento</span><b>Convênio (plano de saúde)</b></div>' : `<div class="row between"><span>Valor da consulta ${modality}</span><b>${money(priceNow())}</b></div>`}
        </div>
        ${mode === 'book' ? `<h3 style="margin:18px 0 6px">Política de agendamento</h3>${policyHtml(rules)}
        <label class="check" style="margin:14px 0"><input type="checkbox" data-accept> Li e aceito a política de agendamento e cancelamento</label>` : ''}
        ${mode === 'propose' && billing === 'convenio' ? `<p class="notice info small" style="margin-top:14px">A consulta já fica <b>agendada</b> (sem Pix). O paciente recebe na conversa <b>"${modality === 'presencial' ? 'Consulta presencial agendada' : 'Consulta agendada'}"</b>${modality === 'presencial' ? ' e, logo depois, a localização do consultório com o mapa' : ''}.</p>` : ''}
        ${mode === 'propose' && billing !== 'convenio' ? `<p class="notice info small" style="margin-top:14px">O paciente recebe na conversa <b>"Sua consulta está quase pronta"</b>, aceita a política de agendamento e tem ${rules?.PAY_MIN || 10} minutos para pagar. ${info.mode === 'auto' ? 'Ele toca em "Pagar agora" e paga o Pix da sua conta Asaas: quando cair, a consulta é confirmada sozinha.' : 'Ele toca em "Copiar Pix" (sua chave e o valor já vão juntos). Quando o dinheiro cair, toque em <b>Sim</b> em "O paciente fez o pagamento?", em cima do campo de mensagem.'}</p>` : ''}
        <div class="form-error hidden" data-err></div>
        <div class="row" style="gap:10px;margin-top:10px"><button type="button" class="btn secondary" data-back2>Voltar</button>
          <button type="button" class="btn grow" data-ok ${mode === 'book' ? 'disabled' : ''}>${mode === 'reschedule' ? 'Remarcar' : mode === 'propose' ? (billing === 'convenio' ? 'Agendar pelo convênio' : 'Enviar para o paciente') : `Ir para o pagamento (${info.mode === 'auto' ? 'Pix' : 'Pix pelo chat'})`}</button></div>`;
      $('[data-accept]', page.body)?.addEventListener('change', (e) => { $('[data-ok]', page.body).disabled = !e.target.checked; });
      $('[data-back2]', page.body).addEventListener('click', () => { page.setTitle(mode === 'reschedule' ? 'Remarcar consulta' : 'Agendar consulta'); renderMonth(); });
      $('[data-ok]', page.body).addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const err = $('[data-err]', page.body);
        btn.disabled = true;
        err.classList.add('hidden');
        try {
          // Presencial: confirma que a pessoa consegue ir até a cidade do consultório (o município do
          // cadastro pode estar desatualizado). "Não" → a consulta vira online.
          if (modality === 'presencial' && !placeChecked && (mode === 'book' || (mode === 'reschedule' && opts.appt.modality !== 'presencial'))) {
            const loc2 = info.presencial;
            const v = await modal({
              title: 'Consulta presencial',
              html: `<p>A consulta presencial é no consultório em <b>${esc(loc2.place)}</b>:</p><div class="opt-place">${ic('pin', 18)}<span>${loc2.name ? `<b>${esc(loc2.name)}</b> · ` : ''}${esc(loc2.address)}</span></div>
                <p style="margin-bottom:0"><b>Você consegue ir até ${esc(loc2.place)} no dia da consulta?</b></p>`,
              actions: [{ label: mode === 'reschedule' ? 'Não, manter online' : 'Não, marcar online', value: 'online', class: 'secondary' }, { label: mode === 'reschedule' ? 'Sim, trocar para presencial' : 'Sim, marcar presencial', value: 'presencial' }],
            });
            if (!v) { btn.disabled = false; return; }
            placeChecked = true;
            if (v === 'online') {
              modality = 'online';
              toast('Ok! A consulta vai ser online.', '', { top: true });
              await confirmStep();
              return;
            }
          }
          if (mode === 'reschedule') {
            const a = await api(`/api/agenda/appointments/${opts.appt.id}/reschedule`, { method: 'POST', body: { start: sel.start, modality, confirm_place: modality === 'presencial' } });
            toast('Consulta remarcada ✓', '', { top: true });
            page.close();
            opts.onDone?.(a);
            return;
          }
          if (mode === 'propose') {
            const a = await api('/api/agenda/propose', { method: 'POST', body: { conversation_id: opts.conversationId, start: sel.start, modality, billing } });
            toast(billing === 'convenio' ? 'Consulta agendada pelo convênio ✓' : 'Proposta enviada ao paciente ✓', '', { top: true });
            page.close();
            opts.onDone?.(a);
            return;
          }
          const a = await api('/api/agenda/book', { method: 'POST', body: { professional_id: proId, start: sel.start, accept: true, modality, confirm_place: modality === 'presencial' } });
          if (a.mode === 'auto') payScreen(page, a);
          else manualSent(page, a);
        } catch (ex) {
          err.textContent = ex.message;
          err.classList.remove('hidden');
          btn.disabled = false;
          if (/não está mais disponível|já tem outra/.test(ex.message)) { sel = null; }
        }
      });
    }

    loadMonth();
  }
  const shiftYm = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };

  // Pedido manual: o profissional manda a chave Pix no chat
  function manualSent(page, a) {
    page.setTitle('Pedido enviado');
    page.body.innerHTML = `<div class="card stack center">
        <div class="big-ic">${ic('send', 30)}</div>
        <h2 style="margin:0">Pedido enviado ao profissional</h2>
        <p>${esc(a.when)}</p>
        <p class="muted">O profissional tem <b>5 minutos</b> para mandar a chave Pix na conversa. Depois que ela chegar, você tem <b>10 minutos</b> para pagar. O horário fica guardado para você enquanto isso.</p>
        <button type="button" class="btn" data-chat>Ir para a conversa</button></div>`;
    $('[data-chat]', page.body).addEventListener('click', async () => { await page.close(); goChat(a.conversation_id); });
    setTimeout(async () => { if (page.el.isConnected) { await page.close(); goChat(a.conversation_id); } }, 2500);
  }

  function goChat(id) {
    if (ctx.onGoChat) ctx.onGoChat(id);
    else location.href = ctx.role === 'professional' ? `/painel#conversas/${id}` : `/app#chat/${id}`;
  }

  // Tela do Pix (automático): QR Code + copia e cola, 10 minutos, confirma sozinho e vai para a conversa
  function payScreen(page, a) {
    if (!page) page = fullPage('Pagamento');
    page.setTitle('Pagamento por Pix');
    syncClock(a.now);
    const end = Date.parse(a.hold_until);
    page.body.innerHTML = `<div class="card stack center pix-card">
        <div class="muted small">${esc(a.professional.name)} · ${esc(a.when)}</div>
        <div class="pix-value">${money(a.price_cents)}</div>
        ${a.pix_image ? `<img class="pix-qr" src="data:image/png;base64,${esc(a.pix_image)}" alt="QR Code do Pix">` : ''}
        <button type="button" class="btn block" data-copy-pix>${ic('copy', 18)} Copiar código Pix</button>
        <p class="small muted" style="margin:0">Abra o app do seu banco, escolha <b>Pix → Pix copia e cola</b> (ou leia o QR Code) e pague. Depois volte aqui: a confirmação é automática.</p>
        <div class="pix-timer" data-timer></div>
        <div class="pix-wait" data-wait><span class="spinner sm"></span> Aguardando o pagamento…</div>
        ${a.simulated ? '<button type="button" class="btn secondary block" data-simulate>🧪 Simular pagamento (conta de teste)</button>' : ''}
        <button type="button" class="link-btn small" data-giveup>Desistir desta consulta</button>
      </div>`;
    $('[data-copy-pix]', page.body).addEventListener('click', () => { copyText(a.pix_payload); toast('Código Pix copiado ✓', '', { top: true }); });
    $('[data-simulate]', page.body)?.addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try { await api(`/api/agenda/appointments/${a.id}/simulate-pay`, { method: 'POST' }); check(); } catch (ex) { toast(ex.message, 'error'); }
    });
    $('[data-giveup]', page.body).addEventListener('click', async () => {
      if (!await confirmDialog('Desistir desta consulta? O horário fica livre para outra pessoa.', { okLabel: 'Desistir', danger: true })) return;
      try { await api(`/api/agenda/appointments/${a.id}/cancel`, { method: 'POST', body: {} }); page.close(); toast('Você desistiu da consulta.'); } catch (e) { toast(e.message, 'error'); }
    });
    let timer = null;
    let poll = null;
    const stop = () => { clearInterval(timer); clearInterval(poll); };
    page.onClose(stop);
    const tick = () => {
      const left = end - now();
      const t = $('[data-timer]', page.body);
      if (t) t.textContent = left > 0 ? `Tempo para pagar: ${mmss(left)}` : 'O tempo para pagar acabou';
    };
    tick();
    timer = setInterval(tick, 1000);
    const check = async () => {
      let cur;
      try { cur = await api(`/api/agenda/appointments/${a.id}`); } catch { return; }
      if (cur.status === 'confirmada') {
        stop();
        page.setTitle('Consulta marcada');
        page.body.innerHTML = `<div class="card stack center"><div class="big-ic ok">${ic('check', 32)}</div><h2 style="margin:0">Pagamento aprovado!</h2>
          <p><b>Consulta marcada</b> para ${esc(cur.when)}.</p><p class="muted small">Levando você para a conversa com ${esc(cur.professional.name)}…</p></div>`;
        refreshAll();
        setTimeout(async () => { await page.close(); goChat(cur.conversation_id); }, 1800);
      } else if (!['aguardando_pagamento'].includes(cur.status)) {
        stop();
        page.body.innerHTML = `<div class="card stack center"><div class="big-ic warn">${ic('clock', 30)}</div><h2 style="margin:0">${cur.status === 'expirada' ? 'O tempo para pagar acabou' : 'Esta cobrança não vale mais'}</h2>
          <p class="muted">O horário foi liberado. Se você já pagou, fale com o profissional pela conversa.</p><button type="button" class="btn" data-chat>Ir para a conversa</button></div>`;
        $('[data-chat]', page.body).addEventListener('click', async () => { await page.close(); goChat(cur.conversation_id); });
        refreshAll();
      }
    };
    poll = setInterval(check, 4000);
  }

  // Proposta do profissional: aceitar a política e pagar
  async function acceptAndPay(a) {
    let rules = null;
    try { rules = (await api('/api/agenda/appointments')).rules; } catch { /* padrão */ }
    const ok = await modal({
      title: 'Confirmar consulta',
      html: `<p><b>${esc(a.when)}</b> · ${money(a.price_cents)} · ${a.minutes} min</p>${policyHtml(rules)}
        <label class="check" style="margin-top:12px"><input type="checkbox" data-accept> Li e aceito a política de agendamento e cancelamento</label>`,
      actions: [{ label: 'Agora não', value: false, class: 'secondary' }, { label: 'Aceitar e pagar', handler: (dlg) => ($('[data-accept]', dlg).checked ? true : (toast('Marque "Li e aceito" para continuar.', 'error'), false)) }],
    });
    if (!ok) return;
    const cur = await api(`/api/agenda/appointments/${a.id}/accept`, { method: 'POST' });
    if (cur.mode === 'auto') payScreen(null, cur);
    else {
      await modal({ title: 'Pague pelo Pix', html: `<p>Chave Pix do profissional:</p><div class="code-box" style="font-size:1rem;word-break:break-all">${esc(cur.pix_payload || '')}</div><p class="muted small">Pague em até 10 minutos. O profissional confirma o pagamento aqui na conversa.</p>`, actions: [{ label: 'Copiar chave', class: 'secondary', handler: () => { copyText(cur.pix_payload); return false; } }, { label: 'Ok' }] });
    }
    refreshAll();
  }

  // Pix manual: copia a chave (e mostra o valor). Na primeira vez, o paciente aceita a política.
  async function copyPix(a) {
    if (a.can?.accept) {
      let rules = null;
      try { rules = (await api('/api/agenda/appointments')).rules; } catch { /* padrão */ }
      const ok = await modal({
        title: 'Confirmar consulta',
        html: `<p><b>${esc(a.when)}</b> · ${money(a.price_cents)} · ${a.minutes} min</p>${policyHtml(rules)}
          <label class="check" style="margin-top:12px"><input type="checkbox" data-accept> Li e aceito a política de agendamento e cancelamento</label>`,
        actions: [{ label: 'Agora não', value: false, class: 'secondary' }, { label: 'Aceitar e copiar o Pix', handler: (dlg) => ($('[data-accept]', dlg).checked ? true : (toast('Marque "Li e aceito" para continuar.', 'error'), false)) }],
      });
      if (!ok) return;
      a = await api(`/api/agenda/appointments/${a.id}/accept`, { method: 'POST' });
    }
    copyText(a.pix_payload);
    await modal({
      title: 'Chave Pix copiada ✓',
      html: `<div class="pix-manual-box"><span class="small muted">Valor</span><b class="pix-value">${money(a.price_cents)}</b>
          <span class="small muted">Chave Pix do profissional</span><div class="code-box" style="font-size:1rem;word-break:break-all">${esc(a.pix_payload || '')}</div></div>
        <p class="small muted">Abra o app do seu banco, escolha <b>Pix → Pagar com chave</b>, cole a chave e pague <b>${money(a.price_cents)}</b> em até 10 minutos. O profissional confirma aqui na conversa quando o dinheiro cair.</p>
        <div class="notice small proof-tip">${ic('camera', 16)} <b>Depois de pagar, tire um print do comprovante</b> e mande aqui na conversa pela foto (botão da câmera ao lado de "Digite uma mensagem").</div>`,
      actions: [{ label: 'Copiar de novo', class: 'secondary', handler: () => { copyText(a.pix_payload); return false; } }, { label: 'Ok' }],
    });
    refreshAll();
  }

  // ---------- Ações (do "Ver" e dos cartões do chat) ----------
  async function cancelDialog(a) {
    const { reasons, rules } = await api('/api/agenda/appointments');
    const byPro = a.status === 'aguardando_paciente';
    const conv = a.billing === 'convenio';
    const how = conv ? 'Consulta pelo convênio: nada foi cobrado aqui, é só cancelar.' : a.mode === 'auto' ? 'O valor volta automaticamente para o seu Pix.' : 'O profissional devolve o valor pelo Pix e manda o comprovante aqui na conversa.';
    const res = await modal({
      title: byPro ? (conv ? 'Cancelar consulta' : 'Quero o reembolso') : 'Cancelar consulta',
      html: `<p><b>${esc(a.when)}</b> com ${esc(a.professional.name)}</p>
        ${byPro ? '' : `<p class="small muted">Dá para cancelar até ${rules.CUTOFF_MIN} minutos antes. Por que você vai cancelar?</p>
        <div class="stack" style="gap:6px">${Object.entries(reasons).map(([k, v]) => `<label class="check"><input type="radio" name="motivo" value="${k}"> ${esc(v)}</label>`).join('')}</div>
        <textarea data-detail rows="2" maxlength="500" placeholder="Conte o motivo (obrigatório em &quot;Outros motivos&quot;)" style="margin-top:8px"></textarea>`}
        <p class="notice info small" style="margin-top:10px">${how}</p>`,
      actions: [{ label: 'Voltar', value: null, class: 'secondary' }, {
        label: conv ? 'Cancelar consulta' : byPro ? 'Quero o reembolso' : 'Cancelar e pedir reembolso', class: 'danger',
        handler: (dlg) => {
          if (byPro) return {};
          const r = $('input[name=motivo]:checked', dlg)?.value;
          const detail = $('[data-detail]', dlg).value.trim();
          if (!r) { toast('Escolha o motivo.', 'error'); return false; }
          if (r === 'outros' && detail.length < 3) { toast('Conte rapidinho o motivo.', 'error'); return false; }
          return { reason: r, detail };
        },
      }],
    });
    if (!res) return;
    await api(`/api/agenda/appointments/${a.id}/cancel`, { method: 'POST', body: res });
    toast(conv ? 'Consulta cancelada.' : a.mode === 'auto' ? 'Consulta cancelada. O reembolso foi pedido ao Pix ✓' : 'Consulta cancelada. Pedido de reembolso enviado ao profissional.', '', { top: true });
  }

  // Trocar o tipo (online ↔ presencial) no mesmo dia e horário — só o paciente
  async function switchType(a) {
    const to = a.modality === 'presencial' ? 'online' : 'presencial';
    const loc = a.switch_location;
    const ok = await modal({
      title: to === 'presencial' ? 'Trocar para presencial' : 'Trocar para online',
      html: to === 'presencial'
        ? `<p>A consulta de <b>${esc(a.when)}</b> passa a ser <b>no consultório</b>, no mesmo dia e horário.</p>
           ${loc ? `<div class="opt-place">${ic('pin', 18)}<span>${loc.name ? `<b>${esc(loc.name)}</b> · ` : ''}${esc(loc.address)}<br><span class="muted">${esc(loc.place)}</span></span></div>
           <p style="margin-bottom:0"><b>Você consegue ir até ${esc(loc.place)} no dia da consulta?</b></p>` : ''}`
        : `<p>A consulta de <b>${esc(a.when)}</b> passa a ser <b>online, por videochamada</b>, no mesmo dia e horário.</p><p class="small muted" style="margin-bottom:0">O link da chamada aparece na conversa 5 minutos antes.</p>`,
      actions: [{ label: 'Voltar', value: false, class: 'secondary' }, { label: to === 'presencial' ? 'Sim, trocar para presencial' : 'Trocar para online', value: true }],
    });
    if (!ok) return;
    await api(`/api/agenda/appointments/${a.id}/modality`, { method: 'POST', body: { modality: to, confirm_place: to === 'presencial' } });
    toast(to === 'presencial' ? 'Pronto! A consulta agora é presencial.' : 'Pronto! A consulta agora é online.', '', { top: true });
  }

  async function act(a, action) {
    try {
      switch (action) {
        case 'pay': payScreen(null, a); return;
        case 'accept': await acceptAndPay(a); return;
        case 'reschedule': openBooking({ mode: 'reschedule', appt: a, onDone: refreshAll }); return;
        case 'switch_type': await switchType(a); break;
        case 'choose': {
          const v = await modal({
            title: 'O profissional não poderá atender', html: `<p>${esc(a.professional.name)} avisou que não poderá atender <b>${esc(a.when)}</b>${a.cancel_detail ? ` (“${esc(a.cancel_detail)}”)` : ''}. O que você prefere?</p>`,
            actions: [{ label: 'Remarcar', value: 'remarcar', class: 'secondary' }, { label: a.billing === 'convenio' ? 'Cancelar' : 'Quero o reembolso', value: 'reembolso' }],
          });
          if (v === 'remarcar') openBooking({ mode: 'reschedule', appt: a, onDone: refreshAll });
          if (v === 'reembolso') await cancelDialog(a);
          break;
        }
        case 'cancel': await cancelDialog(a); break;
        case 'give_up':
          if (!await confirmDialog('Cancelar este agendamento? Nada foi cobrado e o horário fica livre para outra pessoa.', { okLabel: 'Cancelar agendamento', danger: true, cancelLabel: 'Voltar' })) return;
          await api(`/api/agenda/appointments/${a.id}/cancel`, { method: 'POST', body: {} });
          toast('Agendamento cancelado.');
          break;
        case 'withdraw':
          if (!await confirmDialog(`Cancelar o agendamento de ${a.when} com ${a.patient.name}? Ele ainda não pagou e será avisado na conversa.`, { okLabel: 'Cancelar agendamento', danger: true, cancelLabel: 'Voltar' })) return;
          await api(`/api/agenda/appointments/${a.id}/withdraw`, { method: 'POST' });
          toast('Agendamento cancelado.');
          break;
        case 'copy_pix': await copyPix(a); return;
        case 'retry_yes': {
          const r = await api(`/api/agenda/appointments/${a.id}/retry`, { method: 'POST', body: { yes: true } });
          toast(r.status === 'aguardando_pagamento' ? 'Ok! Toque em "Copiar Pix" e pague de novo.' : 'Ok! O profissional vai mandar a chave Pix de novo.');
          break;
        }
        case 'retry_no': await api(`/api/agenda/appointments/${a.id}/retry`, { method: 'POST', body: { yes: false } }); break;
        case 'send_pix': await api(`/api/agenda/appointments/${a.id}/send-pix`, { method: 'POST' }); toast('Chave Pix enviada. O paciente tem 10 minutos para pagar.'); break;
        case 'approve':
          if (!await confirmDialog(`Confirma que o Pix de ${money(a.price_cents)} caiu na sua conta?`, { okLabel: 'Pagamento aprovado' })) return;
          await api(`/api/agenda/appointments/${a.id}/manual-result`, { method: 'POST', body: { approved: true } });
          toast('Consulta marcada ✓', '', { top: true });
          break;
        case 'reject':
          if (!await confirmDialog('O pagamento não chegou? O paciente vai poder tentar de novo.', { okLabel: 'Pagamento não aprovado', danger: true })) return;
          await api(`/api/agenda/appointments/${a.id}/manual-result`, { method: 'POST', body: { approved: false } });
          break;
        case 'pro_cancel': {
          const detail = await modal({
            title: 'Não vou poder atender',
            html: `<p><b>${esc(a.when)}</b> com ${esc(a.patient.name)}</p><p class="small muted">Você não remarca sozinho: o paciente escolhe entre o <b>reembolso</b> e <b>remarcar</b> para outro horário livre.</p>
              <textarea data-d rows="2" maxlength="500" placeholder="Explique rapidinho para o paciente (opcional)"></textarea>`,
            actions: [{ label: 'Voltar', value: null, class: 'secondary' }, { label: 'Avisar o paciente', class: 'danger', handler: (dlg) => ({ detail: $('[data-d]', dlg).value.trim() }) }],
          });
          if (!detail) return;
          await api(`/api/agenda/appointments/${a.id}/pro-cancel`, { method: 'POST', body: detail });
          toast('Aviso enviado. O paciente vai escolher entre reembolso e remarcar.');
          break;
        }
        case 'refund_done':
          if (!await confirmDialog(`Você já devolveu ${money(a.price_cents)} para o paciente pelo Pix? Depois de confirmar, mande a foto do comprovante aqui na conversa. Sem o comprovante, o paciente pode denunciar o reembolso ao Suporte Acolia.`, { okLabel: 'Sim, fiz o reembolso' })) return;
          await api(`/api/agenda/appointments/${a.id}/refund-done`, { method: 'POST' });
          toast('Pronto! Agora mande a foto do comprovante na conversa.');
          break;
        case 'see': openDetail(a); return;
        case 'presence_yes':
          await api(`/api/agenda/appointments/${a.id}/presencial-result`, { method: 'POST', body: { done: true } });
          toast('Consulta registrada ✓ O paciente entrou em Meus pacientes.', '', { top: true });
          break;
        case 'presence_no':
          if (!await confirmDialog(`A consulta presencial com ${a.patient.name} (${a.when}) não aconteceu? Ela sai da lista e não entra em Meus pacientes.`, { okLabel: 'Não aconteceu', cancelLabel: 'Voltar' })) return;
          await api(`/api/agenda/appointments/${a.id}/presencial-result`, { method: 'POST', body: { done: false } });
          toast('Pronto. A consulta saiu da lista.');
          break;
        case 'enter': window.open(`/atendimento?codigo=${encodeURIComponent(a.call_code)}`, '_blank', 'noopener'); return;
        case 'chat': goChat(a.conversation_id); return;
        default: return;
      }
      refreshAll();
    } catch (e) { toast(e.message, 'error'); }
  }

  // Botões possíveis agora (os mesmos no "Ver" e no cartão do chat)
  function buttons(a, role) {
    const c = a.can || {};
    const b = (action, label, cls = 'secondary') => `<button type="button" class="btn sm ${cls}" data-ag-act="${action}" data-ag-id="${a.id}">${label}</button>`;
    const out = [];
    if (c.enter_call) out.push(b('enter', `${ic('video', 16)} Entrar na chamada`, ''));
    if (role === 'patient') {
      if (c.copy_pix) out.push(b('copy_pix', `${ic('pix', 16)} Copiar Pix · ${money(a.price_cents)}`, ''));
      else if (c.accept) out.push(b('accept', `${ic('pix', 16)} Pagar agora`, ''));
      else if (c.pay) out.push(b('pay', `${ic('pix', 16)} Pagar agora`, ''));
      if (c.choose) out.push(b('choose', a.billing === 'convenio' ? 'Escolher: cancelar ou remarcar' : 'Escolher: reembolso ou remarcar', ''));
      if (c.retry) { out.push(b('retry_yes', 'Sim, quero tentar de novo', '')); out.push(b('retry_no', 'Não')); }
      if (c.reschedule) out.push(b('reschedule', 'Remarcar'));
      if (c.switch_type) out.push(b('switch_type', a.modality === 'presencial' ? `${ic('video', 16)} Trocar para online` : `${ic('home', 16)} Trocar para presencial`));
      if (c.cancel) out.push(b('cancel', 'Cancelar consulta', 'ghost danger-text'));
      if (c.give_up && !c.retry) out.push(b('give_up', 'Cancelar agendamento', 'ghost tiny-link'));
    } else {
      if (c.send_pix) out.push(b('send_pix', `${ic('pix', 16)} Enviar chave Pix`, ''));
      if (c.approve) { out.push(b('approve', 'Pagamento aprovado', '')); out.push(b('reject', 'Pagamento não aprovado', 'ghost danger-text')); }
      if (c.refund_done) out.push(b('refund_done', 'Fiz o reembolso', ''));
      if (c.pro_cancel) out.push(b('pro_cancel', 'Não vou poder atender', 'ghost danger-text'));
      if (c.withdraw) out.push(b('withdraw', 'Cancelar agendamento', 'ghost tiny-link'));
      if (c.presence_check) { out.push(b('presence_yes', `${ic('check', 16)} Sim, aconteceu`, '')); out.push(b('presence_no', 'Não aconteceu')); }
    }
    return out.join('');
  }

  // Liga os botões [data-ag-act] de um pedaço da tela
  function bindActions(root, getAppt) {
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-ag-act]');
      if (!btn) return;
      e.preventDefault();
      const a = getAppt(Number(btn.dataset.agId));
      if (a) act(a, btn.dataset.agAct);
    });
  }

  // ---------- Cartão da consulta no chat ----------
  const EVENT = {
    pedido: ['📅 Pedido de consulta', (a, r) => (r === 'professional' ? 'O paciente quer marcar esta consulta e fazer o pagamento. Mande a sua chave Pix em até 5 minutos.' : 'Pedido enviado. O profissional manda a chave Pix aqui em até 5 minutos.')],
    proposta: ['📅 Consulta quase pronta: falta o pagamento', (a, r) => (r === 'patient'
      ? (a.mode === 'auto' ? `Sua consulta de ${a.when} está quase pronta! Toque em "Pagar agora" e pague o Pix em até 10 minutos para confirmar.`
        : `Sua consulta de ${a.when} está quase pronta! Toque em "Copiar Pix", pague ${money(a.price_cents)} no app do seu banco em até 10 minutos e o profissional confirma aqui.`)
      : (a.mode === 'auto' ? 'Enviada ao paciente. Ele tem 10 minutos para pagar o Pix; a confirmação é automática.' : 'Enviada ao paciente com a sua chave Pix e o valor. Ele tem 10 minutos para pagar; confirme em cima do campo de mensagem quando o Pix cair.'))],
    agendada: ['✅ Consulta agendada', () => 'Pagamento aprovado. O link da chamada aparece aqui 5 minutos antes.'],
    remarcada: ['🔁 Consulta remarcada', (a, r, m) => {
      const [was, prevMod] = String(m.extra || '').split(';');
      return `${was ? `Novo horário (antes era ${fmtIso(was)}).` : 'Novo horário.'}${prevMod ? ` Agora a consulta é ${prevMod === 'online' ? 'presencial' : 'online'}.` : ''}`;
    }],
    tipo_trocado: ['🔁 Tipo da consulta trocado', (a, r, m) => {
      const to = m.extra === 'online' ? 'presencial' : 'online';
      return `${r === 'patient' ? 'Você trocou' : 'O paciente trocou'} a consulta para ${to}, no mesmo dia e horário. ${to === 'presencial' ? (r === 'patient' ? 'O endereço e o mapa estão logo abaixo e em "Ver".' : 'Ele recebeu o endereço e o mapa do consultório.') : 'O link da chamada aparece aqui 5 minutos antes.'}`;
    }],
    cancelada: ['Consulta cancelada', (a, r, m) => (m?.extra === 'pro_antes_pagar' ? (r === 'patient' ? 'O profissional cancelou este agendamento antes do pagamento. Nada foi cobrado.' : 'Agendamento cancelado antes do pagamento. O horário foi liberado.') : 'O horário foi liberado.')],
    reembolso_pedido: ['↩️ Pedido de reembolso', (a, r, m) => `${a.cancel_reason_label ? `Motivo: ${a.cancel_reason_label}${a.cancel_detail && a.cancel_reason === 'outros' ? ` — “${a.cancel_detail}”` : ''}. ` : ''}${a.mode === 'auto' && m.extra !== 'erro_auto' ? 'O reembolso automático foi pedido ao Pix.' : (r === 'professional' ? 'Devolva o valor pelo Pix, toque em "Fiz o reembolso" e mande a foto do comprovante aqui na conversa.' : 'O profissional vai devolver o valor pelo Pix e mandar o comprovante aqui na conversa.')}`],
    reembolso_feito: ['✅ Reembolso feito', (a, r) => (r === 'patient' ? 'O profissional informou que devolveu o valor pelo Pix. O comprovante vem aqui na conversa, em foto. Se o dinheiro não chegou, fale com o Suporte Acolia.' : 'Agora mande a foto do comprovante do Pix aqui na conversa (botão de funções → Enviar foto). Sem o comprovante, o paciente pode denunciar ao Suporte Acolia.')],
    reembolso_nao: ['↩️ Reembolso ainda não chegou', (a, r) => (r === 'professional' ? 'O paciente disse que ainda não recebeu. Confira e toque em "Fiz o reembolso" de novo.' : 'Avisamos o profissional.')],
    reembolsada: ['✅ Reembolso concluído', () => 'O valor da consulta foi devolvido.'],
    recusado: ['⚠️ Pagamento não aprovado', (a, r) => (r === 'patient' ? 'Quer realmente fazer esta consulta? Se sim, o profissional manda a chave Pix de novo.' : 'O paciente vai responder se quer tentar de novo.')],
    tentar: ['🔁 Nova tentativa de pagamento', (a, r, m) => (m?.extra === 'direto'
      ? (r === 'professional' ? 'O paciente vai pagar de novo. Confirme em cima do campo de mensagem quando o Pix cair.' : `Toque em "Copiar Pix" e pague ${money(a.price_cents)} em até 10 minutos.`)
      : (r === 'professional' ? 'Mande a chave Pix de novo em até 5 minutos.' : 'O profissional vai mandar a chave Pix de novo.'))],
    pro_cancelou: ['⚠️ O profissional não poderá atender', (a, r) => `${a.cancel_detail ? `“${a.cancel_detail}” · ` : ''}${r === 'patient' ? 'Escolha entre o reembolso e remarcar para outro horário.' : 'O paciente vai escolher entre o reembolso e remarcar.'}`],
    finalizada: ['✅ Chamada finalizada', () => 'A consulta terminou.'],
    concluida: ['✅ Consulta concluída', () => 'A consulta presencial terminou.'],
    paciente_ausente: ['⚠️ O paciente não entrou na chamada', (a, r) => (r === 'patient'
      ? 'Você não entrou até 3 minutos depois do horário. A chamada foi encerrada e o valor não é devolvido.'
      : 'O paciente não entrou até 3 minutos depois do horário. A chamada foi encerrada e o valor não é devolvido.')],
    ausente: ['⚠️ O profissional não compareceu', (a) => `A chamada foi fechada. ${a.mode === 'auto' ? 'O dinheiro será reembolsado automaticamente (100%).' : 'O dinheiro será reembolsado (100%) pelo profissional.'}`],
    chamada: ['🎥 Sua consulta vai começar', (a, r) => (a.can?.enter_call ? `Toque em "Entrar na chamada" e entre até 3 minutos depois do horário: ${r === 'patient' ? 'depois disso a chamada é encerrada e o valor não é devolvido' : 'depois disso a chamada fecha e o paciente é reembolsado'}. Não saia da tela durante a consulta.`
      : a.secretary ? 'A chamada desta consulta foi aberta. Só o profissional entra nela.' : 'A chamada desta consulta foi encerrada.')],
    expirada: ['⏱️ Tempo para pagar acabou', () => 'O horário foi liberado.'],
    sem_resposta: ['⏱️ A chave Pix não chegou a tempo', (a, r) => (r === 'patient' ? 'O profissional não mandou a chave Pix em 5 minutos e o horário foi liberado. Escolha outro horário ou mande uma mensagem.' : 'Você não mandou a chave Pix em 5 minutos e o horário foi liberado.')],
  };
  function fmtIso(s) {
    const d = new Date(Date.parse(s) - 3 * 3600e3);
    return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')} às ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  }
  // Ícone de cada cartão (desenhado, no lugar de emoji) e a cor dele
  const noEmoji = (t) => String(t).replace(/^(\p{Extended_Pictographic}|\uFE0F|\s)+/u, '');
  function cardIcon(ev, a) {
    if (['agendada', 'concluida', 'tipo_trocado'].includes(ev) && a?.modality === 'presencial') return 'home';
    if (ev === 'tipo_trocado') return 'video';
    if (['chamada', 'finalizada', 'paciente_ausente', 'ausente'].includes(ev)) return 'video';
    if (['reembolso_pedido', 'reembolso_feito', 'reembolso_nao', 'reembolsada', 'recusado', 'tentar'].includes(ev)) return 'pix';
    if (['expirada', 'sem_resposta'].includes(ev)) return 'clock';
    if (['agendada', 'concluida'].includes(ev)) return 'check';
    return 'calendar';
  }
  const cardTone = (ev) => (['recusado', 'pro_cancelou', 'ausente', 'paciente_ausente', 'expirada', 'sem_resposta', 'cancelada'].includes(ev) ? 'warn'
    : ['agendada', 'concluida', 'finalizada', 'reembolsada', 'reembolso_feito'].includes(ev) ? 'ok' : '');
  // latest = este é o cartão mais recente desta consulta (só ele mostra os botões)
  function chatCardHtml(m, role, latest) {
    const a = m.booking;
    if (!a) return '<div class="msg-card"><strong>📅 Consulta</strong><span class="small muted">Esta consulta não está mais disponível.</span></div>';
    let [title, text] = EVENT[m.event] || ['📅 Consulta', () => ''];
    // Versão 1.2.1: presencial e convênio
    if (m.event === 'agendada' && a.modality === 'presencial') {
      title = '✅ Consulta presencial agendada';
      text = (x, r) => `${x.billing === 'convenio' ? 'Pelo convênio (plano de saúde). ' : 'Pagamento aprovado. '}${r === 'patient' ? 'Vá ao consultório no dia e horário marcados: o endereço e o mapa estão logo abaixo e em "Ver".' : 'O paciente recebeu o endereço e o mapa do consultório.'}`;
    } else if (m.event === 'agendada' && a.billing === 'convenio') {
      text = () => 'Pelo convênio (plano de saúde): nada é cobrado aqui. O link da chamada aparece aqui 5 minutos antes.';
    } else if (m.event === 'cancelada' && m.extra === 'convenio') {
      text = () => 'Consulta pelo convênio cancelada. O horário foi liberado.';
    } else if (m.event === 'proposta' && a.modality === 'presencial') {
      title = '📅 Consulta presencial quase pronta: falta o pagamento';
    }
    // Cartões antigos da mesma consulta: só o registro (título e horário); a situação atual e os
    // botões ficam no cartão mais recente
    if (!latest) {
      const when = m.event === 'remarcada' && m.extra ? `Remarcada (antes: ${fmtIso(String(m.extra).split(';')[0])})` : m.event === 'remarcada' ? a.when
        : m.event === 'tipo_trocado' ? `Trocada para ${m.extra === 'online' ? 'presencial' : 'online'}` : '';
      return `<div class="msg-card booking-card old" data-booking="${a.id}"><strong class="bk-title"><span class="bk-ic ${cardTone(m.event)}">${ic(cardIcon(m.event, a), 16)}</span>${esc(noEmoji(title))}</strong>${when ? `<span class="small muted">${esc(when)}</span>` : ''}</div>`;
    }
    return `<div class="msg-card booking-card" data-booking="${a.id}">
      <strong class="bk-title"><span class="bk-ic ${cardTone(m.event)}">${ic(cardIcon(m.event, a), 16)}</span>${esc(noEmoji(title))}</strong>
      <span class="bk-when">${ic('calendar', 16)} ${esc(a.when)}</span>
      <span class="small muted">${a.minutes} min · ${a.price_cents != null ? money(a.price_cents) : ''} · ${badge(a)}</span>
      <span class="small">${esc(text(a, role, m))}</span>
      ${role === 'patient' && a.can?.copy_pix ? `<span class="small proof-tip">${ic('camera', 16)} <b>Depois de pagar, tire um print do comprovante</b> e mande aqui na conversa pela foto (botão da câmera ao lado de "Digite uma mensagem").</span>` : ''}
      <div class="bk-actions">${buttons(a, role)}${['confirmada', 'aguardando_paciente'].includes(a.status) ? `<button type="button" class="btn sm secondary" data-ag-act="see" data-ag-id="${a.id}">Ver</button>` : ''}</div>
    </div>`;
  }
  const previewText = (m) => noEmoji((EVENT[String(m.body).split('|')[1]] || ['Consulta'])[0]);

  // Local da consulta presencial: nome, endereço, cidade e o mapa (toque abre no Google Maps)
  function locationHtml(loc, { map = true } = {}) {
    if (!loc) return '';
    return `<div class="loc-box">
      <div class="loc-head"><span class="loc-ic">${ic('pin', 18)}</span><span>${loc.name ? `<b>${esc(loc.name)}</b><br>` : ''}${esc(loc.address)}<br><span class="muted">${esc(loc.place)}</span></span></div>
      ${map && loc.map_embed ? `<div class="loc-map"><iframe src="${esc(loc.map_embed)}" loading="lazy" referrerpolicy="no-referrer-when-downgrade" title="Mapa do consultório" tabindex="-1"></iframe>${loc.maps_url ? `<a class="loc-map-link" href="${esc(loc.maps_url)}" target="_blank" rel="noopener" aria-label="Abrir no mapa"></a>` : ''}</div>` : ''}
      ${loc.maps_url ? `<a class="btn sm secondary" href="${esc(loc.maps_url)}" target="_blank" rel="noopener">${ic('pin', 16)} Abrir no mapa</a>` : ''}
    </div>`;
  }
  // "Ver": detalhes da consulta (presencial com endereço e mapa), com remarcar/cancelar
  function openDetail(a) {
    const role = ctx.role;
    const other = role === 'patient' ? a.professional : a.patient;
    modal({
      title: a.modality === 'presencial' ? 'Consulta presencial' : 'Consulta online',
      html: `<div class="row" style="gap:10px;align-items:center">${avatar(other.name, other.photo, 'sm')}<div><b>${esc(other.name)}</b><div class="small muted">${esc(a.when)} · ${a.minutes} min</div></div></div>
        <div style="margin:10px 0">${badge(a)} <span class="small muted">· ${a.billing === 'convenio' ? 'Convênio (plano de saúde)' : a.price_cents != null ? `${money(a.price_cents)} · Pix` : ''}</span></div>
        ${a.modality === 'presencial' ? locationHtml(a.location) : '<p class="small muted">O link da chamada aparece na conversa 5 minutos antes.</p>'}
        ${role === 'patient' && a.can?.switch_note ? `<p class="small muted" style="margin:10px 0 0">${esc(a.can.switch_note)}</p>` : ''}
        <div class="bk-actions" style="margin-top:12px">${buttons(a, role)}</div>`,
      actions: [{ label: 'Fechar' }],
      onOpen: (dlg) => bindActions(dlg, (id) => { if (id === a.id) { dlg.close(); dlg.remove(); } return id === a.id ? a : findAppt(id); }),
    });
  }

  // ---------- "Ver": lista das consultas ----------
  let cache = [];
  async function loadUpcoming() {
    try {
      const d = await api('/api/agenda/appointments');
      cache = d.items;
      if (d.items[0]) syncClock(d.items[0].now);
    } catch { /* sem conta ou offline */ }
    return cache;
  }
  const findAppt = (id) => cache.find((a) => a.id === id);

  async function openList() {
    await loadUpcoming();
    const role = ctx.role;
    const html = cache.length ? cache.map((a) => {
      const other = role === 'patient' ? a.professional : a.patient;
      return `<div class="appt-item" data-appt="${a.id}">
        <div class="row" style="gap:10px;align-items:flex-start;flex-wrap:nowrap">${avatar(other.name, other.photo, 'sm')}<div class="grow" style="min-width:0"><b>${esc(other.name)}</b><div class="small muted">${esc(a.when)} · ${a.minutes} min · ${a.modality === 'presencial' ? 'presencial' : 'online'}${a.billing === 'convenio' ? ' · convênio' : ''}</div><div style="margin-top:4px">${badge(a)}</div></div></div>
        ${a.modality === 'presencial' && ['confirmada', 'aguardando_paciente'].includes(a.status) ? locationHtml(a.location, { map: false }) : ''}
        ${a.status === 'confirmada' ? `<div class="small appt-left">Faltam <b data-cd="${esc(a.start_at)}">${countdown(Date.parse(a.start_at) - now())}</b></div>` : ''}
        ${a.status === 'confirmada' && role === 'patient' && !a.can.reschedule && !a.can.cancel ? `<div class="small muted">${a.reschedules >= a.max_reschedules ? 'Você já remarcou uma vez.' : ''} ${Date.parse(a.start_at) - now() <= 30 * 60000 ? 'Faltam 30 minutos ou menos: não dá mais para remarcar nem pedir reembolso.' : ''}</div>` : ''}
        ${role === 'patient' && a.can?.switch_note ? `<div class="small muted">${esc(a.can.switch_note)}</div>` : ''}
        <div class="bk-actions">${buttons(a, role)}${a.conversation_id ? `<button type="button" class="btn sm ghost" data-ag-act="chat" data-ag-id="${a.id}">${ic('chat', 16)} Conversa</button>` : ''}</div>
      </div>`;
    }).join('') : `<p class="muted">Você não tem consultas marcadas.</p>`;
    modal({
      title: role === 'patient' ? 'Minhas consultas' : 'Próximas consultas',
      html: `<div class="appt-list" data-list>${html}</div>`,
      actions: [{ label: 'Fechar' }],
      onOpen: (dlg) => {
        bindActions(dlg, (id) => { const a = findAppt(id); if (a) { dlg.close(); dlg.remove(); } return a; });
        const t = setInterval(() => { if (!dlg.isConnected) return clearInterval(t); $$('[data-cd]', dlg).forEach((el) => { el.textContent = countdown(Date.parse(el.dataset.cd) - now()); }); }, 1000);
      },
    });
  }

  // ---------- Aviso fixo com a contagem regressiva ----------
  // Fica embaixo, pequeno, e se ajusta à tela: em cima do menu (feed, config), em cima do campo de
  // mensagem (conversa aberta) e como pílula compacta nos Reels.
  let bar = null;
  let barAppt = null;
  function pickForBar(list) {
    const need = list.find((a) => Object.entries(a.can || {}).some(([k, v]) => v && !['reschedule', 'cancel', 'pro_cancel', 'enter_call', 'give_up'].includes(k)));
    return need || list.find((a) => a.status === 'confirmada') || null;
  }
  // Secretária (versão 1.1.3): o aviso fica sempre embaixo, no lugar do aviso de consulta:
  // "Você está usando o painel como secretária de …" e, em cima, pequeno, a próxima consulta do profissional
  function renderSecretaryBar() {
    const a = barAppt;
    const pro = ctx.secretary.proName;
    let next = '';
    if (a) {
      const left = Date.parse(a.start_at) - now();
      const line2 = a.status === 'confirmada' ? (left > 0 ? `faltam ${countdown(left)}` : 'acontecendo agora') : (STATUS[a.status] || [''])[0];
      next = `<div class="ab-next"><span class="ab-ic">${ic('calendar', 16)}</span>
        <span class="ab-txt"><b>Próxima consulta de ${esc(pro)}</b><small>${esc(a.patient.name.split(' ')[0])} · ${esc(a.date === localToday() ? `hoje às ${a.time}` : shortWhen(a))} · ${esc(line2)}</small></span>
        <button type="button" class="btn sm secondary" data-bar-see>Ver</button></div>`;
    }
    bar.innerHTML = `${next}<div class="ab-sec">${ic('user', 15)}<span>Você está usando o painel como <b>secretária de ${esc(pro)}</b></span></div>`;
    bar.classList.add('sec-mode');
    bar.classList.remove('hidden');
    document.body.classList.add('has-appt-bar');
    place();
  }
  function renderBar() {
    if (!bar) return;
    if (ctx.secretary) return renderSecretaryBar();
    const a = barAppt;
    if (!a) { bar.classList.add('hidden'); document.body.classList.remove('has-appt-bar'); return; }
    const other = ctx.role === 'patient' ? a.professional.name : a.patient.name;
    const left = Date.parse(a.start_at) - now();
    let line2;
    if (a.can.presence_check) line2 = 'Presencial · a consulta aconteceu? Toque em Ver';
    else if (a.status === 'confirmada') line2 = a.can.enter_call ? 'A chamada está aberta' : left > 0 ? `${a.modality === 'presencial' ? 'Presencial' : 'Consulta'} · faltam ${countdown(left)}` : 'Consulta acontecendo agora';
    else line2 = (STATUS[a.status] || [''])[0];
    const main = a.can.enter_call ? `<button type="button" class="btn sm" data-ag-act="enter" data-ag-id="${a.id}">Entrar</button>` : '';
    bar.innerHTML = `<span class="ab-ic">${ic('calendar', 18)}</span>
      <span class="ab-txt"><b>${esc(other.split(' ')[0])} · ${esc(a.date === localToday() ? `hoje às ${a.time}` : shortWhen(a))}</b><small>${esc(line2)}</small></span>
      ${main}<button type="button" class="btn sm secondary" data-bar-see>Ver</button>`;
    bar.classList.remove('hidden');
    document.body.classList.add('has-appt-bar');
    place();
  }
  const localToday = () => new Date(now() - 3 * 3600e3).toISOString().slice(0, 10);
  const shortWhen = (a) => `${a.date.slice(8)}/${a.date.slice(5, 7)} às ${a.time}`;
  function place() {
    if (!bar || bar.classList.contains('hidden')) return;
    const reels = $('.reels-view');
    const story = $('.story-viewer');
    const agendaOpen = $('.agenda-page');
    bar.classList.toggle('in-reels', !!reels);
    bar.classList.toggle('gone', !!story || !!agendaOpen || !!document.querySelector('dialog[open], .fn-pop, .qr-pop'));
    if (reels) { bar.style.bottom = ''; return; }
    // (menu e campo de mensagem podem ser "fixed": confere se estão visíveis pelo tamanho na tela)
    const shown = (el) => { const r = el.getBoundingClientRect(); return r.height > 0 && r.width > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.hidden'); };
    // (no chat do profissional, a pergunta "O paciente fez o pagamento?" fica logo acima do campo)
    const composer = [...$$('.pay-ask')].find(shown) || [...$$('.composer')].find(shown);
    const nav = [...$$('.bottom-nav')].find(shown);
    // Sempre acima do menu de baixo (casinha, profissionais, mensagens…) ou do campo de mensagem
    let bottom = null;
    if (composer) bottom = window.innerHeight - composer.getBoundingClientRect().top + 8;
    else if (nav) bottom = window.innerHeight - nav.getBoundingClientRect().top + 8;
    bar.style.bottom = bottom === null ? '' : `${Math.max(8, Math.round(bottom))}px`;
    document.documentElement.style.setProperty('--appt-bar-space', `${bar.offsetHeight + 12}px`);
  }
  async function refreshBar() {
    if (!bar) return;
    const list = await loadUpcoming();
    barAppt = ctx.secretary ? (list.find((a) => a.status === 'confirmada') || list[0] || null) : pickForBar(list);
    renderBar();
  }
  function mountBar({ role, socket, onSee, secretary = null }) {
    ctx.role = role;
    ctx.secretary = secretary;
    bar = document.createElement('div');
    bar.className = 'appt-bar hidden';
    bar.setAttribute('role', 'status');
    document.body.appendChild(bar);
    bar.addEventListener('click', (e) => {
      if (e.target.closest('[data-bar-see]')) return (onSee || openList)();
      const b = e.target.closest('[data-ag-act]');
      if (b) act(findAppt(Number(b.dataset.agId)), b.dataset.agAct);
    });
    refreshBar();
    socket?.on('agenda:update', () => refreshAll());
    setInterval(() => { renderBar(); }, 30000);
    setInterval(place, 700);
    window.addEventListener('resize', place);
    setInterval(refreshBar, 60000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshBar(); });
  }

  const listeners = new Set();
  function refreshAll() { refreshBar(); listeners.forEach((f) => { try { f(); } catch { /* ignora */ } }); }
  const onChange = (f) => listeners.add(f);

  window.AcoliaAgenda = {
    setContext, openBooking, openDetail, locationHtml, payScreen, acceptAndPay, act, buttons, bindActions, chatCardHtml, previewText,
    mountBar, refreshBar, openList, loadUpcoming, findAppt, onChange, refreshAll, countdown, policyHtml, badge, STATUS,
    get cache() { return cache; },
  };
})();
