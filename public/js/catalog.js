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

  // Quando tem horário: Hoje, Amanhã, Esta semana ou a data
  function whenLabel(nx) {
    if (!nx || !nx.date) return null;
    const t = new Date();
    const today = Date.UTC(t.getFullYear(), t.getMonth(), t.getDate());
    const [y, m, d] = nx.date.split('-').map(Number);
    const days = Math.round((Date.UTC(y, m - 1, d) - today) / 864e5);
    if (days <= 0) return { text: 'Hoje', now: true };
    if (days === 1) return { text: 'Amanhã', now: true };
    if (days <= 6) return { text: 'Esta semana', now: false };
    return { text: `A partir de ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`, now: false };
  }
  // Cartão da vitrine: foto grande, selo de verificado no canto, quando tem horário, nome, profissão,
  // as 2 especialidades principais (o profissional escolhe) e o valor (o mais barato, "a partir de")
  function card(p, { profileHref }) {
    const sp = String(p.specialties || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 2);
    const min = p.price_min_cents != null ? p.price_min_cents : p.price_cents;
    const when = whenLabel(p.next_available || p.next_hint);
    const ini = String(p.name || '').split(/\s+/).filter(Boolean).map((w) => w[0]).filter((c, i, a) => i === 0 || i === a.length - 1).join('').toUpperCase();
    const price = p.locked
      ? `<div class="pc-price lock">${ICONS.lock || ''} Entre para ver o valor</div>`
      : min != null
        ? `<div class="pc-price">${p.price_same === false ? '<small>a partir de</small>' : ''}<b>${money(min)}</b></div>`
        : '<div class="pc-price"><small>Valor a combinar</small></div>';
    return `<article class="card pro-card mini" data-id="${p.id}">
      <a class="pc-link" href="${profileHref(p)}" aria-label="Ver o perfil de ${esc(p.name)}"></a>
      <div class="pc-top">
        ${p.photo ? `<img src="${esc(p.photo)}" alt="" loading="lazy">` : `<div class="pc-ini">${esc(ini)}</div>`}
        ${p.verified ? `<span class="pc-ok" title="Verificado pela Acolia">${Acolia.verifiedBadge}</span>` : ''}
        ${when ? `<span class="pc-when ${when.now ? 'now' : ''}"><i></i>${esc(when.text)}</span>` : ''}
      </div>
      <div class="pc-body">
        <div class="pc-name">${esc(p.name)}</div>
        <div class="pc-prof">${esc(p.profession)}</div>
        ${sp.length ? `<div class="pc-sp">${sp.map((x) => `<span>${esc(x)}</span>`).join('')}</div>` : ''}
        ${price}
      </div>
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
            <div class="field"><label for="f-portal">Área</label>
              <select id="f-portal" name="portal"><option value="">Todas as áreas</option></select></div>
            <div class="field"><label for="f-prof">Profissão</label>
              <select id="f-prof" name="profession"><option value="">Todas as profissões</option></select></div>
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
                <option value="avaliacao">Mais bem avaliados</option>
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
          ${full ? '' : `<p class="small muted" style="margin:0 0 10px">${ICONS.lock.replace('<svg', '<svg style="width:15px;height:15px;vertical-align:-2px"')} Filtrar por localização e por valor: <a href="/cadastro-paciente">crie sua conta grátis</a>.</p>`}
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
    // Versão 2.3: tudo pelo "Filtrar". Área (saúde mental, nutrição, movimento) → profissões daquela área →
    // especialidades daquela área. Escolher só a profissão já marca a área dela.
    let portals = [];
    let allProfs = [];
    const areaOf = (prof) => (portals.find((x) => x.professions.includes(prof)) || {}).key || '';
    const fillProfessions = () => {
      const P = portals.find((x) => x.key === form.portal.value);
      const keep = form.profession.value;
      const list = P ? P.professions : allProfs;
      form.profession.innerHTML = '<option value="">Todas as profissões</option>' + (P || !portals.length
        ? list.map((x) => `<option>${esc(x)}</option>`).join('')
        : portals.map((x) => `<optgroup label="${esc(x.area)}">${x.professions.map((y) => `<option>${esc(y)}</option>`).join('')}</optgroup>`).join(''));
      form.profession.value = list.includes(keep) ? keep : '';
    };
    const ready = api('/api/config').then((c) => {
      portals = c.portals_enabled !== false ? (c.portals || []) : [];
      allProfs = [...new Set(portals.length ? portals.flatMap((x) => x.professions) : c.professions)];
      form.portal.insertAdjacentHTML('beforeend', portals.map((x) => `<option value="${x.key}">${esc(x.area)}</option>`).join(''));
      if (!portals.length) form.portal.closest('.field').classList.add('hidden');
      if (opts.portal && portals.some((x) => x.key === opts.portal)) form.portal.value = opts.portal;
      fillProfessions();
      mountSp();
    }).catch(() => {});
    bindUfCity(form.state, form.city);
    // Especialidades escolhidas no filtro (vão para a busca separadas por "|"): cada portal tem a sua lista,
    // então aparecem depois de escolher o portal
    let spChosen = [];
    function mountSp() {
      const host = $('[data-sp-filter]', root);
      spChosen = [];
      if (!host) return;
      if (!window.AcoliaSpecialties || !form.portal.value) {
        host.innerHTML = '<p class="small muted" style="margin:0">Escolha a área ou a profissão acima para filtrar por especialidade.</p>';
        return;
      }
      AcoliaSpecialties.picker(host, { portal: form.portal.value, onChange: (l) => { spChosen = l; } });
    }
    form.portal.addEventListener('change', () => { form.profession.value = ''; fillProfessions(); mountSp(); load(); });
    // Escolheu a profissão sem a área: a área dela fica marcada (e aparecem as especialidades dela)
    form.profession.addEventListener('change', () => {
      const k = areaOf(form.profession.value);
      if (k && form.portal.value !== k) { const prof = form.profession.value; form.portal.value = k; fillProfessions(); form.profession.value = prof; mountSp(); }
    });

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
      fillProfessions();
      mountSp();
      syncDisp();
      load();
    });

    function activeFilters() {
      let n = 0;
      if (form.portal.value) n++;
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
      // Toque em qualquer parte do cartão (foto, nome, cidade, especialidades…) abre o perfil;
      // os botões (Mensagem, "+N" das especialidades) continuam fazendo o que fazem
      if (e.target.closest('a, button, input, select, label')) return;
      const link = art.querySelector('.pc-link, .actions a[href]');
      if (link) link.click();
    });
    form.addEventListener('submit', (e) => { e.preventDefault(); load(); });
    $$('select, input[type=checkbox]', panel).forEach((el) => { if (el !== form.portal) el.addEventListener('change', () => load()); });
    ready.then(() => load({ auto: logged }));
    return { reload: () => load() };
  }

  window.AcoliaCatalog = { mount, card };
})();
