/* Perfil completo de um profissional */
(function () {
  'use strict';
  const { esc, ICONS, avatar, money } = window.Acolia;
  const ic = (name, s = 18) => ICONS[name].replace('<svg', `<svg style="width:${s}px;height:${s}px;vertical-align:-4px"`);

  function render(p, { actions = '', next = '' } = {}) {
    const specialties = (p.specialties || '').split(',').map((s) => s.trim()).filter(Boolean);
    let details;
    if (p.locked) {
      details = `<div class="card flat stack">
        <div class="locked">${ic('lock')} Valores, pacotes e localização aparecem somente para quem tem conta.</div>
        <div class="row"><a class="btn" href="/cadastro-paciente${next ? `?next=${encodeURIComponent(next)}` : ''}">Criar conta grátis</a><a class="btn secondary" href="/entrar?next=${encodeURIComponent(next || '/app#perfil/' + p.id)}">Já tenho conta</a></div></div>`;
    } else {
      const pk = p.packages || [];
      details = `
        <div class="card flat stack">
          <h3>${ic('calendar')} Valores</h3>
          <div><span class="price" style="font-size:1.5rem;font-weight:800">${p.price_cents != null ? money(p.price_cents) : 'A combinar'}</span> <span class="muted">por sessão online</span></div>
          ${pk.length ? `<div><b>Pacotes</b><ul style="margin:6px 0 0;padding-left:20px">${pk.map((k) => `<li>${k.sessions} sessões por <b>${money(k.price_cents)}</b> <span class="muted small">(${money(Math.round(k.price_cents / k.sessions))}/sessão)</span>${k.description ? ` — ${esc(k.description)}` : ''}</li>`).join('')}</ul></div>` : ''}
        </div>
        <div class="card flat stack">
          <h3>${ic('pin')} Localização</h3>
          <div>${esc(p.city)} - ${esc(p.state)}</div>
          ${p.has_clinic ? `<div><b>${ic('clinic')} ${esc(p.clinic_name || 'Consultório presencial')}</b><div class="muted">${esc(p.clinic_address)}</div>
            <a class="small" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${p.clinic_address}, ${p.city} - ${p.state}`)}">Ver no mapa</a></div>`
            : '<div class="muted">Atende somente online.</div>'}
        </div>`;
    }
    return `
      <div class="card stack">
        <div class="row" style="align-items:flex-start;gap:20px;flex-wrap:wrap">
          ${avatar(p.name, p.photo, 'xl')}
          <div class="grow" style="min-width:220px">
            <h1 style="font-size:1.6rem;margin-bottom:4px">${esc(p.name)}</h1>
            <div class="muted" style="font-weight:700">${esc(p.profession)}</div>
            <div style="margin-top:6px"><span class="badge ok">${ic('badge', 15)} ${esc(p.registry)}</span></div>
            ${specialties.length ? `<div class="meta row" style="gap:6px;margin-top:10px">${specialties.map((s) => `<span class="badge">${esc(s)}</span>`).join('')}</div>` : ''}
          </div>
          <div class="row">${actions}</div>
        </div>
        ${p.bio ? `<div><h3>Sobre</h3><p style="white-space:pre-wrap">${esc(p.bio)}</p></div>` : ''}
      </div>
      <div class="grid-2" style="margin-top:16px;align-items:start">${details}</div>`;
  }

  window.AcoliaProfile = { render };
})();
