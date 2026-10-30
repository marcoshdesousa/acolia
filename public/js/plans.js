/* Planos e evolução (portais Nutri e Fisio, versão 2.1)
   Profissional: monta o plano alimentar (Nutri) ou o plano de exercícios (Fisio) e manda pelo chat; registra
   a evolução (peso e medidas, ou dor de 0 a 10). Paciente: vê o plano, a lista de compras (marca o que
   comprou) ou toca em "Fiz hoje" nos exercícios, e vê o gráfico da evolução. */
(function () {
  'use strict';
  const { $, $$, api, esc, toast, modal } = window.Acolia;
  const br = (d) => String(d || '').slice(0, 10).split('-').reverse().join('/');
  const num = (v) => (v == null || v === '' ? '' : String(v).replace('.', ','));

  // ---------- Gráfico simples (linha) ----------
  function chart(points, { unit = '', max = null, min = null, invert = false } = {}) {
    const ps = points.filter((p) => p.v != null);
    if (ps.length < 1) return '<p class="small muted" style="margin:0">Ainda sem registros.</p>';
    const W = 320, H = 130, P = 26;
    const vs = ps.map((p) => p.v);
    const lo = min ?? Math.floor(Math.min(...vs) - 1), hi = max ?? Math.ceil(Math.max(...vs) + 1);
    const x = (i) => (ps.length === 1 ? W / 2 : P + (i * (W - 2 * P)) / (ps.length - 1));
    const y = (v) => H - P - ((v - lo) / (hi - lo || 1)) * (H - 2 * P);
    const path = ps.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(' ');
    const first = ps[0].v, last = ps.at(-1).v, diff = Math.round((last - first) * 10) / 10;
    const good = invert ? diff > 0 : diff < 0;
    return `<div class="plan-chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Gráfico">
      <path d="M${P} ${H - P}H${W - P}" stroke="var(--line)" />
      <path d="${path}" fill="none" stroke="var(--primary)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
      ${ps.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.v)}" r="4.5" fill="var(--primary)"/><text x="${x(i)}" y="${y(p.v) - 9}" text-anchor="middle" font-size="11" fill="currentColor">${num(p.v)}</text>
        <text x="${x(i)}" y="${H - 6}" text-anchor="middle" font-size="10" fill="var(--muted)">${br(p.d).slice(0, 5)}</text>`).join('')}
    </svg>${ps.length > 1 ? `<div class="small ${good ? 'plan-good' : 'muted'}">Desde ${br(ps[0].d)}: ${diff > 0 ? '+' : ''}${num(diff)}${unit}</div>` : ''}</div>`;
  }
  function evolutionHtml(evo, items) {
    if (!items.length) return '<p class="small muted" style="margin:0">Ainda sem registros.</p>';
    if (evo === 'fisio') {
      return `<b class="small">Dor (0 a 10)</b>${chart(items.map((e) => ({ d: e.date, v: e.pain })), { min: 0, max: 10, unit: ' pontos' })}`;
    }
    const parts = [['weight', 'Peso', ' kg'], ['waist', 'Cintura', ' cm'], ['hip', 'Quadril', ' cm'], ['fat', 'Gordura corporal', '%']]
      .filter(([k]) => items.some((e) => e[k] != null));
    return parts.map(([k, l, u]) => `<b class="small">${l}</b>${chart(items.map((e) => ({ d: e.date, v: e[k] })), { unit: u })}`).join('');
  }

  // ---------- Ver o plano ----------
  function planHtml(p) {
    const d = p.data;
    const by = `<p class="small muted" style="margin:0 0 10px">${esc(p.professional?.name || '')} · ${esc(p.professional?.profession || '')}${p.professional?.registry ? ` · ${esc(p.professional.registry)}` : ''} · ${br(p.created_at)}</p>`;
    if (p.kind === 'alimentar') {
      return `${by}${d.meals.map((m) => `<div class="plan-meal"><div class="pm-h"><b>${esc(m.name)}</b>${m.time ? `<span>${esc(m.time)}</span>` : ''}</div>
          ${m.items.map((i) => `<div class="pm-i"><span>${esc(i.food)}</span>${i.qty ? `<small>${esc(i.qty)}</small>` : ''}${i.subs ? `<em>Ou: ${esc(i.subs)}</em>` : ''}</div>`).join('')}</div>`).join('')}
        ${d.water ? `<p class="small"><b>Água:</b> ${esc(d.water)}</p>` : ''}${d.notes ? `<div class="plan-notes">${esc(d.notes)}</div>` : ''}
        <h3 style="margin:16px 0 6px">Lista de compras</h3>
        <div class="plan-shop">${p.shopping.map((s) => `<label class="check"><input type="checkbox" data-shop="${s.i}" ${s.done ? 'checked' : ''} ${p.viewer === 'patient' ? '' : 'disabled'}> <span>${esc(s.food)}</span></label>`).join('')}</div>
        ${p.viewer === 'patient' ? '<p class="small muted">Marque o que você já comprou.</p>' : ''}`;
    }
    return `${by}${d.freq ? `<p class="small"><b>Frequência:</b> ${esc(d.freq)}</p>` : ''}
      ${d.items.map((i, n) => `<div class="plan-ex"><span class="pe-n">${n + 1}</span><div><b>${esc(i.name)}</b>
        <div class="small">${[i.times && `<b>${esc(i.times)}</b>`, i.sets && `${esc(i.sets)} séries`, i.reps && `${esc(i.reps)}`, i.rest && `descanso ${esc(i.rest)}`].filter(Boolean).join(' · ')}</div>
        ${i.notes ? `<div class="small muted">${esc(i.notes)}</div>` : ''}
        ${i.video ? `<a class="yt-rec" href="${esc(i.video)}" target="_blank" rel="noopener"><span class="yt-badge">Recomendado</span><span class="yt-play" aria-hidden="true">▶</span> Assistir no YouTube</a>` : ''}</div></div>`).join('')}
      ${d.items.some((i) => i.video) ? '<p class="small muted" style="margin:8px 0 0">Os vídeos abrem no YouTube. Depois de assistir, é só voltar para a Acolia para continuar o seu plano.</p>' : ''}
      ${d.notes ? `<div class="plan-notes">${esc(d.notes)}</div>` : ''}
      <h3 style="margin:16px 0 6px">${p.viewer === 'patient' ? 'Seus últimos 14 dias' : 'Adesão (últimos 14 dias)'}</h3>
      <div class="plan-days">${p.days.map((x) => `<span class="${x.done ? 'on' : ''}" title="${br(x.date)}">${br(x.date).slice(0, 2)}</span>`).join('')}</div>
      <p class="small muted">${p.days.filter((x) => x.done).length} de 14 dias com exercícios feitos.</p>
      ${p.viewer === 'patient' ? `<button type="button" class="btn block ${p.done_today ? 'secondary' : ''}" data-done>${p.done_today ? '✓ Feito hoje (toque para desfazer)' : 'Fiz os exercícios hoje'}</button>` : ''}`;
  }
  async function openPlan(id) {
    let p;
    try { p = await api(`/api/plans/${id}`); } catch (e) { toast(e.message, 'error'); return; }
    modal({
      title: p.title, html: `<div data-plan-body>${planHtml(p)}</div>`, actions: [{ label: 'Fechar', class: 'secondary' }],
      onOpen: (dlg) => {
        const bind = () => {
          $$('[data-shop]', dlg).forEach((c) => c.addEventListener('change', async () => {
            try { p = await api(`/api/plans/${p.id}/check`, { method: 'POST', body: { item: Number(c.dataset.shop), on: c.checked } }); } catch (e) { toast(e.message, 'error'); c.checked = !c.checked; }
          }));
          $('[data-done]', dlg)?.addEventListener('click', async () => {
            try { p = await api(`/api/plans/${p.id}/check`, { method: 'POST', body: { on: !p.done_today } }); $('[data-plan-body]', dlg).innerHTML = planHtml(p); bind(); if (p.done_today) toast('Muito bem! Exercícios de hoje marcados.'); }
            catch (e) { toast(e.message, 'error'); }
          });
        };
        bind();
      },
    });
  }

  // ---------- Listas de sugestões (escolhe da lista ou escreve outro) ----------
  const FOODS = ['Arroz branco', 'Arroz integral', 'Feijão', 'Lentilha', 'Grão-de-bico', 'Ervilha', 'Batata-doce', 'Batata inglesa', 'Mandioca', 'Inhame',
    'Cuscuz', 'Macarrão integral', 'Pão integral', 'Pão francês', 'Tapioca', 'Aveia em flocos', 'Granola sem açúcar', 'Quinoa', 'Milho', 'Torrada integral',
    'Ovo cozido', 'Ovo mexido', 'Omelete', 'Frango grelhado', 'Peito de frango desfiado', 'Carne magra', 'Patinho moído', 'Peixe grelhado', 'Atum', 'Sardinha',
    'Tofu', 'Queijo branco', 'Queijo minas frescal', 'Ricota', 'Requeijão light', 'Iogurte natural', 'Iogurte grego', 'Leite desnatado', 'Leite vegetal', 'Whey protein',
    'Banana', 'Maçã', 'Mamão', 'Melão', 'Melancia', 'Laranja', 'Morango', 'Abacaxi', 'Manga', 'Uva', 'Pera', 'Kiwi', 'Abacate', 'Açaí sem açúcar',
    'Alface', 'Rúcula', 'Tomate', 'Pepino', 'Cenoura', 'Beterraba', 'Brócolis', 'Couve', 'Couve-flor', 'Abobrinha', 'Abóbora', 'Chuchu', 'Vagem', 'Espinafre',
    'Salada verde', 'Legumes cozidos', 'Legumes refogados', 'Sopa de legumes', 'Castanha-do-pará', 'Castanha de caju', 'Amêndoas', 'Amendoim', 'Pasta de amendoim',
    'Chia', 'Linhaça', 'Azeite de oliva', 'Café sem açúcar', 'Chá sem açúcar', 'Água de coco', 'Suco natural sem açúcar', 'Chocolate 70%'];
  const QTYS = ['1 unidade', '2 unidades', '1 fatia', '2 fatias', '1 colher de sopa', '2 colheres de sopa', '4 colheres de sopa', '1 concha', '1 xícara', '1/2 xícara',
    '1 copo (200 ml)', '1 pote (170 g)', '100 g', '120 g', '150 g', '1 porção', '1 prato de sobremesa', 'À vontade'];
  const EXERCISES = ['Ponte de glúteo', 'Prancha', 'Prancha lateral', 'Agachamento', 'Agachamento na parede', 'Afundo', 'Elevação de panturrilha', 'Abdominal',
    'Bird dog (quatro apoios)', 'Gato e camelo', 'Alongamento de isquiotibiais', 'Alongamento de quadríceps', 'Alongamento de panturrilha', 'Alongamento de peitoral',
    'Alongamento cervical', 'Rotação de ombros', 'Mobilidade de quadril', 'Rolamento pélvico', 'Respiração diafragmática', 'Ponte com uma perna', 'Ostra (concha)',
    'Elevação lateral de perna', 'Remada com elástico', 'Rotação externa de ombro com elástico', 'Fortalecimento de punho', 'Caminhada', 'Bicicleta ergométrica',
    'Equilíbrio em uma perna', 'Subir e descer degrau', 'Pilates: hundred', 'Pilates: roll up', 'Pilates: swan', 'Yoga: postura da criança', 'Yoga: cachorro olhando para baixo'];
  const TIMES = ['1 vez ao dia', '2 vezes ao dia', '3 vezes ao dia', 'Dia sim, dia não', '3 vezes por semana', '2 vezes por semana', 'Antes de dormir', 'Ao acordar'];
  const lists = () => `<datalist id="dl-foods">${FOODS.map((f) => `<option value="${esc(f)}">`).join('')}</datalist><datalist id="dl-qty">${QTYS.map((f) => `<option value="${esc(f)}">`).join('')}</datalist>
    <datalist id="dl-ex">${EXERCISES.map((f) => `<option value="${esc(f)}">`).join('')}</datalist><datalist id="dl-times">${TIMES.map((f) => `<option value="${esc(f)}">`).join('')}</datalist>`;

  // ---------- Montar o plano (profissional) ----------
  const MEALS = [['Café da manhã', '07:00'], ['Lanche da manhã', '10:00'], ['Almoço', '12:30'], ['Lanche da tarde', '16:00'], ['Jantar', '19:30'], ['Ceia', '21:30']];
  const mealRow = (m = {}) => `<div class="pe-meal" data-meal>
      <div class="row" style="gap:8px;flex-wrap:nowrap"><input data-m="name" value="${esc(m.name || '')}" placeholder="Refeição" maxlength="60" class="grow"><input data-m="time" type="time" value="${esc(m.time || '')}" style="max-width:110px"><button type="button" class="icon-btn" data-rm-meal title="Tirar refeição" aria-label="Tirar refeição">✕</button></div>
      <div data-items>${(m.items && m.items.length ? m.items : [{}]).map(foodRow).join('')}</div>
      <button type="button" class="btn ghost sm" data-add-food>+ alimento</button></div>`;
  function foodRow(i = {}) {
    return `<div class="pe-food" data-food><input data-f="food" list="dl-foods" value="${esc(i.food || '')}" placeholder="Alimento: escolha ou escreva" maxlength="120">
      <input data-f="qty" list="dl-qty" value="${esc(i.qty || '')}" placeholder="Quantidade (ex.: 2 fatias)" maxlength="60">
      <input data-f="subs" value="${esc(i.subs || '')}" placeholder="Substituições (opcional)" maxlength="200"><button type="button" class="icon-btn" data-rm title="Tirar" aria-label="Tirar">✕</button></div>`;
  }
  function exRow(i = {}) {
    return `<div class="pe-ex" data-ex><div class="row" style="gap:8px;flex-wrap:nowrap"><input data-x="name" list="dl-ex" value="${esc(i.name || '')}" placeholder="Exercício: escolha ou escreva" maxlength="100" class="grow"><button type="button" class="icon-btn" data-rm title="Tirar" aria-label="Tirar">✕</button></div>
      <div class="pe-2"><input data-x="times" list="dl-times" value="${esc(i.times || '')}" placeholder="Quantas vezes (ex.: 2 vezes ao dia)" maxlength="40"><input data-x="reps" value="${esc(i.reps || '')}" placeholder="Repetições ou tempo (opcional)" maxlength="40"></div>
      <input data-x="video" value="${esc(i.video || '')}" placeholder="Link do vídeo no YouTube (opcional)" maxlength="300" inputmode="url">
      <input data-x="notes" value="${esc(i.notes || '')}" placeholder="Observação (opcional)" maxlength="300"></div>`;
  }
  async function openEditor({ conversationId, can, patient, onSent }) {
    const food = can.kind === 'alimentar';
    let tpl = [];
    try { tpl = (await api('/api/plans/templates')).items.filter((t) => t.kind === can.kind); } catch { /* sem modelos */ }
    const body = (d = {}) => (food
      ? `<div data-meals>${(d.meals || MEALS.map(([name, time]) => ({ name, time }))).map(mealRow).join('')}</div>
         <button type="button" class="btn secondary sm" data-add-meal>+ refeição</button>
         <div class="field" style="margin-top:12px"><label>Água por dia</label><input data-k="water" value="${esc(d.water || '')}" placeholder="Ex.: 2 litros" maxlength="40"></div>`
      : `<div data-exs>${(d.items || [{}, {}]).map(exRow).join('')}</div>
         <button type="button" class="btn secondary sm" data-add-ex>+ exercício</button>
         <div class="field" style="margin-top:12px"><label>Frequência</label><input data-k="freq" value="${esc(d.freq || '')}" placeholder="Ex.: 3 vezes por semana" maxlength="60"></div>`)
      + `<div class="field"><label>Orientações</label><textarea data-k="notes" rows="3" maxlength="1500" placeholder="${food ? 'Ex.: evite pular refeições; mastigue devagar…' : 'Ex.: pare se sentir dor forte; respire durante o movimento…'}">${esc(d.notes || '')}</textarea></div>`;
    await modal({
      title: `${can.title}${patient ? ` para ${patient.split(' ')[0]}` : ''}`,
      html: `${can.title === 'Cardápio e orientações' ? '<p class="small notice info" style="margin-top:0">Orientações e cardápio, sem prescrição de dieta (a dieta é do nutricionista).</p>' : ''}
        ${tpl.length ? `<div class="field"><label>Começar de um plano anterior</label><select data-tpl><option value="">Plano em branco</option>${tpl.map((t, i) => `<option value="${i}">${esc(t.title)} · ${esc(t.patient.split(' ')[0])} · ${br(t.created_at)}</option>`).join('')}</select></div>` : ''}
        <div class="field"><label>Título</label><input data-k="title" value="${esc(can.title)}" maxlength="80"></div>
        ${food ? '<p class="small muted" style="margin:0 0 8px">Toque no campo do alimento para escolher da lista. Não achou? É só escrever.</p>' : '<p class="small muted" style="margin:0 0 8px">Escolha o exercício da lista ou escreva outro. O vídeo precisa ser um link do YouTube: o paciente assiste lá e volta para a Acolia.</p>'}
        <div data-plan-form class="plan-form">${body()}</div>${lists()}<div class="form-error hidden" data-err></div>`,
      actions: [{ label: 'Cancelar', class: 'secondary', value: false }, {
        label: 'Enviar na conversa', handler: async (dlg) => {
          const g = (k) => ($(`[data-k="${k}"]`, dlg)?.value || '').trim();
          const data = food
            ? { meals: $$('[data-meal]', dlg).map((m) => ({ name: $('[data-m="name"]', m).value, time: $('[data-m="time"]', m).value, items: $$('[data-food]', m).map((f) => ({ food: $('[data-f="food"]', f).value, qty: $('[data-f="qty"]', f).value, subs: $('[data-f="subs"]', f).value })).filter((i) => i.food.trim()) })), water: g('water'), notes: g('notes') }
            : { items: $$('[data-ex]', dlg).map((x) => Object.fromEntries(['name', 'times', 'reps', 'video', 'notes'].map((k) => [k, $(`[data-x="${k}"]`, x).value]))), freq: g('freq'), notes: g('notes') };
          try {
            const r = await api('/api/plans', { method: 'POST', body: { conversation_id: conversationId, title: g('title'), data } });
            toast('Enviado na conversa!'); onSent?.(r); return true;
          } catch (e) { const er = $('[data-err]', dlg); er.textContent = e.message; er.classList.remove('hidden'); return false; }
        },
      }],
      onOpen: (dlg) => {
        dlg.classList.add('wide');
        const form = $('[data-plan-form]', dlg);
        $('[data-tpl]', dlg)?.addEventListener('change', (e) => { const t = tpl[Number(e.target.value)]; form.innerHTML = body(t ? t.data : {}); });
        form.addEventListener('click', (e) => {
          if (e.target.closest('[data-add-meal]')) $('[data-meals]', form).insertAdjacentHTML('beforeend', mealRow());
          else if (e.target.closest('[data-add-food]')) e.target.closest('[data-meal]').querySelector('[data-items]').insertAdjacentHTML('beforeend', foodRow());
          else if (e.target.closest('[data-add-ex]')) $('[data-exs]', form).insertAdjacentHTML('beforeend', exRow());
          else if (e.target.closest('[data-rm-meal]')) e.target.closest('[data-meal]').remove();
          else if (e.target.closest('[data-rm]')) e.target.closest('[data-food], [data-ex]').remove();
        });
      },
    });
  }

  // ---------- Evolução (profissional) ----------
  async function openEvolution({ conversationId }) {
    let info;
    try { info = await api(`/api/plans/conversation/${conversationId}`); } catch (e) { toast(e.message, 'error'); return; }
    const nutri = info.evo === 'nutri';
    const today = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
    const list = (items) => (items.length ? `<div class="evo-list">${items.slice().reverse().map((e) => `<div><span>${br(e.date)}</span><b>${nutri ? [e.weight != null && `${num(e.weight)} kg`, e.waist != null && `cintura ${num(e.waist)}`, e.hip != null && `quadril ${num(e.hip)}`, e.fat != null && `${num(e.fat)}% gordura`].filter(Boolean).join(' · ') : `dor ${num(e.pain)}/10`}</b>${e.note ? `<small>${esc(e.note)}</small>` : ''}<button type="button" class="icon-btn" data-del="${e.id}" aria-label="Apagar">✕</button></div>`).join('')}</div>` : '');
    modal({
      title: `Evolução${info.patient ? ` de ${info.patient.split(' ')[0]}` : ''}`,
      html: `<div data-evo-chart>${evolutionHtml(info.evo, info.evolution)}</div><div data-evo-list>${list(info.evolution)}</div>
        <h3 style="margin:14px 0 8px">Novo registro</h3>
        <div class="evo-form">${nutri ? `<label>Peso (kg)<input data-e="weight" inputmode="decimal" placeholder="70,5"></label><label>Cintura (cm)<input data-e="waist" inputmode="decimal"></label><label>Quadril (cm)<input data-e="hip" inputmode="decimal"></label><label>Gordura (%)<input data-e="fat" inputmode="decimal"></label>`
          : `<label style="grid-column:1/-1">Dor de 0 a 10 <span data-pain-v>5</span><input type="range" min="0" max="10" step="1" value="5" data-e="pain"></label>`}
          <label>Data<input type="date" data-e="date" value="${today}" max="${today}"></label><label style="grid-column:1/-1">Observação<input data-e="note" maxlength="300" placeholder="Opcional"></label></div>
        <div class="form-error hidden" data-err></div><p class="small muted">O paciente vê o gráfico em Configurações → Meus planos e evolução.</p>`,
      actions: [{ label: 'Fechar', class: 'secondary', value: false }, {
        label: 'Salvar registro', handler: async (dlg) => {
          const v = Object.fromEntries($$('[data-e]', dlg).map((i) => [i.dataset.e, i.value]));
          try {
            const r = await api('/api/plans/evolution', { method: 'POST', body: { conversation_id: conversationId, ...v } });
            $('[data-evo-chart]', dlg).innerHTML = evolutionHtml(info.evo, r.evolution); $('[data-evo-list]', dlg).innerHTML = list(r.evolution); info.evolution = r.evolution;
            $$('[data-e]', dlg).forEach((i) => { if (!['date', 'pain'].includes(i.dataset.e)) i.value = ''; });
            $('[data-err]', dlg).classList.add('hidden'); toast('Registro salvo!');
          } catch (e) { const er = $('[data-err]', dlg); er.textContent = e.message; er.classList.remove('hidden'); }
          return false;
        },
      }],
      onOpen: (dlg) => {
        $('[data-e="pain"]', dlg)?.addEventListener('input', (e) => { $('[data-pain-v]', dlg).textContent = e.target.value; });
        dlg.addEventListener('click', async (e) => {
          const b = e.target.closest('[data-del]');
          if (!b) return;
          try { const r = await api(`/api/plans/evolution/${b.dataset.del}`, { method: 'DELETE' }); $('[data-evo-chart]', dlg).innerHTML = evolutionHtml(info.evo, r.evolution); $('[data-evo-list]', dlg).innerHTML = list(r.evolution); } catch (ex) { toast(ex.message, 'error'); }
        });
      },
    });
  }

  // ---------- Paciente: Meus planos e evolução ----------
  async function mountMine(el) {
    el.innerHTML = '<div class="spinner"></div>';
    let r;
    try { r = await api('/api/plans/mine'); } catch (e) { el.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    if (!r.plans.length && !r.evolution.length) { el.innerHTML = '<p class="small muted" style="margin:0">Quando um profissional do Nutri ou do Fisio mandar um plano ou registrar a sua evolução, aparece aqui.</p>'; return; }
    el.innerHTML = `${r.plans.map((p) => `<button type="button" class="plan-item" data-plan="${p.id}"><span class="ptag ${p.professional.portal === 'fisio' ? 'fisio' : 'nutri'}">${p.professional.portal === 'fisio' ? 'Fisio' : 'Nutri'}</span><b>${esc(p.title)}</b><small>${esc(p.professional.name)} · ${br(p.created_at)}</small></button>`).join('')}
      ${r.evolution.map((e) => `<div class="card flat" style="margin-top:10px"><b style="display:block;margin-bottom:6px">Sua evolução com ${esc(e.professional.name)}</b>${evolutionHtml(e.evo, e.items)}</div>`).join('')}`;
    $$('[data-plan]', el).forEach((b) => b.addEventListener('click', () => openPlan(b.dataset.plan)));
  }

  window.AcoliaPlans = { openPlan, openEditor, openEvolution, mountMine, evolutionHtml };
})();
