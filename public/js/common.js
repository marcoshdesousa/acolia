/* Acolia — utilitários compartilhados pelas páginas */
(function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }


  // ---------- Sem internet ----------
  // Faixa no topo "Você está sem internet"; quando a conexão volta, some (com um "De volta!" rápido)
  (function offlineBar() {
    let bar = null;
    let timer = null;
    const show = (on) => {
      if (!document.body) return;
      if (!bar) {
        bar = document.createElement('div');
        bar.className = 'net-bar';
        bar.setAttribute('role', 'status');
        bar.setAttribute('aria-live', 'polite');
        document.body.appendChild(bar);
      }
      if (on) {
        clearTimeout(timer);
        bar.className = 'net-bar off show';
        bar.innerHTML = '<span class="net-dot"></span> Você está sem internet — assim que voltar, tudo continua';
      } else if (bar.classList.contains('off')) {
        clearTimeout(timer);
        bar.className = 'net-bar on show';
        bar.innerHTML = '<span class="net-dot"></span> Conexão de volta';
        timer = setTimeout(() => { bar.classList.remove('show'); }, 2500);
      }
    };
    window.addEventListener('offline', () => show(true));
    window.addEventListener('online', () => show(false));
    const init = () => { if (navigator.onLine === false) show(true); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  })();

  // ---------- Conta bloqueada / assinatura ----------
  // Bloqueado (pelo admin, ou profissional com a assinatura vencida): a tela inteira vira o aviso
  // "Perfil bloqueado", com o botão para falar com a administração (WhatsApp de atendimento) e
  // "Excluir conta permanentemente". Não dá para ver feed, Reels, pacientes nem editar o perfil.
  const brDate = (iso) => (iso ? iso.split('-').reverse().join('/') : '');
  function supportLink(support, text) {
    return `https://wa.me/${String(support || '').replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;
  }
  // Profissional com cadastro em análise: aviso + botão para o WhatsApp de atendimento
  function pendingProBox({ support, name = '', code = '' }) {
    const msg = `Olá! Sou ${name}${code ? ` (código ${code})` : ''} e acabei de me cadastrar como profissional na Acolia. Gostaria de agilizar a análise do meu cadastro.`;
    return `<div class="notice info" style="text-align:left">
        <b>Seus dados estão sendo analisados pela nossa equipe.</b><br>
        Para agilizar a aprovação, mande uma mensagem para o nosso canal de atendimento no WhatsApp. É por lá que conferimos sua carteirinha e combinamos a mensalidade.
      </div>
      <a class="btn block" href="${esc(supportLink(support, msg))}" target="_blank" rel="noopener" style="margin-top:12px">${ICONS.send} Falar com o atendimento no WhatsApp</a>`;
  }
  function showBlocked(me) {
    const a = me.account || {};
    const isPro = me.role === 'professional';
    const u = me.user || {};
    const who = isPro ? `${u.name || ''}${u.code ? ` (código ${u.code})` : ''}` : (u.name || '');
    let text;
    let btn;
    let msg;
    if (isPro && a.blocked === 'vencido') {
      text = `Sua assinatura terminou em <b>${brDate(a.until)}</b> e não foi renovada. Seu perfil está bloqueado e não aparece para ninguém — seus dados continuam guardados.<br>Para reativar a conta, renove sua assinatura com a nossa equipe.`;
      btn = 'Renovar assinatura';
      msg = `Olá! Sou ${who}, profissional da Acolia. Minha assinatura venceu e quero renovar para reativar a conta.`;
    } else if (isPro) {
      text = 'Seu perfil foi bloqueado pela administração e não aparece para ninguém — seus dados continuam guardados.<br>Converse com o administrador para resolver o problema.';
      btn = 'Falar com o administrador';
      msg = `Olá! Sou ${who}, profissional da Acolia. Meu perfil está bloqueado e quero resolver.`;
    } else {
      text = 'Seu perfil foi bloqueado. Converse com o administrador para resolver o problema.';
      btn = 'Falar com o administrador';
      msg = `Olá! Sou ${who}, paciente da Acolia. Meu perfil está bloqueado e quero resolver.`;
    }
    document.body.className = 'blocked-page';
    document.body.innerHTML = `
      <header class="topbar"><div class="container"><a class="brand" href="/">${ICONS.logo}<img class="brand-word" src="/img/logo-nome.png" alt="Acolia"></a></div></header>
      <main class="blocked-wrap">
        <div class="card blocked-card">
          <span class="blocked-ic">${ICONS.lock}</span>
          <h1>Perfil bloqueado</h1>
          <p>${text}</p>
          <a class="btn block" href="${esc(supportLink(a.support, msg))}" target="_blank" rel="noopener">${ICONS.send} ${btn}</a>
          <button type="button" class="btn ghost sm" data-blocked-logout>Sair</button>
          <button type="button" class="link-danger" data-blocked-delete>Excluir conta permanentemente</button>
        </div>
      </main>`;
    $('[data-blocked-logout]').onclick = () => logout('/');
    $('[data-blocked-delete]').onclick = () => deleteAccountFlow(me.role);
  }
  // Excluir a própria conta: 3 passos para não apagar sem querer
  //   1) "Excluir sua conta?"  2) "Tem certeza? Se apagar, já era"  3) digitar o CPF (paciente)
  //   ou o código de acesso (profissional). Só então apaga tudo.
  async function deleteAccountFlow(role) {
    const isPro = role === 'professional';
    const plain = (title, html, ok) => modal({ title, html, actions: [{ label: 'Não', value: false, class: 'secondary' }, { label: ok, value: true, class: 'danger' }] });
    if (!await plain('Excluir sua conta?', '<p>Você quer mesmo excluir a sua conta da Acolia?</p>', 'Sim')) return;
    if (!await plain('Tem certeza?', `<p><b>Se apagar, já era.</b> Some tudo: seus dados, fotos${isPro ? ', publicações, reels, stories e o seu perfil' : ''}, curtidas, comentários e o conteúdo das mensagens que você enviou. <b>Não dá para recuperar.</b></p>`, 'Sim, quero apagar')) return;
    const done = await modal({
      title: 'Última confirmação',
      html: `<p>${isPro ? 'Digite o seu <b>código de acesso</b> (o código da sua conta, que você usa para entrar).' : 'Digite o seu <b>CPF</b> para confirmar.'}</p>
        <div class="form-error hidden" data-err></div>
        <div class="field"><label for="delKey">${isPro ? 'Código de acesso' : 'CPF'}</label>
          <input id="delKey" data-del-key autocomplete="off" ${isPro ? 'autocapitalize="characters" spellcheck="false" placeholder="Ex.: K74HD92P"' : 'inputmode="numeric" placeholder="000.000.000-00"'}></div>`,
      actions: [{ label: 'Cancelar', value: false, class: 'secondary' }, {
        label: 'Apagar minha conta',
        class: 'danger',
        handler: async (dlg) => {
          const v = dlg.querySelector('[data-del-key]').value.trim();
          const err = dlg.querySelector('[data-err]');
          if (!v) { err.textContent = isPro ? 'Digite o seu código de acesso.' : 'Digite o seu CPF.'; err.classList.remove('hidden'); return false; }
          try {
            await api(isPro ? '/api/professional/delete' : '/api/patient/delete', { method: 'POST', body: isPro ? { code: v } : { cpf: v } });
            return true;
          } catch (e) { err.textContent = e.message; err.classList.remove('hidden'); return false; }
        },
      }],
      onOpen: (dlg) => { if (!isPro) maskCpf(dlg.querySelector('[data-del-key]')); },
    });
    if (!done) return;
    await modal({ title: 'Conta excluída', html: '<p>Sua conta foi excluída. Obrigado por ter usado a Acolia.</p>' });
    location.replace('/');
  }

  // Aviso de renovação (profissional): 2 dias antes do vencimento até o último dia
  function renewBanner(me, where) {
    const a = me.account || {};
    if (!a.warn || !where) return;
    const u = me.user || {};
    const el = document.createElement('div');
    el.className = 'notice warn renew-banner';
    el.innerHTML = `<div class="grow"><b>${a.ended ? 'Sua assinatura terminou' : 'Sua assinatura está acabando'}</b>
        <div class="small">${a.ended ? `O plano finalizou em <b>${brDate(a.until)}</b>. Renove agora para continuar aparecendo para os pacientes.` : `O plano finaliza em <b>${brDate(a.until)}</b>. Renove para continuar aparecendo para os pacientes.`}</div></div>
      <a class="btn sm" target="_blank" rel="noopener" href="${esc(supportLink(a.support, `Olá! Sou ${u.name || ''}${u.code ? ` (código ${u.code})` : ''}, profissional da Acolia, e quero renovar minha assinatura.`))}">Renovar</a>`;
    where.prepend(el);
  }
  // Qualquer chamada respondeu "bloqueado": mostra a tela de bloqueio (uma vez só)
  let blockedShown = false;
  async function onBlocked() {
    if (blockedShown) return;
    blockedShown = true;
    try { const me = await api('/api/auth/me'); if (me.account?.blocked) showBlocked(me); } catch { /* ignora */ }
  }

  async function api(path, { method = 'GET', body, form } = {}) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (form) opts.body = form;
    else if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(path, opts);
    } catch {
      throw Object.assign(new Error('Sem conexão com o servidor. Verifique sua internet.'), { status: 0 });
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 423 && data.blocked) onBlocked();
    if (!res.ok) throw Object.assign(new Error(data.error || 'Algo deu errado.'), { status: res.status, data });
    return data;
  }

  const ICONS = {
    logo: '<img class="brand-mark" src="/img/logo-simbolo.png" alt="" width="34" height="34">',
    therapist: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M9.5 7.5h.01M14.5 7.5h.01"/><path d="M10.5 10c.9.6 2.1.6 3 0"/><path d="M8 3.8C9 2.7 10.4 2 12 2s3 .7 4 1.8"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/><path d="M12 14v3"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8.5 8.5 0 0 1-12.4 7.6L3 21l1.5-5.2A8.5 8.5 0 1 1 21 12z"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M12 20.5S3 15 3 8.8A4.8 4.8 0 0 1 12 6.3a4.8 4.8 0 0 1 9 2.5C21 15 12 20.5 12 20.5z"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3.4 20.4 21 12 3.4 3.6 3.3 10l12.6 2-12.6 2z"/></svg>',
    archive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/></svg>',
    unarchive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M12 17v-6m-3 3 3-3 3 3"/></svg>',
    video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="6" width="14" height="12" rx="2"/><path d="m16 10 6-3v10l-6-3z"/></svg>',
    videoOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 16v1a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m4 0h4a2 2 0 0 1 2 2v3.3l6-3.3v10"/><path d="m2 2 20 20"/></svg>',
    mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5"/></svg>',
    micOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m2 2 20 20M9 9v1a3 3 0 0 0 5.1 2.1M15 9.3V5a3 3 0 0 0-5.9-.6"/><path d="M17 16.9A7 7 0 0 1 5 10m14 0a7 7 0 0 1-.1 1.2M12 17v5"/></svg>',
    phoneEnd: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 9c-2.4 0-4.6.4-6.7 1.2-.9.3-1.4 1.2-1.3 2.1l.2 1.8c.1.9 1 1.5 1.9 1.4l2.6-.4c.8-.1 1.4-.8 1.4-1.6v-1.6a13 13 0 0 1 3.8 0v1.6c0 .8.6 1.5 1.4 1.6l2.6.4c.9.1 1.8-.5 1.9-1.4l.2-1.8c.1-.9-.4-1.8-1.3-2.1C16.6 9.4 14.4 9 12 9z"/></svg>',
    pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18 9 12l6-6"/></svg>',
    logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>',
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="4"/><path d="M2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1M16 4a4 4 0 0 1 0 8M22 21v-1a6 6 0 0 0-4-5.7"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a7 7 0 0 1 16 0v1"/></svg>',
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 11 9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5L20 7"/></svg>',
    checks: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m2 12 5 5L17 7M12 16l1 1L23 7"/></svg>',
    pix: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="m12 2.5 4 4-4 4-4-4zM12 13.5l4 4-4 4-4-4zM2.5 12l4-4 4 4-4 4zM13.5 12l4-4 4 4-4 4z"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M4 21h16"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>',
    badge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="11" r="2.5"/><path d="M5.5 17a3.5 3.5 0 0 1 7 0M15 9h3M15 13h3"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
    chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3v18h18"/><path d="M7 15v2M11 11v6M15 7v10M19 12v5"/></svg>',
    userPlus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="4"/><path d="M2 21v-1a7 7 0 0 1 11-5.7M19 14v6M16 17h6"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6M10 11v6M14 11v6"/></svg>',
    storyAdd: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m10 2.8 2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L2.8 8.1l5-.7z"/><path d="M19 14v7M15.5 17.5h7"/></svg>',
    bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/></svg>',
    plane: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/></svg>',
    comment: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-12.2 7.5L3 21l2-5.3A8.4 8.4 0 1 1 21 11.5z"/></svg>',
    text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M8 8h8M12 8v9"/></svg>',
    reel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M3 8.5h18M8 3l2.5 5.5M13.5 3 16 8.5"/><path d="m10 12 5 3-5 3z" fill="currentColor"/></svg>',
    doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>',
    grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18"/></svg>',
    volume: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z" fill="currentColor"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
    volumeOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z" fill="currentColor"/><path d="m16 9 6 6M22 9l-6 6"/></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15a1 1 0 0 0 1.5.9l12-7.5a1 1 0 0 0 0-1.8l-12-7.5A1 1 0 0 0 7 4.5z" fill="currentColor"/></svg>',
    // Funções do chat do profissional (quatro pontinhos: dois em cima, dois embaixo)
    apps: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="7.5" cy="7.5" r="2.4"/><circle cx="16.5" cy="7.5" r="2.4"/><circle cx="7.5" cy="16.5" r="2.4"/><circle cx="16.5" cy="16.5" r="2.4"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="m13.5 6.5 4 4"/></svg>',
    camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/></svg>',
    image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    ban: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true" style="width:15px;height:15px;vertical-align:-3px"><circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/></svg>',
    instagram: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4.2"/><circle cx="17.4" cy="6.6" r="1.1" fill="currentColor" stroke="none"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    clinic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 21V8l8-5 8 5v13H4z"/><path d="M12 10v6M9 13h6"/></svg>',
  };

  function initials(name) {
    const parts = String(name || '?').trim().replace(/^@/, '').split(/[\s._]+/).filter(Boolean);
    return ((parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }

  function avatar(name, photo, size = '') {
    if (photo) return `<img class="avatar ${size}" src="${esc(photo)}" alt="" loading="lazy">`;
    return `<span class="avatar ${size}" aria-hidden="true">${esc(initials(name))}</span>`;
  }

  function money(cents) {
    if (cents === null || cents === undefined) return '';
    return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function fmtTime(sqlDate) {
    const d = parseDate(sqlDate);
    return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }
  function fmtDay(sqlDate) {
    const d = parseDate(sqlDate);
    const today = new Date();
    const y = new Date(); y.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Hoje';
    if (d.toDateString() === y.toDateString()) return 'Ontem';
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
  }
  function fmtShort(sqlDate) {
    const d = parseDate(sqlDate);
    return d.toDateString() === new Date().toDateString() ? fmtTime(sqlDate) : d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  }
  function fmtDate(iso) {
    if (!iso) return '—';
    const [y, m, d] = iso.slice(0, 10).split('-');
    return `${d}/${m}/${y}`;
  }
  // Datas do SQLite vêm em UTC sem fuso
  function parseDate(s) {
    return new Date(String(s).replace(' ', 'T') + (String(s).includes('Z') ? '' : 'Z'));
  }

  // { top: true } = aviso bem em cima da tela (ex.: "Mensagem enviada para este profissional")
  function toast(msg, type = '', { top = false } = {}) {
    const sel = top ? '.toasts.top' : '.toasts:not(.top)';
    let box = $(sel);
    if (!box) { box = document.createElement('div'); box.className = top ? 'toasts top' : 'toasts'; box.setAttribute('role', 'status'); document.body.appendChild(box); }
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(() => t.remove(), type === 'error' ? 5000 : 3000);
  }

  // Janela modal simples. actions: [{label, value, class}]
  // locked: não fecha pelo X, pelo Esc nem tocando fora (só pelos botões)
  function modal({ title = '', html = '', actions = [{ label: 'OK', value: true }], onOpen, locked = false } = {}) {
    return new Promise((resolve) => {
      const dlg = document.createElement('dialog');
      dlg.innerHTML = `${locked ? '' : '<button type="button" class="dlg-close" data-dlg-close aria-label="Fechar" title="Fechar">✕</button>'}
        <div class="dlg-body">${title ? `<h2>${esc(title)}</h2>` : ''}${html}</div>
        <div class="dlg-actions">${actions.map((a, i) => `<button type="button" class="btn ${a.class || ''}" data-i="${i}">${esc(a.label)}</button>`).join('')}</div>`;
      document.body.appendChild(dlg);
      let done = false;
      const close = (v) => { done = true; dlg.close(); dlg.remove(); resolve(v); };
      dlg.addEventListener('cancel', (e) => { e.preventDefault(); if (!locked) close(undefined); });
      // O navegador pode fechar mesmo assim (Esc duas vezes, botão voltar do Android): se é obrigatória, abre de novo
      dlg.addEventListener('close', () => { if (locked && !done) setTimeout(() => { if (!done && dlg.isConnected) dlg.showModal(); }, 0); });
      // X no canto: fecha e volta para onde a pessoa estava
      $('[data-dlg-close]', dlg)?.addEventListener('click', () => close(undefined));
      dlg.addEventListener('click', (e) => { if (e.target === dlg && !locked) close(undefined); }); // toque fora da janela
      $$('.dlg-actions button', dlg).forEach((b) => b.addEventListener('click', async () => {
        const a = actions[b.dataset.i];
        if (a.handler) {
          const r = await a.handler(dlg);
          if (r === false) return;
          return close(r === undefined ? a.value : r);
        }
        close(a.value);
      }));
      dlg.showModal();
      if (onOpen) onOpen(dlg);
    });
  }

  function confirmDialog(text, { okLabel = 'Confirmar', danger = false, title = 'Confirmar', cancelLabel = 'Cancelar' } = {}) {
    return modal({
      title, html: `<p>${esc(text)}</p>`,
      actions: [{ label: cancelLabel, value: false, class: 'secondary' }, { label: okLabel, value: true, class: danger ? 'danger' : '' }],
    });
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast('Copiado!'); } catch { toast('Não foi possível copiar. Selecione e copie manualmente.', 'error'); }
  }

  // ---------- Estados e municípios (IBGE) ----------
  const UFS = [['AC', 'Acre'], ['AL', 'Alagoas'], ['AP', 'Amapá'], ['AM', 'Amazonas'], ['BA', 'Bahia'], ['CE', 'Ceará'], ['DF', 'Distrito Federal'], ['ES', 'Espírito Santo'], ['GO', 'Goiás'], ['MA', 'Maranhão'], ['MT', 'Mato Grosso'], ['MS', 'Mato Grosso do Sul'], ['MG', 'Minas Gerais'], ['PA', 'Pará'], ['PB', 'Paraíba'], ['PR', 'Paraná'], ['PE', 'Pernambuco'], ['PI', 'Piauí'], ['RJ', 'Rio de Janeiro'], ['RN', 'Rio Grande do Norte'], ['RS', 'Rio Grande do Sul'], ['RO', 'Rondônia'], ['RR', 'Roraima'], ['SC', 'Santa Catarina'], ['SP', 'São Paulo'], ['SE', 'Sergipe'], ['TO', 'Tocantins']];

  function ufOptions(selected = '', placeholder = 'UF') {
    return `<option value="">${esc(placeholder)}</option>` + UFS.map(([uf, nm]) => `<option value="${uf}" title="${esc(nm)}" ${uf === selected ? 'selected' : ''}>${uf}</option>`).join('');
  }

  const cityCache = {};
  async function citiesOf(uf) {
    if (!uf) return [];
    if (cityCache[uf]) return cityCache[uf];
    try {
      const cached = localStorage.getItem(`cities:${uf}`);
      if (cached) return (cityCache[uf] = JSON.parse(cached));
    } catch { /* ignora */ }
    try {
      const r = await fetch(`https://servicodados.ibge.gov.br/api/v1/localidades/estados/${uf}/municipios?orderBy=nome`);
      const list = (await r.json()).map((m) => m.nome);
      cityCache[uf] = list;
      try { localStorage.setItem(`cities:${uf}`, JSON.stringify(list)); } catch { /* ignora */ }
      return list;
    } catch {
      return [];
    }
  }

  // Liga um <select> de UF a um <input> de município com sugestões (datalist)
  function bindUfCity(ufSelect, cityInput) {
    const listId = `dl-${Math.random().toString(36).slice(2)}`;
    const dl = document.createElement('datalist');
    dl.id = listId;
    cityInput.setAttribute('list', listId);
    cityInput.after(dl);
    const load = async () => {
      const list = await citiesOf(ufSelect.value);
      dl.innerHTML = list.map((c) => `<option value="${esc(c)}">`).join('');
    };
    ufSelect.addEventListener('change', () => { cityInput.value = ''; load(); });
    load();
  }

  // ---------- Máscaras ----------
  function maskCpf(input) {
    input.addEventListener('input', () => {
      const d = input.value.replace(/\D/g, '').slice(0, 11);
      input.value = d.replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d{1,2})$/, '$1-$2');
    });
  }
  function maskPhone(input) {
    input.addEventListener('input', () => {
      const d = input.value.replace(/\D/g, '').slice(0, 11);
      input.value = d.length > 10 ? d.replace(/(\d{2})(\d{5})(\d{0,4})/, '($1) $2-$3')
        : d.replace(/(\d{2})(\d{0,4})(\d{0,4})/, (m, a, b, c) => (b ? `(${a}) ${b}${c ? '-' + c : ''}` : a));
    });
  }
  function fmtPhone(d) {
    d = String(d || '');
    return d.length === 11 ? d.replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3') : d.length === 10 ? d.replace(/(\d{2})(\d{4})(\d{4})/, '($1) $2-$3') : d;
  }

  function isValidCpf(v) {
    const c = String(v).replace(/\D/g, '');
    if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
    const calc = (len) => { let s = 0; for (let i = 0; i < len; i++) s += c[i] * (len + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
    return calc(9) === +c[9] && calc(10) === +c[10];
  }

  // Diminui a foto no próprio aparelho antes de enviar (fotos de celular costumam passar de 3 MB)
  async function shrinkImage(file, max = 1600) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return file;
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
      if (scale === 1 && file.size < 2.5 * 1024 * 1024) return file;
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale);
      c.height = Math.round(bmp.height * scale);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
      return blob ? new File([blob], 'foto.jpg', { type: 'image/jpeg' }) : file;
    } catch { return file; }
  }

  // "há 5 min", "há 2 h", "ontem", "12 de set."
  // Barra flutuante: encolhe quando a pessoa rola para baixo e volta ao subir
  (function shrinkNavOnScroll() {
    let last = 0;
    let ticking = false;
    window.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const nav = document.querySelector('.bottom-nav.icons');
        const y = window.scrollY;
        if (nav) {
          if (y < 60) nav.classList.remove('compact');
          else if (y > last + 6) nav.classList.add('compact');
          else if (y < last - 6) nav.classList.remove('compact');
        }
        last = y;
        ticking = false;
      });
    }, { passive: true });
  }());

  // Computador: o chat ocupa a tela até pouco antes da barra flutuante (não fica por baixo dela)
  function fitChat() {
    if (!window.matchMedia('(min-width: 801px)').matches) {
      document.querySelectorAll('.chat').forEach((c) => { c.style.height = ''; });
      return;
    }
    const chat = [...document.querySelectorAll('.chat')].find((c) => c.offsetParent !== null);
    if (!chat) return;
    const nav = document.querySelector('.bottom-nav.icons');
    const reserve = nav && getComputedStyle(nav).display !== 'none' ? (window.innerHeight - nav.getBoundingClientRect().top) + 16 : 24;
    const top = chat.getBoundingClientRect().top + window.scrollY;
    chat.style.height = `${Math.max(360, window.innerHeight - top - reserve)}px`;
  }
  window.addEventListener('resize', fitChat);
  window.addEventListener('hashchange', () => setTimeout(fitChat, 60));
  window.addEventListener('load', () => setTimeout(fitChat, 300));
  // Quando algo aparece acima do chat (ex.: aviso de notificações), reajusta
  if ('ResizeObserver' in window) {
    let raf = 0;
    new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(fitChat); }).observe(document.documentElement);
  }

  function timeAgo(sqlDate) {
    const d = parseDate(sqlDate);
    const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (s < 60) return 'agora';
    if (s < 3600) return `há ${Math.floor(s / 60)} min`;
    if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
    if (s < 172800) return 'ontem';
    if (s < 604800) return `há ${Math.floor(s / 86400)} dias`;
    return d.toLocaleDateString('pt-BR', { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  }

  function formData(form) {
    return Object.fromEntries(new FormData(form).entries());
  }

  // Envia um formulário mostrando erro no topo e travando o botão
  function handleForm(form, fn) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('[type=submit]');
      let err = form.querySelector('.form-error');
      if (!err) { err = document.createElement('div'); err.className = 'form-error hidden'; err.setAttribute('role', 'alert'); form.prepend(err); }
      err.classList.add('hidden');
      if (btn) btn.disabled = true;
      try {
        await fn(formData(form), form);
      } catch (ex) {
        err.textContent = ex.message;
        err.classList.remove('hidden');
        err.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } finally {
        if (btn) btn.disabled = false;
      }
    });
  }

  // Sair: desconecta na hora e volta para a página inicial (sem precisar atualizar a página).
  // Desligar as notificações do aparelho tem limite de tempo para nunca travar a saída.
  async function logout(to = '/') {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await Promise.race([stopPushOnThisDevice().catch(() => {}), wait(1500)]);
    await Promise.race([api('/api/auth/logout', { method: 'POST' }).catch(() => {}), wait(4000)]);
    location.replace(to);
  }

  // ---------- App instalável (PWA) ----------
  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  // App instalado: toda vez que abre, começa pela página inicial (lá tem o botão para entrar).
  // Links de notificação (/app#chat/…, /painel#conversas/…) abrem direto onde devem.
  try {
    if (isStandalone() && !sessionStorage.getItem('acolia-aberto')) {
      sessionStorage.setItem('acolia-aberto', '1');
      if (['/app', '/painel', '/entrar', '/admin'].includes(location.pathname) && !location.hash && !location.search) location.replace('/');
    }
  } catch { /* sem sessionStorage: segue normal */ }
  const platform = () => {
    const ua = navigator.userAgent;
    if (/iphone|ipad|ipod/i.test(ua) || (ua.includes('Macintosh') && 'ontouchend' in document)) return 'ios';
    if (/android/i.test(ua)) return 'android';
    return 'pc';
  };
  let deferredInstall = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    $$('[data-install-now]').forEach((b) => b.classList.remove('hidden'));
  });
  window.addEventListener('appinstalled', () => { deferredInstall = null; toast('App instalado! Procure o ícone da Acolia.'); });

  const STEPS = {
    android: {
      label: 'Android',
      steps: [
        'Abra este site no <b>Google Chrome</b>.',
        'Toque nos <b>três pontinhos ⋮</b>, no canto de cima.',
        'Toque em <b>Instalar app</b> (ou <b>Adicionar à tela inicial</b>).',
        'Confirme em <b>Instalar</b>. O ícone da Acolia aparece na sua tela inicial.',
        'Abra o app e toque em <b>Ativar notificações</b> para saber quando chegar mensagem.',
      ],
    },
    ios: {
      label: 'iPhone',
      steps: [
        'Abra este site no <b>Safari</b>.',
        'Toque no botão <b>Compartilhar</b> (o quadrado com a setinha para cima), na barra de baixo.',
        'Role e toque em <b>Adicionar à Tela de Início</b>.',
        'Toque em <b>Adicionar</b>, no canto de cima.',
        'Abra a Acolia <b>pelo ícone novo</b> e toque em <b>Ativar notificações</b>. No iPhone as notificações só funcionam pelo app instalado (iOS 16.4 ou mais novo).',
      ],
    },
    pc: {
      label: 'Computador',
      steps: [
        'Abra este site no <b>Google Chrome</b> ou no <b>Microsoft Edge</b>.',
        'Clique no ícone de <b>instalar</b> no fim da barra de endereço (um monitor com uma setinha), ou no menu <b>⋮ → Instalar Acolia</b>.',
        'Clique em <b>Instalar</b>. A Acolia fica no menu Iniciar e na área de trabalho, como um programa.',
        'Abra e clique em <b>Ativar notificações</b>.',
      ],
    },
  };

  function installGuide() {
    if (isStandalone()) {
      return modal({ title: 'App já instalado', html: '<p>Você já está usando o app da Acolia. 🎉</p>' });
    }
    const current = platform();
    const tabs = Object.entries(STEPS).map(([k, v]) => `<button type="button" data-tab="${k}" class="${k === current ? 'active' : ''}">${v.label}</button>`).join('');
    const panels = Object.entries(STEPS).map(([k, v]) => `<ol class="install-steps ${k === current ? '' : 'hidden'}" data-panel="${k}">${v.steps.map((t) => `<li>${t}</li>`).join('')}</ol>`).join('');
    return modal({
      title: 'Baixe o app da Acolia',
      html: `<p class="muted" style="margin-top:-4px">Grátis, direto pelo site — sem precisar da Play Store ou da App Store. Com o app você recebe as mensagens como notificação.</p>
        <button type="button" class="btn block ${deferredInstall ? '' : 'hidden'}" data-install-now style="margin-bottom:14px">Instalar agora</button>
        <div class="tabs" role="tablist" style="margin-bottom:12px">${tabs}</div>${panels}`,
      actions: [{ label: 'Fechar', class: 'secondary' }],
      onOpen: (dlg) => {
        $$('[data-tab]', dlg).forEach((b) => b.addEventListener('click', () => {
          $$('[data-tab]', dlg).forEach((x) => x.classList.toggle('active', x === b));
          $$('[data-panel]', dlg).forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== b.dataset.tab));
        }));
        $('[data-install-now]', dlg).addEventListener('click', async () => {
          if (!deferredInstall) return;
          deferredInstall.prompt();
          await deferredInstall.userChoice;
          deferredInstall = null;
          dlg.querySelector('.dlg-actions button').click();
        });
      },
    });
  }
  const installApp = installGuide;

  // ---------- Notificações (Web Push) ----------
  function urlB64ToUint8Array(b64) {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
  }
  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  async function registerPush() {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const { publicKey } = await api('/api/push/key');
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(publicKey) });
    }
    await api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
  }

  // Botão "Ativar notificações"
  async function enableNotifications() {
    if (!pushSupported()) {
      if (platform() === 'ios' && !isStandalone()) {
        return modal({
          title: 'Instale o app primeiro',
          html: '<p>No iPhone, as notificações só funcionam depois de instalar a Acolia na tela de início.</p>',
          actions: [{ label: 'Fechar', class: 'secondary' }, { label: 'Ver como instalar', handler: () => { setTimeout(installGuide, 50); } }],
        });
      }
      return toast('Este navegador não aceita notificações. Tente o Chrome.', 'error');
    }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      return modal({
        title: 'Notificações bloqueadas',
        html: '<p>Para receber avisos de mensagem, libere as notificações da Acolia nas configurações do navegador ou do celular (toque no cadeado ao lado do endereço do site → Notificações → Permitir) e tente de novo.</p>',
      });
    }
    try {
      await registerPush();
      toast('Notificações ativadas! Você será avisado quando chegar mensagem.');
      $$('[data-push-banner]').forEach((b) => b.remove());
    } catch (e) {
      toast('Não foi possível ativar as notificações agora.', 'error');
      console.error(e);
    }
  }

  // Ao abrir o app/painel: mantém a inscrição em dia ou mostra o convite
  async function setupNotifications(bannerParent) {
    if (!pushSupported()) {
      if (platform() === 'ios' && !isStandalone() && bannerParent) showPushBanner(bannerParent, true);
      return;
    }
    if (Notification.permission === 'granted') { registerPush().catch(() => {}); return; }
    if (Notification.permission === 'default' && bannerParent) showPushBanner(bannerParent, false);
  }
  function showPushBanner(parent, iosInstall) {
    try { if (localStorage.getItem('push-banner-fechado') === '1') return; } catch { /* ignora */ }
    const div = document.createElement('div');
    div.className = 'notice info push-banner';
    div.dataset.pushBanner = '';
    div.innerHTML = `<span class="grow">${iosInstall ? 'Instale o app da Acolia para receber as mensagens como notificação.' : 'Ative as notificações para saber na hora quando chegar mensagem.'}</span>
      <button class="btn sm" type="button" data-act>${iosInstall ? 'Como instalar' : 'Ativar'}</button>
      <button class="icon-btn" type="button" aria-label="Fechar aviso" data-close>✕</button>`;
    $('[data-act]', div).addEventListener('click', () => (iosInstall ? installGuide() : enableNotifications()));
    $('[data-close]', div).addEventListener('click', () => {
      div.remove();
      try { localStorage.setItem('push-banner-fechado', '1'); } catch { /* ignora */ }
    });
    parent.prepend(div);
  }

  // Ao sair da conta, este aparelho para de receber notificações dessa conta
  async function stopPushOnThisDevice() {
    try {
      if (!pushSupported()) return;
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
        await sub.unsubscribe();
      }
    } catch { /* ignora */ }
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }
  document.addEventListener('DOMContentLoaded', () => {
    if (isStandalone()) $$('[data-install], [data-install-card]').forEach((b) => b.classList.add('hidden'));
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-install]');
    if (b) { e.preventDefault(); installGuide(); }
    const n = e.target.closest('[data-enable-push]');
    if (n) { e.preventDefault(); enableNotifications(); }
  });


  // ---------- Redes sociais (Instagram, TikTok, X, YouTube): no perfil só o ícone com a cor da rede ----------
  const SOCIAL = {
    instagram: { name: 'Instagram', ph: '@seu.usuario ou link do perfil',
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.3" cy="6.7" r="1.1" fill="currentColor" stroke="none"/></svg>' },
    tiktok: { name: 'TikTok', ph: '@seu.usuario ou link do perfil',
      svg: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16.6 3c.3 2.3 1.6 3.8 3.9 4v2.7c-1.4.1-2.6-.3-3.9-1.1v5.1c0 6.5-7.1 8.5-9.9 3.9-1.8-3-.7-8.2 5.1-8.4v2.9c-.4.1-.9.2-1.3.3-1.3.4-2 1.3-1.8 2.8.4 2.7 5.3 3.5 4.9-1.8V3h3z"/></svg>' },
    x: { name: 'X', ph: '@seu_usuario ou link do perfil',
      svg: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.8 2.5h3.1l-6.8 7.8 8 10.6h-6.3l-4.9-6.4-5.6 6.4H2.2l7.3-8.3L1.8 2.5h6.4l4.4 5.9 5.2-5.9zm-1.1 16.5h1.7L7.4 4.2H5.5L16.7 19z"/></svg>' },
    youtube: { name: 'YouTube', ph: '@seucanal ou link do canal',
      svg: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9.6 7.8v8.4l7-4.2z"/></svg>' },
  };
  // Botões redondos só com o símbolo (o nome fica para leitor de tela e na dica do mouse)
  function socialLinks(list) {
    if (!list || !list.length) return '';
    return `<div class="social-links">${list.map((s) => `<a class="soc soc-${esc(s.net)}" href="${esc(s.url)}" target="_blank" rel="noopener" aria-label="${esc(s.name)}" title="${esc(s.name)}">${SOCIAL[s.net]?.svg || ''}</a>`).join('')}</div>`;
  }
  // Campos do formulário: cada rede no seu campo (o servidor confere se o link é da rede certa)
  function socialFields(values = {}) {
    return `<div class="social-fields">${Object.entries(SOCIAL).map(([k, s]) => `<label class="soc-field"><span class="soc soc-${k}" aria-hidden="true">${s.svg}</span>
      <input name="${k}" value="${esc(values[k] || '')}" maxlength="200" placeholder="${esc(s.ph)}" aria-label="${esc(s.name)}" autocomplete="off" autocapitalize="none" spellcheck="false"></label>`).join('')}</div>`;
  }

  window.Acolia = {
    $, $$, esc, api, ICONS, avatar, initials, money, fmtTime, fmtDay, fmtShort, fmtDate, parseDate, toast, modal,
    supportLink, pendingProBox, confirmDialog, copyText, ufOptions, bindUfCity, citiesOf, UFS, maskCpf, maskPhone, fmtPhone, isValidCpf, formData, shrinkImage, timeAgo, fitChat,
    handleForm, logout, showBlocked, renewBanner, deleteAccountFlow, installApp, installGuide, enableNotifications, setupNotifications, isStandalone,
    SOCIAL, socialLinks, socialFields,
  };
})();
