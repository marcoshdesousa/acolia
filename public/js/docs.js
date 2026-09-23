/* Documentos do profissional (atestado, receita, encaminhamento).
   - O profissional preenche no chat (nome e CPF do paciente e o horário do último atendimento
     já vêm preenchidos) e o documento vai para o paciente na conversa.
   - O documento vira uma imagem (folha A4) para salvar/compartilhar, com o nome e o registro
     (CRM/CRP) do profissional, código + QR Code de verificação e, no rodapé, o símbolo e o nome
     da Acolia provando que foi gerado pela plataforma. */
(function () {
  'use strict';
  const { $, $$, esc, api, toast, modal, maskCpf, isValidCpf } = window.Acolia;

  const W = 1240;
  const H = 1754;
  const M = 110; // margem
  const INK = '#1f2a27';
  const MUTED = '#5d6966';
  const BRAND = '#3f5550';

  const pad = (n) => String(n).padStart(2, '0');
  const brDate = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');
  const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  // "2026-09-23 19:33:12" (UTC do servidor) → Date local
  const fromServer = (s) => new Date(`${String(s).replace(' ', 'T')}Z`);
  const longDate = (d) => `${d.getDate()} de ${MONTHS[d.getMonth()]} de ${d.getFullYear()}`;
  const localInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

  function loadImg(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  // Quebra o texto em linhas que cabem na largura; devolve a altura usada
  function wrap(g, text, x, y, maxW, lineH) {
    const words = String(text).split(/\s+/);
    let line = '';
    let yy = y;
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (g.measureText(test).width > maxW && line) {
        g.fillText(line, x, yy);
        line = w;
        yy += lineH;
      } else line = test;
    }
    if (line) { g.fillText(line, x, yy); yy += lineH; }
    return yy;
  }

  // ---------- Desenho da folha ----------
  async function render(doc) {
    const d = doc.data;
    const p = d.professional;
    try { await document.fonts.ready; } catch { /* ignora */ }
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, W, H);
    const font = (size, weight = 400, fam = 'Nunito') => `${weight} ${size}px "${fam}", system-ui, sans-serif`;

    // Cabeçalho: profissional responsável
    g.fillStyle = BRAND;
    g.fillRect(0, 0, W, 14);
    g.fillStyle = INK;
    g.font = font(44, 800);
    g.fillText(p.name, M, 120);
    g.fillStyle = MUTED;
    g.font = font(28, 600);
    g.fillText(`${p.profession} · ${p.registry}`, M, 165);
    if (p.city) g.fillText(`${p.city}${p.state ? ` - ${p.state}` : ''} · Atendimento online`, M, 205);
    g.fillStyle = '#e3e2dc';
    g.fillRect(M, 240, W - 2 * M, 3);

    // Título
    g.fillStyle = INK;
    g.font = font(50, 500, 'Jost');
    g.textAlign = 'center';
    g.fillText(d.title.toUpperCase(), W / 2, 335);
    g.textAlign = 'left';

    // Corpo
    const att = new Date(d.attended_at);
    const attDate = `${pad(att.getDate())}/${pad(att.getMonth() + 1)}/${att.getFullYear()}`;
    const attTime = `${pad(att.getHours())}h${pad(att.getMinutes())}`;
    const who = `${d.patient_name}, CPF ${d.cpf || '—'}${d.birth_date ? `, nascido(a) em ${brDate(d.birth_date)}` : ''}`;
    let y = 430;
    g.fillStyle = INK;
    g.font = font(32, 400);
    const bodyW = W - 2 * M;
    if (doc.kind === 'atestado') {
      const tipo = d.title === 'Atestado médico' ? 'médico' : 'psicológico';
      y = wrap(g, `Atesto, para os devidos fins, que ${who}, esteve sob meu atendimento ${tipo} online no dia ${attDate}, às ${attTime}, necessitando de afastamento de suas atividades por ${d.days || 1} (um) dia, a contar da data do atendimento.`, M, y, bodyW, 50);
      if (d.cid) { y += 20; g.font = font(30, 700); y = wrap(g, `CID: ${d.cid} (informado com a autorização do(a) paciente)`, M, y, bodyW, 46); }
    } else if (doc.kind === 'receita') {
      g.font = font(30, 700);
      y = wrap(g, `Paciente: ${d.patient_name}`, M, y, bodyW, 44);
      g.font = font(28, 400);
      g.fillStyle = MUTED;
      y = wrap(g, `CPF ${d.cpf || '—'}${d.birth_date ? ` · Nascimento: ${brDate(d.birth_date)}` : ''} · Atendimento em ${attDate}, às ${attTime}`, M, y, bodyW, 40);
      y += 30;
      g.fillStyle = INK;
      g.font = font(30, 700);
      g.fillText('Uso conforme orientação:', M, y);
      y += 60;
      (d.items || []).forEach((it, i) => {
        g.font = font(31, 800);
        y = wrap(g, `${i + 1}. ${it.name}${it.dose ? ` — ${it.dose}` : ''}${it.qty ? ` (${it.qty})` : ''}`, M, y, bodyW, 46);
        g.font = font(29, 400);
        g.fillStyle = '#34413e';
        y = wrap(g, it.instructions, M + 40, y, bodyW - 40, 42);
        g.fillStyle = INK;
        y += 18;
      });
    } else {
      y = wrap(g, `Encaminho o(a) paciente ${who}, atendido(a) por mim online em ${attDate}, às ${attTime}, para avaliação e acompanhamento com ${d.specialty}, na modalidade ${d.modality === 'online' ? 'online' : 'presencial'}.`, M, y, bodyW, 50);
      if (d.reason) { y += 14; g.font = font(30, 700); g.fillText('Motivo / informações:', M, y + 10); y += 60; g.font = font(30, 400); y = wrap(g, d.reason, M, y, bodyW, 46); }
    }

    // Local e data de emissão
    const issued = fromServer(doc.created_at);
    g.font = font(30, 400);
    g.fillStyle = INK;
    g.fillText(`${p.city ? `${p.city}${p.state ? `/${p.state}` : ''}, ` : ''}${longDate(issued)}.`, M, Math.max(y + 60, 1040));

    // Assinatura do profissional (feita com o dedo, acima da linha)
    const sy = 1200;
    if (doc.signature) {
      const sig = await loadImg(doc.signature);
      if (sig) {
        const bw = 560;
        const bh = 140;
        const k = Math.min(bw / sig.width, bh / sig.height);
        const w = sig.width * k;
        const h = sig.height * k;
        g.drawImage(sig, W / 2 - w / 2, sy - h - 6, w, h);
      }
    }
    g.fillStyle = INK;
    g.fillRect(W / 2 - 300, sy, 600, 2);
    g.textAlign = 'center';
    g.font = font(32, 800);
    g.fillText(p.name, W / 2, sy + 45);
    g.font = font(27, 600);
    g.fillStyle = MUTED;
    g.fillText(`${p.profession} · ${p.registry}`, W / 2, sy + 85);
    g.font = font(23, 400);
    g.fillText(`Assinado eletronicamente pelo profissional em ${pad(issued.getDate())}/${pad(issued.getMonth() + 1)}/${issued.getFullYear()} às ${pad(issued.getHours())}h${pad(issued.getMinutes())}`, W / 2, sy + 122);
    g.textAlign = 'left';

    // Verificação: QR Code + código
    const vy = 1380;
    g.fillStyle = '#f4f6f5';
    g.fillRect(M, vy, W - 2 * M, 200);
    if (doc.qr) {
      const qr = await loadImg(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(doc.qr)}`);
      if (qr) g.drawImage(qr, M + 20, vy + 20, 160, 160);
    }
    g.fillStyle = INK;
    g.font = font(28, 800);
    g.fillText(`Código de verificação: ${doc.code}`, M + 210, vy + 62);
    g.font = font(24, 400);
    g.fillStyle = MUTED;
    wrap(g, `Confira a autenticidade apontando a câmera para o QR Code ou em ${location.host}/v/${doc.code}`, M + 210, vy + 105, W - 2 * M - 230, 34);
    if (doc.revoked) {
      g.save();
      g.translate(W / 2, 800);
      g.rotate(-0.35);
      g.fillStyle = 'rgba(179, 38, 30, .22)';
      g.font = font(150, 900);
      g.textAlign = 'center';
      g.fillText('CANCELADO', 0, 0);
      g.restore();
    }

    // Rodapé: símbolo e nome da Acolia (prova de que foi gerado pela plataforma)
    const fy = 1620;
    g.fillStyle = '#e3e2dc';
    g.fillRect(M, fy, W - 2 * M, 2);
    const sym = await loadImg('/img/logo-simbolo.png');
    const word = await loadImg('/img/logo-nome.png');
    if (sym) g.drawImage(sym, M, fy + 24, 58, 58);
    if (word) g.drawImage(word, M + 72, fy + 38, 160, 30);
    g.font = font(20, 400);
    g.fillStyle = MUTED;
    wrap(g, 'Documento gerado pela plataforma Acolia. O conteúdo é de responsabilidade exclusiva do profissional que o emitiu, identificado acima pelo nome e pelo registro no conselho.', M + 260, fy + 46, W - 2 * M - 260, 28);
    return c;
  }

  // ---------- Ver / salvar ----------
  async function openDoc(code) {
    let doc;
    try { doc = await api(`/api/docs/${encodeURIComponent(code)}`); } catch (e) { toast(e.message, 'error'); return; }
    const canvas = await render(doc);
    const url = canvas.toDataURL('image/png');
    const fileName = `${doc.title.toLowerCase().replace(/\s+/g, '-')}-${doc.code}.png`;
    await modal({
      title: doc.title,
      html: `${doc.revoked ? '<p class="notice danger" style="margin-top:0">Este documento foi cancelado pelo profissional.</p>' : ''}
        <img src="${url}" alt="${esc(doc.title)}" class="doc-preview">
        <p class="small muted" style="margin:8px 0 0">Código: <b>${esc(doc.code)}</b> · qualquer pessoa pode conferir em <a href="/v/${esc(doc.code)}" target="_blank" rel="noopener">${esc(location.host)}/v/${esc(doc.code)}</a></p>`,
      actions: [
        { label: 'Compartilhar', class: 'secondary', handler: async () => { await share(canvas, fileName, doc); return false; } },
        { label: 'Salvar imagem', handler: () => { download(url, fileName); return false; } },
      ],
      onOpen: (dlg) => dlg.classList.add('doc-dialog'),
    });
  }
  function download(url, name) {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast('Imagem salva');
  }
  async function share(canvas, name, doc) {
    try {
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      const file = new File([blob], name, { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: doc.title }); return; }
    } catch (e) { if (e.name === 'AbortError') return; }
    download(canvas.toDataURL('image/png'), name);
  }

  // ---------- Assinatura com o dedo ----------
  // Abre um quadro branco; o profissional assina com o dedo (ou mouse). Devolve a imagem PNG
  // (fundo transparente, recortada) ou null se cancelar. A assinatura só vale para este documento.
  function signaturePad(title) {
    return new Promise((resolve) => {
      let result = null;
      modal({
        title: 'Sua assinatura',
        html: `<p class="small muted" style="margin-top:0">Assine com o dedo no quadro abaixo. Ela vai no ${esc(title.toLowerCase())}, acima do seu nome e registro, e só vale para este documento.</p>
          <div class="sig-box"><canvas data-sig></canvas><span class="sig-line"></span><span class="sig-hint" data-sig-hint>Assine aqui</span></div>
          <button type="button" class="btn ghost sm" data-sig-clear style="margin-top:6px">Limpar e assinar de novo</button>`,
        actions: [{ label: 'Cancelar', value: null, class: 'secondary' }, {
          label: 'Continuar',
          handler: (dlg) => {
            const cv = $('[data-sig]', dlg);
            if ((cv._ink || 0) < 60) { toast('Faça a sua assinatura no quadro.', 'error'); return false; }
            result = trimCanvas(cv);
            return true;
          },
        }],
        onOpen: (dlg) => {
          const cv = $('[data-sig]', dlg);
          const box = cv.parentElement;
          const ratio = Math.max(2, window.devicePixelRatio || 1);
          const size = () => { cv.width = box.clientWidth * ratio; cv.height = box.clientHeight * ratio; };
          size();
          const g = cv.getContext('2d');
          const pen = () => { g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = '#14213d'; g.lineWidth = 2.6 * ratio; };
          pen();
          cv._ink = 0;
          let last = null;
          const pos = (e) => { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) * ratio, y: (e.clientY - r.top) * ratio }; };
          cv.addEventListener('pointerdown', (e) => { e.preventDefault(); cv.setPointerCapture(e.pointerId); last = pos(e); $('[data-sig-hint]', dlg).classList.add('hidden'); });
          cv.addEventListener('pointermove', (e) => {
            if (!last) return;
            const p = pos(e);
            g.beginPath(); g.moveTo(last.x, last.y);
            // traço suave: curva até o meio do caminho
            const mx = (last.x + p.x) / 2;
            const my = (last.y + p.y) / 2;
            g.quadraticCurveTo(last.x, last.y, mx, my); g.lineTo(p.x, p.y); g.stroke();
            cv._ink += Math.hypot(p.x - last.x, p.y - last.y) / ratio;
            last = p;
          });
          const end = () => { last = null; };
          cv.addEventListener('pointerup', end);
          cv.addEventListener('pointercancel', end);
          $('[data-sig-clear]', dlg).addEventListener('click', () => { g.clearRect(0, 0, cv.width, cv.height); cv._ink = 0; $('[data-sig-hint]', dlg).classList.remove('hidden'); });
        },
      }).then(() => resolve(result));
    });
  }
  // Recorta o espaço vazio em volta da assinatura e reduz o tamanho
  function trimCanvas(cv) {
    const g = cv.getContext('2d');
    const { data, width, height } = g.getImageData(0, 0, cv.width, cv.height);
    let x0 = width; let y0 = height; let x1 = 0; let y1 = 0;
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) {
        if (data[(y * width + x) * 4 + 3] > 20) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
    }
    const padPx = 10;
    x0 = Math.max(0, x0 - padPx); y0 = Math.max(0, y0 - padPx); x1 = Math.min(width, x1 + padPx); y1 = Math.min(height, y1 + padPx);
    const w = x1 - x0;
    const h = y1 - y0;
    const scale = Math.min(1, 700 / w);
    const out = document.createElement('canvas');
    out.width = Math.round(w * scale); out.height = Math.round(h * scale);
    out.getContext('2d').drawImage(cv, x0, y0, w, h, 0, 0, out.width, out.height);
    return out.toDataURL('image/png');
  }

  // ---------- Formulário (profissional) ----------
  async function openForm(conversationId, onSent) {
    let opt;
    try { opt = await api(`/api/docs/options/${conversationId}`); } catch (e) { toast(e.message, 'error'); return; }
    let picked = null;
    await modal({
      title: 'Documentos',
      html: `<p class="small muted" style="margin-top:0">Escolha o que emitir para este paciente. Vai com o seu nome e registro (${esc(opt.professional.registry)}) e um código de verificação.</p>
        <div class="create-menu">${opt.kinds.map((k) => `<button type="button" data-v="${k.kind}"><b>${esc(k.title)}</b><small>${k.kind === 'atestado' ? '1 dia de afastamento pelo atendimento' : k.kind === 'receita' ? 'Medicamentos e como tomar' : 'Para outro profissional (presencial ou online)'}</small></button>`).join('')}</div>
        ${opt.kinds.length === 1 ? `<p class="small muted">Pela sua profissão (${esc(opt.professional.profession)}), você pode emitir encaminhamentos. Atestado é de médico (CRM) ou psicólogo (CRP) e receita, só de médico. Laudos não são feitos pela plataforma.</p>` : '<p class="small muted">Laudos não são feitos pela plataforma (só presencialmente, em clínica).</p>'}`,
      actions: [],
      onOpen: (dlg) => {
        dlg.classList.add('sheet');
        $$('[data-v]', dlg).forEach((b) => b.addEventListener('click', () => { picked = b.dataset.v; $('[data-dlg-close]', dlg).click(); }));
      },
    });
    if (!picked) return;
    const title = opt.kinds.find((k) => k.kind === picked).title;
    const signature = await signaturePad(title); // 1º assina
    if (!signature) return; // cancelou: a assinatura não fica guardada
    formFor(picked, opt, conversationId, onSent, signature); // 2º confere os dados e envia
  }

  function formFor(kind, opt, conversationId, onSent, signature) {
    const title = opt.kinds.find((k) => k.kind === kind).title;
    const att = opt.attended_at ? localInput(fromServer(opt.attended_at)) : localInput(new Date());
    const common = `
      <div class="field"><label>Nome completo do paciente</label><input data-f="patient_name" value="${esc(opt.patient.name)}" required></div>
      <div class="grid-2">
        <div class="field"><label>CPF</label><input data-f="cpf" value="${esc(opt.patient.cpf)}" inputmode="numeric" required></div>
        <div class="field"><label>Data de nascimento</label><input data-f="birth_date" type="date" required></div>
      </div>
      <div class="field"><label>Data e horário do atendimento</label><input data-f="attended_at" type="datetime-local" value="${att}" required>
        <small class="muted">${opt.attended_at ? 'Preenchido com o seu último atendimento com este paciente.' : 'Nenhum atendimento encontrado — confira a data e o horário.'}</small></div>`;
    let extra = '';
    if (kind === 'atestado') {
      extra = `<p class="small notice info" style="margin:0">Afastamento de <b>1 dia</b> (o dia do atendimento).</p>
        <div class="field" style="margin-top:10px"><label>CID (opcional)</label><input data-f="cid" placeholder="Ex.: F41.1" maxlength="10"></div>
        <label class="check"><input type="checkbox" data-f="cid_authorized"> O paciente autorizou colocar o CID no atestado</label>`;
    } else if (kind === 'receita') {
      extra = `<p class="small notice warn" style="margin:0"><b>Medicamentos controlados</b> (tarja preta, receita azul ou amarela — Portaria 344/98) exigem receituário especial e não devem ser prescritos por aqui.</p>
        <div data-items style="display:grid;gap:10px;margin-top:10px"></div>
        <button type="button" class="btn secondary sm" data-add-item style="margin-top:8px">+ Adicionar medicamento</button>`;
    } else {
      extra = `<div class="field"><label>Encaminhar para (profissional / especialidade)</label><input data-f="specialty" placeholder="Ex.: Psiquiatra, Neurologista, Nutricionista…" maxlength="120"></div>
        <div class="field"><label>Modalidade</label><select data-f="modality"><option value="presencial">Presencial</option><option value="online">Online</option></select></div>
        <div class="field"><label>Motivo / informações (opcional)</label><textarea data-f="reason" rows="3" maxlength="800"></textarea></div>`;
    }
    const itemHtml = (i) => `<div class="doc-item card flat" data-item><b class="small">Medicamento ${i + 1}</b>
        <input data-i="name" placeholder="Nome do medicamento" maxlength="120">
        <div class="grid-2"><input data-i="dose" placeholder="Dose (ex.: 50 mg)" maxlength="60"><input data-i="qty" placeholder="Quantidade (ex.: 30 comprimidos)" maxlength="60"></div>
        <input data-i="instructions" placeholder="Como tomar (ex.: 1 comprimido pela manhã, por 30 dias)" maxlength="300"></div>`;
    modal({
      title,
      html: `<div class="form-error hidden" data-err></div>
        <div class="sig-preview"><span class="small muted">Sua assinatura</span><img src="${signature}" alt="Sua assinatura"></div>
        ${common}${extra}
        <p class="small muted" style="margin-bottom:0">O documento sai assinado, com o seu nome e registro (${esc(opt.professional.registry)}). Você é o responsável pelo conteúdo. Se cancelar, a assinatura é descartada.</p>`,
      actions: [{ label: 'Cancelar', value: null, class: 'secondary' }, {
        label: 'Enviar documento',
        handler: async (dlg) => {
          const v = (k) => { const el = $(`[data-f="${k}"]`, dlg); return el ? (el.type === 'checkbox' ? el.checked : el.value) : undefined; };
          const err = $('[data-err]', dlg);
          const body = { conversation_id: conversationId, kind, signature, patient_name: v('patient_name'), cpf: v('cpf'), birth_date: v('birth_date'), attended_at: v('attended_at') };
          if (!isValidCpf(body.cpf)) { err.textContent = 'CPF inválido.'; err.classList.remove('hidden'); return false; }
          if (kind === 'atestado') Object.assign(body, { cid: v('cid'), cid_authorized: v('cid_authorized') });
          if (kind === 'receita') body.items = $$('[data-item]', dlg).map((it) => Object.fromEntries($$('[data-i]', it).map((x) => [x.dataset.i, x.value])));
          if (kind === 'encaminhamento') Object.assign(body, { specialty: v('specialty'), modality: v('modality'), reason: v('reason') });
          try {
            const r = await api('/api/docs', { method: 'POST', body });
            toast(`${title} enviado ao paciente`);
            onSent?.(r.message);
            return true;
          } catch (e) { err.textContent = e.message; err.classList.remove('hidden'); dlg.querySelector('.modal-body, form, div')?.scrollIntoView?.(); return false; }
        },
      }],
      onOpen: (dlg) => {
        maskCpf($('[data-f="cpf"]', dlg));
        const box = $('[data-items]', dlg);
        if (box) {
          const add = () => { if (box.children.length < 10) box.insertAdjacentHTML('beforeend', itemHtml(box.children.length)); };
          add();
          $('[data-add-item]', dlg).addEventListener('click', add);
        }
      },
    });
  }

  window.AcoliaDocs = { render, openDoc, openForm };
})();
