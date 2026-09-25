/* Mensagens prontas do profissional (até 10).
   - Meu perfil: cria, edita e apaga as mensagens (editor).
   - Chat: o "+" ao lado do "Digite uma mensagem" abre a lista; tocando numa, a mensagem inteira vai para
     o campo de digitar e é só enviar. */
(function () {
  'use strict';
  const { $, $$, esc, api, toast } = window.Acolia;
  let cache = null; // { items, max }

  async function load(force) {
    if (!cache || force) cache = await api('/api/professional/quick-replies');
    return cache;
  }

  // ---------- Editor (Meu perfil) ----------
  function editor(root) {
    let items = [];
    let max = 10;
    const row = (t, i) => `<div class="qr-item" data-i="${i}">
        <textarea rows="3" maxlength="1000" placeholder="Ex.: Olá! Obrigado pelo contato. Minhas consultas online duram 50 minutos…" aria-label="Mensagem pronta ${i + 1}">${esc(t)}</textarea>
        <button type="button" class="icon-btn" data-qr-rm aria-label="Apagar esta mensagem" title="Apagar">${window.Acolia.ICONS.trash}</button></div>`;
    function paint() {
      root.innerHTML = `<h2 style="margin:0">Mensagens prontas</h2>
        <p class="small muted" style="margin:0">Deixe salvas as mensagens que você manda sempre (até ${max}). No chat, toque no <b>+</b> ao lado de "Digite uma mensagem", escolha a mensagem e é só enviar.</p>
        <div class="qr-list">${items.length ? items.map(row).join('') : '<p class="small muted" style="margin:0">Você ainda não tem mensagens prontas.</p>'}</div>
        <div class="row" style="gap:8px;flex-wrap:wrap">
          ${items.length < max ? `<button type="button" class="btn secondary sm" data-qr-add>+ Nova mensagem</button>` : `<span class="small muted">Você chegou ao limite de ${max} mensagens.</span>`}
          <span class="small muted" style="margin-left:auto">${items.length} de ${max}</span></div>
        <button type="button" class="btn" data-qr-save>Salvar mensagens prontas</button>`;
      growAll();
    }
    const read = () => $$('.qr-item textarea', root).map((t) => t.value);
    // O campo cresce com o texto (a mensagem aparece inteira)
    const grow = (t) => { t.style.height = 'auto'; t.style.height = `${t.scrollHeight + 2}px`; };
    root.addEventListener('input', (e) => { if (e.target.matches('.qr-item textarea')) grow(e.target); });
    const growAll = () => requestAnimationFrame(() => $$('.qr-item textarea', root).forEach(grow));
    root.addEventListener('click', async (e) => {
      if (e.target.closest('[data-qr-add]')) {
        items = read();
        if (items.length >= max) return;
        items.push('');
        paint();
        const all = $$('.qr-item textarea', root);
        all[all.length - 1]?.focus();
        return;
      }
      const rm = e.target.closest('[data-qr-rm]');
      if (rm) {
        items = read();
        items.splice(Number(rm.closest('.qr-item').dataset.i), 1);
        paint();
        return;
      }
      const save = e.target.closest('[data-qr-save]');
      if (save) {
        save.disabled = true;
        try {
          cache = await api('/api/professional/quick-replies', { method: 'PUT', body: { items: read() } });
          items = cache.items.slice();
          paint();
          toast('Mensagens prontas salvas ✓');
        } catch (ex) { toast(ex.message, 'error'); save.disabled = false; }
      }
    });
    load(true).then((d) => { items = d.items.slice(); max = d.max; paint(); })
      .catch((ex) => { root.innerHTML = `<p class="muted small">${esc(ex.message)}</p>`; });
  }

  // ---------- Chat: lista para escolher ----------
  function closePicker() { $('.qr-pop')?.remove(); document.removeEventListener('click', outside, true); }
  function outside(e) { if (!e.target.closest('.qr-pop, [data-quick]')) closePicker(); }

  async function openPicker(form, ta) {
    if ($('.qr-pop', form)) { closePicker(); return; }
    closePicker();
    let d;
    try { d = await load(); } catch (ex) { toast(ex.message, 'error'); return; }
    const pop = document.createElement('div');
    pop.className = 'qr-pop';
    pop.setAttribute('role', 'menu');
    pop.innerHTML = `<div class="qr-pop-head"><b>Mensagens prontas</b><a href="/painel#perfil" data-qr-edit class="small">Editar</a></div>
      ${d.items.length ? d.items.map((t, i) => `<button type="button" role="menuitem" data-qr-pick="${i}">${esc(t)}</button>`).join('')
        : '<p class="small muted" style="margin:6px 4px">Você ainda não tem mensagens prontas. Crie em <b>Meu perfil</b> (até 10).</p>'}`;
    form.appendChild(pop);
    pop.addEventListener('click', (e) => {
      const b = e.target.closest('[data-qr-pick]');
      if (!b) { if (e.target.closest('[data-qr-edit]')) closePicker(); return; }
      ta.value = d.items[Number(b.dataset.qrPick)];
      ta.dispatchEvent(new Event('input', { bubbles: true })); // ajusta a altura e mostra o botão de enviar
      closePicker();
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });
    setTimeout(() => document.addEventListener('click', outside, true));
  }

  window.AcoliaQuick = { editor, openPicker, closePicker, reset: () => { cache = null; } };
})();
