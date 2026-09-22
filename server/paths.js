'use strict';
// Onde o banco e os arquivos ficam guardados.
// 1) DATA_DIR, se estiver definida;
// 2) senão, um disco permanente montado em /var/data ou /data (ex.: disco do Render),
//    detectado sozinho — não precisa configurar variável;
// 3) senão, a pasta ./data do projeto (no Render sem disco, ela é apagada a cada atualização).
const fs = require('node:fs');
const path = require('node:path');

const CANDIDATES = ['/var/data', '/data'];

function isMountPoint(dir) {
  try {
    const st = fs.statSync(dir);
    if (!st.isDirectory()) return false;
    return st.dev !== fs.statSync(path.dirname(dir)).dev;
  } catch { return false; }
}

function isWritable(dir) {
  try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; }
}

function resolveDataDir() {
  if (process.env.DATA_DIR) return { dir: process.env.DATA_DIR, source: 'env' };
  for (const c of CANDIDATES) if (isMountPoint(c) && isWritable(c)) return { dir: c, source: 'disco' };
  return { dir: path.join(__dirname, '..', 'data'), source: 'local' };
}

const resolved = resolveDataDir();
const DATA_DIR = resolved.dir;
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'acolia.db');

// O armazenamento é permanente? (para o aviso do painel do admin)
function storageStatus() {
  const cloud = require('./cloud');
  if (cloud.enabled) return { mode: 'nuvem', label: 'Supabase (cópia na nuvem)', permanent: true };
  const onDisk = isMountPoint(DATA_DIR) || CANDIDATES.some((c) => DATA_DIR.startsWith(`${c}/`) && isMountPoint(c));
  if (onDisk) return { mode: 'disco', label: `Disco permanente (${DATA_DIR})`, permanent: true };
  // No Render, uma pasta que não é disco montado é apagada a cada atualização
  if (process.env.RENDER) return { mode: 'temporario', label: `Pasta temporária (${DATA_DIR})`, permanent: false };
  return { mode: 'local', label: `Disco deste computador (${DATA_DIR})`, permanent: true };
}

module.exports = { DATA_DIR, DB_FILE, storageStatus, resolved };
