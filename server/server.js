'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');

if (!process.env.DATABASE_URL) { require('./db'); } // prints a friendly message and exits
const { run, all, one, init: initDb } = require('./db');
const storage = require('./storage');

const PORT = process.env.PORT || 3000;
let JWT_SECRET = null;
const sign = uid => jwt.sign({ uid }, JWT_SECRET, { expiresIn: '60d' });

const isAdminRole = r => r === 'owner' || r === 'admin';
const fail = msg => { const e = new Error(msg); e.expected = true; throw e; };
const valuesSql = (rows, cols) => Array.from({ length: rows }, () => '(' + Array(cols).fill('?').join(',') + ')').join(',');
const likeEsc = s => '%' + String(s).replace(/[\\%_]/g, '\\$&') + '%';

/* ----------------------------------------------------------------- users */
const online = new Map();      // userId -> number of connected sockets
const userCache = new Map();   // userId -> db row (kept fresh on every change)

async function getUser(id) {
  let u = userCache.get(id);
  if (!u) { u = await one('SELECT * FROM users WHERE id=?', [id]); if (u) userCache.set(id, u); }
  return u;
}
async function getUsersMap(ids) {
  const map = new Map(), missing = [];
  for (const id of ids) { const u = userCache.get(id); if (u) map.set(id, u); else missing.push(id); }
  if (missing.length) (await all('SELECT * FROM users WHERE id = ANY(?)', [missing])).forEach(u => { userCache.set(u.id, u); map.set(u.id, u); });
  return map;
}
const publicUser = u => ({ id: u.id, username: u.username, displayName: u.display_name, avatar: u.avatar, status: u.status, lastSeen: u.last_seen, online: online.has(u.id) });

/* --------------------------------------------------------- conversations */
const getConv = id => one('SELECT * FROM conversations WHERE id=?', [id]);
const getMember = (cid, uid) => one('SELECT * FROM members WHERE conversation_id=? AND user_id=?', [cid, uid]);
const memberIds = async cid => (await all('SELECT user_id FROM members WHERE conversation_id=?', [cid])).map(r => r.user_id);
async function requireMember(cid, uid) { const m = await getMember(cid, uid); if (!m) fail('You are not a member of this chat'); return m; }
async function requireAdmin(cid, uid) { const m = await requireMember(cid, uid); if (!isAdminRole(m.role)) fail('Only admins can do this'); return m; }

/* ------------------------------------------------- message formatting (batched: few DB round trips) */
async function fmtMany(rows, { fresh = false } = {}) {
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);
  const senderIds = [...new Set(rows.map(r => r.sender_id).filter(Boolean))];
  const replyIds = [...new Set(rows.map(r => r.reply_to).filter(Boolean))];
  const pollIds = rows.filter(r => r.type === 'poll' && !r.deleted).map(r => r.id);
  const [senders, replies, rx, polls, opts, votes] = await Promise.all([
    getUsersMap(senderIds),
    replyIds.length ? all('SELECT r.*, u.display_name AS sender_name FROM messages r LEFT JOIN users u ON u.id=r.sender_id WHERE r.id = ANY(?)', [replyIds]) : [],
    fresh ? [] : all('SELECT message_id, emoji, user_id FROM message_reactions WHERE message_id = ANY(?)', [ids]),
    pollIds.length ? all('SELECT * FROM polls WHERE message_id = ANY(?)', [pollIds]) : [],
    pollIds.length ? all('SELECT * FROM poll_options WHERE message_id = ANY(?) ORDER BY id', [pollIds]) : [],
    pollIds.length ? all('SELECT option_id, user_id FROM poll_votes WHERE message_id = ANY(?)', [pollIds]) : []
  ]);
  const replyMap = new Map(replies.map(r => [r.id, r]));
  return rows.map(m => {
    const s = m.sender_id ? senders.get(m.sender_id) : null;
    const out = {
      id: m.id, convId: m.conversation_id, senderId: m.sender_id, senderName: s ? s.display_name : null,
      type: m.type, text: m.deleted ? '' : (m.text || ''),
      file: (m.file_url && !m.deleted) ? { url: m.file_url, name: m.file_name, size: m.file_size, mime: m.file_mime } : null,
      replyTo: null, editedAt: m.edited_at, deleted: !!m.deleted, pinned: !!m.pinned_at,
      createdAt: m.created_at, reactions: [], poll: null
    };
    const r = m.reply_to && replyMap.get(m.reply_to);
    if (r) out.replyTo = { id: r.id, senderName: r.sender_name || '', text: r.deleted ? '' : (r.text || ''), fileName: r.deleted ? null : r.file_name, deleted: !!r.deleted };
    if (!m.deleted) {
      const map = {};
      rx.filter(x => x.message_id === m.id).forEach(x => (map[x.emoji] = map[x.emoji] || []).push(x.user_id));
      out.reactions = Object.entries(map).map(([emoji, userIds]) => ({ emoji, userIds }));
      if (m.type === 'poll') {
        const p = polls.find(x => x.message_id === m.id);
        if (p) out.poll = { multiple: !!p.multiple, options: opts.filter(o => o.message_id === m.id).map(o => ({ id: o.id, text: o.text, votes: votes.filter(v => v.option_id === o.id).map(v => v.user_id) })) };
      }
    }
    return out;
  });
}
const fmtById = async id => (await fmtMany([await one('SELECT * FROM messages WHERE id=?', [id])]))[0];

const PER_VIEWER = `
SELECT m.user_id, m.role, m.muted,
  (SELECT COUNT(*) FROM messages x WHERE x.conversation_id=m.conversation_id AND x.id>m.last_read_id AND x.sender_id IS NOT NULL
     AND x.sender_id<>m.user_id AND x.deleted=0 AND x.type<>'system'
     AND x.id NOT IN (SELECT d.message_id FROM message_deletions d WHERE d.user_id=m.user_id)) AS unread,
  (SELECT t.text FROM drafts t WHERE t.user_id=m.user_id AND t.conversation_id=m.conversation_id) AS draft,
  (SELECT x.id FROM messages x WHERE x.conversation_id=m.conversation_id
     AND x.id NOT IN (SELECT d.message_id FROM message_deletions d WHERE d.user_id=m.user_id) ORDER BY x.id DESC LIMIT 1) AS last_id
FROM members m WHERE m.conversation_id=? AND m.user_id = ANY(?)`;

// builds the conversation card for several viewers using ~6 queries in total
async function convSummaries(cid, viewerIds) {
  const [c, members, per, pin] = await Promise.all([
    getConv(cid),
    all('SELECT user_id AS id, role FROM members WHERE conversation_id=? ORDER BY joined_at, user_id', [cid]),
    all(PER_VIEWER, [cid, viewerIds]),
    one('SELECT * FROM messages WHERE conversation_id=? AND pinned_at IS NOT NULL AND deleted=0 ORDER BY pinned_at DESC LIMIT 1', [cid])
  ]);
  if (!c || !per.length) return [];
  const usersMap = await getUsersMap(members.map(m => m.id));
  const memberList = members.map(m => ({ ...publicUser(usersMap.get(m.id)), role: m.role }));
  const lastIds = [...new Set(per.map(p => p.last_id).filter(Boolean))];
  const lastRows = lastIds.length ? await all('SELECT * FROM messages WHERE id = ANY(?)', [lastIds]) : [];
  const formatted = await fmtMany(pin ? [...lastRows, pin] : lastRows);
  const byId = new Map(formatted.map(m => [m.id, m]));
  return per.map(p => {
    let name = c.name, avatar = c.avatar, otherId = null;
    if (c.type === 'direct') {
      const other = memberList.find(m => m.id !== p.user_id) || memberList[0];
      name = other.displayName; avatar = other.avatar; otherId = other.id;
    }
    return {
      viewerId: p.user_id,
      summary: {
        id: c.id, type: c.type, name, description: c.description, avatar, isPublic: !!c.is_public,
        onlyAdminsSend: !!c.only_admins_send || c.type === 'channel', createdAt: c.created_at,
        role: p.role, muted: !!p.muted, unread: p.unread, last: p.last_id ? byId.get(p.last_id) || null : null,
        members: memberList, otherId, inviteCode: isAdminRole(p.role) ? c.invite_code : null,
        draft: p.draft || '', pinned: pin ? byId.get(pin.id) || null : null
      }
    };
  });
}
const convSummary = async (cid, uid) => { const r = await convSummaries(cid, [uid]); return r.length ? r[0].summary : null; };

let io;
const toUser = (uid, ev, data) => io.to('user:' + uid).emit(ev, data);
const toConv = async (cid, ev, data) => (await memberIds(cid)).forEach(uid => toUser(uid, ev, data));
async function pushConv(cid) { (await convSummaries(cid, await memberIds(cid))).forEach(r => toUser(r.viewerId, 'conv:update', r.summary)); }
async function pushConvTo(cid, uid) { const s = await convSummary(cid, uid); if (s) toUser(uid, 'conv:update', s); }

async function insertMessage(cid, senderId, f) {
  return one(`INSERT INTO messages (conversation_id, sender_id, type, text, file_url, file_name, file_size, file_mime, reply_to, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING *`,
    [cid, senderId, f.type || 'text', f.text || '', f.file ? f.file.url : null, f.file ? f.file.name : null,
     f.file ? f.file.size : null, f.file ? f.file.mime : null, f.replyTo || null, Date.now()]);
}
async function postSystem(cid, text) {
  const row = await insertMessage(cid, null, { type: 'system', text });
  const [msg] = await fmtMany([row], { fresh: true });
  await toConv(cid, 'msg:new', msg);
}
const nameOf = async uid => ((await getUser(uid)) || {}).display_name || 'Someone';

async function getMessages(cid, uid, { before, around, limit = 40 }) {
  const vis = 'conversation_id=? AND id NOT IN (SELECT message_id FROM message_deletions WHERE user_id=?)';
  let rows, hasMore;
  if (around) {
    const [older, newer] = await Promise.all([
      all(`SELECT * FROM messages WHERE ${vis} AND id<=? ORDER BY id DESC LIMIT 26`, [cid, uid, around]),
      all(`SELECT * FROM messages WHERE ${vis} AND id>? ORDER BY id ASC LIMIT 300`, [cid, uid, around])
    ]);
    hasMore = older.length > 25;
    rows = [...older.slice(0, 25).reverse(), ...newer];
  } else {
    rows = before
      ? await all(`SELECT * FROM messages WHERE ${vis} AND id<? ORDER BY id DESC LIMIT ?`, [cid, uid, before, limit + 1])
      : await all(`SELECT * FROM messages WHERE ${vis} ORDER BY id DESC LIMIT ?`, [cid, uid, limit + 1]);
    hasMore = rows.length > limit;
    rows = rows.slice(0, limit).reverse();
  }
  return { messages: await fmtMany(rows), hasMore };
}

/* ------------------------------------------------------------------- HTTP */
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const attempts = new Map();
const limited = ip => {
  const now = Date.now(), arr = (attempts.get(ip) || []).filter(t => now - t < 60000);
  arr.push(now); attempts.set(ip, arr); return arr.length > 20;
};

app.get('/', (_req, res) => res.json({ ok: true, name: 'Chattrix server', storage: storage.useSupabase ? 'supabase' : 'local' }));
app.get('/health', (_req, res) => res.send('ok'));

app.post('/api/register', wrap(async (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: 'Too many attempts, wait a minute' });
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const displayName = String(req.body.displayName || '').trim().slice(0, 30) || username;
  if (!/^[A-Za-z0-9_.]{3,20}$/.test(username)) return res.status(400).json({ error: 'Username: 3-20 letters, numbers, _ or .' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const u = await one('INSERT INTO users (username, display_name, password_hash, last_seen, created_at) VALUES (?,?,?,?,?) RETURNING *',
      [username, displayName, await bcrypt.hash(password, 10), Date.now(), Date.now()]);
    userCache.set(u.id, u);
    res.json({ token: sign(u.id), user: publicUser(u) });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Username already taken' });
    throw e;
  }
}));

app.post('/api/login', wrap(async (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: 'Too many attempts, wait a minute' });
  const u = await one('SELECT * FROM users WHERE lower(username)=lower(?)', [String(req.body.username || '').trim()]);
  if (!u || !(await bcrypt.compare(String(req.body.password || ''), u.password_hash))) return res.status(401).json({ error: 'Wrong username or password' });
  userCache.set(u.id, u);
  res.json({ token: sign(u.id), user: publicUser(u) });
}));

const authHttp = wrap(async (req, res, next) => {
  try {
    const p = jwt.verify((req.headers.authorization || '').replace(/^Bearer /, ''), JWT_SECRET);
    if (!(await getUser(p.uid))) throw new Error('no user');
    req.uid = p.uid;
  } catch { return res.status(401).json({ error: 'Unauthorized' }); }
  next();
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
app.post('/api/upload', authHttp, upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const url = await storage.save(req.file.buffer, req.file.originalname, req.file.mimetype);
  res.json({ url, name: Buffer.from(req.file.originalname, 'latin1').toString('utf8'), size: req.file.size, mime: req.file.mimetype });
}));

if (!storage.useSupabase) { // local-disk mode (development only)
  const INLINE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp3', '.wav', '.ogg', '.webm', '.m4a', '.mp4', '.pdf']);
  app.get('/uploads/:file', (req, res) => {
    const f = path.basename(req.params.file), p = path.join(storage.UPLOAD_DIR, f);
    if (!fs.existsSync(p)) return res.sendStatus(404);
    res.set('X-Content-Type-Options', 'nosniff');
    if (INLINE.has(path.extname(f).toLowerCase())) return res.sendFile(p);
    res.download(p, String(req.query.name || f));
  });
  app.get('/download/:file', (req, res) => {
    const f = path.basename(req.params.file), p = path.join(storage.UPLOAD_DIR, f);
    if (!fs.existsSync(p)) return res.sendStatus(404);
    res.set('X-Content-Type-Options', 'nosniff');
    res.download(p, String(req.query.name || f));
  });
}

app.get('/join/:code', wrap(async (req, res) => {
  const code = String(req.params.code).replace(/[^a-z0-9]/gi, '');
  const c = await one('SELECT name, type FROM conversations WHERE invite_code=?', [code]);
  const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  res.send(`<!doctype html><meta charset="utf-8"><title>Join on Chattrix</title>
<body style="font-family:system-ui;background:#0f0f10;color:#f4f4f5;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center;max-width:420px;padding:24px">
${c ? `<h2>You are invited to join<br>“${esc(c.name)}”</h2>
<p><a href="chattrix://join/${code}" style="background:#ffb224;color:#1b1300;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:700">Open in Chattrix</a></p>
<p style="color:#b4b4ba">If the button does nothing, open Chattrix → ⋮ menu → “Join via link” and paste this code:</p>
<code style="background:#1f1f22;padding:8px 12px;border-radius:8px">${code}</code>` : '<h2>This invite link is invalid or was revoked.</h2>'}
</div></body>`);
}));

app.use((err, _req, res, _next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large (max 25 MB)' });
  console.error(err); res.status(500).json({ error: 'Server error' });
});

const server = http.createServer(app);
io = new Server(server, { cors: { origin: '*' } });

/* ----------------------------------------------------------------- socket */
io.use(async (socket, next) => {
  try {
    const p = jwt.verify(String((socket.handshake.auth || {}).token || ''), JWT_SECRET);
    if (!(await getUser(p.uid))) throw new Error('no user');
    socket.data.userId = p.uid; next();
  } catch { next(new Error('unauthorized')); }
});

function handle(socket, ev, fn) {
  socket.on(ev, async (data, ack) => {
    if (typeof data === 'function') { ack = data; data = {}; }
    try {
      const res = await fn(data || {}, socket.data.userId, socket);
      if (typeof ack === 'function') ack({ ok: true, ...res });
    } catch (e) {
      if (!e.expected) console.error(ev, e);
      if (typeof ack === 'function') ack({ ok: false, error: e.expected ? e.message : 'Server error' });
    }
  });
}

io.on('connection', socket => {
  const uid = socket.data.userId;
  socket.join('user:' + uid);
  online.set(uid, (online.get(uid) || 0) + 1);
  if (online.get(uid) === 1) io.emit('presence', { userId: uid, online: true });

  socket.on('disconnect', async () => {
    const n = (online.get(uid) || 1) - 1;
    if (n > 0) return online.set(uid, n);
    online.delete(uid);
    const ts = Date.now();
    const u = userCache.get(uid); if (u) u.last_seen = ts;
    io.emit('presence', { userId: uid, online: false, lastSeen: ts });
    try { await run('UPDATE users SET last_seen=? WHERE id=?', [ts, uid]); } catch (e) { console.error(e.message); }
  });

  /* ---- bootstrap / history ---- */
  handle(socket, 'bootstrap', async (_d, uid) => {
    const rows = await all('SELECT conversation_id AS id FROM members WHERE user_id=?', [uid]);
    const conversations = (await Promise.all(rows.map(r => convSummary(r.id, uid)))).filter(Boolean);
    return { me: publicUser(await getUser(uid)), conversations };
  });

  handle(socket, 'conv:open', async ({ convId, before, around }, uid) => {
    await requireMember(convId, uid);
    return getMessages(convId, uid, { before, around });
  });

  /* ---- messages ---- */
  handle(socket, 'msg:send', async ({ convId, text, replyTo, file }, uid) => {
    const [mem, conv] = await Promise.all([getMember(convId, uid), getConv(convId)]);
    if (!mem) fail('You are not a member of this chat');
    if ((conv.type === 'channel' || conv.only_admins_send) && !isAdminRole(mem.role)) fail('Only admins can send messages here');
    text = String(text || '').trim().slice(0, 4000);
    if (file && !storage.isOwnUrl(file.url)) fail('Invalid file');
    if (!text && !file) fail('Empty message');
    if (replyTo) { const r = await one('SELECT conversation_id FROM messages WHERE id=?', [replyTo]); if (!r || r.conversation_id !== convId) replyTo = null; }
    const row = await insertMessage(convId, uid, {
      type: file ? 'file' : 'text', text, replyTo,
      file: file ? { url: file.url, name: String(file.name || 'file').slice(0, 200), size: Number(file.size) || 0, mime: String(file.mime || 'application/octet-stream').slice(0, 100) } : null
    });
    const [[msg], ids] = await Promise.all([
      fmtMany([row], { fresh: true }), memberIds(convId),
      run('UPDATE members SET last_read_id=GREATEST(last_read_id,?) WHERE conversation_id=? AND user_id=?', [row.id, convId, uid]),
      run('DELETE FROM drafts WHERE user_id=? AND conversation_id=?', [uid, convId])
    ]);
    ids.forEach(id => toUser(id, 'msg:new', msg));
    toUser(uid, 'draft', { convId, text: '' });
    return { id: msg.id };
  });

  handle(socket, 'msg:edit', async ({ id, text }, uid) => {
    const m = await one('SELECT * FROM messages WHERE id=?', [id]);
    if (!m || m.sender_id !== uid || m.deleted || m.type !== 'text') fail('You can only edit your own text messages');
    text = String(text || '').trim().slice(0, 4000);
    if (!text) fail('Message cannot be empty');
    await run('UPDATE messages SET text=?, edited_at=? WHERE id=?', [text, Date.now(), id]);
    await toConv(m.conversation_id, 'msg:update', await fmtById(id));
    return {};
  });

  handle(socket, 'msg:delete', async ({ id, scope }, uid) => {
    const m = await one('SELECT * FROM messages WHERE id=?', [id]);
    if (!m) fail('Message not found');
    const mem = await requireMember(m.conversation_id, uid);
    if (scope === 'me') {
      await run('INSERT INTO message_deletions (message_id, user_id) VALUES (?,?) ON CONFLICT DO NOTHING', [id, uid]);
      toUser(uid, 'msg:removed', { id, convId: m.conversation_id });
      await pushConvTo(m.conversation_id, uid);
      return {};
    }
    const conv = await getConv(m.conversation_id);
    if (m.sender_id !== uid && !(conv.type !== 'direct' && isAdminRole(mem.role))) fail('You can only delete your own messages for everyone');
    await run("UPDATE messages SET deleted=1, text='', file_url=NULL, pinned_at=NULL WHERE id=?", [id]);
    await run('DELETE FROM message_reactions WHERE message_id=?', [id]);
    await toConv(m.conversation_id, 'msg:update', await fmtById(id));
    await pushConv(m.conversation_id);
    return {};
  });

  handle(socket, 'msg:react', async ({ id, emoji }, uid) => {
    const m = await one('SELECT * FROM messages WHERE id=?', [id]);
    if (!m || m.deleted) fail('Message not found');
    await requireMember(m.conversation_id, uid);
    emoji = emoji ? String(emoji).slice(0, 8) : null;
    const cur = await one('SELECT emoji FROM message_reactions WHERE message_id=? AND user_id=?', [id, uid]);
    if (!emoji || (cur && cur.emoji === emoji)) await run('DELETE FROM message_reactions WHERE message_id=? AND user_id=?', [id, uid]);
    else await run('INSERT INTO message_reactions (message_id, user_id, emoji) VALUES (?,?,?) ON CONFLICT (message_id, user_id) DO UPDATE SET emoji=EXCLUDED.emoji', [id, uid, emoji]);
    await toConv(m.conversation_id, 'msg:update', await fmtById(id));
    return {};
  });

  handle(socket, 'msg:pin', async ({ id, pin }, uid) => {
    const m = await one('SELECT * FROM messages WHERE id=?', [id]);
    if (!m || m.deleted || m.type === 'system') fail('Message not found');
    const [mem, conv] = await Promise.all([requireMember(m.conversation_id, uid), getConv(m.conversation_id)]);
    if (conv.type !== 'direct' && !isAdminRole(mem.role)) fail('Only admins can pin messages');
    if (pin) await run('UPDATE messages SET pinned_at=?, pinned_by=? WHERE id=?', [Date.now(), uid, id]);
    else await run('UPDATE messages SET pinned_at=NULL, pinned_by=NULL WHERE id=?', [id]);
    await toConv(m.conversation_id, 'msg:update', await fmtById(id));
    await pushConv(m.conversation_id);
    await postSystem(m.conversation_id, `${await nameOf(uid)} ${pin ? 'pinned' : 'unpinned'} a message`);
    return {};
  });

  /* ---- polls ---- */
  handle(socket, 'poll:create', async ({ convId, question, options, multiple }, uid) => {
    const [mem, conv] = await Promise.all([requireMember(convId, uid), getConv(convId)]);
    if ((conv.type === 'channel' || conv.only_admins_send) && !isAdminRole(mem.role)) fail('Only admins can send messages here');
    question = String(question || '').trim().slice(0, 300);
    options = (Array.isArray(options) ? options : []).map(o => String(o || '').trim().slice(0, 100)).filter(Boolean).slice(0, 10);
    if (!question) fail('Poll needs a question');
    if (options.length < 2) fail('Poll needs at least 2 options');
    const row = await insertMessage(convId, uid, { type: 'poll', text: question });
    await run('INSERT INTO polls (message_id, multiple) VALUES (?,?)', [row.id, multiple ? 1 : 0]);
    await run(`INSERT INTO poll_options (message_id, text) VALUES ${valuesSql(options.length, 2)}`, options.flatMap(o => [row.id, o]));
    await run('UPDATE members SET last_read_id=GREATEST(last_read_id,?) WHERE conversation_id=? AND user_id=?', [row.id, convId, uid]);
    await toConv(convId, 'msg:new', await fmtById(row.id));
    return {};
  });

  handle(socket, 'poll:vote', async ({ messageId, optionId }, uid) => {
    const m = await one('SELECT * FROM messages WHERE id=? AND type=?', [messageId, 'poll']);
    if (!m || m.deleted) fail('Poll not found');
    await requireMember(m.conversation_id, uid);
    const [poll, opt, had] = await Promise.all([
      one('SELECT * FROM polls WHERE message_id=?', [messageId]),
      one('SELECT * FROM poll_options WHERE id=? AND message_id=?', [optionId, messageId]),
      one('SELECT 1 AS x FROM poll_votes WHERE option_id=? AND user_id=?', [optionId, uid])
    ]);
    if (!opt) fail('Invalid option');
    if (!poll.multiple) await run('DELETE FROM poll_votes WHERE message_id=? AND user_id=?', [messageId, uid]);
    if (had) await run('DELETE FROM poll_votes WHERE option_id=? AND user_id=?', [optionId, uid]);
    else await run('INSERT INTO poll_votes (option_id, message_id, user_id) VALUES (?,?,?) ON CONFLICT DO NOTHING', [optionId, messageId, uid]);
    await toConv(m.conversation_id, 'msg:update', await fmtById(messageId));
    return {};
  });

  /* ---- read / drafts / typing / mute (synced across devices) ---- */
  handle(socket, 'read', async ({ convId, messageId }, uid) => {
    await requireMember(convId, uid);
    await run('UPDATE members SET last_read_id=GREATEST(last_read_id,?) WHERE conversation_id=? AND user_id=?', [Number(messageId) || 0, convId, uid]);
    toUser(uid, 'read', { convId, messageId });
    return {};
  });
  handle(socket, 'draft', async ({ convId, text }, uid, sock) => {
    await requireMember(convId, uid);
    text = String(text || '').slice(0, 4000);
    if (text) await run('INSERT INTO drafts (user_id, conversation_id, text) VALUES (?,?,?) ON CONFLICT (user_id, conversation_id) DO UPDATE SET text=EXCLUDED.text', [uid, convId, text]);
    else await run('DELETE FROM drafts WHERE user_id=? AND conversation_id=?', [uid, convId]);
    sock.to('user:' + uid).emit('draft', { convId, text });
    return {};
  });
  handle(socket, 'typing', async ({ convId }, uid) => {
    const [mem, conv, ids] = await Promise.all([requireMember(convId, uid), getConv(convId), memberIds(convId)]);
    if ((conv.type === 'channel' || conv.only_admins_send) && !isAdminRole(mem.role)) return {};
    ids.filter(id => id !== uid).forEach(id => toUser(id, 'typing', { convId, userId: uid }));
    return {};
  });
  handle(socket, 'mute', async ({ convId, muted }, uid) => {
    await requireMember(convId, uid);
    await run('UPDATE members SET muted=? WHERE conversation_id=? AND user_id=?', [muted ? 1 : 0, convId, uid]);
    await pushConvTo(convId, uid);
    return {};
  });

  /* ---- people / direct chats ---- */
  handle(socket, 'users:search', async ({ q: text }, uid) => {
    const like = likeEsc(text || '');
    const rows = await all("SELECT * FROM users WHERE id<>? AND (username ILIKE ? ESCAPE '\\' OR display_name ILIKE ? ESCAPE '\\') ORDER BY display_name LIMIT 30", [uid, like, like]);
    rows.forEach(u => userCache.set(u.id, u));
    return { users: rows.map(publicUser) };
  });

  handle(socket, 'dm:open', async ({ userId }, uid) => {
    if (!Number.isInteger(userId) || userId === uid || !(await getUser(userId))) fail('Invalid user');
    const key = [uid, userId].sort((a, b) => a - b).join(':');
    let c = await one('SELECT * FROM conversations WHERE direct_key=?', [key]);
    if (!c) {
      c = await one('INSERT INTO conversations (type, created_by, created_at, direct_key) VALUES (?,?,?,?) ON CONFLICT (direct_key) DO NOTHING RETURNING *', ['direct', uid, Date.now(), key]);
      if (c) {
        await run(`INSERT INTO members (conversation_id, user_id, role, joined_at) VALUES ${valuesSql(2, 4)} ON CONFLICT DO NOTHING`, [c.id, uid, 'member', Date.now(), c.id, userId, 'member', Date.now()]);
        await pushConv(c.id);
      } else c = await one('SELECT * FROM conversations WHERE direct_key=?', [key]);
    }
    return { convId: c.id };
  });

  /* ---- groups & channels ---- */
  handle(socket, 'group:create', async ({ name, type, memberIds: ids, isPublic, description }, uid) => {
    name = String(name || '').trim().slice(0, 50);
    if (!name) fail('Name is required');
    type = type === 'channel' ? 'channel' : 'group';
    const c = await one('INSERT INTO conversations (type, name, description, created_by, created_at, only_admins_send, is_public) VALUES (?,?,?,?,?,?,?) RETURNING *',
      [type, name, String(description || '').slice(0, 300), uid, Date.now(), type === 'channel' ? 1 : 0, type === 'channel' && isPublic ? 1 : 0]);
    const wanted = (Array.isArray(ids) ? ids : []).filter(id => Number.isInteger(id) && id !== uid);
    const users = wanted.length ? await all('SELECT id FROM users WHERE id = ANY(?)', [wanted]) : [];
    const rows = [[c.id, uid, 'owner', Date.now()], ...users.map(u => [c.id, u.id, 'member', Date.now()])];
    await run(`INSERT INTO members (conversation_id, user_id, role, joined_at) VALUES ${valuesSql(rows.length, 4)} ON CONFLICT DO NOTHING`, rows.flat());
    await pushConv(c.id);
    await postSystem(c.id, `${await nameOf(uid)} created ${type} “${name}”`);
    return { convId: c.id };
  });

  handle(socket, 'group:update', async ({ convId, name, description, avatar, onlyAdminsSend }, uid) => {
    await requireAdmin(convId, uid);
    const c = await getConv(convId);
    if (c.type === 'direct') fail('Not allowed');
    let renamed = null;
    if (name !== undefined) {
      name = String(name).trim().slice(0, 50);
      if (!name) fail('Name is required');
      if (name !== c.name) { await run('UPDATE conversations SET name=? WHERE id=?', [name, convId]); renamed = name; }
    }
    if (description !== undefined) await run('UPDATE conversations SET description=? WHERE id=?', [String(description).slice(0, 300), convId]);
    if (avatar !== undefined) {
      if (avatar && !storage.isOwnUrl(avatar)) fail('Invalid image');
      await run('UPDATE conversations SET avatar=? WHERE id=?', [avatar || null, convId]);
    }
    if (onlyAdminsSend !== undefined && c.type === 'group') await run('UPDATE conversations SET only_admins_send=? WHERE id=?', [onlyAdminsSend ? 1 : 0, convId]);
    await pushConv(convId);
    if (renamed) await postSystem(convId, `${await nameOf(uid)} changed the name to “${renamed}”`);
    return {};
  });

  handle(socket, 'group:addMembers', async ({ convId, userIds }, uid) => {
    await requireAdmin(convId, uid);
    if ((await getConv(convId)).type === 'direct') fail('Not allowed');
    const wanted = (Array.isArray(userIds) ? userIds : []).filter(Number.isInteger);
    if (!wanted.length) return {};
    const users = await all('SELECT id, display_name FROM users WHERE id = ANY(?) AND id NOT IN (SELECT user_id FROM members WHERE conversation_id=?)', [wanted, convId]);
    if (!users.length) return {};
    await run(`INSERT INTO members (conversation_id, user_id, role, joined_at) VALUES ${valuesSql(users.length, 4)} ON CONFLICT DO NOTHING`, users.flatMap(u => [convId, u.id, 'member', Date.now()]));
    await pushConv(convId);
    await postSystem(convId, `${await nameOf(uid)} added ${users.map(u => u.display_name).join(', ')}`);
    return {};
  });

  handle(socket, 'group:removeMember', async ({ convId, userId }, uid) => {
    const [me, target] = await Promise.all([requireAdmin(convId, uid), getMember(convId, userId)]);
    if (!target) fail('Not a member');
    if (target.role === 'owner') fail('The owner cannot be removed');
    if (target.role === 'admin' && me.role !== 'owner') fail('Only the owner can remove admins');
    await run('DELETE FROM members WHERE conversation_id=? AND user_id=?', [convId, userId]);
    toUser(userId, 'conv:removed', { convId });
    await pushConv(convId);
    await postSystem(convId, `${await nameOf(uid)} removed ${await nameOf(userId)}`);
    return {};
  });

  handle(socket, 'group:setRole', async ({ convId, userId, role }, uid) => {
    const me = await requireMember(convId, uid);
    if (me.role !== 'owner') fail('Only the owner can change roles');
    const target = await getMember(convId, userId);
    if (!target || target.role === 'owner') fail('Invalid member');
    role = role === 'admin' ? 'admin' : 'member';
    await run('UPDATE members SET role=? WHERE conversation_id=? AND user_id=?', [role, convId, userId]);
    await pushConv(convId);
    await postSystem(convId, `${await nameOf(userId)} is ${role === 'admin' ? 'now an admin' : 'no longer an admin'}`);
    return {};
  });

  handle(socket, 'group:leave', async ({ convId }, uid) => {
    const me = await requireMember(convId, uid), c = await getConv(convId);
    if (c.type === 'direct') fail('Not allowed');
    await run('DELETE FROM members WHERE conversation_id=? AND user_id=?', [convId, uid]);
    toUser(uid, 'conv:removed', { convId });
    const rest = await all("SELECT * FROM members WHERE conversation_id=? ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, joined_at", [convId]);
    if (!rest.length) { await run('DELETE FROM conversations WHERE id=?', [convId]); return {}; }
    if (me.role === 'owner') await run("UPDATE members SET role='owner' WHERE conversation_id=? AND user_id=?", [convId, rest[0].user_id]);
    await pushConv(convId);
    await postSystem(convId, `${await nameOf(uid)} left`);
    return {};
  });

  handle(socket, 'group:delete', async ({ convId }, uid) => {
    const me = await requireMember(convId, uid);
    if (me.role !== 'owner') fail('Only the owner can delete this');
    const ids = await memberIds(convId);
    await run('DELETE FROM conversations WHERE id=?', [convId]);
    ids.forEach(id => toUser(id, 'conv:removed', { convId }));
    return {};
  });

  handle(socket, 'group:invite', async ({ convId, action }, uid) => {
    await requireAdmin(convId, uid);
    if ((await getConv(convId)).type === 'direct') fail('Not allowed');
    const code = action === 'revoke' ? null : crypto.randomBytes(6).toString('hex');
    await run('UPDATE conversations SET invite_code=? WHERE id=?', [code, convId]);
    await pushConv(convId);
    return { code };
  });

  handle(socket, 'group:join', async ({ code }, uid) => {
    const c = await one('SELECT * FROM conversations WHERE invite_code=?', [String(code || '').replace(/[^a-z0-9]/gi, '')]);
    if (!c) fail('Invite link is invalid or was revoked');
    if (!(await getMember(c.id, uid))) {
      await run('INSERT INTO members (conversation_id, user_id, role, joined_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING', [c.id, uid, 'member', Date.now()]);
      await pushConv(c.id);
      await postSystem(c.id, `${await nameOf(uid)} joined using an invite link`);
    }
    return { convId: c.id };
  });

  handle(socket, 'channels:list', async (_d, uid) => {
    const rows = await all(`SELECT c.id, c.name, c.description, c.avatar,
        (SELECT COUNT(*) FROM members m WHERE m.conversation_id=c.id) AS cnt,
        EXISTS(SELECT 1 FROM members m WHERE m.conversation_id=c.id AND m.user_id=?) AS joined
      FROM conversations c WHERE c.type='channel' AND c.is_public=1 ORDER BY c.created_at DESC LIMIT 50`, [uid]);
    return { channels: rows.map(c => ({ id: c.id, name: c.name, description: c.description, avatar: c.avatar, members: c.cnt, joined: c.joined })) };
  });

  handle(socket, 'channel:join', async ({ convId }, uid) => {
    const c = await getConv(convId);
    if (!c || c.type !== 'channel' || !c.is_public) fail('Channel not found');
    if (!(await getMember(convId, uid))) {
      await run('INSERT INTO members (conversation_id, user_id, role, joined_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING', [convId, uid, 'member', Date.now()]);
      await pushConv(convId);
    }
    return { convId };
  });

  /* ---- profile ---- */
  handle(socket, 'profile:update', async ({ displayName, status, avatar }, uid) => {
    if (displayName !== undefined) {
      displayName = String(displayName).trim().slice(0, 30);
      if (!displayName) fail('Name cannot be empty');
      await run('UPDATE users SET display_name=? WHERE id=?', [displayName, uid]);
    }
    if (status !== undefined) await run('UPDATE users SET status=? WHERE id=?', [String(status).trim().slice(0, 80), uid]);
    if (avatar !== undefined) {
      if (avatar && !storage.isOwnUrl(avatar)) fail('Invalid image');
      await run('UPDATE users SET avatar=? WHERE id=?', [avatar || null, uid]);
    }
    const u = await one('SELECT * FROM users WHERE id=?', [uid]);
    userCache.set(uid, u);
    io.emit('profile', publicUser(u));
    return {};
  });

  /* ---- search ---- */
  handle(socket, 'search', async ({ q: text, convId, sender, from, to, type }, uid) => {
    let sql = `SELECT m.* FROM messages m JOIN members mem ON mem.conversation_id=m.conversation_id AND mem.user_id=?
               WHERE m.deleted=0 AND m.type<>'system' AND m.id NOT IN (SELECT message_id FROM message_deletions WHERE user_id=?)`;
    const p = [uid, uid];
    if (convId) { sql += ' AND m.conversation_id=?'; p.push(convId); }
    if (text) { const like = likeEsc(text); sql += " AND (m.text ILIKE ? ESCAPE '\\' OR m.file_name ILIKE ? ESCAPE '\\')"; p.push(like, like); }
    if (sender) { sql += ' AND m.sender_id=?'; p.push(Number(sender)); }
    if (from) { sql += ' AND m.created_at>=?'; p.push(Number(from)); }
    if (to) { sql += ' AND m.created_at<=?'; p.push(Number(to)); }
    if (type === 'text') sql += " AND m.type='text'";
    else if (type === 'image') sql += " AND m.file_mime LIKE 'image/%'";
    else if (type === 'video') sql += " AND m.file_mime LIKE 'video/%'";
    else if (type === 'audio') sql += " AND m.file_mime LIKE 'audio/%'";
    else if (type === 'document') sql += " AND m.file_url IS NOT NULL AND m.file_mime NOT LIKE 'image/%' AND m.file_mime NOT LIKE 'video/%' AND m.file_mime NOT LIKE 'audio/%'";
    else if (type === 'poll') sql += " AND m.type='poll'";
    sql += ' ORDER BY m.id DESC LIMIT 60';
    return { results: await fmtMany(await all(sql, p)) };
  });

  /* ---- WebRTC call signalling (server only relays) ---- */
  socket.on('call:invite', async ({ to, video }) => {
    if (!Number.isInteger(to) || to === uid || !(await getUser(to))) return;
    if (!online.has(to)) return socket.emit('call:ended', { from: to, reason: 'User is offline' });
    toUser(to, 'call:incoming', { from: publicUser(await getUser(uid)), video: !!video });
  });
  socket.on('call:accept', ({ to }) => toUser(to, 'call:accepted', { from: uid }));
  socket.on('call:reject', ({ to, reason }) => toUser(to, 'call:ended', { from: uid, reason: reason || 'Call declined' }));
  socket.on('call:signal', ({ to, data }) => toUser(to, 'call:signal', { from: uid, data }));
  socket.on('call:end', ({ to }) => toUser(to, 'call:ended', { from: uid, reason: 'Call ended' }));
});

/* ------------------------------------------------------------------ start */
(async () => {
  await initDb();
  JWT_SECRET = process.env.JWT_SECRET;
  if (!JWT_SECRET) { // keep a persistent secret in the database so logins survive restarts
    await run("INSERT INTO meta (key, value) VALUES ('jwt_secret', ?) ON CONFLICT (key) DO NOTHING", [crypto.randomBytes(32).toString('hex')]);
    JWT_SECRET = (await one("SELECT value FROM meta WHERE key='jwt_secret'")).value;
  }
  await storage.init();
  server.listen(PORT, '0.0.0.0', () => console.log(`Chattrix server running on port ${PORT}`));
})().catch(e => { console.error('Startup failed:', e.message); process.exit(1); });
