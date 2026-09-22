/* Acolia — utilitários compartilhados pelas páginas */
(function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
    if (!res.ok) throw Object.assign(new Error(data.error || 'Algo deu errado.'), { status: res.status });
    return data;
  }

  const ICONS = {
    logo: '<img src="/img/logo-simbolo.png" alt="">',
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
    clinic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 21V8l8-5 8 5v13H4z"/><path d="M12 10v6M9 13h6"/></svg>',
  };

  function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/);
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

  function toast(msg, type = '') {
    let box = $('.toasts');
    if (!box) { box = document.createElement('div'); box.className = 'toasts'; box.setAttribute('role', 'status'); document.body.appendChild(box); }
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(() => t.remove(), type === 'error' ? 5000 : 3000);
  }

  // Janela modal simples. actions: [{label, value, class}]
  function modal({ title = '', html = '', actions = [{ label: 'OK', value: true }], onOpen } = {}) {
    return new Promise((resolve) => {
      const dlg = document.createElement('dialog');
      dlg.innerHTML = `<div class="dlg-body">${title ? `<h2>${esc(title)}</h2>` : ''}${html}</div>
        <div class="dlg-actions">${actions.map((a, i) => `<button type="button" class="btn ${a.class || ''}" data-i="${i}">${esc(a.label)}</button>`).join('')}</div>`;
      document.body.appendChild(dlg);
      const close = (v) => { dlg.close(); dlg.remove(); resolve(v); };
      dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(undefined); });
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

  function confirmDialog(text, { okLabel = 'Confirmar', danger = false, title = 'Confirmar' } = {}) {
    return modal({
      title, html: `<p>${esc(text)}</p>`,
      actions: [{ label: 'Cancelar', value: false, class: 'secondary' }, { label: okLabel, value: true, class: danger ? 'danger' : '' }],
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

  async function logout(to = '/') {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    location.href = to;
  }

  // ---------- App instalável (PWA) ----------
  let deferredInstall = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    $$('[data-install]').forEach((b) => b.classList.remove('hidden'));
  });
  async function installApp() {
    if (deferredInstall) {
      deferredInstall.prompt();
      await deferredInstall.userChoice;
      deferredInstall = null;
      return;
    }
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    modal({
      title: 'Instalar o aplicativo',
      html: ios
        ? '<p>No iPhone/iPad: toque no botão <b>Compartilhar</b> do Safari e depois em <b>Adicionar à Tela de Início</b>.</p>'
        : '<p>No menu do navegador (⋮), toque em <b>Instalar aplicativo</b> ou <b>Adicionar à tela inicial</b>.</p>',
    });
  }
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-install]');
    if (b) { e.preventDefault(); installApp(); }
  });

  window.Acolia = {
    $, $$, esc, api, ICONS, avatar, initials, money, fmtTime, fmtDay, fmtShort, fmtDate, parseDate, toast, modal,
    confirmDialog, copyText, ufOptions, bindUfCity, citiesOf, UFS, maskCpf, maskPhone, fmtPhone, isValidCpf, formData,
    handleForm, logout, installApp,
  };
})();
