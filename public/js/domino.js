/* Acolia 1.3 — Minijogo de dominó na chamada (só o paciente vê o botão).
   O paciente joga contra o robô enquanto continua vendo e ouvindo o profissional.
   Regras (dominó de 28 peças, duplo-seis): 7 peças para cada um; o resto fica para comprar.
   Começa quem tem o maior duplo. Sem peça que encaixe, compra; sem peças para comprar, passa.
   Ganha quem acabar as peças primeiro; se o jogo trancar, ganha quem tiver menos pontos na mão.
   Robô "médio": na maioria das vezes escolhe uma boa jogada, mas às vezes erra.
   Para tirar o minijogo: apagar este arquivo, o <script> em atendimento.html, o botão data-game
   e as linhas marcadas "minijogo" em call.js e app.css. */
(function () {
  'use strict';
  const DOTS = { 0: [], 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
  const half = (n) => `<span class="dm-half">${Array.from({ length: 9 }, (_, i) => `<i class="${DOTS[n].includes(i) ? 'on' : ''}"></i>`).join('')}</span>`;
  const tileHtml = (a, b, cls = '', attrs = '') => `<span class="dm-tile ${a === b ? 'v' : ''} ${cls}" ${attrs}>${half(a)}${half(b)}</span>`;
  const sum = (hand) => hand.reduce((x, t) => x + t[0] + t[1], 0);

  function newGame() {
    const all = [];
    for (let a = 0; a <= 6; a++) for (let b = a; b <= 6; b++) all.push([a, b]);
    for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
    const g = { hands: [all.slice(0, 7), all.slice(7, 14)], stock: all.slice(14), chain: [], turn: 0, passes: 0, over: null, pending: null };
    // começa quem tem o maior duplo (sem duplo: a peça mais alta)
    const best = (h) => Math.max(...h.map((t) => (t[0] === t[1] ? 100 + t[0] : t[0] + t[1])));
    g.turn = best(g.hands[0]) >= best(g.hands[1]) ? 0 : 1;
    return g;
  }
  const ends = (g) => (g.chain.length ? [g.chain[0][0], g.chain[g.chain.length - 1][1]] : null);
  function movesOf(g, who) {
    const e = ends(g);
    const out = [];
    g.hands[who].forEach((t, i) => {
      if (!e) { out.push({ i, side: 'R' }); return; }
      if (t[0] === e[0] || t[1] === e[0]) out.push({ i, side: 'L' });
      if ((t[0] === e[1] || t[1] === e[1]) && !(e[0] === e[1] && out.some((m) => m.i === i))) out.push({ i, side: 'R' });
    });
    return out;
  }
  function play(g, who, { i, side }) {
    const t = g.hands[who].splice(i, 1)[0];
    const e = ends(g);
    if (!e) g.chain.push([t[0], t[1]]);
    else if (side === 'L') g.chain.unshift(t[1] === e[0] ? [t[0], t[1]] : [t[1], t[0]]);
    else g.chain.push(t[0] === e[1] ? [t[0], t[1]] : [t[1], t[0]]);
    g.passes = 0;
    if (!g.hands[who].length) g.over = { winner: who, reason: 'bateu' };
  }
  function pass(g) {
    g.passes += 1;
    if (g.passes >= 2) { // trancou: menos pontos na mão ganha
      const a = sum(g.hands[0]);
      const b = sum(g.hands[1]);
      g.over = { winner: a < b ? 0 : b < a ? 1 : -1, reason: 'trancou', points: [a, b] };
    }
  }
  // Robô médio: 25% das vezes joga qualquer peça que encaixe; no resto, escolhe a melhor pela conta
  function robotMove(g) {
    const ms = movesOf(g, 1);
    if (!ms.length) return null;
    if (Math.random() < 0.25) return ms[Math.floor(Math.random() * ms.length)];
    const hand = g.hands[1];
    const e = ends(g);
    let best = null;
    let bestScore = -Infinity;
    for (const m of ms) {
      const t = hand[m.i];
      const exposed = !e ? t[1] : m.side === 'L' ? (t[1] === e[0] ? t[0] : t[1]) : (t[0] === e[1] ? t[1] : t[0]);
      const keep = hand.filter((x, k) => k !== m.i && (x[0] === exposed || x[1] === exposed)).length;
      const score = t[0] + t[1] + (t[0] === t[1] ? 4 : 0) + keep * 1.5 + Math.random();
      if (score > bestScore) { bestScore = score; best = m; }
    }
    return best;
  }

  function mount(stage, { onToggle } = {}) {
    const el = document.createElement('div');
    el.className = 'dm-panel hidden';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Minijogo de dominó');
    el.innerHTML = `
      <div class="dm-head"><b>Dominó</b><span class="dm-score" data-dm-score></span>
        <button type="button" class="dm-x" data-dm-close aria-label="Fechar o minijogo">✕</button></div>
      <div class="dm-robot"><span>🤖 Robô</span><span class="dm-backs" data-dm-robot></span></div>
      <div class="dm-board" data-dm-board></div>
      <div class="dm-status" data-dm-status></div>
      <div class="dm-sides hidden" data-dm-sides>
        <button type="button" class="dm-btn" data-dm-side="L">◀ Na ponta esquerda</button>
        <button type="button" class="dm-btn" data-dm-side="R">Na ponta direita ▶</button></div>
      <div class="dm-hand" data-dm-hand></div>
      <div class="dm-actions"><button type="button" class="dm-btn hidden" data-dm-draw></button>
        <button type="button" class="dm-btn hidden" data-dm-pass>Passar a vez</button></div>
      <div class="dm-over hidden" data-dm-over><div><div class="dm-over-t" data-dm-over-t></div><div class="dm-over-s" data-dm-over-s></div>
        <div class="dm-sides" style="justify-content:center"><button type="button" class="dm-btn main" data-dm-restart>Jogar de novo</button>
        <button type="button" class="dm-btn" data-dm-close>Fechar</button></div></div></div>`;
    stage.appendChild(el);
    const $ = (s) => el.querySelector(s);
    const score = [0, 0];
    let g = null;
    let robotTimer = null;

    function render() {
      $('[data-dm-score]').textContent = `Você ${score[0]} × ${score[1]} Robô`;
      $('[data-dm-robot]').innerHTML = `${'<i></i>'.repeat(g.hands[1].length)} <small>${g.hands[1].length}</small>`;
      const e = ends(g);
      $('[data-dm-board]').innerHTML = g.chain.length
        ? g.chain.map((t, k) => tileHtml(t[0], t[1], k === 0 || k === g.chain.length - 1 ? 'end' : '')).join('')
        : '<span class="dm-empty">A mesa está vazia</span>';
      const board = $('[data-dm-board]');
      board.scrollTop = board.scrollHeight;
      const mine = g.turn === 0 && !g.over;
      const ms = mine ? movesOf(g, 0) : [];
      $('[data-dm-hand]').innerHTML = g.hands[0].map((t, i) => {
        const can = ms.some((m) => m.i === i);
        return tileHtml(t[0], t[1], `big ${can ? 'can' : ''} ${g.pending === i ? 'sel' : ''}`, `data-dm-i="${i}" role="button" aria-label="Peça ${t[0]} e ${t[1]}"`);
      }).join('');
      const draw = $('[data-dm-draw]');
      draw.textContent = `Comprar peça (${g.stock.length})`;
      draw.classList.toggle('hidden', !(mine && !ms.length && g.stock.length));
      $('[data-dm-pass]').classList.toggle('hidden', !(mine && !ms.length && !g.stock.length));
      $('[data-dm-sides]').classList.toggle('hidden', g.pending == null);
      $('[data-dm-status]').textContent = g.over ? '' : g.turn === 1 ? 'Robô pensando…'
        : ms.length ? (e ? `Sua vez · pontas: ${e[0]} e ${e[1]}` : 'Você começa! Escolha uma peça.')
          : g.stock.length ? 'Nenhuma peça encaixa: compre uma.' : 'Nenhuma peça encaixa e acabou o monte: passe a vez.';
      const ov = $('[data-dm-over]');
      ov.classList.toggle('hidden', !g.over);
      if (g.over) {
        const w = g.over.winner;
        $('[data-dm-over-t]').textContent = w === 0 ? 'Você venceu! 🎉' : w === 1 ? 'O robô venceu 🤖' : 'Empate!';
        $('[data-dm-over-s]').textContent = g.over.reason === 'bateu'
          ? (w === 0 ? 'Você acabou com as suas peças.' : 'O robô acabou com as peças dele.')
          : `O jogo trancou. Pontos na mão: você ${g.over.points[0]}, robô ${g.over.points[1]}.`;
      }
    }
    function finishIfOver() {
      if (!g.over) return false;
      if (g.over.winner >= 0) score[g.over.winner] += 1;
      render();
      return true;
    }
    function robotTurn() {
      clearTimeout(robotTimer);
      robotTimer = setTimeout(() => {
        if (!g || g.over || g.turn !== 1) return;
        let m = robotMove(g);
        while (!m && g.stock.length) { g.hands[1].push(g.stock.pop()); m = robotMove(g); }
        if (m) play(g, 1, m); else pass(g);
        g.turn = 0;
        if (!finishIfOver()) render();
      }, 700 + Math.random() * 600);
    }
    function humanPlay(m) {
      g.pending = null;
      play(g, 0, m);
      g.turn = 1;
      if (finishIfOver()) return;
      render();
      robotTurn();
    }
    function start() {
      g = newGame();
      render();
      if (g.turn === 1) robotTurn();
    }

    el.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-dm-close]')) return close();
      if (ev.target.closest('[data-dm-restart]')) return start();
      if (!g || g.over || g.turn !== 0) return;
      const tile = ev.target.closest('[data-dm-i]');
      if (tile) {
        const i = Number(tile.dataset.dmI);
        const ms = movesOf(g, 0).filter((m) => m.i === i);
        if (!ms.length) { $('[data-dm-status]').textContent = 'Essa peça não encaixa em nenhuma ponta.'; return; }
        if (ms.length === 1) return humanPlay(ms[0]);
        g.pending = i; // encaixa nas duas pontas: a pessoa escolhe o lado
        return render();
      }
      const side = ev.target.closest('[data-dm-side]');
      if (side && g.pending != null) return humanPlay({ i: g.pending, side: side.dataset.dmSide });
      if (ev.target.closest('[data-dm-draw]') && g.stock.length) { g.hands[0].push(g.stock.pop()); return render(); }
      if (ev.target.closest('[data-dm-pass]')) {
        pass(g);
        g.turn = 1;
        if (!finishIfOver()) { render(); robotTurn(); }
      }
    });

    function open() {
      el.classList.remove('hidden');
      stage.classList.add('game-open');
      if (!g) start();
      else { render(); if (!g.over && g.turn === 1) robotTurn(); } // continua de onde parou
      onToggle?.(true);
    }
    function close() {
      clearTimeout(robotTimer);
      el.classList.add('hidden');
      stage.classList.remove('game-open');
      onToggle?.(false);
    }
    return { open, close, get isOpen() { return !el.classList.contains('hidden'); } };
  }

  window.AcoliaDomino = { mount, _test: { newGame, movesOf, play, pass, robotMove, ends } };
})();
