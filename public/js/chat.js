/* Acolia — chat estilo WhatsApp (usado pelo paciente e pelo profissional).
   Mensagens não podem ser apagadas; conversas podem ser arquivadas/desarquivadas. */
(function () {
  'use strict';
  const { $, $$, esc, api, ICONS, avatar, fmtTime, fmtDay, fmtShort, toast, modal, copyText } = window.Acolia;

  function mount(root, { role, me, socket, onUnreadChange = () => {}, onNavigate = () => {} }) {
    const getMe = typeof me === 'function' ? me : () => me;
    const state = { archived: false, list: [], current: null, messages: [], hasMore: false, loadingOlder: false, typingTimer: null };

    root.innerHTML = `
      <div class="chat">
        <aside class="chat-list" aria-label="Conversas">
          <div class="list-head row between">
            <h2 style="margin:0" data-title>Conversas</h2>
            <button class="btn ghost sm hidden" data-back-list>${ICONS.back} Voltar</button>
          </div>
          <div class="archived-link hidden" data-archived-link role="button" tabindex="0">${ICONS.archive}<span class="grow">Arquivadas</span><span class="unread hidden" data-archived-unread></span><span class="muted small" data-archived-count></span></div>
          <ul data-list></ul>
        </aside>
        <section class="chat-thread" aria-live="polite">
          <div class="chat-empty" data-empty>
            <div>${ICONS.chat.replace('<svg', '<svg style="width:64px;height:64px;opacity:.4;margin:0 auto 8px"')}
            <p>${role === 'patient' ? 'Escolha um profissional para conversar.' : 'Selecione uma conversa para responder.'}</p>
            <p class="small">As mensagens ficam salvas e não podem ser apagadas.</p></div>
          </div>
          <div class="hidden" data-thread style="display:contents"></div>
        </section>
      </div>`;

    const chatEl = $('.chat', root);
    const listEl = $('[data-list]', root);
    const threadWrap = $('[data-thread]', root);

    $('[data-archived-link]', root).addEventListener('click', () => { state.archived = true; renderListHead(); loadList(); });
    $('[data-archived-link]', root).addEventListener('keydown', (e) => { if (e.key === 'Enter') e.currentTarget.click(); });
    $('[data-back-list]', root).addEventListener('click', () => { state.archived = false; renderListHead(); loadList(); });

    function renderListHead() {
      $('[data-title]', root).textContent = state.archived ? 'Arquivadas' : 'Conversas';
      $('[data-back-list]', root).classList.toggle('hidden', !state.archived);
    }

    function previewOf(m) {
      if (!m) return 'Nenhuma mensagem ainda';
      const prefix = m.sender_role === role ? 'Você: ' : '';
      if (m.kind === 'pix') return `${prefix}Chave Pix enviada`;
      if (m.kind === 'call') return `${prefix}Código de atendimento`;
      return prefix + m.body;
    }

    async function loadList() {
      try {
        const data = await api(`/api/chat/conversations?archived=${state.archived ? 1 : 0}`);
        state.list = data.items;
        const link = $('[data-archived-link]', root);
        link.classList.toggle('hidden', state.archived || data.archived_count === 0);
        $('[data-archived-count]', root).textContent = data.archived_count || '';
        const au = $('[data-archived-unread]', root);
        au.textContent = data.archived_unread;
        au.classList.toggle('hidden', !data.archived_unread);
        renderList();
        refreshUnread();
      } catch (e) { toast(e.message, 'error'); }
    }

    function renderList() {
      if (!state.list.length) {
        listEl.innerHTML = `<li class="empty">${state.archived ? 'Nenhuma conversa arquivada.' : role === 'patient'
          ? 'Você ainda não tem conversas. Encontre um profissional e envie uma mensagem.' : 'Nenhuma conversa ainda. Quando um paciente enviar mensagem, ela aparece aqui.'}</li>`;
        return;
      }
      listEl.innerHTML = state.list.map((c) => `
        <li class="conv ${state.current?.id === c.id ? 'active' : ''}" data-id="${c.id}" tabindex="0">
          ${avatar(c.peer.name, c.peer.photo)}
          <div class="grow">
            <div class="top"><span class="nm">${esc(c.peer.name)}</span><span class="tm">${c.last_message ? fmtShort(c.last_message.created_at) : ''}</span></div>
            <div class="row" style="gap:8px;flex-wrap:nowrap"><span class="pv grow">${esc(previewOf(c.last_message))}</span>${c.unread ? `<span class="unread">${c.unread}</span>` : ''}</div>
          </div>
        </li>`).join('');
      $$('.conv', listEl).forEach((li) => {
        li.addEventListener('click', () => open(Number(li.dataset.id)));
        li.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(Number(li.dataset.id)); });
      });
    }

    async function refreshUnread() {
      try { onUnreadChange((await api('/api/chat/unread')).unread); } catch { /* ignora */ }
    }

    async function open(id) {
      try {
        const conv = await api(`/api/chat/conversations/${id}`);
        state.current = conv;
        const data = await api(`/api/chat/conversations/${id}/messages`);
        state.messages = data.items;
        state.hasMore = data.has_more;
        renderThread();
        chatEl.classList.add('open');
        onNavigate(id);
        markRead();
        $$('.conv', listEl).forEach((li) => li.classList.toggle('active', Number(li.dataset.id) === id));
      } catch (e) { toast(e.message, 'error'); }
    }

    function closeThread() {
      state.current = null;
      chatEl.classList.remove('open');
      threadWrap.classList.add('hidden');
      $('[data-empty]', root).classList.remove('hidden');
      onNavigate(null);
      loadList();
    }

    function renderThread() {
      const c = state.current;
      $('[data-empty]', root).classList.add('hidden');
      threadWrap.classList.remove('hidden');
      const proActions = role === 'professional' ? `
        <button class="icon-btn" title="Enviar chave Pix" aria-label="Enviar chave Pix" data-pix>${ICONS.pix}</button>
        <button class="icon-btn" title="Criar atendimento (chamada)" aria-label="Criar atendimento" data-call>${ICONS.video}</button>` : '';
      threadWrap.innerHTML = `
        <div class="thread-head">
          <button class="icon-btn back-btn" aria-label="Voltar" data-close>${ICONS.back}</button>
          ${avatar(c.peer.name, c.peer.photo, 'sm')}
          <div class="grow" style="min-width:0">
            <div class="nm">${esc(c.peer.name)}</div>
            <div class="sub" data-sub>${esc(c.peer.subtitle || '')}${c.peer.active ? '' : ' · conta inativa'}</div>
          </div>
          ${proActions}
          <button class="icon-btn" data-archive title="${c.archived ? 'Desarquivar' : 'Arquivar'}" aria-label="${c.archived ? 'Desarquivar conversa' : 'Arquivar conversa'}">${c.archived ? ICONS.unarchive : ICONS.archive}</button>
        </div>
        <div class="messages" data-messages></div>
        <form class="composer" data-composer>
          <textarea rows="1" placeholder="${c.peer.active ? 'Digite uma mensagem' : 'Esta conta não está mais ativa'}" aria-label="Mensagem" ${c.peer.active ? '' : 'disabled'} maxlength="4000"></textarea>
          <button class="btn send" type="submit" aria-label="Enviar" ${c.peer.active ? '' : 'disabled'}>${ICONS.send}</button>
        </form>`;
      renderMessages(true);

      $('[data-close]', threadWrap).addEventListener('click', closeThread);
      $('[data-archive]', threadWrap).addEventListener('click', toggleArchive);
      $('[data-pix]', threadWrap)?.addEventListener('click', sendPix);
      $('[data-call]', threadWrap)?.addEventListener('click', createCall);
      const form = $('[data-composer]', threadWrap);
      const ta = $('textarea', form);
      ta.addEventListener('input', () => {
        ta.style.height = 'auto';
        ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
        if (socket && !state.typingTimer) {
          socket.emit('chat:typing', { conversation_id: c.id });
          state.typingTimer = setTimeout(() => { state.typingTimer = null; }, 2500);
        }
      });
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(min-width: 801px)').matches) { e.preventDefault(); form.requestSubmit(); }
      });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = ta.value.trim();
        if (!body) return;
        ta.value = '';
        ta.style.height = 'auto';
        try {
          addMessage(await api(`/api/chat/conversations/${c.id}/messages`, { method: 'POST', body: { body } }));
        } catch (ex) { ta.value = body; toast(ex.message, 'error'); }
        ta.focus();
      });
      const box = $('[data-messages]', threadWrap);
      box.addEventListener('scroll', () => { if (box.scrollTop < 60) loadOlder(); });
    }

    function msgHtml(m) {
      const mine = m.sender_role === role;
      const ticks = mine ? `<span class="tick ${m.read_at ? 'read' : ''}" title="${m.read_at ? 'Lida' : 'Enviada'}">${m.read_at ? ICONS.checks : ICONS.check}</span>` : '';
      let inner;
      if (m.kind === 'pix') {
        inner = `<div class="msg-card"><strong>${ICONS.pix.replace('<svg', '<svg style="width:18px;height:18px;vertical-align:-3px"')} Chave Pix para pagamento</strong>
          <span class="code" style="font-size:1rem;word-break:break-all">${esc(m.body)}</span>
          <button type="button" class="btn secondary sm" data-copy="${esc(m.body)}">${ICONS.copy} Copiar chave</button></div>`;
      } else if (m.kind === 'call') {
        const link = `${location.origin}/atendimento?codigo=${encodeURIComponent(m.body)}`;
        inner = `<div class="msg-card"><strong>${ICONS.video.replace('<svg', '<svg style="width:18px;height:18px;vertical-align:-3px"')} Código de atendimento</strong>
          <span class="code">${esc(m.body)}</span>
          <span class="small muted">Use este código em “Entrar no atendimento”. Ele deixa de valer quando o atendimento for finalizado.</span>
          ${mine ? `<button type="button" class="btn secondary sm" data-copy="${esc(link)}">${ICONS.copy} Copiar link</button>`
            : `<a class="btn sm" href="${esc(link)}" target="_blank" rel="noopener">${ICONS.video} Entrar no atendimento</a>`}</div>`;
      } else {
        inner = esc(m.body);
      }
      return `<div class="msg ${mine ? 'me' : ''}" data-mid="${m.id}">${inner}<span class="when">${fmtTime(m.created_at)}${ticks}</span></div>`;
    }

    function renderMessages(scrollBottom) {
      const box = $('[data-messages]', threadWrap);
      if (!box) return;
      let lastDay = '';
      let html = state.hasMore ? '<div class="day-sep">Role para cima para ver mensagens anteriores</div>' : '';
      if (!state.messages.length) html += `<div class="day-sep">${role === 'patient' ? 'Envie uma mensagem para começar' : 'Sem mensagens'}</div>`;
      for (const m of state.messages) {
        const day = fmtDay(m.created_at);
        if (day !== lastDay) { html += `<div class="day-sep">${esc(day)}</div>`; lastDay = day; }
        html += msgHtml(m);
      }
      html += '<div class="typing hidden" data-typing>digitando…</div>';
      const prevHeight = box.scrollHeight;
      const prevTop = box.scrollTop;
      box.innerHTML = html;
      $$('[data-copy]', box).forEach((b) => b.addEventListener('click', () => copyText(b.dataset.copy)));
      if (scrollBottom) box.scrollTop = box.scrollHeight;
      else box.scrollTop = box.scrollHeight - prevHeight + prevTop;
    }

    async function loadOlder() {
      if (!state.hasMore || state.loadingOlder || !state.messages.length) return;
      state.loadingOlder = true;
      try {
        const data = await api(`/api/chat/conversations/${state.current.id}/messages?before=${state.messages[0].id}`);
        state.messages = [...data.items, ...state.messages];
        state.hasMore = data.has_more;
        renderMessages(false);
      } finally { state.loadingOlder = false; }
    }

    function addMessage(m) {
      if (state.messages.some((x) => x.id === m.id)) return;
      const box = $('[data-messages]', threadWrap);
      const nearBottom = box && box.scrollHeight - box.scrollTop - box.clientHeight < 120;
      state.messages.push(m);
      renderMessages(nearBottom || m.sender_role === role);
    }

    async function markRead() {
      if (!state.current) return;
      await api(`/api/chat/conversations/${state.current.id}/read`, { method: 'POST' }).catch(() => {});
      loadList();
    }

    async function toggleArchive() {
      const c = state.current;
      await api(`/api/chat/conversations/${c.id}/archive`, { method: 'POST', body: { archived: !c.archived } });
      toast(c.archived ? 'Conversa desarquivada' : 'Conversa arquivada');
      c.archived = !c.archived;
      state.archived = c.archived;
      renderListHead();
      renderThread();
      loadList();
    }

    async function sendPix() {
      const pixKey = getMe().pix_key;
      if (!pixKey) {
        return modal({ title: 'Chave Pix', html: '<p>Cadastre sua chave Pix em <b>Meu perfil</b> para enviá-la aos pacientes com um toque.</p>' });
      }
      const ok = await modal({
        title: 'Enviar chave Pix', html: `<p>Enviar a sua chave Pix para este paciente?</p><div class="code-box" style="font-size:1.1rem;letter-spacing:0">${esc(pixKey)}</div>`,
        actions: [{ label: 'Cancelar', value: false, class: 'secondary' }, { label: 'Enviar', value: true }],
      });
      if (!ok) return;
      try { addMessage(await api(`/api/chat/conversations/${state.current.id}/messages`, { method: 'POST', body: { kind: 'pix' } })); } catch (e) { toast(e.message, 'error'); }
    }

    async function createCall() {
      const c = state.current;
      const label = await modal({
        title: 'Criar atendimento',
        html: `<p class="muted">Será gerado um código para este paciente e ele será enviado aqui na conversa. Só é possível ter um atendimento aberto por vez.</p>
          <div class="field"><label for="callLabel">Nome do paciente (pode ser fictício)</label><input id="callLabel" maxlength="80" value="${esc(c.peer.name)}"></div>`,
        actions: [{ label: 'Cancelar', value: null, class: 'secondary' },
          { label: 'Criar e enviar código', handler: (dlg) => $('#callLabel', dlg).value.trim() || false }],
      });
      if (!label) return;
      try {
        await api('/api/calls', { method: 'POST', body: { patient_label: label, conversation_id: c.id } });
        const again = await api(`/api/chat/conversations/${c.id}/messages`);
        state.messages = again.items; state.hasMore = again.has_more;
        renderMessages(true);
        const go = await modal({
          title: 'Atendimento criado', html: '<p>O código foi enviado ao paciente. Deseja entrar na sala de atendimento agora?</p>',
          actions: [{ label: 'Depois', value: false, class: 'secondary' }, { label: 'Iniciar atendimento', value: true }],
        });
        if (go) window.open('/atendimento', '_blank', 'noopener');
      } catch (e) { toast(e.message, 'error'); }
    }

    // ---------- Tempo real ----------
    if (socket) {
      socket.on('message:new', (m) => {
        if (state.current && m.conversation_id === state.current.id) {
          addMessage(m);
          if (m.sender_role !== role && document.visibilityState === 'visible') markRead();
          else loadList();
        } else {
          loadList();
          if (m.sender_role !== role) notify(m);
        }
      });
      socket.on('message:read', ({ conversation_id }) => {
        if (state.current?.id === conversation_id) {
          state.messages.forEach((m) => { if (m.sender_role === role && !m.read_at) m.read_at = new Date().toISOString(); });
          renderMessages(false);
        }
      });
      socket.on('conversation:peer', () => loadList());
      socket.on('chat:typing', ({ conversation_id }) => {
        if (state.current?.id !== conversation_id) return;
        const t = $('[data-typing]', threadWrap);
        if (!t) return;
        t.classList.remove('hidden');
        clearTimeout(t._h);
        t._h = setTimeout(() => t.classList.add('hidden'), 3000);
      });
      socket.on('connect', () => { loadList(); if (state.current) open(state.current.id); });
    }
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.current) markRead(); });

    function notify() {
      toast('Nova mensagem recebida');
    }

    loadList();
    return { open, reload: loadList, close: closeThread, get current() { return state.current; } };
  }

  window.AcoliaChat = { mount };
})();
