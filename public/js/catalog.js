/* Vitrine de profissionais (usada na página inicial e no app do paciente) */
(function () {
  'use strict';
  const { $, $$, esc, api, ICONS, avatar, money, toast, modal, ufOptions, bindUfCity } = window.Acolia;

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
      ${p.locked ? `<button class="icon-btn fav" data-need-account aria-label="Favoritar (precisa de conta)">${ICONS.heart}</button>`
        : `<button class="icon-btn fav ${p.favorite ? 'on' : ''}" data-fav aria-pressed="${p.favorite}" aria-label="${p.favorite ? 'Remover dos favoritos' : 'Adicionar aos favoritos'}">${ICONS.heart}</button>`}
      <div class="head">${avatar(p.name, p.photo, 'lg')}
        <div style="min-width:0;padding-right:28px"><div class="name">${esc(p.name)}</div><div class="muted small">${esc(p.profession)}</div>
        <div class="small">${ICONS.badge.replace('<svg', '<svg style="width:15px;height:15px;vertical-align:-3px"')} ${esc(p.registry)}</div></div>
      </div>
      ${p.bio ? `<p class="bio">${esc(p.bio)}</p>` : ''}
      ${p.specialties ? `<div class="meta">${p.specialties.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 4).map((s) => `<span class="badge">${esc(s)}</span>`).join('')}</div>` : ''}
      ${priceLine(p)}
      <div class="actions"><a class="btn secondary sm grow" href="${profileHref(p)}">Ver perfil</a>
        <button class="btn sm grow" ${p.locked ? 'data-need-account' : 'data-msg'}>${ICONS.chat.replace('<svg', '<svg style="width:18px;height:18px"')} Mensagem</button></div>
    </article>`;
  }

  const ic = (name, size = 18) => ICONS[name].replace('<svg', `<svg style="width:${size}px;height:${size}px"`);
  const FILTER_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" style="width:18px;height:18px"><path d="M4 6h16M7 12h10M10 18h4"/></svg>';

  // opts: { root, loggedIn, me, profileHref, onMessage }
  function mount(root, opts) {
    const logged = opts.loggedIn;
    const me = opts.me;
    const defaultState = logged && me ? me.state : 'todos';
    root.innerHTML = `
      <form data-form role="search">
        <div class="search-row">
          <input name="q" type="search" placeholder="Buscar pelo nome ou especialidade" aria-label="Buscar pelo nome ou especialidade">
          <button type="button" class="btn secondary" data-toggle aria-expanded="false" aria-controls="filtros">${FILTER_ICON} Filtrar <span class="nav-badge filter-count" data-count></span></button>
          <button class="btn" type="submit" aria-label="Buscar">${ic('search')}<span class="hide-sm">Buscar</span></button>
        </div>
        <div class="filter-panel card flat hidden" id="filtros" data-panel>
          <div class="filter-grid">
            <div class="field"><label for="f-prof">Tipo de profissional</label>
              <select id="f-prof" name="profession"><option value="">Todos os tipos</option></select></div>
            <div class="field"><label for="f-state">Estado</label>
              <select id="f-state" name="state"><option value="todos">Todos os estados</option></select></div>
            <div class="field"><label for="f-city">Município</label><input id="f-city" name="city" placeholder="Qualquer município"></div>
            <div class="field"><label for="f-place">Bairro ou localidade</label><input id="f-place" name="place" type="search" placeholder="Ex.: Centro"></div>
            <div class="field"><label for="f-sort">Ordenar por</label>
              <select id="f-sort" name="sort">
                <option value="">${logged ? 'Mais perto de você' : 'Destaques'}</option>
                <option value="preco_menor">Menor valor primeiro</option>
                <option value="preco_maior">Maior valor primeiro</option>
              </select></div>
            <div class="field"><label for="f-max">Valor máximo da consulta</label>
              <select id="f-max" name="max_price">
                <option value="">Qualquer valor</option>
                <option value="80">Até R$ 80</option><option value="100">Até R$ 100</option><option value="150">Até R$ 150</option>
                <option value="200">Até R$ 200</option><option value="300">Até R$ 300</option>
              </select></div>
          </div>
          ${logged ? `<label class="check" style="margin-bottom:12px"><input type="checkbox" name="favorites" value="1"> ${ic('heart')} Só meus favoritos</label>` : ''}
          <div class="row"><button class="btn" type="submit">Aplicar filtros</button><button class="btn ghost" type="button" data-clear>Limpar filtros</button></div>
        </div>
      </form>
      <p class="muted small" data-hint style="margin:12px 0"></p>
      <div class="pro-grid" data-grid><div class="spinner"></div></div>`;

    const form = $('[data-form]', root);
    const grid = $('[data-grid]', root);
    const panel = $('[data-panel]', root);
    const toggle = $('[data-toggle]', root);
    form.state.insertAdjacentHTML('beforeend', ufOptions('', '').replace('<option value=""></option>', ''));
    form.state.value = defaultState;
    api('/api/config').then((c) => {
      form.profession.insertAdjacentHTML('beforeend', c.professions.map((p) => `<option>${esc(p)}</option>`).join(''));
    }).catch(() => {});
    bindUfCity(form.state, form.city);

    toggle.addEventListener('click', () => {
      const open = panel.classList.toggle('hidden') === false;
      toggle.setAttribute('aria-expanded', String(open));
    });
    $('[data-clear]', root).addEventListener('click', () => {
      form.reset();
      form.state.value = defaultState;
      load();
    });

    function activeFilters() {
      let n = 0;
      if (form.profession.value) n++;
      if (form.state.value !== defaultState) n++;
      if (form.city.value.trim()) n++;
      if (form.place.value.trim()) n++;
      if (form.sort.value) n++;
      if (form.max_price.value) n++;
      if (form.favorites?.checked) n++;
      return n;
    }

    function hint(data) {
      const h = $('[data-hint]', root);
      if (!logged) { h.innerHTML = 'Profissionais em destaque. <a href="/cadastro-paciente">Crie sua conta</a> para ver valores, localização e conversar.'; return; }
      if (form.city.value.trim() || form.place.value.trim() || form.sort.value || form.q.value.trim()) { h.textContent = ''; return; }
      if (data.state && data.state === me?.state) {
        h.innerHTML = `Profissionais de <b>${esc(me.state)}</b>, com os de <b>${esc(me.city)}</b> primeiro. Para ver outros estados, use <b>Filtrar</b>.`;
      } else h.textContent = data.state ? `Profissionais de ${data.state}.` : 'Profissionais de todo o Brasil.';
    }

    let items = [];
    async function load() {
      const params = new URLSearchParams();
      for (const [k, v] of new FormData(form).entries()) if (v) params.set(k, v);
      const n = activeFilters();
      $('[data-count]', root).textContent = n ? String(n) : '';
      grid.innerHTML = '<div class="spinner"></div>';
      let data;
      try {
        data = await api(`/api/professionals?${params}`);
        items = data.items;
      } catch (e) { grid.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
      hint(data);
      if (!items.length) {
        const other = logged && form.state.value !== 'todos'
          ? '<p><button class="btn secondary sm" type="button" data-all>Ver profissionais de todos os estados</button></p>' : '';
        grid.innerHTML = `<div class="empty" style="grid-column:1/-1">${ICONS.therapist}<p>Nenhum profissional encontrado com esses filtros.</p>${other}</div>`;
        $('[data-all]', grid)?.addEventListener('click', () => { form.state.value = 'todos'; form.city.value = ''; load(); });
        return;
      }
      grid.innerHTML = items.map((p) => card(p, opts)).join('');
    }

    function needAccount() {
      modal({
        title: 'Crie sua conta grátis',
        html: '<p>Para favoritar, mandar mensagem e ver valores e localização dos profissionais, é preciso ter uma conta. É rápido.</p>',
        actions: [{ label: 'Já tenho conta', value: 'entrar', class: 'secondary' }, { label: 'Criar conta', value: 'criar' }],
      }).then((v) => {
        if (v === 'criar') location.href = '/cadastro-paciente';
        if (v === 'entrar') location.href = '/entrar';
      });
    }

    grid.addEventListener('click', async (e) => {
      const art = e.target.closest('[data-id]');
      if (!art) return;
      const id = Number(art.dataset.id);
      if (e.target.closest('[data-need-account]')) return needAccount();
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
    $$('select, input[type=checkbox]', panel).forEach((el) => el.addEventListener('change', load));
    load();
    return { reload: load };
  }

  window.AcoliaCatalog = { mount, card };
})();
