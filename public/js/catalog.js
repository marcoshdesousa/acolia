/* Vitrine de profissionais (usada na página inicial e no app do paciente) */
(function () {
  'use strict';
  const { $, $$, esc, api, ICONS, avatar, money, toast, ufOptions, bindUfCity } = window.Acolia;

  function priceLine(p) {
    if (p.locked) return `<div class="locked">${ICONS.lock.replace('<svg', '<svg style="width:18px;height:18px"')} Crie sua conta grátis para ver valores e localização</div>`;
    const bits = [];
    if (p.price_cents != null) bits.push(`<span class="price">${money(p.price_cents)}</span> <span class="muted small">/ sessão online</span>`);
    else bits.push('<span class="muted small">Valor a combinar</span>');
    if (p.packages?.length) bits.push(`<span class="badge primary">${p.packages.length} pacote${p.packages.length > 1 ? 's' : ''}</span>`);
    return `<div>${bits.join(' ')}</div>
      <div class="meta"><span class="badge ${p.near ? 'ok' : ''}">${ICONS.pin.replace('<svg', '<svg style="width:14px;height:14px"')} ${esc(p.city)} - ${esc(p.state)}</span>
      ${p.has_clinic ? '<span class="badge">Atende presencial</span>' : '<span class="badge">Somente online</span>'}</div>`;
  }

  function card(p, { profileHref }) {
    return `<article class="card pro-card" data-id="${p.id}">
      ${p.locked ? '' : `<button class="icon-btn fav ${p.favorite ? 'on' : ''}" data-fav aria-pressed="${p.favorite}" aria-label="${p.favorite ? 'Remover dos favoritos' : 'Adicionar aos favoritos'}">${ICONS.heart}</button>`}
      <div class="head">${avatar(p.name, p.photo, 'lg')}
        <div style="min-width:0;padding-right:28px"><div class="name">${esc(p.name)}</div><div class="muted small">${esc(p.profession)}</div>
        <div class="small">${ICONS.badge.replace('<svg', '<svg style="width:15px;height:15px;vertical-align:-3px"')} ${esc(p.registry)}</div></div>
      </div>
      ${p.bio ? `<p class="bio">${esc(p.bio)}</p>` : ''}
      ${p.specialties ? `<div class="meta">${p.specialties.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 4).map((s) => `<span class="badge">${esc(s)}</span>`).join('')}</div>` : ''}
      ${priceLine(p)}
      <div class="actions"><a class="btn secondary sm grow" href="${profileHref(p)}">Ver perfil</a>
        ${p.locked ? '' : `<button class="btn sm grow" data-msg>${ICONS.chat.replace('<svg', '<svg style="width:18px;height:18px"')} Mensagem</button>`}</div>
    </article>`;
  }

  // opts: { root, loggedIn, me, profileHref, onMessage }
  function mount(root, opts) {
    const logged = opts.loggedIn;
    root.innerHTML = `
      <form class="search-bar" role="search" data-form>
        <input name="q" type="search" placeholder="Buscar pelo nome ou especialidade" aria-label="Buscar pelo nome">
        <select name="profession" aria-label="Profissão"><option value="">Todas as profissões</option></select>
        ${logged ? `
          <select name="state" aria-label="Estado" style="flex:0 1 110px">${ufOptions('', 'Estado')}</select>
          <input name="city" placeholder="Município" aria-label="Município">
          <input name="place" type="search" placeholder="Pesquisar localidade (bairro, cidade…)" aria-label="Pesquisar localidade">
          <label class="check" style="margin:0"><input type="checkbox" name="favorites" value="1"> ${ICONS.heart.replace('<svg', '<svg style="width:18px;height:18px"')} Favoritos</label>` : ''}
        <button class="btn" type="submit">${ICONS.search.replace('<svg', '<svg style="width:18px;height:18px"')} Buscar</button>
      </form>
      ${logged && opts.me ? `<p class="muted small" data-hint>Mostrando primeiro profissionais de <b>${esc(opts.me.city)} - ${esc(opts.me.state)}</b>.</p>` : ''}
      <div class="pro-grid" data-grid><div class="spinner"></div></div>`;

    const form = $('[data-form]', root);
    const grid = $('[data-grid]', root);
    api('/api/config').then((c) => {
      form.profession.insertAdjacentHTML('beforeend', c.professions.map((p) => `<option>${esc(p)}</option>`).join(''));
    }).catch(() => {});
    if (logged) bindUfCity(form.state, form.city);

    let items = [];
    async function load() {
      const params = new URLSearchParams();
      for (const [k, v] of new FormData(form).entries()) if (v) params.set(k, v);
      grid.innerHTML = '<div class="spinner"></div>';
      try {
        items = (await api(`/api/professionals?${params}`)).items;
      } catch (e) { grid.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
      if (!items.length) {
        grid.innerHTML = `<div class="empty" style="grid-column:1/-1">${ICONS.therapist}<p>Nenhum profissional encontrado com esses filtros.</p></div>`;
        return;
      }
      grid.innerHTML = items.map((p) => card(p, opts)).join('');
    }

    grid.addEventListener('click', async (e) => {
      const art = e.target.closest('[data-id]');
      if (!art) return;
      const id = Number(art.dataset.id);
      if (e.target.closest('[data-msg]')) return opts.onMessage?.(id);
      const fav = e.target.closest('[data-fav]');
      if (fav) {
        const on = fav.classList.contains('on');
        try {
          await api(`/api/patient/favorites/${id}`, { method: on ? 'DELETE' : 'POST' });
          fav.classList.toggle('on', !on);
          fav.setAttribute('aria-pressed', String(!on));
          fav.setAttribute('aria-label', on ? 'Adicionar aos favoritos' : 'Remover dos favoritos');
          toast(on ? 'Removido dos favoritos' : 'Adicionado aos favoritos');
        } catch (ex) { toast(ex.message, 'error'); }
      }
    });
    form.addEventListener('submit', (e) => { e.preventDefault(); load(); });
    $$('select, input[type=checkbox]', form).forEach((el) => el.addEventListener('change', load));
    load();
    return { reload: load };
  }

  window.AcoliaCatalog = { mount, card };
})();
