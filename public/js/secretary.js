/* Versão 1.1.3 — Secretária e Chamadas.
   - Meu perfil (só o profissional): criar a secretária. O sistema gera o login e a senha (aleatórios).
   - Painel da secretária: o mesmo do profissional, com limites (não entra nas chamadas, não muda perfil,
     senha, conta nem pagamento, não vê o código único).
   - Chamadas (só o profissional): a próxima chamada em destaque e as outras pequenas embaixo. */
(function () {
  'use strict';
  const { $, $$, esc, api, toast, confirmDialog, copyText, avatar, ICONS } = window.Acolia;
  const ic = (name, s = 18) => ICONS[name].replace('<svg', `<svg style="width:${s}px;height:${s}px"`);

  // ---------- Cartão "Secretária" no Meu perfil ----------
  function card(root) {
    let state = null; // { secretary, login?, password? }
    const creds = (login, password) => `<div class="sec-creds">
        <div><span class="small muted">Login</span><b data-sec-login>${esc(login)}</b></div>
        ${password ? `<div><span class="small muted">Senha</span><b data-sec-pass>${esc(password)}</b></div>` : ''}
      </div>`;
    function paint() {
      const s = state.secretary;
      if (!s) {
        root.innerHTML = `<h2 style="margin:0">${ic('user', 22)} Secretária</h2>
          <p class="small muted" style="margin:0">Crie um acesso para a sua secretária responder as mensagens, cuidar da agenda e publicar por você. <b>O login e a senha são gerados pelo sistema.</b> Ela entra no mesmo lugar que você (Entrar → Sou profissional).</p>
          <ul class="small sec-rules">
            <li>✅ Responde as conversas no seu lugar (você vê tudo o que ela manda, com o selo "Secretária"; o paciente não vê diferença).</li>
            <li>✅ Vê e organiza as consultas e a agenda, publica no seu perfil e vê os seus pacientes.</li>
            <li>🚫 Não entra nas chamadas de vídeo, não muda o seu perfil, a senha nem a conta, não mexe no pagamento automático nem na chave Pix e não vê o seu código único.</li>
          </ul>
          <button type="button" class="btn" data-sec-create>Criar secretária</button>`;
        return;
      }
      const fresh = state.password;
      root.innerHTML = `<h2 style="margin:0">${ic('user', 22)} Secretária</h2>
        ${fresh ? `<div class="notice ok small"><b>Pronto!</b> Mande o login e a senha para a sua secretária. <b>A senha só aparece agora</b>: se perder, toque em "Gerar nova senha".</div>` : ''}
        ${creds(s.login, fresh)}
        <div class="row" style="gap:8px;flex-wrap:wrap">
          ${fresh ? `<button type="button" class="btn" data-sec-copy>${ic('copy', 16)} Copiar login e senha</button>` : ''}
          <button type="button" class="btn secondary sm" data-sec-reset>Gerar nova senha</button>
          <button type="button" class="btn ghost sm danger-text" data-sec-del>Apagar secretária</button>
        </div>
        <p class="small muted" style="margin:0">${s.last_login_at ? `Último acesso: ${esc(new Date(s.last_login_at.replace(' ', 'T') + 'Z').toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }))}.` : 'Ela ainda não entrou.'} Gerar nova senha ou apagar tira a secretária do painel na hora.</p>`;
    }
    root.addEventListener('click', async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      try {
        if (b.matches('[data-sec-create]')) {
          b.disabled = true;
          state = await api('/api/professional/secretary', { method: 'POST' });
          paint();
        } else if (b.matches('[data-sec-copy]')) {
          copyText(`Acesso de secretária na Acolia\nEntre em ${location.origin}/entrar → Sou profissional\nLogin: ${state.login}\nSenha: ${state.password}`);
        } else if (b.matches('[data-sec-reset]')) {
          if (!await confirmDialog('Gerar uma nova senha? A senha antiga para de funcionar e a secretária sai do painel até entrar com a nova.', { okLabel: 'Gerar nova senha' })) return;
          state = await api('/api/professional/secretary/password', { method: 'POST' });
          paint();
        } else if (b.matches('[data-sec-del]')) {
          if (!await confirmDialog('Apagar a secretária? Ela sai do painel na hora e o login para de funcionar. As mensagens que ela mandou continuam na conversa.', { okLabel: 'Apagar', danger: true })) return;
          state = await api('/api/professional/secretary', { method: 'DELETE' });
          paint();
          toast('Secretária apagada');
        }
      } catch (ex) { toast(ex.message, 'error'); b.disabled = false; }
    });
    api('/api/professional/secretary').then((d) => { state = d; paint(); })
      .catch((ex) => { root.innerHTML = `<p class="muted small">${esc(ex.message)}</p>`; });
  }

  // ---------- Painel da secretária: tira o que ela não pode ----------
  function lockPanel(me) {
    $$('[data-pro-only]').forEach((el) => el.remove());
    // Aviso fixo no topo
    const main = $('.panel-main');
    main?.insertAdjacentHTML('afterbegin', `<div class="sec-banner">${ic('user', 18)} <span>Você está no painel como <b>secretária de ${esc(me.name)}</b>.</span></div>`);
    // Meu perfil: só olhar (quem muda é o profissional). Mensagens prontas continuam liberadas.
    const form = $('[data-profile-form]');
    if (form) {
      $$('input, select, textarea, button', form).forEach((el) => { el.disabled = true; });
      $('button[type=submit]', form)?.remove();
      form.insertAdjacentHTML('afterbegin', '<div class="notice small" style="margin-bottom:12px">🔒 Só o profissional muda os dados do perfil.</div>');
    }
    $('[data-slug-form]')?.remove();
    $('[data-photo-input]')?.closest('label')?.remove();
    // Engrenagem: nada de nome, senha ou conta
    const conta = $('[data-view="conta"]');
    if (conta) {
      conta.innerHTML = `<h1 style="font-size:1.5rem">Configurações</h1>
        <div class="card stack">
          <p style="margin:0">Você está usando o painel como <b>secretária de ${esc(me.name)}</b>.</p>
          <p class="small muted" style="margin:0">Nome, senha, dados da conta e pagamento só o profissional muda. Se precisar de uma nova senha, peça para ele gerar em Meu perfil → Secretária.</p>
          <div class="row" style="gap:8px;flex-wrap:wrap"><button type="button" class="btn secondary" data-install>Instalar o app</button><button type="button" class="btn secondary" data-enable-push>Ativar notificações</button></div>
        </div>
        <button class="btn secondary block" style="margin-top:16px" data-sec-logout>Sair</button>
        <p class="small muted center" style="margin-top:16px">Acolia · versão 1.1.3</p>`;
      $('[data-sec-logout]', conta).addEventListener('click', () => window.Acolia.logout('/entrar#profissional'));
    }
  }

  // ---------- Chamadas (só o profissional) ----------
  let callsTimer = null;
  async function renderCalls(root) {
    const G = window.AcoliaAgenda;
    let list;
    try { list = await G.loadUpcoming(); } catch (ex) { root.innerHTML = `<p class="muted">${esc(ex.message)}</p>`; return; }
    const calls = list.filter((a) => a.status === 'confirmada').sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at));
    if (!calls.length) {
      root.innerHTML = `<div class="card empty-calls">${ic('video', 34)}<p style="margin:8px 0 0"><b>Nenhuma chamada marcada.</b></p><p class="small muted" style="margin:4px 0 0">Quando um paciente confirmar uma consulta, a chamada aparece aqui.</p></div>`;
      return;
    }
    const [first, ...rest] = calls;
    // Limite para o profissional entrar (horário + tolerância); depois disso o paciente é reembolsado
    const deadline = (a) => new Date(Date.parse(a.start_at) + (G.rules?.PRO_GRACE_MIN || 3) * 60e3)
      .toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
    const left = (a) => Date.parse(a.start_at) - Date.now();
    const status = (a) => (a.can.enter_call ? '<span class="badge ok">🎥 Chamada aberta</span>'
      : left(a) > 0 ? `<span class="badge">Faltam <b data-cd="${esc(a.start_at)}">${G.countdown(left(a))}</b></span>` : '<span class="badge warn">Acontecendo agora</span>');
    root.innerHTML = `<div class="card call-next">
        <div class="small muted" style="font-weight:800;letter-spacing:.04em">PRÓXIMA CHAMADA</div>
        <div class="row" style="gap:12px;flex-wrap:nowrap;align-items:center">${avatar(first.patient.name, first.patient.photo, 'lg')}
          <div class="grow" style="min-width:0"><h2 style="margin:0">${esc(first.patient.name)}</h2>
            <div class="muted">${esc(first.when)} · ${first.minutes} min</div><div style="margin-top:6px">${status(first)}</div></div></div>
        ${first.can.enter_call
          ? `<button type="button" class="btn block call-enter" data-call-enter="${first.id}">${ic('video', 22)} Entrar na chamada</button>`
          : '<p class="small muted" style="margin:0">O botão <b>Entrar na chamada</b> aparece aqui 5 minutos antes do horário.</p>'}
        <p class="small" style="margin:0">⏱️ Entre até as <b>${esc(deadline(first))}</b> (${G.rules?.PRO_GRACE_MIN || 3} minutos depois do horário). Depois disso a chamada fecha e o paciente é reembolsado.</p>
        <button type="button" class="btn ghost sm" data-call-chat="${first.id}">${ic('chat', 16)} Abrir a conversa</button>
      </div>
      ${rest.length ? `<h2 style="margin:20px 0 8px;font-size:1.05rem">Depois (${rest.length})</h2>
      <div class="call-rest">${rest.map((a) => `<button type="button" class="call-row" data-call-chat="${a.id}">
          ${avatar(a.patient.name, a.patient.photo, 'sm')}<span class="grow"><b>${esc(a.patient.name)}</b><span class="small muted">${esc(a.when)}</span></span></button>`).join('')}</div>` : ''}`;
  }
  function mountCalls(root) {
    root.addEventListener('click', (e) => {
      const en = e.target.closest('[data-call-enter]');
      const G = window.AcoliaAgenda;
      if (en) {
        const a = G.findAppt(Number(en.dataset.callEnter));
        if (a?.call_code) window.open(`/atendimento?codigo=${encodeURIComponent(a.call_code)}`, '_blank', 'noopener');
        return;
      }
      const ch = e.target.closest('[data-call-chat]');
      if (ch) {
        const a = G.findAppt(Number(ch.dataset.callChat));
        if (a?.conversation_id) location.hash = `conversas/${a.conversation_id}`;
      }
    });
    const load = () => renderCalls(root);
    window.AcoliaAgenda?.onChange(() => { if (!root.closest('.hidden')) load(); });
    clearInterval(callsTimer);
    callsTimer = setInterval(() => {
      if (root.closest('.hidden')) return;
      $$('[data-cd]', root).forEach((el) => { el.textContent = window.AcoliaAgenda.countdown(Date.parse(el.dataset.cd) - Date.now()); });
    }, 30000);
    return { load };
  }

  window.AcoliaSecretary = { card, lockPanel, mountCalls };
})();
