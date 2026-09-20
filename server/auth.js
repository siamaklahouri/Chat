'use strict';

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { db } = require('./db');

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

const hashPassword = (plain) => bcrypt.hashSync(plain, 10);
const verifyPassword = (plain, hash) => bcrypt.compareSync(plain, hash);

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare(
    'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).run(token, userId, now, now + SESSION_TTL_MS);
  return { token, expiresAt: now + SESSION_TTL_MS };
}

function destroySession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function userForToken(token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ?`
    )
    .get(token, Date.now());
  return row || null;
}

function purgeExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
}

/** Reads the bearer token from the Authorization header or the `token` cookie. */
function tokenFromRequest(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  const cookie = req.headers.cookie || '';
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === 'token') return decodeURIComponent(rest.join('='));
  }
  return null;
}

function requireAuth(req, res, next) {
  const token = tokenFromRequest(req);
  const user = userForToken(token);
  if (!user) return res.status(401).json({ error: 'ابتدا وارد شوید.' });
  req.user = user;
  req.token = token;
  next();
}

/** Blocks users whose account has not been approved by an admin yet. */
function requireApproved(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.status === 'pending') {
      return res
        .status(403)
        .json({ error: 'حساب شما هنوز توسط مدیر تایید نشده است.', code: 'pending' });
    }
    if (req.user.status === 'blocked') {
      return res.status(403).json({ error: 'حساب شما مسدود شده است.', code: 'blocked' });
    }
    next();
  });
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (!req.user.is_admin) return res.status(403).json({ error: 'دسترسی مدیریتی لازم است.' });
    next();
  });
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  userForToken,
  purgeExpiredSessions,
  tokenFromRequest,
  requireAuth,
  requireApproved,
  requireAdmin,
  SESSION_TTL_MS,
};
