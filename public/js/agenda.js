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
  };
  const badge = (a) => { const [t, c] = STATUS[a.status] || [a.status, '']; return `<span class="badge ${c}">${esc(t)}</span>`; };

  // ---------- Política (aparece antes de pagar, com "Li e aceito") ----------
  function policyHtml(rules) {
    const r = rules || { CUTOFF_MIN: 30, PAY_MIN: 10, PRO_PIX_MIN: 5, PRO_GRACE_MIN: 3, PRO_CANCEL_H: 24 };
    return `<ul class="policy-list">
      <li>O pagamento é <b>só por Pix</b> e confirma a consulta. Você tem <b>${r.PAY_MIN} minutos</b> para pagar; depois disso o horário é liberado.</li>
      <li>Você pode <b>remarcar uma vez</b> ou <b>cancelar com reembolso</b> até <b>${r.CUTOFF_MIN} minutos antes</b>. Com ${r.CUTOFF_MIN} minutos ou menos, não dá mais para remarcar nem pedir reembolso.</li>
      <li>Se você <b>não comparecer</b>, o valor não é devolvido.</li>
      <li>Se o profissional não puder atender, ele avisa até ${r.PRO_CANCEL_H} horas antes e <b>você escolhe</b>: reembolso ou remarcar.</li>
      <li>Se o profissional <b>não entrar na chamada</b> até ${r.PRO_GRACE_MIN} minutos depois do horário, você recebe <b>100% de volta</b>.</li>
      <li>O dinheiro vai direto para a conta do profissional. A Acolia não recebe nem cobra taxa sobre a consulta.</li>
    </ul><a href="/politica-agendamento" target="_blank" rel="noopener" class="small">Ler a política completa</a>`;
  }

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

    async function loadMonth() {
      page.body.innerHTML = '<div class="spinner"></div>';
      try {
        info = await api(`/api/agenda/pro/${proId}/month?${ym ? `ym=${ym}&` : ''}${extra}`);
      } catch (e) { page.body.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
      ym = info.ym;
      if (!info.ready) {
        page.body.innerHTML = `<div class="empty">${mode === 'propose' ? 'Abra a sua agenda primeiro: em <b>Consultas</b>, cadastre os horários (e confira o valor da consulta e a forma de receber).' : 'Este profissional ainda não abriu a agenda. Mande uma mensagem para combinar.'}</div>`;
        return;
      }
      renderMonth();
    }

    function renderMonth() {
      const [y, m] = ym.split('-').map(Number);
      const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
      const minYm = info.today.slice(0, 7);
      const maxYm = info.max_date.slice(0, 7);
      const head = mode === 'propose' ? `<p class="muted" style="margin-top:0">Consulta com <b>${esc(opts.peerName || 'o paciente')}</b>. Ele recebe no chat e tem ${10} minutos para pagar.</p>`
        : mode === 'reschedule' ? `<p class="muted" style="margin-top:0">Consulta atual: <b>${esc(opts.appt.when)}</b>. Escolha o novo dia e horário.${opts.appt.status === 'confirmada' ? ' <b>Você só pode remarcar uma vez.</b>' : ''}</p>`
          : `<div class="row" style="gap:12px;margin-bottom:12px">${avatar(proName, opts.pro.photo, 'md')}<div><b>${esc(proName)}</b><div class="muted small">${esc(opts.pro.profession || '')}</div></div></div>`;
      page.body.innerHTML = `${head}
        <div class="cal">
          <div class="cal-head"><button type="button" class="icon-btn" data-prev aria-label="Mês anterior" ${ym <= minYm ? 'disabled' : ''}>‹</button>
            <b>${MONTHS[m - 1][0].toUpperCase() + MONTHS[m - 1].slice(1)} ${y}</b>
            <button type="button" class="icon-btn" data-next aria-label="Próximo mês" ${ym >= maxYm ? 'disabled' : ''}>›</button></div>
          <div class="cal-grid">${WD.map((d) => `<span class="cal-wd">${d}</span>`).join('')}${'<span></span>'.repeat(firstDow)}${info.days.map((d) => {
            const n = Number(d.date.slice(8));
            const on = d.free > 0;
            return `<button type="button" class="cal-day ${on ? 'on' : ''} ${d.date === info.today ? 'today' : ''} ${sel?.date === d.date ? 'sel' : ''}" data-day="${d.date}" ${on ? '' : 'disabled'} aria-label="${n}${on ? `, ${d.free} horário(s) livre(s)` : ', sem horário'}">${n}</button>`;
          }).join('')}</div>
          <p class="small muted cal-legend"><span class="cal-dot"></span> dias com horário livre · ${info.minutes} min por consulta · ${info.price_cents != null ? money(info.price_cents) : ''}</p>
        </div>
        <div data-slots></div>
        <div class="ag-foot" data-foot></div>`;
      $('[data-prev]', page.body).addEventListener('click', () => { ym = shiftYm(ym, -1); sel = null; loadMonth(); });
      $('[data-next]', page.body).addEventListener('click', () => { ym = shiftYm(ym, 1); sel = null; loadMonth(); });
      $$('[data-day]', page.body).forEach((b) => b.addEventListener('click', () => pickDay(b.dataset.day)));
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
        ? `<div class="ag-sum"><b>${esc(sel.dayLabel)} às ${esc(sel.label)}</b><span class="muted small">${info.minutes} min · ${info.price_cents != null ? money(info.price_cents) : ''} · online</span></div>
           <button type="button" class="btn" data-go>Avançar</button>`
        : '<span class="muted small">Escolha um dia e um horário.</span>';
      $('[data-go]', foot)?.addEventListener('click', confirmStep);
    }

    async function confirmStep() {
      if (!rules) { try { rules = (await api('/api/agenda/appointments')).rules; } catch { /* usa o padrão */ } }
      page.setTitle(mode === 'reschedule' ? 'Confirmar remarcação' : 'Confirmar consulta');
      const when = `${sel.dayLabel} às ${sel.label}`;
      page.body.innerHTML = `<div class="card stack">
          <div class="row" style="gap:12px">${ic('calendar', 26)}<div><b style="font-size:1.1rem">${esc(when)}</b><div class="muted small">${esc(proName)} · ${info.minutes} min · consulta online</div></div></div>
          ${mode === 'reschedule' ? '<p class="small" style="margin:0">O valor que você já pagou continua valendo para o novo horário.</p>' : `<div class="row between"><span>Valor da consulta</span><b>${money(info.price_cents)}</b></div>`}
        </div>
        ${mode === 'book' ? `<h3 style="margin:18px 0 6px">Política de agendamento</h3>${policyHtml(rules)}
        <label class="check" style="margin:14px 0"><input type="checkbox" data-accept> Li e aceito a política de agendamento e cancelamento</label>` : ''}
        ${mode === 'propose' ? `<p class="notice info small" style="margin-top:14px">O paciente recebe a proposta na conversa, lê e aceita a política de agendamento e tem ${rules?.PAY_MIN || 10} minutos para pagar. ${info.mode === 'auto' ? 'O Pix é o da sua conta Asaas: quando cair, a consulta é marcada sozinha.' : 'A sua chave Pix vai junto; quando o dinheiro cair, toque em "Pagamento aprovado".'}</p>` : ''}
        <div class="form-error hidden" data-err></div>
        <div class="row" style="gap:10px;margin-top:10px"><button type="button" class="btn secondary" data-back2>Voltar</button>
          <button type="button" class="btn grow" data-ok ${mode === 'book' ? 'disabled' : ''}>${mode === 'reschedule' ? 'Remarcar' : mode === 'propose' ? 'Enviar para o paciente' : `Ir para o pagamento (${info.mode === 'auto' ? 'Pix' : 'Pix pelo chat'})`}</button></div>`;
      $('[data-accept]', page.body)?.addEventListener('change', (e) => { $('[data-ok]', page.body).disabled = !e.target.checked; });
      $('[data-back2]', page.body).addEventListener('click', () => { page.setTitle(mode === 'reschedule' ? 'Remarcar consulta' : 'Agendar consulta'); renderMonth(); });
      $('[data-ok]', page.body).addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const err = $('[data-err]', page.body);
        btn.disabled = true;
        err.classList.add('hidden');
        try {
          if (mode === 'reschedule') {
            const a = await api(`/api/agenda/appointments/${opts.appt.id}/reschedule`, { method: 'POST', body: { start: sel.start } });
            toast('Consulta remarcada ✓', '', { top: true });
            page.close();
            opts.onDone?.(a);
            return;
          }
          if (mode === 'propose') {
            const a = await api('/api/agenda/propose', { method: 'POST', body: { conversation_id: opts.conversationId, start: sel.start } });
            toast('Proposta enviada ao paciente ✓', '', { top: true });
            page.close();
            opts.onDone?.(a);
            return;
          }
          const a = await api('/api/agenda/book', { method: 'POST', body: { professional_id: proId, start: sel.start, accept: true } });
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
        <div style="font-size:2.4rem">📨</div>
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
        page.body.innerHTML = `<div class="card stack center"><div style="font-size:2.6rem">✅</div><h2 style="margin:0">Pagamento aprovado!</h2>
          <p><b>Consulta marcada</b> para ${esc(cur.when)}.</p><p class="muted small">Levando você para a conversa com ${esc(cur.professional.name)}…</p></div>`;
        refreshAll();
        setTimeout(async () => { await page.close(); goChat(cur.conversation_id); }, 1800);
      } else if (!['aguardando_pagamento'].includes(cur.status)) {
        stop();
        page.body.innerHTML = `<div class="card stack center"><div style="font-size:2.4rem">⏱️</div><h2 style="margin:0">${cur.status === 'expirada' ? 'O tempo para pagar acabou' : 'Esta cobrança não vale mais'}</h2>
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

  // ---------- Ações (do "Ver" e dos cartões do chat) ----------
  async function cancelDialog(a) {
    const { reasons, rules } = await api('/api/agenda/appointments');
    const byPro = a.status === 'aguardando_paciente';
    const how = a.mode === 'auto' ? 'O valor volta automaticamente para o seu Pix.' : 'O profissional devolve o valor pelo Pix. Enquanto isso, ele não consegue te mandar mensagens; quando o dinheiro chegar, você confirma aqui.';
    const res = await modal({
      title: byPro ? 'Quero o reembolso' : 'Cancelar consulta',
      html: `<p><b>${esc(a.when)}</b> com ${esc(a.professional.name)}</p>
        ${byPro ? '' : `<p class="small muted">Dá para cancelar até ${rules.CUTOFF_MIN} minutos antes. Por que você vai cancelar?</p>
        <div class="stack" style="gap:6px">${Object.entries(reasons).map(([k, v]) => `<label class="check"><input type="radio" name="motivo" value="${k}"> ${esc(v)}</label>`).join('')}</div>
        <textarea data-detail rows="2" maxlength="500" placeholder="Conte o motivo (obrigatório em &quot;Outros motivos&quot;)" style="margin-top:8px"></textarea>`}
        <p class="notice info small" style="margin-top:10px">${how}</p>`,
      actions: [{ label: 'Voltar', value: null, class: 'secondary' }, {
        label: byPro ? 'Quero o reembolso' : 'Cancelar e pedir reembolso', class: 'danger',
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
    toast(a.mode === 'auto' ? 'Consulta cancelada. O reembolso foi pedido ao Pix ✓' : 'Consulta cancelada. Pedido de reembolso enviado ao profissional.', '', { top: true });
  }

  async function act(a, action) {
    try {
      switch (action) {
        case 'pay': payScreen(null, a); return;
        case 'accept': await acceptAndPay(a); return;
        case 'reschedule': openBooking({ mode: 'reschedule', appt: a, onDone: refreshAll }); return;
        case 'choose': {
          const v = await modal({
            title: 'O profissional não poderá atender', html: `<p>${esc(a.professional.name)} avisou que não poderá atender <b>${esc(a.when)}</b>${a.cancel_detail ? ` (“${esc(a.cancel_detail)}”)` : ''}. O que você prefere?</p>`,
            actions: [{ label: 'Remarcar', value: 'remarcar', class: 'secondary' }, { label: 'Quero o reembolso', value: 'reembolso' }],
          });
          if (v === 'remarcar') openBooking({ mode: 'reschedule', appt: a, onDone: refreshAll });
          if (v === 'reembolso') await cancelDialog(a);
          break;
        }
        case 'cancel': await cancelDialog(a); break;
        case 'give_up':
          if (!await confirmDialog('Desistir desta consulta? O horário fica livre para outra pessoa.', { okLabel: 'Desistir', danger: true })) return;
          await api(`/api/agenda/appointments/${a.id}/cancel`, { method: 'POST', body: {} });
          toast('Você desistiu da consulta.');
          break;
        case 'retry_yes': await api(`/api/agenda/appointments/${a.id}/retry`, { method: 'POST', body: { yes: true } }); toast('Ok! O profissional vai mandar a chave Pix de novo.'); break;
        case 'retry_no': await api(`/api/agenda/appointments/${a.id}/retry`, { method: 'POST', body: { yes: false } }); break;
        case 'refund_yes': await api(`/api/agenda/appointments/${a.id}/refund-received`, { method: 'POST', body: { yes: true } }); toast('Obrigado! Reembolso confirmado ✓'); break;
        case 'refund_no': await api(`/api/agenda/appointments/${a.id}/refund-received`, { method: 'POST', body: { yes: false } }); toast('Avisamos o profissional que o dinheiro ainda não chegou.'); break;
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
          if (!await confirmDialog(`Você já devolveu ${money(a.price_cents)} para o paciente pelo Pix?`, { okLabel: 'Sim, fiz o reembolso' })) return;
          await api(`/api/agenda/appointments/${a.id}/refund-done`, { method: 'POST' });
          toast('Pronto! O paciente vai confirmar que recebeu.');
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
      if (c.accept) out.push(b('accept', 'Aceitar e pagar', ''));
      else if (c.pay) out.push(b('pay', 'Pagar com Pix', ''));
      if (c.choose) out.push(b('choose', 'Escolher: reembolso ou remarcar', ''));
      if (c.retry) { out.push(b('retry_yes', 'Sim, quero tentar de novo', '')); out.push(b('retry_no', 'Não')); }
      if (c.refund_received) { out.push(b('refund_yes', 'Sim, recebi', '')); out.push(b('refund_no', 'Ainda não recebi')); }
      if (c.reschedule) out.push(b('reschedule', 'Remarcar'));
      if (c.cancel) out.push(b('cancel', 'Cancelar consulta', 'ghost danger-text'));
      if (c.give_up && !c.retry) out.push(b('give_up', 'Desistir', 'ghost'));
    } else {
      if (c.send_pix) out.push(b('send_pix', `${ic('pix', 16)} Enviar chave Pix`, ''));
      if (c.approve) { out.push(b('approve', 'Pagamento aprovado', '')); out.push(b('reject', 'Pagamento não aprovado', 'ghost danger-text')); }
      if (c.refund_done) out.push(b('refund_done', 'Fiz o reembolso', ''));
      if (c.pro_cancel) out.push(b('pro_cancel', 'Não vou poder atender', 'ghost danger-text'));
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
    proposta: ['📅 Proposta de consulta', (a, r) => (r === 'patient' ? `Toque em "Aceitar e pagar" para confirmar. Você tem 10 minutos para pagar o Pix.` : 'Enviada ao paciente. Ele tem 10 minutos para pagar.')],
    agendada: ['✅ Consulta agendada', () => 'Pagamento aprovado. O link da chamada aparece aqui 10 minutos antes.'],
    remarcada: ['🔁 Consulta remarcada', (a, r, m) => (m.extra ? `Novo horário (antes era ${fmtIso(m.extra)}).` : 'Novo horário.')],
    cancelada: ['Consulta cancelada', () => 'O horário foi liberado.'],
    reembolso_pedido: ['↩️ Pedido de reembolso', (a, r, m) => `${a.cancel_reason_label ? `Motivo: ${a.cancel_reason_label}${a.cancel_detail && a.cancel_reason === 'outros' ? ` — “${a.cancel_detail}”` : ''}. ` : ''}${a.mode === 'auto' && m.extra !== 'erro_auto' ? 'O reembolso automático foi pedido ao Pix.' : (r === 'professional' ? 'Devolva o valor pelo Pix e toque em "Fiz o reembolso". Até o paciente confirmar, você não consegue mandar mensagens para ele.' : 'O profissional vai devolver o valor pelo Pix.')}`],
    reembolso_feito: ['↩️ Reembolso feito', (a, r) => (r === 'patient' ? 'O profissional informou que devolveu o valor. Você recebeu?' : 'Esperando o paciente confirmar que recebeu.')],
    reembolso_nao: ['↩️ Reembolso ainda não chegou', (a, r) => (r === 'professional' ? 'O paciente disse que ainda não recebeu. Confira e toque em "Fiz o reembolso" de novo.' : 'Avisamos o profissional.')],
    reembolsada: ['✅ Reembolso concluído', () => 'O valor da consulta foi devolvido.'],
    recusado: ['⚠️ Pagamento não aprovado', (a, r) => (r === 'patient' ? 'Quer realmente fazer esta consulta? Se sim, o profissional manda a chave Pix de novo.' : 'O paciente vai responder se quer tentar de novo.')],
    tentar: ['🔁 Nova tentativa de pagamento', (a, r) => (r === 'professional' ? 'Mande a chave Pix de novo em até 5 minutos.' : 'O profissional vai mandar a chave Pix de novo.')],
    pro_cancelou: ['⚠️ O profissional não poderá atender', (a, r) => `${a.cancel_detail ? `“${a.cancel_detail}” · ` : ''}${r === 'patient' ? 'Escolha entre o reembolso e remarcar para outro horário.' : 'O paciente vai escolher entre o reembolso e remarcar.'}`],
    ausente: ['⚠️ O profissional não compareceu', (a) => `A chamada foi fechada. ${a.mode === 'auto' ? 'O dinheiro será reembolsado automaticamente (100%).' : 'O dinheiro será reembolsado (100%) pelo profissional.'}`],
    chamada: ['🎥 Sua consulta vai começar', (a) => (a.can?.enter_call ? 'Toque em "Entrar na chamada". Não saia da tela durante a consulta.'
      : a.secretary ? 'A chamada desta consulta foi aberta. Só o profissional entra nela.' : 'A chamada desta consulta foi encerrada.')],
    expirada: ['⏱️ Tempo para pagar acabou', () => 'O horário foi liberado.'],
    sem_resposta: ['⏱️ A chave Pix não chegou a tempo', (a, r) => (r === 'patient' ? 'O profissional não mandou a chave Pix em 5 minutos e o horário foi liberado. Escolha outro horário ou mande uma mensagem.' : 'Você não mandou a chave Pix em 5 minutos e o horário foi liberado.')],
  };
  function fmtIso(s) {
    const d = new Date(Date.parse(s) - 3 * 3600e3);
    return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')} às ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  }
  // latest = este é o cartão mais recente desta consulta (só ele mostra os botões)
  function chatCardHtml(m, role, latest) {
    const a = m.booking;
    if (!a) return '<div class="msg-card"><strong>📅 Consulta</strong><span class="small muted">Esta consulta não está mais disponível.</span></div>';
    const [title, text] = EVENT[m.event] || ['📅 Consulta', () => ''];
    // Cartões antigos da mesma consulta: só o registro (título e horário); a situação atual e os
    // botões ficam no cartão mais recente
    if (!latest) {
      const when = m.event === 'remarcada' && m.extra ? `Remarcada (antes: ${fmtIso(m.extra)})` : m.event === 'remarcada' ? a.when : '';
      return `<div class="msg-card booking-card old" data-booking="${a.id}"><strong>${title}</strong>${when ? `<span class="small muted">${esc(when)}</span>` : ''}</div>`;
    }
    return `<div class="msg-card booking-card" data-booking="${a.id}">
      <strong>${title}</strong>
      <span class="bk-when">${ic('calendar', 16)} ${esc(a.when)}</span>
      <span class="small muted">${a.minutes} min · ${a.price_cents != null ? money(a.price_cents) : ''} · ${badge(a)}</span>
      <span class="small">${esc(text(a, role, m))}</span>
      <div class="bk-actions">${buttons(a, role)}</div>
    </div>`;
  }
  const previewText = (m) => (EVENT[String(m.body).split('|')[1]] || ['📅 Consulta'])[0];

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
        <div class="row" style="gap:10px;align-items:flex-start;flex-wrap:nowrap">${avatar(other.name, other.photo, 'sm')}<div class="grow" style="min-width:0"><b>${esc(other.name)}</b><div class="small muted">${esc(a.when)} · ${a.minutes} min</div><div style="margin-top:4px">${badge(a)}</div></div></div>
        ${a.status === 'confirmada' ? `<div class="small appt-left">Faltam <b data-cd="${esc(a.start_at)}">${countdown(Date.parse(a.start_at) - now())}</b></div>` : ''}
        ${a.status === 'confirmada' && role === 'patient' && !a.can.reschedule && !a.can.cancel ? `<div class="small muted">${a.reschedules >= a.max_reschedules ? 'Você já remarcou uma vez.' : ''} ${Date.parse(a.start_at) - now() <= 30 * 60000 ? 'Faltam 30 minutos ou menos: não dá mais para remarcar nem pedir reembolso.' : ''}</div>` : ''}
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
  function renderBar() {
    if (!bar) return;
    const a = barAppt;
    if (!a) { bar.classList.add('hidden'); document.body.classList.remove('has-appt-bar'); return; }
    const other = ctx.role === 'patient' ? a.professional.name : a.patient.name;
    const left = Date.parse(a.start_at) - now();
    let line2;
    if (a.status === 'confirmada') line2 = a.can.enter_call ? '🎥 A chamada está aberta' : left > 0 ? `Consulta · faltam ${countdown(left)}` : 'Consulta acontecendo agora';
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
    bar.classList.toggle('gone', !!story || !!agendaOpen || !!document.querySelector('dialog[open]'));
    if (reels) { bar.style.bottom = ''; return; }
    // (menu e campo de mensagem podem ser "fixed": confere se estão visíveis pelo tamanho na tela)
    const shown = (el) => { const r = el.getBoundingClientRect(); return r.height > 0 && r.width > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.hidden'); };
    const composer = [...$$('.composer')].find(shown);
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
    barAppt = pickForBar(await loadUpcoming());
    renderBar();
  }
  function mountBar({ role, socket, onSee }) {
    ctx.role = role;
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
    setContext, openBooking, payScreen, acceptAndPay, act, buttons, bindActions, chatCardHtml, previewText,
    mountBar, refreshBar, openList, loadUpcoming, findAppt, onChange, refreshAll, countdown, policyHtml, badge, STATUS,
    get cache() { return cache; },
  };
})();
