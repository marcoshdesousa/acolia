'use strict';
const { Server } = require('socket.io');
const { db } = require('./db');
const { sessionFromCookie } = require('./auth');
const { resolveCode, endCall } = require('./routes/calls');
const rt = require('./realtime');

function setupSocket(httpServer) {
  const io = new Server(httpServer, { maxHttpBufferSize: 256 * 1024 });
  rt.setIo(io);

  io.on('connection', (socket) => {
    const auth = sessionFromCookie(socket.handshake.headers.cookie);
    socket.data.auth = auth;
    if (auth && (auth.role === 'patient' || auth.role === 'professional')) socket.join(`${auth.role}:${auth.user.id}`);

    // Indicador "digitando..."
    socket.on('chat:typing', ({ conversation_id } = {}) => {
      if (!auth || !['patient', 'professional'].includes(auth.role)) return;
      const col = auth.role === 'patient' ? 'patient_id' : 'professional_id';
      const c = db.prepare(`SELECT * FROM conversations WHERE id = ? AND ${col} = ?`).get(Number(conversation_id), auth.user.id);
      if (!c) return;
      // Antes da primeira mensagem do paciente, o profissional não sabe da conversa
      if (!c.patient_wrote && !c.pro_started) return;
      if (db.prepare('SELECT 1 FROM chat_blocks WHERE conversation_id = ?').get(c.id)) return; // bloqueado: nada de "digitando"
      const target = auth.role === 'patient' ? `professional:${c.professional_id}` : `patient:${c.patient_id}`;
      io.to(target).emit('chat:typing', { conversation_id: c.id });
    });

    // ---------- Atendimento (chamada de vídeo/voz, WebRTC) ----------
    socket.on('call:join', async ({ code } = {}, ack = () => {}) => {
      let r;
      try {
        // Reavalia a sessão no momento da entrada (pode ter logado depois de abrir a página)
        r = resolveCode(code, sessionFromCookie(socket.handshake.headers.cookie));
      } catch (e) {
        return ack({ error: e.message });
      }
      const room = `call:${r.call.id}`;
      // Uma pessoa por papel na sala: nova conexão substitui a antiga
      for (const s of await io.in(room).fetchSockets()) {
        if (s.data.call?.role === r.role && s.id !== socket.id) {
          s.emit('call:replaced');
          s.leave(room);
          s.data.call = null;
        }
      }
      socket.data.call = { id: r.call.id, role: r.role };
      // Consulta marcada: registra que o profissional entrou (se não entrar em 3 minutos, o paciente é reembolsado)
      if (r.role === 'host') db.prepare("UPDATE calls SET host_joined_at = COALESCE(host_joined_at, datetime('now')) WHERE id = ?").run(r.call.id);
      // E o paciente também: se ele não entrar em 3 minutos, a chamada acaba e não há reembolso
      if (r.role === 'guest') db.prepare("UPDATE calls SET guest_joined_at = COALESCE(guest_joined_at, datetime('now')) WHERE id = ?").run(r.call.id);
      socket.join(room);
      const others = (await io.in(room).fetchSockets()).filter((s) => s.id !== socket.id && s.data.call);
      const peerPresent = others.length > 0;
      if (peerPresent) {
        db.prepare("UPDATE calls SET started_at = COALESCE(started_at, datetime('now')) WHERE id = ?").run(r.call.id);
        // Quem inicia a negociação é sempre o profissional
        if (r.role === 'guest') others.forEach((s) => s.emit('call:peer-joined'));
      }
      ack({ ok: true, role: r.role, peerPresent });
    });

    const relay = (event) => (payload) => {
      const c = socket.data.call;
      if (!c) return;
      const active = db.prepare("SELECT 1 FROM calls WHERE id = ? AND status = 'ativo'").get(c.id);
      if (!active) return socket.emit('call:ended', { id: c.id });
      socket.to(`call:${c.id}`).emit(event, payload);
    };
    socket.on('call:signal', relay('call:signal'));
    socket.on('call:media-state', relay('call:media-state'));

    socket.on('call:end', () => {
      const c = socket.data.call;
      if (!c || c.role !== 'host') return;
      const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(c.id);
      // Paciente ainda não entrou: a chamada continua aberta para ele (o profissional só sai)
      if (call && require('./agenda').canEndCall(call)) { endCall(call); require('./agenda').finishFromCall(call); }
    });

    socket.on('call:leave', () => {
      const c = socket.data.call;
      if (!c) return;
      socket.to(`call:${c.id}`).emit('call:peer-left');
      socket.leave(`call:${c.id}`);
      socket.data.call = null;
    });

    socket.on('disconnect', () => {
      const c = socket.data.call;
      if (c) socket.to(`call:${c.id}`).emit('call:peer-left');
    });
  });
  return io;
}

module.exports = { setupSocket };
