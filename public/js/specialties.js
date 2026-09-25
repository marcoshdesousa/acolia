/* Especialidades do profissional: seletor com busca (cadastro, perfil, admin e filtro da vitrine)
   e a página "todas as especialidades" do perfil (as 2 primeiras aparecem, o resto fica no "+"). */
(function () {
  'use strict';
  const { $, $$, esc, api, ICONS, avatar } = window.Acolia;
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const list = (text) => String(text || '').split(',').map((s) => s.trim()).filter(Boolean);
  let groupsP = null;
  const groups = () => (groupsP ||= api('/api/config').then((c) => c.specialties || []));

  // host: onde desenhar · opts: { selected, name, hint, onChange }
  // Clicar numa especialidade escolhe (vai para o fim da lista); clicar de novo, ou no ✕, tira.
  async function picker(host, opts = {}) {
    let chosen = [...(opts.selected || [])];
    host.innerHTML = `<div class="sp-picker">
      <div class="sp-chosen" data-sp-chosen></div>
      ${opts.hint ? `<div class="hint" style="margin:0 0 8px">${opts.hint}</div>` : ''}
      <input type="search" class="sp-search" data-sp-search placeholder="Procurar (ex.: TEA, casal, ansiedade, TCC)" aria-label="Procurar especialidade" autocomplete="off">
      <div class="sp-box" data-sp-box><div class="spinner"></div></div>
      ${opts.name ? `<input type="hidden" name="${esc(opts.name)}">` : ''}
    </div>`;
    const box = $('[data-sp-box]', host);
    const hidden = opts.name ? $(`input[name="${opts.name}"]`, host) : null;
    const gs = await groups().catch(() => []);
    box.innerHTML = gs.map((g) => `<div class="sp-group"><div class="sp-gname">${esc(g.name)}</div>
        <div class="sp-chips">${g.items.map((s) => `<button type="button" class="sp-chip" data-sp="${esc(s)}" data-n="${esc(norm(s))}">${esc(s)}</button>`).join('')}</div></div>`).join('')
      + '<p class="sp-none muted small hidden" data-sp-none>Nenhuma especialidade com esse nome.</p>';

    function paint() {
      const set = new Set(chosen.map(norm));
      $$('[data-sp]', box).forEach((b) => { const on = set.has(b.dataset.n); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
      $('[data-sp-chosen]', host).innerHTML = chosen.length
        ? chosen.map((s, i) => `<span class="sp-tag">${esc(s)}<button type="button" data-sp-rm="${i}" aria-label="Tirar ${esc(s)}">✕</button></span>`).join('')
        : '<span class="muted small">Nenhuma escolhida ainda.</span>';
      if (hidden) hidden.value = JSON.stringify(chosen);
      opts.onChange?.(chosen);
    }
    box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-sp]');
      if (!b) return;
      const i = chosen.findIndex((s) => norm(s) === b.dataset.n);
      if (i >= 0) chosen.splice(i, 1); else chosen.push(b.dataset.sp);
      paint();
    });
    $('[data-sp-chosen]', host).addEventListener('click', (e) => {
      const r = e.target.closest('[data-sp-rm]');
      if (r) { chosen.splice(Number(r.dataset.spRm), 1); paint(); }
    });
    $('[data-sp-search]', host).addEventListener('input', (e) => {
      const q = norm(e.target.value);
      let any = false;
      $$('.sp-group', box).forEach((g) => {
        let n = 0;
        $$('[data-sp]', g).forEach((b) => { const ok = !q || b.dataset.n.includes(q); b.classList.toggle('hidden', !ok); if (ok) n++; });
        g.classList.toggle('hidden', !n);
        if (n) any = true;
      });
      $('[data-sp-none]', box).classList.toggle('hidden', any);
    });
    // Enter na busca não envia o formulário
    $('[data-sp-search]', host).addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
    paint();
    return {
      value: () => [...chosen],
      set: (arr) => { chosen = [...arr]; paint(); },
    };
  }

  // Página com todas as especialidades (botão Voltar; o voltar do celular também fecha)
  function openAll(pro) {
    const items = list(pro.specialties);
    const el = document.createElement('div');
    el.className = 'bio-page';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', `Especialidades de ${pro.name}`);
    el.innerHTML = `<div class="bio-head"><button type="button" class="icon-btn" data-sp-back aria-label="Voltar">${ICONS.back}</button><b>Especialidades</b></div>
      <div class="bio-body">
        <div class="row" style="gap:14px;margin-bottom:18px">${avatar(pro.name, pro.photo, 'lg')}<div><div style="font-weight:800;font-size:1.2rem">${esc(pro.name)}</div><div class="muted">${esc(pro.profession || '')}</div></div></div>
        <div class="sp-all">${items.map((s) => `<span class="badge">${esc(s)}</span>`).join('')}</div>
        <button type="button" class="btn secondary" data-sp-back style="margin-top:24px">${ICONS.back} Voltar ao perfil</button>
      </div>`;
    document.body.appendChild(el);
    document.documentElement.classList.add('no-scroll');
    const close = () => { el.remove(); document.documentElement.classList.remove('no-scroll'); window.removeEventListener('popstate', onPop); };
    const onPop = () => close();
    history.pushState({ specialties: 1 }, '');
    window.addEventListener('popstate', onPop);
    el.addEventListener('click', (e) => { if (e.target.closest('[data-sp-back]')) history.back(); });
  }

  // Visitante sem conta: "ver mais" pede para criar a conta (e volta para esta página depois)
  function needAccount(what = 'ver tudo') {
    const here = location.pathname + location.search + location.hash;
    return window.Acolia.modal({
      title: 'Crie sua conta grátis',
      html: `<p>Para ${esc(what)}, crie sua conta grátis. É rápido, e depois você volta direto para cá.</p>`,
      actions: [{ label: 'Já tenho conta', value: 'entrar', class: 'secondary' }, { label: 'Criar conta', value: 'criar' }],
    }).then((v) => {
      if (v === 'criar') location.href = '/cadastro-paciente?next=' + encodeURIComponent(here);
      if (v === 'entrar') location.href = '/entrar?next=' + encodeURIComponent(here);
    });
  }

  // As 2 primeiras + botão "+N" (abre a página com todas; visitante: pede conta)
  const CACHE = new Map();
  function badges(pro, max = 2) {
    const items = list(pro.specialties);
    if (!items.length) return '';
    CACHE.set(String(pro.id), pro);
    const total = Math.max(items.length, pro.specialties_total || 0); // visitante recebe só as 2 primeiras + o total
    const extra = total - max;
    return `${items.slice(0, max).map((s) => `<span class="badge">${esc(s)}</span>`).join('')}${extra > 0
      ? `<button type="button" class="badge sp-more" data-sp-more="${pro.id}" aria-label="Ver todas as ${total} especialidades">+${extra}</button>` : ''}`;
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-sp-more]');
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    const pro = CACHE.get(b.dataset.spMore);
    if (pro?.locked) needAccount('ver todas as especialidades');
    else if (pro) openAll(pro);
  });

  window.AcoliaSpecialties = { picker, openAll, badges, list, norm, groups, needAccount };
})();
