/* Acolia — chat estilo WhatsApp (usado pelo paciente e pelo profissional).
   Apagar para mim / para todos, limpar conversa, bloquear (só mensagens) e arquivar. */
(function () {
  'use strict';
  const { $, $$, esc, api, ICONS, avatar, fmtTime, fmtDay, fmtShort, toast, modal, copyText, money } = window.Acolia;

  function mount(root, { role, me, socket, secretary = false, onUnreadChange = () => {}, onNavigate = () => {} }) {
    const getMe = typeof me === 'function' ? me : () => me;
    const state = { archived: false, list: [], current: null, messages: [], hasMore: false, loadingOlder: false, typingTimer: null, support: null };
    // Suporte Acolia: conversa fixa no topo (endereços próprios em /api/support)
    const isSup = () => !!state.current?.support;
    const SUP = { id: 'suporte', support: true, peer: { name: 'Suporte Acolia', photo: '/img/logo-simbolo.png', active: true, subtitle: 'Equipe Acolia · dúvidas, erros e sugestões' } };

    root.innerHTML = `
      <div class="chat">
        <aside class="chat-list" aria-label="Conversas">
          <div class="list-head row between">
            <h2 style="margin:0" data-title>Conversas</h2>
            <button class="btn ghost sm hidden" data-back-list>${ICONS.back} Voltar</button>
          </div>
          <div class="archived-link hidden" data-archived-link role="button" tabindex="0">${ICONS.archive}<span class="grow">Arquivadas</span><span class="unread hidden" data-archived-unread></span><span class="muted small" data-archived-count></span></div>
          <div class="archived-link hidden" data-blocked-link role="button" tabindex="0">${ICONS.ban}<span class="grow">Bloqueados</span><span class="muted small" data-blocked-count></span></div>
          <ul data-list></ul>
        </aside>
        <section class="chat-thread" aria-live="polite">
          <div class="chat-empty" data-empty>
            <div>${ICONS.chat.replace('<svg', '<svg style="width:64px;height:64px;opacity:.4;margin:0 auto 8px"')}
            <p>${role === 'patient' ? 'Escolha um profissional para conversar.' : 'Selecione uma conversa para responder.'}</p>
            <p class="small">Você pode apagar as suas mensagens para todos e, pelo ⋮ da conversa, limpar a conversa (só para você) ou bloquear.</p></div>
          </div>
          <div class="hidden" data-thread style="display:contents"></div>
        </section>
      </div>`;

    const chatEl = $('.chat', root);
    // Tocar fora fecha o menu ⋮ da conversa
    document.addEventListener('click', (e) => { if (!e.target.closest('.thread-menu-wrap')) $$('[data-thread-pop]', root).forEach((p) => p.classList.add('hidden')); });
    const listEl = $('[data-list]', root);
    const threadWrap = $('[data-thread]', root);

    $('[data-archived-link]', root).addEventListener('click', () => { state.archived = true; renderListHead(); loadList(); });
    $('[data-archived-link]', root).addEventListener('keydown', (e) => { if (e.key === 'Enter') e.currentTarget.click(); });
    $('[data-back-list]', root).addEventListener('click', () => { state.archived = false; renderListHead(); loadList(); });
    $('[data-blocked-link]', root).addEventListener('click', openBlocked);
    $('[data-blocked-link]', root).addEventListener('keydown', (e) => { if (e.key === 'Enter') openBlocked(); });

    // Bloqueados: quem eu bloqueei (dá para desbloquear e voltar a conversar)
    async function openBlocked() {
      let items = [];
      try { items = (await api('/api/chat/blocks')).items; } catch (e) { toast(e.message, 'error'); return; }
      await modal({
        title: 'Bloqueados',
        html: items.length ? `<p class="small muted" style="margin-top:0">Quem está aqui não consegue mandar mensagem para você (e você também não manda). O bloqueio é só das mensagens.</p>
          <ul class="blocked-list">${items.map((b) => `<li>${avatar(b.peer.name, b.peer.photo, 'sm')}<span class="grow"><b>${esc(b.peer.name)}</b><small class="muted">${esc(b.peer.subtitle || '')}</small></span>
            <button type="button" class="btn secondary sm" data-unblock="${b.conversation_id}">Desbloquear</button></li>`).join('')}</ul>`
          : '<p class="muted">Você não bloqueou ninguém.</p>',
        actions: [{ label: 'Fechar' }],
        onOpen: (dlg) => {
          dlg.addEventListener('click', async (e) => {
            const u = e.target.closest('[data-unblock]');
            if (!u) return;
            try {
              await api(`/api/chat/conversations/${u.dataset.unblock}/block`, { method: 'DELETE' });
              u.closest('li').remove();
              toast('Desbloqueado');
              loadList();
            } catch (ex) { toast(ex.message, 'error'); }
          });
        },
      });
    }

    function renderListHead() {
      $('[data-title]', root).textContent = state.archived ? 'Arquivadas' : 'Conversas';
      $('[data-back-list]', root).classList.toggle('hidden', !state.archived);
    }

    function previewOf(m) {
      if (!m) return 'Nenhuma mensagem ainda';
      const prefix = m.sender_role === role ? 'Você: ' : '';
      if (m.kind === 'pix') return `${prefix}Chave Pix enviada`;
      if (m.kind === 'call') return `${prefix}Código de atendimento`;
      if (m.kind === 'audio') return `${prefix}🎤 Áudio (${fmtSecs(audioParts(m.body).secs)})`;
      if (m.kind === 'deleted') return `${prefix}🚫 Mensagem apagada`;
      if (m.kind === 'doc') return `${prefix}📄 ${String(m.body).split('|')[1] || 'Documento'}`;
      if (m.kind === 'post') return `${prefix}📌 Publicação`;
      if (m.kind === 'booking') return prefix + (window.AcoliaAgenda ? AcoliaAgenda.previewText(m) : '📅 Consulta');
      return prefix + m.body;
    }

    async function loadList() {
      try {
        const [data, sup] = await Promise.all([api(`/api/chat/conversations?archived=${state.archived ? 1 : 0}`), api('/api/support').catch(() => null)]);
        state.list = data.items;
        state.support = sup;
        const link = $('[data-archived-link]', root);
        link.classList.toggle('hidden', state.archived || data.archived_count === 0);
        $('[data-archived-count]', root).textContent = data.archived_count || '';
        $('[data-blocked-link]', root).classList.toggle('hidden', state.archived || !data.blocked_count);
        $('[data-blocked-count]', root).textContent = data.blocked_count || '';
        const au = $('[data-archived-unread]', root);
        au.textContent = data.archived_unread;
        au.classList.toggle('hidden', !data.archived_unread);
        renderList();
        refreshUnread();
      } catch (e) { toast(e.message, 'error'); }
    }

    function renderList() {
      // Suporte Acolia fixo no topo (não arquiva, não bloqueia)
      const s = state.support;
      const pinned = !state.archived && s ? `
        <li class="conv pinned ${isSup() ? 'active' : ''}" data-support tabindex="0">
          <span class="avatar sup-avatar"><img src="/img/logo-simbolo.png" alt=""></span>
          <div class="grow">
            <div class="top"><span class="nm">${esc(s.name)} <span class="pin-ic" title="Conversa fixada" aria-label="Conversa fixada">📌</span></span><span class="tm">${s.last_message ? fmtShort(s.last_message.created_at) : ''}</span></div>
            <div class="row" style="gap:8px;flex-wrap:nowrap"><span class="pv grow">${esc(s.last_message ? previewOf(s.last_message) : 'Dúvidas, erros ou sugestões? Fale com a gente.')}</span>${s.unread ? `<span class="unread">${s.unread}</span>` : ''}</div>
          </div>
        </li>` : '';
      if (!state.list.length) {
        listEl.innerHTML = `${pinned}<li class="empty">${state.archived ? 'Nenhuma conversa arquivada.' : role === 'patient'
          ? 'Você ainda não tem conversas. Encontre um profissional e envie uma mensagem.' : 'Nenhuma conversa ainda. Quando um paciente enviar mensagem, ela aparece aqui.'}</li>`;
        bindSupportItem();
        return;
      }
      listEl.innerHTML = pinned + state.list.map((c) => `
        <li class="conv ${state.current?.id === c.id ? 'active' : ''}" data-id="${c.id}" tabindex="0">
          ${avatar(c.peer.name, c.peer.photo)}
          <div class="grow">
            <div class="top"><span class="nm">${esc(c.peer.name)}</span><span class="tm">${c.last_message ? fmtShort(c.last_message.created_at) : ''}</span></div>
            <div class="row" style="gap:8px;flex-wrap:nowrap"><span class="pv grow">${esc(previewOf(c.last_message))}</span>${c.unread ? `<span class="unread">${c.unread}</span>` : ''}</div>
          </div>
        </li>`).join('');
      $$('.conv:not([data-support])', listEl).forEach((li) => {
        li.addEventListener('click', () => open(Number(li.dataset.id)));
        li.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(Number(li.dataset.id)); });
      });
      bindSupportItem();
    }
    function bindSupportItem() {
      const li = $('[data-support]', listEl);
      if (!li) return;
      li.addEventListener('click', openSupport);
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter') openSupport(); });
    }

    async function refreshUnread() {
      try { onUnreadChange((await api('/api/chat/unread')).unread + (state.support?.unread || 0)); } catch { /* ignora */ }
    }

    async function openSupport() {
      try {
        const data = await api('/api/support/messages');
        state.current = { ...SUP };
        state.messages = data.items.map((m) => ({ ...m, support: true }));
        state.hasMore = data.has_more;
        renderThread();
        chatEl.classList.add('open');
        const toEnd = () => { const box = $('[data-messages]', threadWrap); if (box) box.scrollTop = box.scrollHeight; };
        requestAnimationFrame(toEnd);
        setTimeout(toEnd, 250);
        onNavigate('suporte');
        markRead();
        $$('.conv', listEl).forEach((li) => li.classList.toggle('active', li.hasAttribute('data-support')));
      } catch (e) { toast(e.message, 'error'); }
    }

    async function open(id) {
      if (id === 'suporte') return openSupport();
      try {
        const conv = await api(`/api/chat/conversations/${id}`);
        state.current = conv;
        const data = await api(`/api/chat/conversations/${id}/messages`);
        state.messages = data.items;
        state.hasMore = data.has_more;
        renderThread();
        chatEl.classList.add('open');
        // No celular a conversa só aparece agora: rola até a última mensagem depois que ela está na tela
        const toEnd = () => { const box = $('[data-messages]', threadWrap); if (box) box.scrollTop = box.scrollHeight; };
        requestAnimationFrame(toEnd);
        setTimeout(toEnd, 250);
        onNavigate(id);
        markRead();
        $$('.conv', listEl).forEach((li) => li.classList.toggle('active', Number(li.dataset.id) === id));
      } catch (e) { toast(e.message, 'error'); }
    }

    function closeThread() {
      const f = $('[data-composer]', threadWrap);
      if (f) stopRecording(f, 'cancel');
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
      if (c.support) { renderSupportThread(); return; }
      const proActions = role === 'professional' ? `
        <button class="icon-btn" title="Enviar chave Pix" aria-label="Enviar chave Pix" data-pix>${ICONS.pix}</button>
        ${secretary ? '' : `<button class="icon-btn" title="Documentos: atestado, receita, encaminhamento" aria-label="Documentos" data-docs>${ICONS.doc}</button>`}` : ''; // secretária não emite documentos (assinatura do profissional)
      threadWrap.innerHTML = `
        <div class="thread-head">
          <button class="icon-btn back-btn" aria-label="Voltar" data-close>${ICONS.back}</button>
          ${avatar(c.peer.name, c.peer.photo, 'sm')}
          <div class="grow" style="min-width:0">
            <div class="nm">${esc(c.peer.name)}</div>
            <div class="sub" data-sub>${esc(c.peer.subtitle || '')}${c.peer.active ? '' : ' · conta inativa'}</div>
          </div>
          ${proActions}
          <img class="brand-mark" src="/img/logo-simbolo.png" alt="Acolia" title="Acolia">
          <div class="thread-menu-wrap">
            <button class="icon-btn" data-thread-menu aria-label="Opções da conversa" title="Opções"><span style="font-size:1.3rem;line-height:1">⋮</span></button>
            <div class="msg-pop thread-pop hidden" data-thread-pop>
              <button type="button" data-archive>${c.archived ? ICONS.unarchive : ICONS.archive} ${c.archived ? 'Desarquivar conversa' : 'Arquivar conversa'}</button>
              <button type="button" data-clear>${ICONS.trash} Limpar conversa</button>
              <button type="button" data-block class="danger">${ICONS.ban} ${c.blocked_by_me ? 'Desbloquear' : 'Bloquear'} ${role === 'professional' ? 'paciente' : 'profissional'}</button>
            </div>
          </div>
        </div>
        ${c.blocked_by_me ? `<div class="block-banner">${ICONS.ban}<span class="grow">Você bloqueou este ${role === 'professional' ? 'paciente' : 'profissional'}. Ninguém consegue mandar mensagem nesta conversa.</span><button type="button" class="btn secondary sm" data-unblock-here>Desbloquear</button></div>`
          : c.blocked_me ? `<div class="block-banner">${ICONS.ban}<span class="grow">Não é possível enviar mensagens nesta conversa.</span></div>` : ''}
        <div class="messages-wrap">
          <div class="messages" data-messages></div>
        </div>
        <div data-pay-ask></div>
        <form class="composer" data-composer>
          ${role === 'professional' && window.AcoliaQuick ? `<button class="icon-btn quick-btn" type="button" data-quick aria-label="Mensagens prontas" title="Mensagens prontas" ${canWrite(c) ? '' : 'disabled'}>${ICONS.plus}</button>` : ''}
          ${role === 'professional' && window.AcoliaAgenda ? `<button class="icon-btn quick-btn" type="button" data-schedule aria-label="Marcar consulta" title="Marcar consulta para este paciente" ${canWrite(c) ? '' : 'disabled'}>${ICONS.calendar}</button>` : ''}
          <textarea rows="1" placeholder="${!c.peer.active ? 'Esta conta não está mais ativa' : c.blocked_by_me || c.blocked_me ? 'Mensagens bloqueadas' : c.refund_lock ? 'Faça o reembolso para voltar a conversar' : 'Digite uma mensagem'}" aria-label="Mensagem" ${canWrite(c) ? '' : 'disabled'} maxlength="4000"></textarea>
          <button class="icon-btn rec-cancel" type="button" data-rec-cancel aria-label="Apagar áudio" title="Apagar áudio">${ICONS.trash}</button>
          <div class="rec-bar" aria-live="polite"><span class="rec-dot"></span><b data-rec-time>0:00</b><div class="rec-live" data-rec-live></div>
            <button class="icon-btn rec-stop" type="button" data-rec-stop aria-label="Parar e ouvir antes de enviar" title="Parar e ouvir">${ICONS.stop}</button></div>
          <div class="rec-preview" data-rec-preview></div>
          <button class="btn send mic" type="button" data-mic aria-label="Gravar áudio" title="Gravar áudio" ${canWrite(c) ? '' : 'disabled'}>${ICONS.mic}</button>
          <button class="btn send" type="submit" data-send aria-label="Enviar" ${canWrite(c) ? '' : 'disabled'}>${ICONS.send}</button>
        </form>`;
      renderMessages(true);

      $('[data-close]', threadWrap).addEventListener('click', closeThread);
      const pop = $('[data-thread-pop]', threadWrap);
      $('[data-thread-menu]', threadWrap).addEventListener('click', (e) => { e.stopPropagation(); pop.classList.toggle('hidden'); });
      $('[data-archive]', threadWrap).addEventListener('click', () => { pop.classList.add('hidden'); toggleArchive(); });
      $('[data-clear]', threadWrap).addEventListener('click', () => { pop.classList.add('hidden'); clearConversation(); });
      $('[data-block]', threadWrap).addEventListener('click', () => { pop.classList.add('hidden'); toggleBlock(); });
      $('[data-unblock-here]', threadWrap)?.addEventListener('click', toggleBlock);
      $('[data-pix]', threadWrap)?.addEventListener('click', sendPix);
      // Agendar consulta pelo chat: o profissional escolhe dia e horário e o paciente paga o Pix
      $('[data-schedule]', threadWrap)?.addEventListener('click', () => {
        if (!canWrite(state.current)) { toast('Não é possível enviar nesta conversa.', 'error'); return; }
        window.AcoliaAgenda?.openBooking({ mode: 'propose', conversationId: state.current.id, patientId: state.current.peer.id, peerName: state.current.peer.name, me: getMe() });
      });
      $('[data-docs]', threadWrap)?.addEventListener('click', () => {
        if (!canWrite(state.current)) { toast('Não é possível enviar nesta conversa.', 'error'); return; }
        window.AcoliaDocs.openForm(state.current.id, (msg) => addMessage(msg));
      });
      const form = $('[data-composer]', threadWrap);
      const ta = $('textarea', form);
      // Igual ao WhatsApp: campo vazio mostra o microfone; com texto, o botão de enviar
      const syncButtons = () => form.classList.toggle('has-text', ta.value.trim().length > 0);
      syncButtons();
      $('[data-mic]', form).addEventListener('click', () => startRecording(form));
      // Mensagens prontas do profissional: escolhe uma e ela vai inteira para o campo de digitar
      $('[data-quick]', form)?.addEventListener('click', () => window.AcoliaQuick.openPicker(form, ta));
      $('[data-rec-cancel]', form).addEventListener('click', () => stopRecording(form, 'cancel'));
      $('[data-rec-stop]', form).addEventListener('click', () => stopRecording(form, 'preview'));
      ta.addEventListener('input', syncButtons);
      ta.addEventListener('input', () => {
        ta.style.height = 'auto';
        ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
        if (socket && !state.typingTimer && !isSup()) {
          socket.emit('chat:typing', { conversation_id: c.id });
          state.typingTimer = setTimeout(() => { state.typingTimer = null; }, 2500);
        }
      });
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(min-width: 801px)').matches) { e.preventDefault(); form.requestSubmit(); }
      });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (form.classList.contains('recording')) { stopRecording(form, 'send'); return; }
        if (form.classList.contains('previewing')) { sendRecording(form); return; }
        const body = ta.value.trim();
        if (!body) return;
        ta.value = '';
        ta.style.height = 'auto';
        syncButtons();
        try {
          addMessage(isSup() ? { ...(await api('/api/support/messages', { method: 'POST', body: { body } })), support: true }
            : await api(`/api/chat/conversations/${c.id}/messages`, { method: 'POST', body: { body } }));
        } catch (ex) { ta.value = body; toast(ex.message, 'error'); }
        ta.focus();
      });
      const box = $('[data-messages]', threadWrap);
      box.addEventListener('scroll', () => { if (box.scrollTop < 60) loadOlder(); });
      // ⋮ na mensagem → "Apagar mensagem"
      box.addEventListener('click', (e) => {
        const op = e.target.closest('[data-open-post]');
        if (op && !e.target.closest('[data-msg-menu]')) { window.AcoliaSocial?.openPost?.(Number(op.dataset.openPost)); return; }
        const b = e.target.closest('[data-msg-menu]');
        const old = $('.msg-pop', box);
        if (old) old.remove();
        if (!b) return;
        e.stopPropagation();
        const pop = document.createElement('div');
        pop.className = 'msg-pop';
        // Mensagem por mensagem: só as suas, e apaga para todos (para só você, use "Limpar conversa")
        pop.innerHTML = `<button type="button" data-del="everyone">${ICONS.trash} Apagar para todos</button>`;
        b.closest('.msg').appendChild(pop);
        pop.addEventListener('click', (ev) => {
          const d = ev.target.closest('[data-del]');
          if (!d) return;
          ev.stopPropagation();
          pop.remove();
          deleteMessage(Number(b.dataset.msgMenu), d.dataset.del);
        });
      });
    }

    // ---------- Suporte Acolia: conversa com a equipe (texto, foto e áudio) ----------
    function renderSupportThread() {
      const c = state.current;
      threadWrap.innerHTML = `
        <div class="thread-head">
          <button class="icon-btn back-btn" aria-label="Voltar" data-close>${ICONS.back}</button>
          <span class="avatar sm sup-avatar"><img src="/img/logo-simbolo.png" alt=""></span>
          <div class="grow" style="min-width:0">
            <div class="nm">${esc(c.peer.name)}</div>
            <div class="sub">${esc(c.peer.subtitle)}</div>
          </div>
          <div class="thread-menu-wrap">
            <button class="icon-btn" data-thread-menu aria-label="Opções da conversa" title="Opções"><span style="font-size:1.3rem;line-height:1">⋮</span></button>
            <div class="msg-pop thread-pop hidden" data-thread-pop>
              <button type="button" data-clear>${ICONS.trash} Limpar conversa</button>
            </div>
          </div>
        </div>
        <div class="sup-note small">Tire dúvidas, avise se algo deu erro ou mande sugestões. Pode mandar <b>foto</b> e <b>áudio</b>. A equipe Acolia responde por aqui.</div>
        <div class="messages-wrap"><div class="messages" data-messages></div></div>
        <form class="composer" data-composer>
          <label class="icon-btn quick-btn" title="Enviar foto" aria-label="Enviar foto">${ICONS.camera}<input type="file" accept="image/jpeg,image/png,image/webp" data-sup-photo hidden></label>
          <textarea rows="1" placeholder="Escreva para o suporte" aria-label="Mensagem" maxlength="4000"></textarea>
          <button class="icon-btn rec-cancel" type="button" data-rec-cancel aria-label="Apagar áudio" title="Apagar áudio">${ICONS.trash}</button>
          <div class="rec-bar" aria-live="polite"><span class="rec-dot"></span><b data-rec-time>0:00</b><div class="rec-live" data-rec-live></div>
            <button class="icon-btn rec-stop" type="button" data-rec-stop aria-label="Parar e ouvir antes de enviar" title="Parar e ouvir">${ICONS.stop}</button></div>
          <div class="rec-preview" data-rec-preview></div>
          <button class="btn send mic" type="button" data-mic aria-label="Gravar áudio" title="Gravar áudio">${ICONS.mic}</button>
          <button class="btn send" type="submit" data-send aria-label="Enviar">${ICONS.send}</button>
        </form>`;
      renderMessages(true);
      $('[data-close]', threadWrap).addEventListener('click', closeThread);
      const pop = $('[data-thread-pop]', threadWrap);
      $('[data-thread-menu]', threadWrap).addEventListener('click', (e) => { e.stopPropagation(); pop.classList.toggle('hidden'); });
      $('[data-clear]', threadWrap).addEventListener('click', () => { pop.classList.add('hidden'); clearConversation(); });
      const form = $('[data-composer]', threadWrap);
      const ta = $('textarea', form);
      const syncButtons = () => form.classList.toggle('has-text', ta.value.trim().length > 0);
      syncButtons();
      $('[data-mic]', form).addEventListener('click', () => startRecording(form));
      $('[data-rec-cancel]', form).addEventListener('click', () => stopRecording(form, 'cancel'));
      $('[data-rec-stop]', form).addEventListener('click', () => stopRecording(form, 'preview'));
      ta.addEventListener('input', () => { syncButtons(); ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 140) + 'px'; });
      ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(min-width: 801px)').matches) { e.preventDefault(); form.requestSubmit(); } });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (form.classList.contains('recording')) { stopRecording(form, 'send'); return; }
        if (form.classList.contains('previewing')) { sendRecording(form); return; }
        const body = ta.value.trim();
        if (!body) return;
        ta.value = ''; ta.style.height = 'auto'; syncButtons();
        try { addMessage({ ...(await api('/api/support/messages', { method: 'POST', body: { body } })), support: true }); } catch (ex) { ta.value = body; toast(ex.message, 'error'); }
        ta.focus();
      });
      // Foto: diminui antes de enviar (até 3 MB)
      $('[data-sup-photo]', form).addEventListener('change', async (e) => {
        const file = e.target.files[0];
        e.target.value = '';
        if (!file) return;
        try {
          const img = await Acolia.shrinkImage(file);
          const fd = new FormData();
          fd.append('photo', img, 'foto.jpg');
          toast('Enviando foto…');
          addMessage({ ...(await api('/api/support/photo', { method: 'POST', form: fd })), support: true });
        } catch (ex) { toast(ex.message, 'error'); }
      });
      const box = $('[data-messages]', threadWrap);
      box.addEventListener('scroll', () => { if (box.scrollTop < 60) loadOlder(); });
      box.addEventListener('click', (e) => {
        const im = e.target.closest('[data-img]');
        if (im && !e.target.closest('[data-msg-menu]')) { modal({ title: 'Foto', html: `<img src="${esc(im.dataset.img)}" alt="" style="width:100%;border-radius:12px">`, actions: [{ label: 'Fechar' }] }); return; }
        const b = e.target.closest('[data-msg-menu]');
        const old = $('.msg-pop', box);
        if (old) old.remove();
        if (!b) return;
        e.stopPropagation();
        const p = document.createElement('div');
        p.className = 'msg-pop';
        p.innerHTML = `<button type="button" data-del="everyone">${ICONS.trash} Apagar para todos</button>`;
        b.closest('.msg').appendChild(p);
        p.addEventListener('click', (ev) => { if (!ev.target.closest('[data-del]')) return; ev.stopPropagation(); p.remove(); deleteMessage(Number(b.dataset.msgMenu), 'everyone'); });
      });
    }

    // ---------- Áudio (mensagem de voz) ----------
    function audioParts(body) {
      const [file, secs, peaks] = String(body).split('|');
      return { file, secs: Number(secs) || 0, peaks: peaks || '' };
    }
    function fmtSecs(t) { return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`; }

    // Gravar (estilo WhatsApp): microfone → gravando com as barrinhas da voz ao vivo →
    // ■ para e ouve antes de enviar → ➤ envia (ou 🗑 descarta)
    const MAX_REC_SECS = 300; // 5 minutos
    const rec = { recorder: null, result: null, previewUrl: null };

    function setMode(form, mode) {
      form.classList.toggle('recording', mode === 'recording');
      form.classList.toggle('previewing', mode === 'preview');
    }

    async function startRecording(form) {
      const V = window.AcoliaVoice;
      if (!V?.Recorder.supported()) {
        toast('Seu navegador não permite gravar áudio. Atualize o navegador.', 'error');
        return;
      }
      V.stopAll();
      const live = $('[data-rec-live]', form);
      const clock = $('[data-rec-time]', form);
      live.innerHTML = '';
      clock.textContent = '0:00';
      rec.result = null;
      rec.recorder = new V.Recorder({
        maxSecs: MAX_REC_SECS,
        onMax: () => stopRecording(form, 'preview'),
        onLevel: (level, secs) => {
          clock.textContent = V.fmt(secs);
          const bar = document.createElement('i');
          bar.style.height = `${12 + Math.round(level * 88)}%`; // parado = pontinho; falando alto = barra grande
          live.appendChild(bar);
          while (live.childElementCount > 60) live.firstElementChild.remove();
        },
      });
      setMode(form, 'recording'); // a barra aparece na hora do toque
      const r = rec.recorder;
      try {
        await r.start();
      } catch {
        if (rec.recorder === r) rec.recorder = null;
        setMode(form, 'idle');
        toast('Libere o microfone no navegador para gravar áudio.', 'error');
        return;
      }
      if (rec.recorder !== r) r.cancel(); // cancelou enquanto o microfone ligava
    }

    // mode: 'preview' (para e deixa ouvir), 'send' (para e envia), 'cancel' (descarta)
    function stopRecording(form, mode) {
      if (rec.recorder) {
        const r = rec.recorder;
        rec.recorder = null;
        if (mode === 'cancel') r.cancel();
        else rec.result = r.stop();
      }
      if (mode === 'cancel' || !rec.result) { discardRecording(form); return; }
      if (rec.result.secs < 1) { toast('Áudio muito curto.'); discardRecording(form); return; }
      if (mode === 'send') { sendRecording(form); return; }
      // Prévia: ouvir antes de enviar
      if (rec.previewUrl) URL.revokeObjectURL(rec.previewUrl);
      rec.previewUrl = URL.createObjectURL(rec.result.blob);
      $('[data-rec-preview]', form).innerHTML = window.AcoliaVoice.playerHtml({ src: rec.previewUrl, secs: rec.result.secs, peaks: rec.result.peaks });
      setMode(form, 'preview');
    }

    function discardRecording(form) {
      window.AcoliaVoice?.stopAll();
      rec.result = null;
      if (rec.previewUrl) { URL.revokeObjectURL(rec.previewUrl); rec.previewUrl = null; }
      if (form) { $('[data-rec-preview]', form).innerHTML = ''; setMode(form, 'idle'); }
    }

    async function sendRecording(form) {
      const r = rec.result;
      const c = state.current;
      discardRecording(form);
      if (!r || !c) return;
      const fd = new FormData();
      fd.append('duration', String(Math.round(r.secs)));
      fd.append('peaks', r.peaks);
      fd.append('audio', r.blob, 'audio.wav');
      try {
        addMessage(c.support ? { ...(await api('/api/support/audio', { method: 'POST', form: fd })), support: true }
          : await api(`/api/chat/conversations/${c.id}/audio`, { method: 'POST', form: fd }));
      } catch (ex) { toast(ex.message, 'error'); }
    }

    // ---------- Apagar mensagem ----------
    // Uma a uma: "Apagar para todos" (só as suas) — os dois lados passam a ver "Mensagem apagada".
    // Para apagar só para você (as suas e as do outro), use "Limpar conversa" no ⋮ da conversa.
    async function deleteMessage(id, mode) {
      const ok = await Acolia.confirmDialog(mode === 'everyone'
        ? 'Apagar esta mensagem para todos? Para você e para a outra pessoa vai aparecer "Mensagem apagada".'
        : 'Apagar esta mensagem só para você? A outra pessoa continua vendo.', { okLabel: 'Apagar', danger: true, title: mode === 'everyone' ? 'Apagar para todos' : 'Apagar para mim' });
      if (!ok) return;
      try {
        if (isSup()) await api(`/api/support/messages/${id}/delete`, { method: 'POST' });
        else await api(`/api/chat/messages/${id}/delete`, { method: 'POST', body: { for: mode } });
        if (mode === 'everyone') markDeleted(id); else removeMessage(id);
        loadList();
      } catch (ex) { toast(ex.message, 'error'); }
    }

    function removeMessage(id) {
      const before = state.messages.length;
      state.messages = state.messages.filter((x) => x.id !== id);
      if (state.messages.length !== before) renderMessages(false);
    }

    function markDeleted(id) {
      const m = state.messages.find((x) => x.id === id);
      if (!m) return;
      m.kind = 'deleted';
      m.body = '';
      const el = $(`[data-mid="${id}"]`, threadWrap);
      if (el) el.outerHTML = msgHtml(m);
    }

    // Reembolso manual pendente: o profissional não escreve para este paciente até ele confirmar
    const canWrite = (c) => c.peer.active && !c.blocked_by_me && !c.blocked_me && !c.refund_lock;

    // Limpar conversa: apaga todas as mensagens só para você
    async function clearConversation() {
      if (!await Acolia.confirmDialog('Limpar esta conversa? Todas as mensagens somem para você. A outra pessoa continua vendo as dela.', { okLabel: 'Limpar', danger: true, title: 'Limpar conversa' })) return;
      try {
        await api(isSup() ? '/api/support/clear' : `/api/chat/conversations/${state.current.id}/clear`, { method: 'POST' });
        state.messages = [];
        state.hasMore = false;
        renderMessages(true);
        loadList();
        toast('Conversa limpa');
      } catch (ex) { toast(ex.message, 'error'); }
    }

    // Bloquear (só as mensagens) / desbloquear
    async function toggleBlock() {
      const c = state.current;
      const who = role === 'professional' ? 'paciente' : 'profissional';
      if (!c.blocked_by_me) {
        const ok = await Acolia.confirmDialog(`Bloquear este ${who}? Ele não vai conseguir mandar mensagem para você e as mensagens desta conversa serão apagadas para você. ${role === 'patient' ? 'Você continua vendo o perfil, as fotos e os vídeos dele. ' : ''}Dá para desbloquear em "Bloqueados".`, { okLabel: 'Bloquear', danger: true, title: `Bloquear ${who}` });
        if (!ok) return;
      }
      try {
        const upd = await api(`/api/chat/conversations/${c.id}/block`, { method: c.blocked_by_me ? 'DELETE' : 'POST' });
        toast(upd.blocked_by_me ? `${who[0].toUpperCase()}${who.slice(1)} bloqueado` : 'Desbloqueado');
        if (upd.blocked_by_me) { closeThread(); return; }
        state.current = upd;
        renderThread();
        loadList();
      } catch (ex) { toast(ex.message, 'error'); }
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
      } else if (m.kind === 'audio') {
        const a = audioParts(m.body);
        inner = window.AcoliaVoice.playerHtml({ src: `${m.support ? '/api/support/audio/' : '/api/chat/audio/'}${encodeURIComponent(a.file)}`, secs: a.secs, peaks: a.peaks, hint: true });
      } else if (m.kind === 'image') {
        // Foto (só no Suporte Acolia)
        inner = `<button type="button" class="msg-img" data-img="${esc(m.body)}" aria-label="Ver foto"><img src="${esc(m.body)}" alt="Foto" loading="lazy"></button>`;
      } else if (m.kind === 'doc') {
        // Documento (atestado, receita, encaminhamento): abre a folha para ver e salvar
        const [code, title] = String(m.body).split('|');
        inner = `<div class="msg-card doc-card"><strong>${ICONS.doc.replace('<svg', '<svg style="width:20px;height:20px;vertical-align:-4px"')} ${esc(title || 'Documento')}</strong>
          <span class="small muted">Código de verificação: <b>${esc(code)}</b></span>
          <button type="button" class="btn ${mine ? 'secondary' : ''} sm" data-open-doc="${esc(code)}">${ICONS.doc} ${mine ? 'Ver documento' : 'Ver e salvar documento'}</button></div>`;
      } else if (m.kind === 'post') {
        inner = postCardHtml(m.post, mine);
      } else if (m.kind === 'booking') {
        // Cartão da consulta: só o mais recente de cada consulta mostra os botões
        inner = window.AcoliaAgenda ? AcoliaAgenda.chatCardHtml(m, role, m.booking && latestBooking[m.booking.id] === m.id) : '📅 Consulta';
      } else if (m.kind === 'deleted') {
        inner = `<span class="msg-deleted">${ICONS.ban} Mensagem apagada</span>`;
      } else {
        inner = esc(m.body);
      }
      const menu = mine && m.kind !== 'deleted' && m.kind !== 'booking'
        ? `<button type="button" class="msg-menu" data-msg-menu="${m.id}" aria-label="Opções da mensagem" title="Opções">⋮</button>` : '';
      // Mandada pela secretária (só o profissional e a secretária veem este selo)
      const sec = m.secretary_id && role === 'professional' ? '<span class="sec-tag">Secretária</span>' : '';
      return `<div class="msg ${mine ? 'me' : ''} ${m.kind === 'audio' ? 'is-audio' : ''}" data-mid="${m.id}">${menu}${inner}<span class="when">${sec}${fmtTime(m.created_at)}${ticks}</span></div>`;
    }

    // Publicação enviada pelo paciente (a partir do botão "Mensagem" do post)
    function postCardHtml(p, mine) {
      if (!p) return `<div class="msg-card chat-post off">${ICONS.ban} <span>Publicação indisponível</span></div>`;
      const media = p.kind === 'text'
        ? `<div class="cp-text text-post font-${esc(p.font || 'padrao')}">${esc(p.caption.slice(0, 140))}</div>`
        : `<div class="cp-media"><img src="${esc(p.image)}" alt="" loading="lazy">${p.kind === 'reel' ? `<span class="cp-play">${ICONS.play || '▶'}</span>` : ''}</div>`;
      return `<button type="button" class="msg-card chat-post" data-open-post="${p.id}" aria-label="Abrir publicação">
        <span class="cp-head small">${mine ? 'Você enviou' : 'Enviou'} ${p.kind === 'reel' ? 'um vídeo' : p.kind === 'text' ? 'um texto' : 'uma foto'} de <b>${esc(p.author)}</b></span>
        ${media}
        ${p.kind !== 'text' && p.caption ? `<span class="cp-cap small">${esc(p.caption)}</span>` : ''}
        <span class="cp-open small">Ver publicação</span></button>`;
    }

    let latestBooking = {};
    function renderMessages(scrollBottom) {
      const box = $('[data-messages]', threadWrap);
      if (!box) return;
      let lastDay = '';
      let html = state.hasMore ? '<div class="day-sep">Role para cima para ver mensagens anteriores</div>' : '';
      if (!state.messages.length) html += `<div class="day-sep">${role === 'patient' ? 'Envie uma mensagem para começar' : 'Sem mensagens'}</div>`;
      latestBooking = {};
      for (const m of state.messages) if (m.kind === 'booking' && m.booking) latestBooking[m.booking.id] = m.id;
      for (const m of state.messages) {
        const day = fmtDay(m.created_at);
        if (day !== lastDay) { html += `<div class="day-sep">${esc(day)}</div>`; lastDay = day; }
        html += msgHtml(m);
      }
      html += '<div class="typing hidden" data-typing>digitando…</div>';
      renderPayAsk();
      const prevHeight = box.scrollHeight;
      const prevTop = box.scrollTop;
      box.innerHTML = html;
      $$('[data-copy]', box).forEach((b) => b.addEventListener('click', () => copyText(b.dataset.copy)));
      $$('[data-open-doc]', box).forEach((b) => b.addEventListener('click', () => window.AcoliaDocs.openDoc(b.dataset.openDoc)));
      if (scrollBottom) box.scrollTop = box.scrollHeight;
      else box.scrollTop = box.scrollHeight - prevHeight + prevTop;
      // Foto de publicação que termina de carregar depois: continua no fim da conversa
      if (scrollBottom) $$('img', box).forEach((im) => { if (!im.complete) im.addEventListener('load', () => { box.scrollTop = box.scrollHeight; }, { once: true }); });
    }

    // Profissional/secretária: "O paciente fez o pagamento?" em cima do campo de mensagem (Pix manual),
    // enquanto ainda dá para conversar (ex.: perguntar o nome de quem pagou)
    let payAskTimer = null;
    function renderPayAsk() {
      const el = $('[data-pay-ask]', threadWrap);
      if (!el) return;
      clearInterval(payAskTimer);
      const ask = role === 'professional' ? state.messages.filter((m) => m.kind === 'booking' && m.booking?.can?.approve && latestBooking[m.booking.id] === m.id).map((m) => m.booking).pop() : null;
      if (!ask) { el.innerHTML = ''; el.className = ''; return; }
      el.className = 'pay-ask';
      el.innerHTML = `<span class="grow">💰 O paciente fez o pagamento de <b>${money(ask.price_cents)}</b>? <span class="small muted">(${esc(ask.when)})</span> <span class="pa-time" data-pa-time></span></span>
        <button type="button" class="btn sm" data-ag-act="approve" data-ag-id="${ask.id}">Sim</button>
        <button type="button" class="btn sm secondary" data-ag-act="reject" data-ag-id="${ask.id}">Não</button>`;
      const tick = () => {
        const left = Date.parse(ask.hold_until) - Date.now();
        const t = $('[data-pa-time]', el);
        if (!t) return clearInterval(payAskTimer);
        t.textContent = left > 0 ? `· ${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}` : '· tempo para pagar acabou';
      };
      tick();
      payAskTimer = setInterval(tick, 1000);
    }

    async function loadOlder() {
      if (!state.hasMore || state.loadingOlder || !state.messages.length) return;
      state.loadingOlder = true;
      try {
        const sup = isSup();
        const data = await api(sup ? `/api/support/messages?before=${state.messages[0].id}` : `/api/chat/conversations/${state.current.id}/messages?before=${state.messages[0].id}`);
        state.messages = [...data.items.map((m) => (sup ? { ...m, support: true } : m)), ...state.messages];
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
      await api(isSup() ? '/api/support/read' : `/api/chat/conversations/${state.current.id}/read`, { method: 'POST' }).catch(() => {});
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

    // ---------- Consultas: botões dos cartões e atualização quando a consulta muda ----------
    if (window.AcoliaAgenda) {
      AcoliaAgenda.bindActions(threadWrap, (id) => [...state.messages].reverse().find((m) => m.kind === 'booking' && m.booking?.id === id)?.booking);
      AcoliaAgenda.onChange(() => refreshThread());
    }
    let refreshing = null;
    async function refreshThread() {
      const c = state.current;
      if (!c) return;
      if (c.support) {
        try { const d = await api('/api/support/messages'); if (isSup()) { state.messages = d.items.map((m) => ({ ...m, support: true })); state.hasMore = d.has_more; renderMessages(false); } } catch { /* ignora */ }
        return;
      }
      clearTimeout(refreshing);
      refreshing = setTimeout(async () => {
        try {
          const [conv, data] = await Promise.all([api(`/api/chat/conversations/${c.id}`), api(`/api/chat/conversations/${c.id}/messages`)]);
          if (state.current?.id !== c.id) return;
          const lockChanged = conv.refund_lock !== state.current.refund_lock;
          state.current = conv;
          state.messages = data.items;
          state.hasMore = data.has_more;
          if (lockChanged) renderThread(); else renderMessages(false);
        } catch { /* conversa sumiu */ }
      }, 300);
    }

    // ---------- Tempo real ----------
    if (socket) {
      socket.on('message:deleted', ({ id, conversation_id: cid }) => {
        if (state.current && cid === state.current.id) markDeleted(id);
        loadList();
      });
      // Eu apaguei (em outro aparelho): some daqui também
      socket.on('message:removed', ({ id, conversation_id: cid }) => {
        if (state.current && cid === state.current.id) removeMessage(id);
        loadList();
      });
      // Bloqueio/desbloqueio: atualiza a conversa aberta (campo de mensagem liberado ou não)
      socket.on('chat:block', async ({ conversation_id: cid }) => {
        if (state.current?.id === cid) {
          try { state.current = await api(`/api/chat/conversations/${cid}`); renderThread(); } catch { closeThread(); }
        }
        loadList();
      });
      socket.on('message:new', async (m) => {
        // Cartão de consulta chegou pelo tempo real: busca a situação dela (com os botões certos)
        if (m.kind === 'booking' && !m.booking) {
          const [id, event, extra] = String(m.body).split('|');
          m.event = event; m.extra = extra;
          try { m.booking = await api(`/api/agenda/appointments/${id}`); } catch { m.booking = null; }
        }
        if (state.current && m.conversation_id === state.current.id) {
          addMessage(m);
          if (m.sender_role !== role && document.visibilityState === 'visible') markRead();
          else loadList();
        } else {
          loadList();
          if (m.sender_role !== role) notify(m);
        }
      });
      // Suporte Acolia
      socket.on('support:new', (m) => {
        if (isSup()) {
          addMessage({ ...m, support: true });
          if (m.sender_role === 'admin' && document.visibilityState === 'visible') markRead(); else loadList();
        } else {
          loadList();
          if (m.sender_role === 'admin') toast('Nova mensagem do Suporte Acolia');
        }
      });
      socket.on('support:changed', () => { if (isSup()) refreshThread(); loadList(); });
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
      socket.on('connect', () => { loadList(); if (state.current) open(state.current.support ? 'suporte' : state.current.id); });
    }
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.current) markRead(); });

    function notify() {
      toast('Nova mensagem recebida');
    }

    loadList();
    return { open, openSupport, reload: loadList, close: closeThread, get current() { return state.current; } };
  }

  window.AcoliaChat = { mount };
})();
