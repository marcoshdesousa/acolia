/* Painel do administrador — Mensagens:
   - Suporte Acolia: conversas de quem escreveu (profissionais, secretárias e pacientes); responder com
     texto ou foto.
   - Mensagem para todos os profissionais (aparece na conversa de suporte de cada um).
   - Avisos (sininho): para pacientes, profissionais ou todos, com foto opcional (vídeo não). */
(function () {
  'use strict';
  const { $, $$, esc, api, toast, avatar, fmtTime, fmtDay, fmtShort, confirmDialog, shrinkImage, modal } = window.Acolia;
  const root = $('[data-view="mensagens"]');
  if (!root) return;
  const panes = { suporte: $('[data-msg-pane="suporte"]', root), todos: $('[data-msg-pane="todos"]', root), avisos: $('[data-msg-pane="avisos"]', root) };
  let current = null; // conversa de suporte aberta
  let filter = '';

  // ---------- Abas ----------
  function tab(name) {
    $$('[data-msg-tab]', root).forEach((b) => b.classList.toggle('on', b.dataset.msgTab === name));
    Object.entries(panes).forEach(([k, el]) => el.classList.toggle('hidden', k !== name));
    if (name === 'suporte') loadThreads();
    if (name === 'todos') renderBroadcast();
    if (name === 'avisos') loadNotices();
  }
  $$('[data-msg-tab]', root).forEach((b) => b.addEventListener('click', () => tab(b.dataset.msgTab)));

  // ---------- Suporte ----------
  const who = (u) => (u.role === 'patient' ? 'Paciente' : `Profissional${u.profession ? ` · ${u.profession}` : ''}`);
  const preview = (m) => (!m ? '' : m.kind === 'image' ? '📷 Foto' : m.kind === 'audio' ? '🎤 Áudio' : m.kind === 'deleted' ? 'Mensagem apagada' : m.body);
  async function loadThreads() {
    const pane = panes.suporte;
    if (!pane.dataset.ready) {
      pane.dataset.ready = '1';
      pane.innerHTML = `<div class="sup-admin">
          <aside class="card flat sup-list-wrap">
            <div class="row" style="gap:6px;flex-wrap:wrap;margin-bottom:8px">
              <button type="button" class="chip-btn on" data-sup-filter="">Todos</button>
              <button type="button" class="chip-btn" data-sup-filter="professional">Profissionais</button>
              <button type="button" class="chip-btn" data-sup-filter="patient">Pacientes</button>
            </div>
            <ul class="sup-list" data-sup-list></ul>
          </aside>
          <div class="card flat sup-thread" data-sup-thread><p class="muted small" style="margin:0">Escolha uma conversa. Só aparece quem já escreveu para o suporte.</p></div>
        </div>`;
      $$('[data-sup-filter]', pane).forEach((b) => b.addEventListener('click', () => {
        filter = b.dataset.supFilter;
        $$('[data-sup-filter]', pane).forEach((x) => x.classList.toggle('on', x === b));
        loadThreads();
      }));
    }
    let data;
    try { data = await api(`/api/admin/support/threads${filter ? `?role=${filter}` : ''}`); } catch (e) { toast(e.message, 'error'); return; }
    setBadge(data.unread);
    const list = $('[data-sup-list]', pane);
    list.innerHTML = data.items.length ? data.items.map((t) => `
      <li class="conv ${current === t.id ? 'active' : ''}" data-sup-id="${t.id}" tabindex="0">
        ${avatar(t.user.name, t.user.photo)}
        <div class="grow" style="min-width:0">
          <div class="top"><span class="nm">${esc(t.user.name)}</span><span class="tm">${t.last_message ? fmtShort(t.last_message.created_at) : ''}</span></div>
          <div class="small muted">${esc(who(t.user))}${t.user.is_test ? ' · teste' : ''}</div>
          <div class="row" style="gap:8px;flex-wrap:nowrap"><span class="pv grow">${esc(preview(t.last_message))}</span>${t.unread ? `<span class="unread">${t.unread}</span>` : ''}</div>
        </div>
      </li>`).join('') : '<li class="empty">Nenhuma mensagem ainda.</li>';
    $$('[data-sup-id]', list).forEach((li) => li.addEventListener('click', () => openThread(Number(li.dataset.supId))));
  }

  function bubble(t, m) {
    const mine = m.sender === 'admin';
    let inner;
    if (m.kind === 'image') inner = `<button type="button" class="msg-img" data-img="${esc(m.body)}"><img src="${esc(m.body)}" alt="Foto"></button>`;
    else if (m.kind === 'audio') {
      const [file, secs, peaks] = String(m.body).split('|');
      inner = window.AcoliaVoice ? AcoliaVoice.playerHtml({ src: `/api/admin/support/threads/${t}/audio/${encodeURIComponent(file)}`, secs: Number(secs), peaks: peaks || '' }) : '🎤 Áudio';
    } else if (m.kind === 'deleted') inner = '<span class="msg-deleted">Mensagem apagada</span>';
    else inner = esc(m.body);
    const tag = m.secretary_id ? '<span class="sec-tag">Secretária</span>' : m.broadcast ? '<span class="sec-tag">Para todos</span>' : '';
    const menu = mine && m.kind !== 'deleted' ? `<button type="button" class="msg-menu" data-del-msg="${m.id}" aria-label="Apagar" title="Apagar">⋮</button>` : '';
    return `<div class="msg ${mine ? 'me' : ''}" data-mid="${m.id}">${menu}${inner}<span class="when">${tag}${fmtTime(m.created_at)}</span></div>`;
  }

  async function openThread(id) {
    current = id;
    const box = $('[data-sup-thread]', panes.suporte);
    let data;
    try { data = await api(`/api/admin/support/threads/${id}/messages`); } catch (e) { toast(e.message, 'error'); return; }
    const u = data.thread.user;
    let lastDay = '';
    const msgs = data.items.map((m) => { const d = fmtDay(m.created_at); const sep = d !== lastDay ? `<div class="day-sep">${esc(d)}</div>` : ''; lastDay = d; return sep + bubble(id, m); }).join('');
    box.innerHTML = `<div class="row" style="gap:10px;margin-bottom:10px">${avatar(u.name, u.photo, 'sm')}<div class="grow"><b>${esc(u.full_name || u.name)}</b><div class="small muted">${esc(who(u))}${u.active ? '' : ' · conta inativa'}</div></div></div>
      <div class="messages sup-msgs" data-sup-msgs>${msgs || '<div class="day-sep">Sem mensagens</div>'}</div>
      <form class="composer" data-sup-form style="border-radius:0 0 14px 14px">
        <label class="icon-btn quick-btn" title="Enviar foto" aria-label="Enviar foto">${window.Acolia.ICONS.camera}<input type="file" accept="image/jpeg,image/png,image/webp" data-sup-photo hidden></label>
        <textarea rows="1" placeholder="Responder como Suporte Acolia" maxlength="4000" aria-label="Resposta"></textarea>
        <button class="btn send" type="submit" aria-label="Enviar" style="display:inline-flex">${window.Acolia.ICONS.send}</button>
      </form>`;
    const mbox = $('[data-sup-msgs]', box);
    mbox.scrollTop = mbox.scrollHeight;
    const form = $('[data-sup-form]', box);
    const ta = $('textarea', form);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = ta.value.trim();
      if (!body) return;
      ta.value = '';
      try { await api(`/api/admin/support/threads/${id}/messages`, { method: 'POST', body: { body } }); openThread(id); loadThreads(); } catch (ex) { ta.value = body; toast(ex.message, 'error'); }
    });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
    $('[data-sup-photo]', form).addEventListener('change', async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try {
        const fd = new FormData();
        fd.append('photo', await shrinkImage(f), 'foto.jpg');
        await api(`/api/admin/support/threads/${id}/photo`, { method: 'POST', form: fd });
        openThread(id);
      } catch (ex) { toast(ex.message, 'error'); }
    });
    mbox.addEventListener('click', async (e) => {
      const im = e.target.closest('[data-img]');
      if (im) { modal({ title: 'Foto', html: `<img src="${esc(im.dataset.img)}" alt="" style="width:100%;border-radius:12px">`, actions: [{ label: 'Fechar' }] }); return; }
      const d = e.target.closest('[data-del-msg]');
      if (d && await confirmDialog('Apagar esta mensagem para todos?', { okLabel: 'Apagar', danger: true })) {
        try { await api(`/api/admin/support/messages/${d.dataset.delMsg}/delete`, { method: 'POST' }); openThread(id); } catch (ex) { toast(ex.message, 'error'); }
      }
    });
    loadThreads();
  }

  // ---------- Mensagem para todos os profissionais ----------
  function renderBroadcast() {
    const pane = panes.todos;
    if (pane.dataset.ready) return;
    pane.dataset.ready = '1';
    pane.innerHTML = `<form class="card stack" data-bc-form>
        <p class="small muted" style="margin:0">A mensagem aparece na conversa <b>Suporte Acolia</b> de <b>todos os profissionais</b> (e das secretárias deles), como uma mensagem do suporte. Para pacientes não existe esta opção: você responde quem escrever.</p>
        <textarea name="body" rows="4" maxlength="4000" placeholder="Escreva a mensagem para todos os profissionais"></textarea>
        <button class="btn" type="submit">Enviar para todos os profissionais</button>
      </form>`;
    $('[data-bc-form]', pane).addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = e.target.body.value.trim();
      if (!body) return toast('Escreva a mensagem.', 'error');
      if (!await confirmDialog('Enviar esta mensagem para todos os profissionais?', { okLabel: 'Enviar para todos' })) return;
      try { const r = await api('/api/admin/support/broadcast-professionals', { method: 'POST', body: { body } }); e.target.reset(); toast(`Mensagem enviada para ${r.sent} profissionais ✓`); } catch (ex) { toast(ex.message, 'error'); }
    });
  }

  // ---------- Avisos (sininho) ----------
  const AUD = { patient: 'Pacientes', professional: 'Profissionais (e secretárias)', all: 'Todos' };
  async function loadNotices() {
    const pane = panes.avisos;
    if (!pane.dataset.ready) {
      pane.dataset.ready = '1';
      pane.innerHTML = `<form class="card stack" data-nt-form>
          <p class="small muted" style="margin:0">O aviso aparece no <b>sininho</b> (notificações) e chega como notificação no celular de quem ativou. Pode ter uma foto (vídeo não).</p>
          <div class="field" style="margin:0"><label>Para quem</label>
            <div class="row" style="gap:6px;flex-wrap:wrap">${Object.entries(AUD).map(([k, v], i) => `<label class="check"><input type="radio" name="audience" value="${k}" ${i === 2 ? 'checked' : ''}> ${v}</label>`).join('')}</div></div>
          <textarea name="text" rows="4" maxlength="2000" placeholder="Escreva o aviso"></textarea>
          <div class="row" style="gap:10px;align-items:center"><label class="btn secondary sm" style="margin:0">Adicionar foto<input type="file" accept="image/jpeg,image/png,image/webp" data-nt-photo hidden></label><span class="small muted" data-nt-photo-name>Sem foto</span></div>
          <button class="btn" type="submit">Enviar aviso</button>
        </form>
        <h2 style="margin-top:20px;font-size:1.1rem">Avisos enviados</h2>
        <div data-nt-list></div>`;
      let photo = null;
      $('[data-nt-photo]', pane).addEventListener('change', async (e) => {
        const f = e.target.files[0];
        photo = f ? await shrinkImage(f) : null;
        $('[data-nt-photo-name]', pane).textContent = f ? `📷 ${f.name}` : 'Sem foto';
      });
      $('[data-nt-form]', pane).addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.target;
        const text = f.text.value.trim();
        if (!text) return toast('Escreva o aviso.', 'error');
        const audience = f.audience.value;
        if (!await confirmDialog(`Enviar este aviso para: ${AUD[audience]}?`, { okLabel: 'Enviar aviso' })) return;
        try {
          let image = null;
          if (photo) { const fd = new FormData(); fd.append('photo', photo, 'aviso.jpg'); image = (await api('/api/admin/notices/photo', { method: 'POST', form: fd })).image; }
          const n = await api('/api/admin/notices', { method: 'POST', body: { audience, text, image } });
          f.reset(); photo = null; $('[data-nt-photo-name]', pane).textContent = 'Sem foto';
          toast(`Aviso enviado para ${n.sent_count} pessoa(s) ✓`);
          loadNotices();
        } catch (ex) { toast(ex.message, 'error'); }
      });
    }
    const box = $('[data-nt-list]', pane);
    let data;
    try { data = await api('/api/admin/notices'); } catch (e) { box.innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }
    box.innerHTML = data.items.length ? data.items.map((n) => `<div class="card flat row" style="gap:12px;align-items:flex-start;margin-bottom:8px">
        ${n.image ? `<img src="${esc(n.image)}" alt="" style="width:64px;height:64px;object-fit:cover;border-radius:10px">` : ''}
        <div class="grow"><div class="small muted">${esc(AUD[n.audience])} · ${n.sent_count} pessoa(s) · ${esc(fmtShort(n.created_at))}</div><div style="white-space:pre-wrap">${esc(n.text)}</div></div>
        <button type="button" class="btn ghost sm danger-text" data-nt-del="${n.id}">Apagar</button></div>`).join('') : '<p class="muted small">Nenhum aviso enviado ainda.</p>';
    $$('[data-nt-del]', box).forEach((b) => b.addEventListener('click', async () => {
      if (!await confirmDialog('Apagar este aviso? Ele some do sininho de todo mundo.', { okLabel: 'Apagar', danger: true })) return;
      try { await api(`/api/admin/notices/${b.dataset.ntDel}`, { method: 'DELETE' }); loadNotices(); } catch (ex) { toast(ex.message, 'error'); }
    }));
  }

  // ---------- Contador de não lidas + tempo real ----------
  function setBadge(n) { $$('[data-sup-unread]').forEach((el) => { el.textContent = n ? String(n) : ''; }); }
  async function refreshBadge() { try { setBadge((await api('/api/admin/support/threads')).unread); } catch { /* ignora */ } }
  if (window.io) {
    const socket = window.io();
    socket.on('support:new', ({ thread_id: t }) => {
      refreshBadge();
      if (!root.classList.contains('hidden') && !panes.suporte.classList.contains('hidden')) { if (current === t) openThread(t); else loadThreads(); }
    });
    socket.on('support:changed', ({ thread_id: t }) => { if (current === t) openThread(t); });
  }
  setTimeout(refreshBadge, 1500);

  window.AcoliaAdminMessages = { show: (arg) => tab(['suporte', 'todos', 'avisos'].includes(arg) ? arg : ($('[data-msg-tab].on', root)?.dataset.msgTab || 'suporte')) };
  if (location.hash.startsWith('#mensagens')) setTimeout(() => window.AcoliaAdminMessages.show(location.hash.split('/')[1]), 800);
})();
