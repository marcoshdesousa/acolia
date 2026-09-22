'use strict';
const express = require('express');
const A = require('../auth');
const push = require('../push');

const router = express.Router();

router.get('/key', (_req, res) => res.json({ publicKey: push.publicKey() }));

router.post('/subscribe', A.requireRole('patient', 'professional'), (req, res) => {
  push.subscribe(req.auth.role, req.auth.user.id, req.body.subscription);
  res.json({ ok: true });
});

router.post('/unsubscribe', (req, res) => {
  push.unsubscribe(req.body.endpoint);
  res.json({ ok: true });
});

module.exports = { router };
