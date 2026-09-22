'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const multer = require('multer');
const { DATA_DIR } = require('./db');
const { HttpError } = require('./util');

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
      resolve(`/uploads/${req.file.filename}`);
    });
  });
}

function removePhoto(url) {
  if (!url || !url.startsWith('/uploads/')) return;
  const file = path.join(UPLOAD_DIR, path.basename(url));
  fs.promises.unlink(file).catch(() => {});
}

module.exports = { handlePhoto, removePhoto, UPLOAD_DIR };
