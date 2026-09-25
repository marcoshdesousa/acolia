/* Vitrine de profissionais (usada na página inicial e no app do paciente) */
(function () {
  'use strict';
  const { $, $$, esc, api, ICONS, avatar, money, toast, modal, ufOptions, bindUfCity } = window.Acolia;

  function priceLine(p) {
    const place = p.locked ? '' : `<span class="badge ${p.near ? 'ok' : ''}">${ICONS.pin.replace('<svg', '<svg style="width:14px;height:14px"')} ${esc(p.city)} - ${esc(p.state)}</span>`;
    const where = `<div class="meta">${place}
      <span class="badge">Atende online</span>${p.has_clinic ? '<span class="badge">Atende presencial</span>' : ''}${p.accepts_insurance ? '<span class="badge ok">Aceita plano de saúde</span>' : ''}</div>`;
    if (p.locked) {
      return `<div class="locked">${ICONS.lock.replace('<svg', '<svg style="width:18px;height:18px"')} Valores e localização: crie sua conta grátis para ver</div>${where}`;
    }
    const bits = [];
    // Sempre o menor valor (online ou presencial); os dois aparecem no perfil
    const min = p.price_min_cents != null ? p.price_min_cents : p.price_cents;
    if (min != null) bits.push(p.price_same === false ? `<span class="muted small">a partir de</span> <span class="price">${money(min)}</span> <span class="muted small">/ sessão</span>`
      : `<span class="price">${money(min)}</span> <span class="muted small">/ sessão${p.price_presencial_cents != null ? ' online e presencial' : ' online'}</span>`);
    else bits.push('<span class="muted small">Valor a combinar</span>');
    return `<div>${bits.join(' ')}</div>${where}`;
  }

  function card(p, { profileHref, viewerRole }) {
    const pro = viewerRole === 'professional'; // profissional vê a vitrine, mas não manda mensagem
    return `<article class="card pro-card" data-id="${p.id}">
      <div class="head">${avatar(p.name, p.photo, 'lg')}
        <div style="min-width:0;padding-right:28px"><div class="name">${esc(p.name)}</div><div class="muted small">${esc(p.profession)}</div>
        ${p.registry ? `<div class="small">${ICONS.badge.replace('<svg', '<svg style="width:15px;height:15px;vertical-align:-3px"')} ${esc(p.registry)}</div>` : ''}</div>
      </div>
      ${p.bio ? `<p class="bio">${esc(p.bio)}</p>` : ''}
      ${p.specialties ? `<div class="meta">${window.AcoliaSpecialties ? AcoliaSpecialties.badges(p) : p.specialties.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 2).map((s) => `<span class="badge">${esc(s)}</span>`).join('')}</div>` : ''}
      ${p.next_available ? `<div class="next-line">${ICONS.calendar.replace('<svg', '<svg style="width:15px;height:15px"')} Próximo dia disponível: <b>${esc(p.next_available.label)}${p.next_available.first ? ` às ${esc(p.next_available.first)}` : ''}</b></div>` : ''}
      ${priceLine(p)}
      <div class="actions"><a class="btn ${pro ? '' : 'secondary'} sm grow" href="${profileHref(p)}">Ver perfil</a>
        ${pro ? '' : `<button class="btn sm grow" ${p.locked ? 'data-need-account' : 'data-msg'}>${ICONS.chat.replace('<svg', '<svg style="width:18px;height:18px"')} Mensagem</button>`}</div>
    </article>`;
  }

  const ic = (name, size = 18) => ICONS[name].replace('<svg', `<svg style="width:${size}px;height:${size}px"`);
  const FILTER_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" style="width:18px;height:18px"><path d="M4 6h16M7 12h10M10 18h4"/></svg>';

  // opts: { root, loggedIn, me, profileHref, onMessage }
  function mount(root, opts) {
    const logged = opts.loggedIn;
    const full = logged || opts.viewerRole === 'professional'; // visitante: sem filtros de localização e valor
    const me = opts.me;
    // Paciente logado: a vitrine já começa filtrada (estado e, se houver, município dele) —
    // o número no botão Filtrar mostra isso. Sem filtro nenhum = todos os profissionais.
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
            <div class="field"><label for="f-disp">Consulta disponível</label>
              <select id="f-disp" name="disp">
                <option value="">Qualquer dia</option>
                <option value="hoje">Hoje</option>
                <option value="amanha">Até amanhã</option>
                <option value="3">Nos próximos 3 dias</option>
                <option value="7">Nos próximos 7 dias</option>
              </select></div>
            <div class="field ${full ? '' : 'hidden'}"><label for="f-state">Estado</label>
              <select id="f-state" name="state"><option value="todos">Todos os estados</option></select></div>
            <div class="field ${full ? '' : 'hidden'}"><label for="f-city">Município</label><input id="f-city" name="city" placeholder="Qualquer município"></div>
            <div class="field ${full ? '' : 'hidden'}"><label for="f-place">Bairro ou localidade</label><input id="f-place" name="place" type="search" placeholder="Ex.: Centro"></div>
            <div class="field ${full ? '' : 'hidden'}"><label for="f-sort">Ordenar por</label>
              <select id="f-sort" name="sort">
                <option value="">${logged ? 'Mais perto de você' : 'Destaques'}</option>
                <option value="preco_menor">Menor valor primeiro</option>
                <option value="preco_maior">Maior valor primeiro</option>
              </select></div>
            <div class="field ${full ? '' : 'hidden'}"><label for="f-max">Valor máximo da consulta</label>
              <select id="f-max" name="max_price">
                <option value="">Qualquer valor</option>
                <option value="80">Até R$ 80</option><option value="100">Até R$ 100</option><option value="150">Até R$ 150</option>
                <option value="200">Até R$ 200</option><option value="300">Até R$ 300</option>
              </select></div>
          </div>
          ${full ? '' : '<p class="small muted" style="margin:0 0 10px">🔒 Filtrar por localização e por valor: <a href="/cadastro-paciente">crie sua conta grátis</a>.</p>'}
          <div class="field sp-filter"><label>Especialidades <span class="muted small" style="font-weight:600">(mostra quem tem todas as que você escolher)</span></label><div data-sp-filter></div></div>
          <div class="row"><button class="btn" type="submit">Aplicar filtros</button><button class="btn ghost" type="button" data-clear>Limpar filtros</button></div>
        </div>
      </form>
      <div class="disp-chips" role="group" aria-label="Consulta disponível">
        <span class="small muted">Consulta disponível:</span>
        ${[['', 'Qualquer dia'], ['hoje', 'Hoje'], ['amanha', 'Até amanhã'], ['7', 'Próximos 7 dias']].map(([v, t]) => `<button type="button" class="chip-btn ${v ? '' : 'on'}" data-disp="${v}">${t}</button>`).join('')}
      </div>
      <p class="muted small" data-hint style="margin:12px 0"></p>
      <div class="pro-grid" data-grid><div class="spinner"></div></div>`;

    const form = $('[data-form]', root);
    const grid = $('[data-grid]', root);
    const panel = $('[data-panel]', root);
    const toggle = $('[data-toggle]', root);
    form.state.insertAdjacentHTML('beforeend', ufOptions('', '').replace('<option value=""></option>', ''));
    form.state.value = 'todos';
    api('/api/config').then((c) => {
      form.profession.insertAdjacentHTML('beforeend', c.professions.map((p) => `<option>${esc(p)}</option>`).join(''));
    }).catch(() => {});
    bindUfCity(form.state, form.city);
    // Especialidades escolhidas no filtro (vão para a busca separadas por "|")
    let spChosen = [];
    const spFilter = window.AcoliaSpecialties ? AcoliaSpecialties.picker($('[data-sp-filter]', root), { onChange: (l) => { spChosen = l; } }) : null;
    if (!spFilter) $('.sp-filter', root).remove();

    // Atalhos de disponibilidade (os mesmos do filtro "Consulta disponível")
    const syncDisp = () => $$('[data-disp]', root).forEach((b) => b.classList.toggle('on', b.dataset.disp === form.disp.value));
    $$('[data-disp]', root).forEach((b) => b.addEventListener('click', () => { form.disp.value = b.dataset.disp; syncDisp(); load(); }));
    form.disp.addEventListener('change', syncDisp);
    toggle.addEventListener('click', () => {
      const open = panel.classList.toggle('hidden') === false;
      toggle.setAttribute('aria-expanded', String(open));
    });
    $('[data-clear]', root).addEventListener('click', () => {
      form.reset();
      form.state.value = 'todos';
      form.city.value = '';
      spFilter?.then((sp) => sp.set([]));
      spChosen = [];
      syncDisp();
      load();
    });

    function activeFilters() {
      let n = 0;
      if (form.profession.value) n++;
      if (form.disp.value) n++;
      if (form.state.value && form.state.value !== 'todos') n++;
      if (form.city.value.trim()) n++;
      if (form.place.value.trim()) n++;
      if (form.sort.value) n++;
      if (form.max_price.value) n++;
      if (form.favorites?.checked) n++;
      n += spChosen.length;
      return n;
    }

    function hint(data) {
      const h = $('[data-hint]', root);
      if (opts.viewerRole === 'professional') { h.textContent = ''; return; }
      if (!logged) { h.innerHTML = 'Profissionais em destaque. <a href="/cadastro-paciente">Crie sua conta</a> para ver valores, localização e conversar.'; return; }
      if (form.place.value.trim() || form.sort.value || form.q.value.trim()) { h.textContent = ''; return; }
      if (data.widened === 'brasil') {
        h.innerHTML = `Ainda não temos profissionais em <b>${esc(data.my_city)} - ${esc(data.my_state)}</b>, então mostramos os de <b>todo o Brasil</b> — todos atendem online.`;
      } else if (data.city && data.state) {
        h.innerHTML = `Mostrando profissionais de <b>${esc(data.city)} - ${esc(data.state)}</b>, perto de você. Para ver outros lugares, use <b>Filtrar</b> ou <a href="#" data-clear-link>ver todos</a>.`;
      } else if (data.state) {
        h.innerHTML = `Mostrando profissionais de <b>${esc(data.state)}</b>. Para ver outros estados, use <b>Filtrar</b> ou <a href="#" data-clear-link>ver todos</a>.`;
      } else h.textContent = 'Profissionais de todo o Brasil.';
      $('[data-clear-link]', h)?.addEventListener('click', (e) => { e.preventDefault(); $('[data-clear]', root).click(); });
    }

    let items = [];
    const showCount = () => { const n = activeFilters(); $('[data-count]', root).textContent = n ? String(n) : ''; };
    async function load({ auto = false } = {}) {
      const params = new URLSearchParams();
      for (const [k, v] of new FormData(form).entries()) {
        if (!v || (auto && (k === 'state' || k === 'city'))) continue;
        params.set(k, v);
      }
      if (spChosen.length) params.set('specialties', spChosen.join('|'));
      if (auto) params.set('auto', '1');
      showCount();
      grid.innerHTML = '<div class="spinner"></div>';
      let data;
      try {
        data = await api(`/api/professionals?${params}`);
        items = data.items.filter((p) => p.id !== opts.excludeId); // painel: a própria pessoa não aparece em "outros profissionais"
      } catch (e) { grid.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
      if (auto) {
        // Mostra no painel o filtro que foi aplicado automaticamente
        form.state.value = data.state || 'todos';
        form.city.value = data.city || '';
        showCount();
      }
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
        html: '<p>Para mandar mensagem e ver os valores dos profissionais, é preciso ter uma conta grátis. É rápido.</p>',
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
    });
    form.addEventListener('submit', (e) => { e.preventDefault(); load(); });
    $$('select, input[type=checkbox]', panel).forEach((el) => el.addEventListener('change', () => load()));
    load({ auto: logged });
    return { reload: () => load() };
  }

  window.AcoliaCatalog = { mount, card };
})();
