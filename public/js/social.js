/* Acolia 1.2 — Início estilo Instagram (só para quem tem conta).
   - Stories no topo (foto ou vídeo de até 20 s). Profissional posta; todos que seguem veem e curtem.
   - Feed com as publicações de quem a pessoa segue: primeiro as que ela ainda não viu.
   - Curtir (símbolo da Acolia, fica vermelho), comentar (só texto) e compartilhar (aviãozinho).
   - Sininho com as notificações (seguiu você, curtiu, comentou, curtiu seu story). */
(function () {
  'use strict';
  const { $, $$, esc, api, ICONS, avatar, toast, modal, confirmDialog, timeAgo, shrinkImage } = window.Acolia;
  const ic = (name, s = 22) => ICONS[name].replace('<svg', `<svg style="width:${s}px;height:${s}px"`);
  const MAX_STORY_SECS = 20;

  let ctx = { role: null, me: null, onMessage: null, onOpenProfile: null };

  // ---------- Peças ----------
  const likeBtn = (liked, attr) => `<button type="button" class="like-btn ${liked ? 'on' : ''}" ${attr} aria-pressed="${liked}" aria-label="${liked ? 'Descurtir' : 'Curtir'}"><span class="mind" aria-hidden="true"></span></button>`;

  // Selo do perfil oficial (Acolia Brasil)
  const officialBadge = '<span class="official-badge" title="Perfil oficial da Acolia" aria-label="Perfil oficial"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 1.5l2.6 1.9 3.2-.1 1 3 2.6 1.9-1 3.1 1 3.1-2.6 1.9-1 3-3.2-.1L12 22.5l-2.6-1.9-3.2.1-1-3-2.6-1.9 1-3.1-1-3.1 2.6-1.9 1-3 3.2.1z"/><path d="M8 12.2l2.7 2.7L16.2 9.4" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';

  function authorLink(a, extra = '') {
    const inner = `${avatar(a.name, a.photo, 'sm')}<span class="who"><b>${esc(a.name)}${a.official ? officialBadge : ''}</b>${a.subtitle ? `<small>${esc(a.subtitle)}</small>` : ''}${extra}</span>`;
    return a.role === 'professional'
      ? `<a class="post-author" href="#" data-open-pro="${a.id}">${inner}</a>`
      : `<span class="post-author">${inner}</span>`;
  }

  // Uma foto, ou carrossel (arrastar para o lado) com as bolinhas e o contador "1/5"
  function mediaHtml(p) {
    // Reel no feed: toca sozinho sem som quando aparece na tela; tocar no vídeo liga/desliga o som
    if (p.kind === 'reel') {
      return `<div class="post-img reel-media" data-dbl-like="${p.id}">
        <video src="${esc(p.video)}" poster="${esc(p.image)}" playsinline muted loop preload="none" data-autoplay data-feed-video></video>
        <button type="button" class="reel-tag" data-reel-open="${p.id}" aria-label="Abrir nos Reels">${ic('reel', 16)} Reels</button>
        <button type="button" class="reel-sound" data-sound aria-label="Ligar ou desligar o som">${ic(feedSound ? 'volume' : 'volumeOff', 18)}</button>
      </div>`;
    }
    const imgs = p.images?.length ? p.images : [p.image];
    const alt = `Publicação de ${esc(p.author.name)}`;
    if (imgs.length === 1) return `<div class="post-img" data-dbl-like="${p.id}"><img src="${esc(imgs[0])}" alt="${alt}" loading="lazy"></div>`;
    return `<div class="post-img carousel" data-dbl-like="${p.id}" data-carousel>
        <div class="car-track" data-track>${imgs.map((src, i) => `<img src="${esc(src)}" alt="${alt} — foto ${i + 1} de ${imgs.length}" loading="lazy">`).join('')}</div>
        <span class="car-count" data-count>1/${imgs.length}</span>
        <button type="button" class="car-arrow prev" data-car="-1" aria-label="Foto anterior" hidden>‹</button>
        <button type="button" class="car-arrow next" data-car="1" aria-label="Próxima foto">›</button>
      </div>
      <div class="car-dots" data-dots>${imgs.map((_, i) => `<i class="${i ? '' : 'on'}"></i>`).join('')}</div>`;
  }

  // Atualiza bolinhas, contador e setas conforme a pessoa arrasta
  function syncCarousel(car) {
    const track = car.querySelector('[data-track]');
    const n = track.children.length;
    const i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
    car.querySelector('[data-count]').textContent = `${i + 1}/${n}`;
    car.nextElementSibling?.querySelectorAll('i').forEach((d, k) => d.classList.toggle('on', k === i));
    car.querySelector('.prev').hidden = i === 0;
    car.querySelector('.next').hidden = i === n - 1;
  }
  document.addEventListener('scroll', (e) => {
    const t = e.target;
    if (t instanceof Element && t.matches('[data-track]')) syncCarousel(t.closest('[data-carousel]'));
  }, true);
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-car]');
    if (!b) return;
    const track = b.closest('[data-carousel]').querySelector('[data-track]');
    track.scrollBy({ left: Number(b.dataset.car) * track.clientWidth, behavior: 'smooth' });
  });

  // Ícone de "várias fotos" na grade do perfil
  const multiIcon = '<span class="multi-ic" aria-label="Várias fotos"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 3h11a3 3 0 0 1 3 3v11a1 1 0 0 1-1 1h-1V6a1 1 0 0 0-1-1H6V4a1 1 0 0 1 1-1z"/><rect x="3" y="7" width="13" height="14" rx="2.5"/></svg></span>';
  const reelIcon = `<span class="multi-ic" aria-label="Vídeo">${ICONS.play}</span>`;
  const gridTile = (x) => `<button type="button" class="gallery-item ${x.kind === 'reel' ? 'is-reel' : ''}" data-post-open="${x.id}" aria-label="${x.kind === 'reel' ? 'Abrir vídeo' : `Abrir publicação${x.count > 1 ? ` (${x.count} fotos)` : ''}`}"><img src="${esc(x.image)}" alt="" loading="lazy">${x.kind === 'reel' ? reelIcon : x.count > 1 ? multiIcon : ''}</button>`;

  // ---------- Vídeos: tocam sozinhos quando aparecem na tela ----------
  let feedSound = false; // no feed começam sem som (tocar no vídeo liga)
  let reelSound = true;  // na aba Reels começam com som
  const videoIO = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      const v = en.target;
      if (en.isIntersecting && en.intersectionRatio >= 0.6) {
        v.muted = !feedSound;
        v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
      } else v.pause();
    });
  }, { threshold: [0, 0.6] }) : null;
  function watchVideos(root) {
    $$('video[data-autoplay]:not([data-watched])', root).forEach((v) => { v.dataset.watched = '1'; videoIO?.observe(v); });
  }
  function syncSoundIcons() {
    $$('[data-feed-video]').forEach((v) => { v.muted = !feedSound; });
    $$('[data-sound]').forEach((b) => { b.innerHTML = ic(feedSound ? 'volume' : 'volumeOff', 18); });
  }

  // Só paciente (ou visitante, que é levado a criar conta) manda mensagem; profissional não manda para profissional
  const canMsg = (p) => !p.mine && !p.author.official && ctx.role !== 'professional';
  function sendMessage(proId) {
    if (ctx.onMessage) ctx.onMessage(proId);
    else location.href = `/app#conversar/${proId}`;
  }

  // Seguir / Seguindo no canto da publicação (não aparece na própria publicação — lá fica o ⋮)
  function followChip(p) {
    if (p.follow === 'official') return '<button type="button" class="follow-chip following" data-follow-official>Seguindo</button>';
    if (p.follow !== true && p.follow !== false) return '';
    return `<button type="button" class="follow-chip ${p.follow ? 'following' : ''}" data-follow-pro="${p.author.id}">${p.follow ? 'Seguindo' : 'Seguir'}</button>`;
  }

  function postCard(p) {
    return `<article class="post-card" data-post="${p.id}">
      <header>${authorLink(p.author, `<small class="muted">· ${esc(timeAgo(p.created_at))}</small>`)}
        ${followChip(p)}
        ${p.mine ? `<button type="button" class="icon-btn" data-post-menu="${p.id}" aria-label="Opções">⋮</button>` : ''}</header>
      ${mediaHtml(p)}
      <div class="post-actions">
        ${likeBtn(p.liked, `data-like="${p.id}"`)}
        <button type="button" class="icon-btn" data-comments="${p.id}" aria-label="Comentários">${ic('comment')}<span class="cnt" data-ccount="${p.id}">${p.comments || ''}</span></button>
        <button type="button" class="icon-btn" data-share="${p.id}" aria-label="Compartilhar">${ic('plane')}</button>
        ${p.mine ? `<button type="button" class="icon-btn to-story" data-to-story="${p.id}" aria-label="Colocar no meu story" title="Colocar no meu story">${ic('storyAdd')}</button>` : ''}
        ${canMsg(p) ? `<button type="button" class="msg-pill" data-msg-pro="${p.author.id}" title="Enviar mensagem para marcar a consulta">${ic('send', 16)} Mensagem</button>` : ''}
      </div>
      ${p.likes ? `<div class="post-likes" data-lcount="${p.id}">${p.likes} ${p.likes === 1 ? 'curtida' : 'curtidas'}</div>` : `<div class="post-likes" data-lcount="${p.id}"></div>`}
      ${p.caption ? `<p class="post-caption"><b>${esc(p.author.name)}</b> ${esc(p.caption)}</p>` : ''}
    </article>`;
  }

  function updateLikes(root, p) {
    $$(`[data-like="${p.id}"]`, root).forEach((b) => { b.classList.toggle('on', p.liked); b.setAttribute('aria-pressed', String(p.liked)); });
    $$(`[data-lcount="${p.id}"]`, root).forEach((el) => { el.textContent = p.likes ? `${p.likes} ${p.likes === 1 ? 'curtida' : 'curtidas'}` : ''; });
    $$(`[data-lnum="${p.id}"]`, root).forEach((el) => { el.textContent = p.likes || ''; });
  }

  // ---------- Ações (curtir, comentar, compartilhar, apagar) ----------
  async function toggleLike(id, btn) {
    const on = btn.classList.contains('on');
    btn.classList.toggle('on', !on); // responde na hora
    if (!on) { btn.classList.remove('pop'); void btn.offsetWidth; btn.classList.add('pop'); }
    try {
      const p = await api(`/api/social/posts/${id}/like`, { method: on ? 'DELETE' : 'POST' });
      updateLikes(document, p);
    } catch (e) { btn.classList.toggle('on', on); toast(e.message, 'error'); }
  }

  async function share(id) {
    const url = `${location.origin}/p/${id}`;
    const text = 'Veja esta publicação na Acolia:';
    if (navigator.share) {
      try { await navigator.share({ title: 'Acolia', text, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    window.open(`https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}`, '_blank', 'noopener');
  }

  function commentHtml(c) {
    return `<li class="comment" data-comment="${c.id}">
      ${c.author.role === 'professional' ? `<a href="#" data-open-pro="${c.author.id}">${avatar(c.author.name, c.author.photo, 'sm')}</a>` : avatar(c.author.name, c.author.photo, 'sm')}
      <div class="grow">
        <div class="c-head">${c.author.role === 'professional' ? `<a href="#" data-open-pro="${c.author.id}"><b>${esc(c.author.name)}</b></a>` : `<b>${esc(c.author.name)}</b>`}
          ${c.author.subtitle ? `<small class="muted">${esc(c.author.subtitle)}</small>` : ''}</div>
        <div class="c-body">${esc(c.body)}</div>
        <small class="muted">${esc(timeAgo(c.created_at))}</small>
      </div>
      ${c.can_delete ? `<button type="button" class="icon-btn" data-del-comment="${c.id}" aria-label="Apagar comentário" title="Apagar">${ic('trash', 18)}</button>` : ''}
    </li>`;
  }

  async function openComments(postId) {
    let items = [];
    try { items = (await api(`/api/social/posts/${postId}/comments`)).items; } catch (e) { toast(e.message, 'error'); return; }
    const setCount = () => $$(`[data-ccount="${postId}"]`).forEach((el) => { el.textContent = items.length || ''; });
    await modal({
      title: 'Comentários',
      html: `<ul class="comments" data-list>${items.length ? items.map(commentHtml).join('') : '<li class="muted small" data-empty>Seja o primeiro a comentar.</li>'}</ul>
        <form class="comment-form" data-form><input maxlength="500" placeholder="Escreva um comentário…" aria-label="Comentário" required>
          <button class="btn sm" type="submit" aria-label="Publicar comentário">${ic('send', 18)}</button></form>`,
      actions: [],
      onOpen: (dlg) => {
        dlg.classList.add('sheet');
        const list = $('[data-list]', dlg);
        $('[data-form]', dlg).addEventListener('submit', async (e) => {
          e.preventDefault();
          const input = $('input', e.target);
          const body = input.value.trim();
          if (!body) return;
          input.value = '';
          try {
            const c = await api(`/api/social/posts/${postId}/comments`, { method: 'POST', body: { body } });
            items.push(c);
            $('[data-empty]', list)?.remove();
            list.insertAdjacentHTML('beforeend', commentHtml(c));
            list.lastElementChild.scrollIntoView({ block: 'nearest' });
            setCount();
          } catch (ex) { input.value = body; toast(ex.message, 'error'); }
        });
        list.addEventListener('click', async (e) => {
          const b = e.target.closest('[data-del-comment]');
          if (b) {
            if (!await confirmDialog('Apagar este comentário?', { okLabel: 'Apagar', danger: true, title: 'Apagar comentário' })) return;
            try {
              await api(`/api/social/comments/${b.dataset.delComment}`, { method: 'DELETE' });
              items = items.filter((c) => c.id !== Number(b.dataset.delComment));
              b.closest('li').remove();
              setCount();
            } catch (ex) { toast(ex.message, 'error'); }
            return;
          }
          const pro = e.target.closest('[data-open-pro]');
          if (pro) { e.preventDefault(); dlg.close(); dlg.remove(); openProfile(Number(pro.dataset.openPro)); }
        });
      },
    });
  }

  function openProfile(id) {
    if (ctx.onOpenProfile) ctx.onOpenProfile(id);
    else location.href = `/profissional.html?id=${id}`;
  }

  // Só o dono: coloca a publicação no próprio story (quem vê o story toca e abre a publicação)
  async function postToStory(id, btn) {
    btn.disabled = true;
    try {
      await api(`/api/social/posts/${id}/story`, { method: 'POST' });
      toast('Publicação adicionada ao seu story!');
      window.dispatchEvent(new Event('acolia:stories'));
    } catch (e) { toast(e.message, 'error'); }
    btn.disabled = false;
  }

  async function deletePost(id, root) {
    if (!await confirmDialog('Apagar esta publicação? Ela some do seu perfil e do feed.', { okLabel: 'Apagar', danger: true, title: 'Apagar publicação' })) return false;
    try {
      await api(`/api/social/posts/${id}`, { method: 'DELETE' });
      $$(`[data-post="${id}"]`, root || document).forEach((el) => el.remove());
      toast('Publicação apagada');
      return true;
    } catch (e) { toast(e.message, 'error'); return false; }
  }

  // Botão "Seguir" em cima da publicação de quem a pessoa ainda não segue
  async function followFromPost(btn) {
    const id = Number(btn.dataset.followPro);
    const on = btn.classList.contains('following');
    const all = $$(`[data-follow-pro="${id}"]`);
    all.forEach((b) => { b.disabled = true; });
    try {
      const r = await api(`/api/social/follow/${id}`, { method: on ? 'DELETE' : 'POST' });
      all.forEach((b) => { b.classList.toggle('following', r.following); b.textContent = r.following ? 'Seguindo' : 'Seguir'; });
      toast(r.following ? 'Agora você segue este profissional' : 'Você deixou de seguir este profissional');
    } catch (e) { toast(e.message, 'error'); }
    all.forEach((b) => { b.disabled = false; });
  }

  // Um único "ouvinte" de cliques para feed, publicação aberta e perfil
  function bindActions(root) {
    if (root._socialBound) return;
    root._socialBound = true;
    watchVideos(root);
    if ('MutationObserver' in window) new MutationObserver(() => watchVideos(root)).observe(root, { childList: true, subtree: true });
    root.addEventListener('click', (e) => {
      const like = e.target.closest('[data-like]');
      const com = e.target.closest('[data-comments]');
      // Sem conta: vê a publicação e compartilha, mas curtir e comentar pedem conta
      if (ctx.anon && (like || com)) return ctx.onNeedAccount?.();
      if (like) return toggleLike(Number(like.dataset.like), like);
      if (com) return openComments(Number(com.dataset.comments));
      const sh = e.target.closest('[data-share]');
      if (sh) return share(Number(sh.dataset.share));
      const msg = e.target.closest('[data-msg-pro]');
      if (msg) return ctx.anon ? ctx.onNeedAccount?.() : sendMessage(Number(msg.dataset.msgPro));
      const ro = e.target.closest('[data-reel-open]');
      if (ro) return openPost(Number(ro.dataset.reelOpen));
      if (e.target.closest('[data-sound]') || e.target.closest('[data-feed-video]')) {
        feedSound = !feedSound;
        syncSoundIcons();
        const v = e.target.closest('.reel-media')?.querySelector('video');
        if (v && v.paused) v.play().catch(() => {});
        return;
      }
      const fol = e.target.closest('[data-follow-pro]');
      if (fol) return ctx.anon ? ctx.onNeedAccount?.() : followFromPost(fol);
      if (e.target.closest('[data-follow-official]')) return toast('Todos seguem a Acolia Brasil 💚');
      const pro = e.target.closest('[data-open-pro]');
      if (pro) { e.preventDefault(); return openProfile(Number(pro.dataset.openPro)); }
      const menu = e.target.closest('[data-post-menu]');
      if (menu) return deletePost(Number(menu.dataset.postMenu), root);
      const ts = e.target.closest('[data-to-story]');
      if (ts) return postToStory(Number(ts.dataset.toStory), ts);
    });
    // Toque duplo na foto curte (como no Instagram)
    root.addEventListener('dblclick', (e) => {
      const img = e.target.closest('[data-dbl-like]');
      if (!img) return;
      if (ctx.anon) return ctx.onNeedAccount?.();
      const btn = $(`[data-like="${img.dataset.dblLike}"]`, img.closest('.post-card, .rv-slide'));
      if (btn && !btn.classList.contains('on')) toggleLike(Number(img.dataset.dblLike), btn);
    });
  }

  // Publicação aberta (a partir da grade do perfil ou de uma notificação)
  async function openPost(id) {
    let p;
    try { p = await api(`/api/social/posts/${id}`); } catch (e) { toast(e.message, 'error'); return; }
    if (p.kind === 'reel' && !p.locked) return openReels({ start: p });
    await modal({
      html: postCard(p),
      actions: [],
      onOpen: (dlg) => {
        dlg.classList.add('post-dialog');
        bindActions(dlg);
        dlg.addEventListener('click', (e) => {
          if (e.target.closest('[data-open-pro]')) { dlg.close(); dlg.remove(); }
        }, true);
      },
    });
  }

  // ---------- Nova publicação (profissional) ----------
  // Uma publicação com 1 a 10 fotos (carrossel) e uma descrição para todas
  const MAX_PHOTOS = 10;
  async function newPost(onDone, { base = '/api/social/posts', title = 'Nova publicação' } = {}) {
    let files = [];
    await modal({
      title,
      html: `<label class="pick-media" data-pick><input type="file" accept="image/jpeg,image/png,image/webp" multiple hidden data-file>
          <span data-empty-pick>${ic('image', 40)}<b>Escolher fotos</b><small class="muted">Até ${MAX_PHOTOS} fotos numa publicação</small></span></label>
        <div class="pick-strip hidden" data-strip></div>
        <div class="field" style="margin-top:12px"><label for="cap">Descrição (opcional)</label><textarea id="cap" rows="3" maxlength="2200" placeholder="Escreva algo sobre esta publicação…" data-cap></textarea></div>`,
      actions: [{ label: 'Cancelar', value: null, class: 'secondary' }, {
        label: 'Publicar',
        handler: async (dlg) => {
          if (!files.length) { toast('Escolha pelo menos uma foto.', 'error'); return false; }
          const btn = $$('.dlg-actions .btn', dlg).at(-1);
          btn.disabled = true;
          btn.textContent = 'Publicando…';
          const fd = new FormData();
          fd.append('caption', $('[data-cap]', dlg).value);
          for (const f of files) fd.append('photos', await shrinkImage(f, 1600));
          try {
            const p = await api(base, { method: 'POST', form: fd });
            // Miniatura leve (da 1ª foto) para a prévia do link no WhatsApp
            const tf = new FormData();
            tf.append('photo', await shrinkImage(files[0], 600));
            api(`${base}/${p.id}/thumb`, { method: 'POST', form: tf }).catch(() => {});
            toast('Publicado!');
            onDone?.(p);
            return true;
          } catch (e) { toast(e.message, 'error'); btn.disabled = false; btn.textContent = 'Publicar'; return false; }
        },
      }],
      onOpen: (dlg) => {
        const strip = $('[data-strip]', dlg);
        const render = () => {
          strip.classList.toggle('hidden', !files.length);
          $('[data-empty-pick]', dlg).innerHTML = files.length
            ? `${ic('plus', 28)}<b>Adicionar mais fotos</b><small class="muted">${files.length} de ${MAX_PHOTOS}</small>`
            : `${ic('image', 40)}<b>Escolher fotos</b><small class="muted">Até ${MAX_PHOTOS} fotos numa publicação</small>`;
          $('[data-pick]', dlg).classList.toggle('compact', files.length > 0);
          $('[data-pick]', dlg).classList.toggle('hidden', files.length >= MAX_PHOTOS);
          strip.innerHTML = files.map((f, i) => `<div class="pick-thumb"><img src="${URL.createObjectURL(f)}" alt="Foto ${i + 1}">
            <span class="n">${i + 1}</span><button type="button" data-rm="${i}" aria-label="Tirar foto ${i + 1}">${ic('close', 14)}</button></div>`).join('');
        };
        $('[data-file]', dlg).addEventListener('change', (e) => {
          const picked = [...e.target.files];
          if (files.length + picked.length > MAX_PHOTOS) toast(`No máximo ${MAX_PHOTOS} fotos por publicação.`, 'error');
          files = [...files, ...picked].slice(0, MAX_PHOTOS);
          e.target.value = '';
          render();
        });
        strip.addEventListener('click', (e) => {
          const rm = e.target.closest('[data-rm]');
          if (rm) { files.splice(Number(rm.dataset.rm), 1); render(); }
        });
      },
    });
  }

  // Cruz do Início: escolher entre publicar fotos ou story
  function createMenu(onPost, onStory, onReel) {
    modal({
      title: 'Criar',
      html: `<div class="create-menu">
        <button type="button" data-v="post">${ic('image', 30)}<b>Publicar fotos</b><small>No feed e no seu perfil (até ${MAX_PHOTOS} fotos)</small></button>
        <button type="button" data-v="reel">${ic('reel', 30)}<b>Publicar reel</b><small>Vídeo de até 5 minutos, no feed, nos Reels e no seu perfil</small></button>
        <button type="button" data-v="story">${ic('video', 30)}<b>Publicar story</b><small>Foto ou vídeo de até ${MAX_STORY_SECS} s, some em 24 h</small></button></div>`,
      actions: [],
      onOpen: (dlg) => {
        dlg.classList.add('sheet');
        $$('[data-v]', dlg).forEach((b) => b.addEventListener('click', () => {
          dlg.close();
          dlg.remove();
          if (b.dataset.v === 'post') onPost(); else if (b.dataset.v === 'reel') onReel?.(); else onStory();
        }));
      },
    });
  }

  // ---------- Stories ----------
  const SEEN_KEY = 'acolia-stories-vistos';
  const seenSet = () => { try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')); } catch { return new Set(); } };
  function markSeen(id) {
    try { const s = seenSet(); s.add(id); localStorage.setItem(SEEN_KEY, JSON.stringify([...s].slice(-500))); } catch { /* ignora */ }
  }

  async function newStory(onDone) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*,video/*';
    input.addEventListener('change', async () => {
      const f = input.files[0];
      if (!f) return;
      let duration = 0;
      if (f.type.startsWith('video/')) {
        duration = await new Promise((ok) => {
          const v = document.createElement('video');
          v.preload = 'metadata';
          v.onloadedmetadata = () => ok(v.duration || 0);
          v.onerror = () => ok(0);
          v.src = URL.createObjectURL(f);
        });
        if (duration > MAX_STORY_SECS + 0.9) { toast(`O vídeo do story pode ter no máximo ${MAX_STORY_SECS} segundos. Este tem ${Math.round(duration)} s.`, 'error'); return; }
      }
      const fd = new FormData();
      fd.append('duration', String(duration));
      fd.append('media', f.type.startsWith('image/') ? await shrinkImage(f, 1600) : f);
      toast('Enviando story…');
      try {
        await api('/api/social/stories', { method: 'POST', form: fd });
        toast('Story publicado!');
        onDone?.();
      } catch (e) { toast(e.message, 'error'); }
    });
    input.click();
  }

  // Visualizador em tela cheia: barrinhas de progresso, toque à direita/esquerda para avançar/voltar
  function openStories(groups, gi, onClose) {
    let g = gi;
    let i = 0;
    let timer = null;
    const el = document.createElement('div');
    el.className = 'story-viewer';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Stories');
    document.body.appendChild(el);
    document.body.style.overflow = 'hidden';
    const first = groups[g].items.findIndex((s) => !seenSet().has(s.id));
    i = first >= 0 ? first : 0;

    const close = () => { clearTimeout(timer); el.remove(); document.body.style.overflow = ''; onClose?.(); };
    const next = () => { clearTimeout(timer); if (i < groups[g].items.length - 1) i++; else if (g < groups.length - 1) { g++; i = 0; } else return close(); show(); };
    const prev = () => { clearTimeout(timer); if (i > 0) i--; else if (g > 0) { g--; i = groups[g].items.length - 1; } show(); };

    function show() {
      const grp = groups[g];
      const s = grp.items[i];
      markSeen(s.id);
      const pro = grp.professional;
      el.innerHTML = `
        <div class="sv-bars">${grp.items.map((_, k) => `<i class="${k < i ? 'done' : ''}"><b></b></i>`).join('')}</div>
        <div class="sv-head">${avatar(pro.name, pro.photo, 'sm')}<b>${esc(pro.name)}</b><small>${esc(timeAgo(s.created_at))}</small>
          <button type="button" class="sv-close" aria-label="Fechar">${ic('close', 26)}</button></div>
        <div class="sv-media">${s.kind === 'post' && s.post
          ? `<div class="sv-post" style="--bg:url('${esc(s.post.image)}')">
              <button type="button" class="sv-post-card" data-sv-open-post="${s.post.id}" aria-label="Abrir publicação">
                <span class="sv-post-head">${avatar(pro.name, pro.photo, 'sm')}<b>${esc(pro.name)}</b></span>
                <span class="sv-post-img"><img src="${esc(s.post.image)}" alt="Publicação de ${esc(pro.name)}">${s.post.count > 1 ? `<span class="car-count">1/${s.post.count}</span>` : ''}</span>
                ${s.post.caption ? `<span class="sv-post-cap">${esc(s.post.caption.slice(0, 120))}${s.post.caption.length > 120 ? '…' : ''}</span>` : ''}
              </button>
              <span class="sv-post-hint">Toque na publicação para abrir</span></div>`
          : s.kind === 'video'
            ? `<video src="${esc(s.media)}" playsinline autoplay></video>`
            : `<img src="${esc(s.media)}" alt="Story de ${esc(pro.name)}">`}</div>
        <button type="button" class="sv-nav prev" aria-label="Anterior"></button>
        <button type="button" class="sv-nav next" aria-label="Próximo"></button>
        <div class="sv-foot">
          ${grp.mine
            ? `<span class="sv-likes">${likeBtn(false, 'disabled')} ${s.likes || 0} ${s.likes === 1 ? 'curtida' : 'curtidas'}</span>
               <button type="button" class="btn sm secondary" data-sv-del>${ic('trash', 16)} Apagar</button>`
            : `${likeBtn(s.liked, 'data-sv-like')}
               ${ctx.role === 'patient' ? `<button type="button" class="btn sm" data-sv-msg>${ic('chat', 18)} Enviar mensagem</button>` : ''}`}
        </div>`;
      const bar = $$('.sv-bars i', el)[i].querySelector('b');
      const run = (secs) => {
        bar.style.transition = 'none';
        bar.style.width = '0';
        requestAnimationFrame(() => { bar.style.transition = `width ${secs}s linear`; bar.style.width = '100%'; });
        timer = setTimeout(next, secs * 1000);
      };
      const v = $('video', el);
      if (v) {
        v.addEventListener('loadedmetadata', () => run(Math.min(MAX_STORY_SECS, v.duration || MAX_STORY_SECS)));
        v.addEventListener('error', () => run(5));
        v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
      } else run(5);

      $('[data-sv-open-post]', el)?.addEventListener('click', () => { const pid = s.post.id; close(); openPost(pid); });
      $('.sv-close', el).onclick = close;
      $('.sv-nav.next', el).onclick = next;
      $('.sv-nav.prev', el).onclick = prev;
      $('[data-sv-like]', el)?.addEventListener('click', async (e) => {
        const b = e.currentTarget;
        const on = b.classList.contains('on');
        b.classList.toggle('on', !on);
        if (!on) b.classList.add('pop');
        try { const r = await api(`/api/social/stories/${s.id}/like`, { method: on ? 'DELETE' : 'POST' }); s.liked = r.liked; } catch (ex) { b.classList.toggle('on', on); toast(ex.message, 'error'); }
      });
      $('[data-sv-msg]', el)?.addEventListener('click', () => { close(); ctx.onMessage?.(pro.id); });
      $('[data-sv-del]', el)?.addEventListener('click', async () => {
        clearTimeout(timer);
        v?.pause();
        if (!await confirmDialog('Apagar este story?', { okLabel: 'Apagar', danger: true, title: 'Apagar story' })) { next(); return; }
        try {
          await api(`/api/social/stories/${s.id}`, { method: 'DELETE' });
          grp.items.splice(i, 1);
          if (!grp.items.length) return close();
          if (i >= grp.items.length) i = grp.items.length - 1;
          show();
        } catch (ex) { toast(ex.message, 'error'); }
      });
    }
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); if (e.key === 'ArrowRight') next(); if (e.key === 'ArrowLeft') prev(); });
    el.tabIndex = -1;
    show();
    el.focus();
  }

  // ---------- Notificações ----------
  async function openNotifications(onRead) {
    let data;
    try { data = await api('/api/social/notifications'); } catch (e) { toast(e.message, 'error'); return; }
    api('/api/social/notifications/read', { method: 'POST' }).then(onRead).catch(() => {});
    await modal({
      title: 'Notificações',
      html: data.items.length ? `<ul class="notifs">${data.items.map((n) => `
        <li class="${n.read ? '' : 'unread'}" ${n.post ? `data-open-post="${n.post.id}"` : ''}>
          ${n.actor ? avatar(n.actor.name, n.actor.photo, 'sm') : `<span class="avatar sm notif-ic">${n.type === 'follow' ? ic('userPlus', 18) : '<span class="like-btn on" style="padding:0"><span class="mind" style="width:22px;height:22px"></span></span>'}</span>`}
          <div class="grow"><div>${esc(n.text)}</div><small class="muted">${esc(timeAgo(n.created_at))}</small></div>
          ${n.post ? `<img src="${esc(n.post.image)}" alt="" class="notif-thumb">` : ''}
        </li>`).join('')}</ul>` : '<p class="muted">Nenhuma notificação ainda.</p>',
      actions: [],
      onOpen: (dlg) => {
        dlg.classList.add('sheet');
        dlg.addEventListener('click', (e) => {
          const li = e.target.closest('[data-open-post]');
          if (li) { dlg.close(); dlg.remove(); openPost(Number(li.dataset.openPost)); }
        });
      },
    });
  }

  // ---------- Novo reel (profissional): vídeo de até 5 minutos ----------
  const REEL_MAX_SECS = 5 * 60;
  const REEL_MAX_MB = 200;
  // Lê a duração e tira a capa (um quadro do começo do vídeo). Se o aparelho não conseguir
  // abrir o vídeo aqui (formato), usa uma capa com as cores da Acolia.
  function readVideo(file) {
    return new Promise((resolve) => {
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'metadata';
      const url = URL.createObjectURL(file);
      let done = false;
      const finish = (duration, canvas) => {
        if (done) return;
        done = true;
        const c = canvas || fallbackPoster();
        c.toBlob((blob) => { URL.revokeObjectURL(url); resolve({ duration, poster: blob }); }, 'image/jpeg', 0.82);
      };
      setTimeout(() => finish(Number.isFinite(v.duration) ? v.duration : null, null), 15000);
      v.addEventListener('loadedmetadata', () => {
        const d = Number.isFinite(v.duration) ? v.duration : null;
        if (!v.videoWidth) return finish(d, null);
        v.addEventListener('seeked', () => {
          const scale = Math.min(1, 720 / v.videoWidth);
          const c = document.createElement('canvas');
          c.width = Math.round(v.videoWidth * scale); c.height = Math.round(v.videoHeight * scale);
          try { c.getContext('2d').drawImage(v, 0, 0, c.width, c.height); finish(d, c); } catch { finish(d, null); }
        }, { once: true });
        v.currentTime = Math.min(1, (d || 2) * 0.1);
      }, { once: true });
      v.addEventListener('error', () => finish(null, null), { once: true });
      v.src = url;
    });
  }
  function fallbackPoster() {
    const c = document.createElement('canvas');
    c.width = 720; c.height = 1280;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 720, 1280);
    grad.addColorStop(0, '#3f5550'); grad.addColorStop(1, '#8a7362');
    g.fillStyle = grad; g.fillRect(0, 0, 720, 1280);
    g.fillStyle = 'rgba(255,255,255,.9)';
    g.beginPath(); g.moveTo(300, 540); g.lineTo(300, 740); g.lineTo(460, 640); g.closePath(); g.fill();
    return c;
  }
  // Envio com barra de progresso (vídeo pode ser grande)
  function uploadWithProgress(url, fd, onProgress) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('POST', url);
      x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      x.onload = () => {
        let d = {};
        try { d = JSON.parse(x.responseText); } catch { /* ignora */ }
        if (x.status < 400) resolve(d); else reject(new Error(d.error || 'Não foi possível enviar o vídeo.'));
      };
      x.onerror = () => reject(new Error('A conexão caiu durante o envio. Tente de novo.'));
      x.send(fd);
    });
  }
  const fmtSecs = (t) => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`;

  async function newReel(onDone) {
    let file = null;
    let meta = null;
    await modal({
      title: 'Novo reel',
      html: `<label class="pick-media" data-pick><input type="file" accept="video/mp4,video/quicktime,video/webm,video/*" hidden data-file>
          <span data-empty-pick>${ic('reel', 40)}<b>Escolher vídeo</b><small class="muted">Até 5 minutos (máximo ${REEL_MAX_MB} MB)</small></span></label>
        <div class="reel-preview hidden" data-prev><video playsinline muted controls data-pv></video><small class="muted" data-dur></small></div>
        <div class="field" style="margin-top:12px"><label for="rcap">Descrição (opcional)</label><textarea id="rcap" rows="3" maxlength="2200" placeholder="Escreva algo sobre este vídeo…" data-cap></textarea></div>
        <div class="upload-bar hidden" data-bar><i data-fill></i><span data-pct>0%</span></div>`,
      actions: [{ label: 'Cancelar', value: null, class: 'secondary' }, {
        label: 'Publicar',
        handler: async (dlg) => {
          if (!file || !meta) { toast('Escolha um vídeo.', 'error'); return false; }
          const btn = $$('.dlg-actions .btn', dlg).at(-1);
          btn.disabled = true;
          btn.textContent = 'Enviando…';
          $('[data-bar]', dlg).classList.remove('hidden');
          const fd = new FormData();
          fd.append('caption', $('[data-cap]', dlg).value);
          if (meta.duration) fd.append('duration', String(Math.round(meta.duration * 10) / 10));
          fd.append('poster', meta.poster, 'capa.jpg');
          fd.append('video', file, file.name || 'video.mp4');
          try {
            const p = await uploadWithProgress('/api/social/reels', fd, (f) => {
              $('[data-fill]', dlg).style.width = `${Math.round(f * 100)}%`;
              $('[data-pct]', dlg).textContent = f >= 1 ? 'Finalizando…' : `${Math.round(f * 100)}%`;
            });
            toast('Reel publicado!');
            onDone?.(p);
            return true;
          } catch (e) {
            toast(e.message, 'error');
            btn.disabled = false; btn.textContent = 'Publicar';
            $('[data-bar]', dlg).classList.add('hidden');
            return false;
          }
        },
      }],
      onOpen: (dlg) => {
        $('[data-file]', dlg).addEventListener('change', async (e) => {
          const f = e.target.files[0];
          e.target.value = '';
          if (!f) return;
          if (f.size > REEL_MAX_MB * 1024 * 1024) { toast(`Vídeo muito grande (máximo ${REEL_MAX_MB} MB).`, 'error'); return; }
          $('[data-empty-pick]', dlg).innerHTML = `<span class="spinner"></span><small class="muted">Preparando o vídeo…</small>`;
          const m = await readVideo(f);
          if (m.duration && m.duration > REEL_MAX_SECS + 1) {
            toast('O vídeo pode ter no máximo 5 minutos.', 'error');
            $('[data-empty-pick]', dlg).innerHTML = `${ic('reel', 40)}<b>Escolher outro vídeo</b><small class="muted">Até 5 minutos</small>`;
            return;
          }
          file = f; meta = m;
          $('[data-empty-pick]', dlg).innerHTML = `${ic('reel', 28)}<b>Trocar vídeo</b>`;
          $('[data-pick]', dlg).classList.add('compact');
          $('[data-prev]', dlg).classList.remove('hidden');
          $('[data-pv]', dlg).src = URL.createObjectURL(f);
          $('[data-dur]', dlg).textContent = m.duration ? `Duração: ${fmtSecs(m.duration)}` : '';
        });
      },
    });
  }

  // ---------- Reels: vídeos em tela cheia, um por vez (arrasta para cima) ----------
  // Ordem aleatória, de todos os profissionais. Curtir, comentar, compartilhar, Seguir e
  // Mensagem (paciente). O dono do vídeo tem ⭐+ (colocar no story) e ⋮ (apagar).
  function reelSlide(p) {
    return `<section class="rv-slide" data-slide="${p.id}" data-post="${p.id}">
      <div class="rv-media" data-dbl-like="${p.id}" data-rv-tap>
        <video src="${esc(p.video)}" poster="${esc(p.image)}" playsinline loop preload="metadata" data-rv-video></video>
        <span class="rv-paused" aria-hidden="true">${ic('play', 72)}</span>
      </div>
      <button type="button" class="rv-sound" data-rv-sound aria-label="Ligar ou desligar o som">${ic(reelSound ? 'volume' : 'volumeOff', 20)}</button>
      <div class="rv-side">
        <div class="rv-act">${likeBtn(p.liked, `data-like="${p.id}"`)}<span data-lnum="${p.id}">${p.likes || ''}</span></div>
        <button type="button" class="rv-act" data-comments="${p.id}" aria-label="Comentários">${ic('comment', 30)}<span data-ccount="${p.id}">${p.comments || ''}</span></button>
        <button type="button" class="rv-act" data-share="${p.id}" aria-label="Compartilhar">${ic('plane', 30)}</button>
        ${canMsg(p) ? `<button type="button" class="rv-act msg" data-msg-pro="${p.author.id}" aria-label="Enviar mensagem para marcar a consulta">${ic('send', 26)}<span>Mensagem</span></button>` : ''}
        ${p.mine ? `<button type="button" class="rv-act" data-to-story="${p.id}" aria-label="Colocar no meu story">${ic('storyAdd', 30)}</button>
          <button type="button" class="rv-act" data-post-menu="${p.id}" aria-label="Opções"><span style="font-size:1.6rem;line-height:1">⋮</span></button>` : ''}
      </div>
      <div class="rv-info">
        <div class="rv-author">${authorLink(p.author)}${followChip(p)}</div>
        ${p.caption ? `<p class="rv-cap" data-rv-cap>${esc(p.caption)}</p>` : ''}
      </div>
    </section>`;
  }

  function openReels({ start = null } = {}) {
    return new Promise((resolve) => {
      $$('video[data-feed-video]').forEach((v) => v.pause());
      const el = document.createElement('div');
      el.className = 'reels-view';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-label', 'Reels');
      el.innerHTML = `<div class="rv-top"><button type="button" class="rv-close" data-rv-close aria-label="Voltar">${ic('back', 26)}</button><b>Reels</b><span></span></div>
        <div class="rv-list" data-rv-list></div>`;
      document.body.appendChild(el);
      document.documentElement.classList.add('rv-open');
      bindActions(el);
      const list = $('[data-rv-list]', el);
      const shown = [];
      let more = true;
      let busy = false;
      let closed = false;
      const seenIds = new Set();

      const io = new IntersectionObserver((entries) => {
        entries.forEach((en) => {
          const slide = en.target;
          const v = $('video', slide);
          if (en.isIntersecting && en.intersectionRatio >= 0.7) {
            v.muted = !reelSound;
            v.play().then(() => slide.classList.remove('paused')).catch(() => {
              v.muted = true; reelSound = false; syncReelSound();
              v.play().catch(() => slide.classList.add('paused'));
            });
            const id = Number(slide.dataset.slide);
            if (!seenIds.has(id)) { seenIds.add(id); api('/api/social/seen', { method: 'POST', body: { ids: [id] } }).catch(() => {}); }
            if (!slide.nextElementSibling || !slide.nextElementSibling.nextElementSibling) load();
          } else { v.pause(); }
        });
      }, { root: list, threshold: [0, 0.7] });

      function syncReelSound() {
        $$('[data-rv-video]', el).forEach((v) => { v.muted = !reelSound; });
        $$('[data-rv-sound]', el).forEach((b) => { b.innerHTML = ic(reelSound ? 'volume' : 'volumeOff', 20); });
      }
      function add(items) {
        items = items.filter((p) => !shown.includes(p.id));
        shown.push(...items.map((p) => p.id));
        list.insertAdjacentHTML('beforeend', items.map(reelSlide).join(''));
        items.forEach((p) => {
          const slide = $(`[data-slide="${p.id}"]`, list);
          const v = $('video', slide);
          // vídeo deitado aparece inteiro; em pé ocupa a tela toda
          v.addEventListener('loadedmetadata', () => slide.classList.toggle('landscape', v.videoWidth > v.videoHeight), { once: true });
          io.observe(slide);
        });
      }
      async function load() {
        if (busy || !more || closed) return;
        busy = true;
        try {
          const d = await api(`/api/social/reels?sug=${shown.slice(-400).join(',')}`);
          add(d.items);
          more = d.has_more;
          if (!shown.length) list.innerHTML = `<div class="rv-empty">${ic('reel', 56)}<p>Ainda não há vídeos. Quando os profissionais publicarem, eles aparecem aqui.</p></div>`;
        } catch (e) { toast(e.message, 'error'); more = false; }
        busy = false;
      }

      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-rv-close]')) { history.state?.acoliaReels ? history.back() : close(); return; }
        if (e.target.closest('[data-rv-sound]')) { reelSound = !reelSound; syncReelSound(); return; }
        const cap = e.target.closest('[data-rv-cap]');
        if (cap) { cap.classList.toggle('open'); return; }
        const tap = e.target.closest('[data-rv-tap]');
        if (tap) {
          const slide = tap.closest('.rv-slide');
          const v = $('video', slide);
          if (v.paused) { v.muted = !reelSound; v.play().catch(() => {}); slide.classList.remove('paused'); } else { v.pause(); slide.classList.add('paused'); }
        }
      });
      const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('dialog[open]')) close(); };
      const onPop = () => close();
      const onHash = () => close();
      function close() {
        if (closed) return;
        closed = true;
        io.disconnect();
        $$('video', el).forEach((v) => { v.pause(); v.removeAttribute('src'); v.load(); });
        el.remove();
        document.documentElement.classList.remove('rv-open');
        document.removeEventListener('keydown', onKey);
        window.removeEventListener('popstate', onPop);
        window.removeEventListener('hashchange', onHash);
        resolve();
      }
      history.pushState({ acoliaReels: 1 }, '');
      document.addEventListener('keydown', onKey);
      window.addEventListener('popstate', onPop);
      window.addEventListener('hashchange', onHash);
      if (start) add([start]);
      load();
    });
  }

  // ---------- Início ----------
  function mountHome(root, opts) {
    ctx = { ...ctx, ...opts };
    const isPro = opts.role === 'professional';
    root.innerHTML = `
      <div class="home">
        <div class="home-top">
          <div class="ht-side left">${isPro ? `<button type="button" class="icon-btn create-btn" data-create aria-label="Criar: publicar fotos ou story" title="Publicar fotos ou story">${ic('plus', 28)}</button>` : ''}</div>
          <h1 class="ht-title"><button type="button" class="feed-logo" data-home-top title="Voltar ao topo e atualizar">
            <span class="fl-words"><img class="fl-name brand-word" src="/img/logo-nome.png" alt="Acolia"><span class="fl-feed">Feed</span></span></button></h1>
          <div class="ht-side right"><button type="button" class="icon-btn bell" data-bell aria-label="Notificações" title="Notificações">${ic('bell', 27)}<span class="nav-badge" data-bell-count></span></button></div>
          <!-- Feed | Reels: ficam sempre à mão no topo (encolhem ao rolar) -->
          <div class="home-tabs" role="tablist" aria-label="Feed ou Reels">
            <button type="button" class="active" role="tab" aria-selected="true" data-home-tab="feed">${ic('grid', 18)}<span>Feed</span></button>
            <button type="button" role="tab" aria-selected="false" data-home-tab="reels">${ic('reel', 18)}<span>Reels</span></button>
          </div>
        </div>
        <div class="stories-bar" data-stories></div>
        <div class="feed" data-feed></div>
        <div data-sentinel style="height:1px"></div>
      </div>`;
    bindActions(root);
    const feed = $('[data-feed]', root);
    let offset = 0;
    let more = true;
    let loading = false;
    let groups = [];
    let sugIds = []; // sugestões já mostradas (o servidor não repete)

    async function loadStories() {
      try {
        const data = await api('/api/social/stories');
        groups = data.groups;
      } catch { groups = []; }
      const seen = seenSet();
      const own = groups.find((x) => x.mine);
      const others = groups.filter((x) => !x.mine);
      const bubble = (grp, idx) => {
        const unseen = grp.items.some((s) => !seen.has(s.id));
        return `<button type="button" class="story-bubble ${unseen ? 'unseen' : ''}" data-story-group="${idx}">
          <span class="ring">${avatar(grp.professional.name, grp.professional.photo, 'lg')}</span><small>${esc(grp.mine ? 'Seu story' : grp.professional.name.split(' ')[0])}</small></button>`;
      };
      const ordered = own ? [own, ...others] : others;
      groups = ordered;
      const addOwn = '';
      $('[data-stories]', root).innerHTML = addOwn + ordered.map(bubble).join('');
      $('[data-stories]', root).classList.toggle('hidden', !addOwn && !ordered.length);
    }

    const seenQueue = new Set();
    let seenTimer = null;
    const io = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting && en.intersectionRatio >= 0.6) {
          seenQueue.add(Number(en.target.dataset.post));
          io.unobserve(en.target);
        }
      });
      clearTimeout(seenTimer);
      seenTimer = setTimeout(() => {
        const ids = [...seenQueue];
        seenQueue.clear();
        if (ids.length) api('/api/social/seen', { method: 'POST', body: { ids } }).catch(() => {});
      }, 1200);
    }, { threshold: [0.6] }) : null;

    async function loadFeed(reset) {
      if (loading || (!more && !reset)) return;
      loading = true;
      if (reset) { offset = 0; more = true; sugIds = []; feed.innerHTML = '<div class="spinner"></div>'; }
      try {
        const data = await api(`/api/social/feed?offset=${offset}&sug=${sugIds.slice(-400).join(',')}`);
        if (reset) feed.innerHTML = '';
        if (!data.items.length && offset === 0) {
          feed.innerHTML = `<div class="empty">${ic('home', 48)}<p>${data.following
            ? 'Quem você segue ainda não publicou nada.'
            : 'Siga profissionais para ver as publicações e os stories deles aqui.'}</p>
            <button type="button" class="btn secondary sm" data-go-pros>Ver profissionais</button></div>`;
          $('[data-go-pros]', feed).onclick = () => opts.onFindPros?.();
        }
        data.items = data.items.filter((p) => !$(`[data-post="${p.id}"]`, feed)); // sem repetir no feed
        feed.insertAdjacentHTML('beforeend', data.items.map(postCard).join(''));
        data.items.forEach((p) => { if (!p.seen && io) io.observe($(`[data-post="${p.id}"]`, feed)); });
        offset += data.main_count ?? data.items.length;
        sugIds.push(...data.items.filter((p) => p.suggested).map((p) => p.id));
        more = data.has_more;
      } catch (e) { if (reset) feed.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
      loading = false;
    }

    async function refreshBell() {
      try {
        const { unread } = await api('/api/social/notifications/unread');
        $('[data-bell-count]', root).textContent = unread ? String(unread) : '';
        opts.onUnread?.(unread);
      } catch { /* ignora */ }
    }

    root.addEventListener('click', (e) => {
      const sb = e.target.closest('[data-story-group]');
      if (sb) return openStories(groups, Number(sb.dataset.storyGroup), loadStories);
      if (e.target.closest('[data-create]')) return createMenu(() => newPost(() => loadFeed(true)), () => newStory(loadStories), () => newReel(() => loadFeed(true)));
      if (e.target.closest('[data-home-tab="reels"]')) return openReels();
      if (e.target.closest('[data-bell]')) return openNotifications(refreshBell);
      if (e.target.closest('[data-home-top]') || e.target.closest('[data-home-tab="feed"]')) return toTop();
    });

    if ('IntersectionObserver' in window) {
      new IntersectionObserver((en) => { if (en[0].isIntersecting) loadFeed(false); }, { rootMargin: '600px' }).observe($('[data-sentinel]', root));
    }
    opts.socket?.on('social:notification', refreshBell);
    window.addEventListener('acolia:stories', loadStories);

    const topBar = $('.home-top', root);
    window.addEventListener('scroll', () => { topBar.classList.toggle('stuck', window.scrollY > 40); }, { passive: true });
    const reload = () => { loadStories(); loadFeed(true); refreshBell(); };
    // Tocar na casinha (ou no título "Início") já estando no Início: sobe e atualiza
    const toTop = () => { window.scrollTo({ top: 0, behavior: 'smooth' }); reload(); };
    reload();
    return { reload, refreshBell, toTop };
  }

  // ---------- Perfil: grade de publicações e botão Seguir ----------
  // Primeiras 6 fotos; "Ver todas as fotos" carrega o resto (só com conta). Visitante não abre.
  function bindProfile(container, p, { onNeedAccount } = {}) {
    bindActions(container);
    if (p.official) return bindOfficial(container, p, { onNeedAccount });
    $$('[data-all-posts]', container).forEach((moreBtn) => {
      moreBtn.addEventListener('click', () => {
        if (p.locked || !p.viewer_role) return onNeedAccount?.();
        const kind = moreBtn.dataset.allPosts === 'reel' ? 'reel' : 'photo';
        if (ctx.onAllPosts) ctx.onAllPosts(p.id, kind);
        else location.href = `${ctx.role === 'professional' ? '/painel' : '/app'}#posts/${p.id}/${kind}`;
      });
    });
    container.addEventListener('click', (e) => {
      const open = e.target.closest('[data-post-open]');
      if (open) return openPost(Number(open.dataset.postOpen));
    });
    const fb = $('[data-follow]', container);
    if (fb) {
      fb.addEventListener('click', async () => {
        if (p.locked || !p.viewer_role) return onNeedAccount?.();
        const on = fb.classList.contains('following');
        try {
          const r = await api(`/api/social/follow/${p.id}`, { method: on ? 'DELETE' : 'POST' });
          fb.classList.toggle('following', r.following);
          fb.textContent = r.following ? 'Seguindo' : 'Seguir';
          $$('[data-followers]', container).forEach((el) => { el.textContent = r.followers; });
        } catch (ex) { toast(ex.message, 'error'); }
      });
    }
  }

  // ---------- Perfil oficial Acolia Brasil ----------
  // Todas as publicações direto no perfil, com rolagem sem fim. Visitante sem conta vê só
  // as primeiras (mesma regra dos profissionais) e o resto pede conta. Não dá para deixar de seguir.
  function bindOfficial(container, p, { onNeedAccount } = {}) {
    const grid = $('[data-official-grid]', container);
    const end = $('[data-official-end]', container);
    const spin = $('[data-official-loading]', container);
    container.addEventListener('click', (e) => {
      const open = e.target.closest('[data-post-open]');
      if (open) return openPost(Number(open.dataset.postOpen));
      if (e.target.closest('[data-follow]')) {
        if (p.locked || !p.viewer_role) return onNeedAccount?.();
        toast('Todos seguem a Acolia Brasil 💚');
      }
    });
    let offset = 0;
    let more = true;
    let busy = false;
    let kind = 'photo';
    container.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-of-tab]');
      if (!tab || tab.dataset.ofTab === kind) return;
      kind = tab.dataset.ofTab;
      $$('[data-of-tab]', container).forEach((b) => b.classList.toggle('active', b === tab));
      grid.innerHTML = ''; offset = 0; more = true; busy = false;
      load();
    });
    async function load() {
      if (busy || !more) return;
      busy = true;
      try {
        const want = kind;
        const data = await api(`/api/social/professionals/${p.id}/posts?offset=${offset}&limit=24&kind=${want}`);
        if (want !== kind) { busy = false; return; }
        if (data.locked) {
          const next = location.pathname + location.search;
          const lockedTiles = Math.min(data.hidden || 0, 4 - data.items.length);
          grid.innerHTML = data.items.map((x, i) => `<button type="button" class="gallery-item" data-gallery-need-account="${esc(next)}" aria-label="Crie conta para ampliar"><img src="${esc(x.image)}" alt="Publicação ${i + 1} da Acolia Brasil" loading="lazy"></button>`).join('')
            + Array.from({ length: lockedTiles }, () => `<a class="gallery-item gallery-locked" href="/cadastro-paciente?next=${encodeURIComponent(next)}">${ic('lock', 20)}<span>Crie conta para ver</span></a>`).join('');
          more = false;
        } else {
          grid.insertAdjacentHTML('beforeend', data.items.map(gridTile).join(''));
          offset += data.items.length;
          more = data.has_more;
        }
        if (!grid.children.length) grid.innerHTML = `<p class="muted" style="grid-column:1/-1">${kind === 'reel' ? 'Nenhum vídeo ainda.' : 'Nenhuma foto ainda.'}</p>`;
      } catch (e) { toast(e.message, 'error'); more = false; }
      spin?.classList.toggle('hidden', !more);
      busy = false;
    }
    if ('IntersectionObserver' in window && end) {
      new IntersectionObserver((en) => { if (en[0].isIntersecting) load(); }, { rootMargin: '400px' }).observe(end);
    }
    load();
  }

  // ---------- Página "Todas as publicações" de um profissional ----------
  // Grade com rolagem infinita; tocar abre a publicação. Botão para voltar ao perfil.
  function mountPostsPage(root, proId, { onBack, kind } = {}) {
    kind = kind || (location.hash.split('/')[2] === 'reel' ? 'reel' : 'photo');
    root.innerHTML = `<div class="posts-page">
        <div class="posts-top"><button type="button" class="btn ghost sm" data-back-profile>← Voltar para o perfil</button></div>
        <div class="posts-head" data-head></div>
        <div class="pv-tabs" role="tablist">
          <button type="button" role="tab" data-pp-tab="photo" class="${kind === 'photo' ? 'active' : ''}">${ic('grid', 20)} Fotos</button>
          <button type="button" role="tab" data-pp-tab="reel" class="${kind === 'reel' ? 'active' : ''}">${ic('reel', 20)} Vídeos</button>
        </div>
        <div class="gallery-grid posts-grid" data-grid></div>
        <div class="spinner" data-loading></div>
        <div data-end style="height:1px"></div>
      </div>`;
    bindActions(root);
    $('[data-back-profile]', root).addEventListener('click', () => onBack?.(proId));
    const grid = $('[data-grid]', root);
    let offset = 0;
    let more = true;
    let busy = false;
    api(`/api/professionals/${proId}`).then((p) => {
      $('[data-head]', root).innerHTML = `<div class="row" style="gap:12px">${avatar(p.name, p.photo)}<div><b>${esc(p.name)}</b>
        <div class="muted small">${p.posts_count} ${p.posts_count === 1 ? 'publicação' : 'publicações'}</div></div></div>`;
    }).catch(() => {});
    async function load() {
      if (busy || !more) return;
      busy = true;
      try {
        const want = kind;
        const data = await api(`/api/social/professionals/${proId}/posts?offset=${offset}&limit=24&kind=${want}`);
        if (want !== kind) { busy = false; return; } // trocou de aba no meio
        grid.insertAdjacentHTML('beforeend', data.items.map(gridTile).join(''));
        offset += data.items.length;
        more = data.has_more;
        if (!offset) grid.innerHTML = `<p class="muted" style="grid-column:1/-1">${kind === 'reel' ? 'Nenhum vídeo ainda.' : 'Nenhuma foto ainda.'}</p>`;
      } catch (e) { toast(e.message, 'error'); more = false; }
      $('[data-loading]', root).classList.toggle('hidden', !more);
      busy = false;
    }
    root.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-pp-tab]');
      if (tab && tab.dataset.ppTab !== kind) {
        kind = tab.dataset.ppTab;
        $$('[data-pp-tab]', root).forEach((b) => b.classList.toggle('active', b === tab));
        const parts = location.hash.split('/');
        if (parts[0] === '#posts') history.replaceState(history.state, '', `#posts/${proId}/${kind}`);
        grid.innerHTML = ''; offset = 0; more = true; busy = false;
        $('[data-loading]', root).classList.remove('hidden');
        load();
        return;
      }
      const open = e.target.closest('[data-post-open]');
      if (open) openPost(Number(open.dataset.postOpen));
    });
    if ('IntersectionObserver' in window) {
      new IntersectionObserver((en) => { if (en[0].isIntersecting) load(); }, { rootMargin: '400px' }).observe($('[data-end]', root));
    }
    load();
  }

  window.AcoliaSocial = { openReels, openNewReel: newReel, officialBadge, mountPostsPage, gridTile, mountHome, openNewPost: newPost, openPost, openComments, bindProfile, postCard, bindActions, setContext: (o) => { ctx = { ...ctx, ...o }; } };
})();
