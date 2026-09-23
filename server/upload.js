'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const multer = require('multer');
const { DATA_DIR } = require('./db');
const { HttpError } = require('./util');
const cloud = require('./cloud');

const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

const photoUpload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + EXT[file.mimetype]),
  }),
  limits: { fileSize: 3 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!EXT[file.mimetype]) return cb(new HttpError(400, 'Envie uma imagem JPG, PNG ou WEBP.'));
    cb(null, true);
  },
}).single('photo');

function handlePhoto(req, res) {
  return new Promise((resolve, reject) => {
    photoUpload(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') return reject(new HttpError(400, 'A foto deve ter no máximo 3 MB.'));
        return reject(err.status ? err : new HttpError(400, 'Não foi possível enviar a foto.'));
      }
      if (!req.file) return reject(new HttpError(400, 'Selecione uma foto.'));
      cloud.uploadFile('uploads', req.file.path);
      resolve(`/uploads/${req.file.filename}`);
    });
  });
}

// Carteirinha profissional: fica em pasta PRIVADA (não é servida publicamente)
const DOC_DIR = path.join(DATA_DIR, 'documents');
const DOC_EXT = { ...EXT, 'application/pdf': '.pdf' };
const docUpload = multer({
  storage: multer.diskStorage({
    destination: DOC_DIR,
    filename: (_req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + DOC_EXT[file.mimetype]),
  }),
  limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 30 },
  fileFilter: (_req, file, cb) => {
    if (file.fieldname !== 'document' || !DOC_EXT[file.mimetype]) return cb(new HttpError(400, 'Envie a foto da carteirinha em JPG, PNG, WEBP ou PDF.'));
    cb(null, true);
  },
}).single('document');

// Lê um formulário multipart com a carteirinha. Retorna o nome do arquivo salvo (ou null).
function handleDocument(req, res) {
  return new Promise((resolve, reject) => {
    docUpload(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') return reject(new HttpError(400, 'O arquivo da carteirinha deve ter no máximo 8 MB.'));
        return reject(err.status ? err : new HttpError(400, 'Não foi possível enviar a carteirinha.'));
      }
      if (req.file) cloud.uploadFile('documents', req.file.path);
      resolve(req.file ? req.file.filename : null);
    });
  });
}

function removeDocument(name) {
  if (name) fs.promises.unlink(path.join(DOC_DIR, path.basename(name))).catch(() => {});
  cloud.removeFile('documents', name);
}

// Áudios do chat: pasta PRIVADA (só quem participa da conversa ouve)
const AUDIO_DIR = path.join(DATA_DIR, 'audio');
fs.mkdirSync(AUDIO_DIR, { recursive: true });
const AUDIO_EXT = {
  'audio/webm': '.webm', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/aac': '.aac', 'audio/mpeg': '.mp3',
};
const audioUpload = multer({
  storage: multer.diskStorage({
    destination: AUDIO_DIR,
    filename: (_req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + AUDIO_EXT[file.mimetype.split(';')[0]]),
  }),
  limits: { fileSize: 12 * 1024 * 1024, files: 1, fields: 5 },
  fileFilter: (_req, file, cb) => {
    if (file.fieldname !== 'audio' || !AUDIO_EXT[file.mimetype.split(';')[0]]) return cb(new HttpError(400, 'Formato de áudio não suportado.'));
    cb(null, true);
  },
}).single('audio');

function handleAudio(req, res) {
  return new Promise((resolve, reject) => {
    audioUpload(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') return reject(new HttpError(400, 'Áudio muito longo. Grave até 5 minutos.'));
        return reject(err.status ? err : new HttpError(400, 'Não foi possível enviar o áudio.'));
      }
      if (!req.file) return reject(new HttpError(400, 'Grave um áudio.'));
      cloud.uploadFile('audio', req.file.path);
      resolve(req.file.filename);
    });
  });
}

function removePhoto(url) {
  if (!url || !url.startsWith('/uploads/')) return;
  const file = path.join(UPLOAD_DIR, path.basename(url));
  fs.promises.unlink(file).catch(() => {});
  cloud.removeFile('uploads', url);
}

module.exports = { handleAudio, AUDIO_DIR, handlePhoto, removePhoto, handleDocument, removeDocument, UPLOAD_DIR, DOC_DIR };
