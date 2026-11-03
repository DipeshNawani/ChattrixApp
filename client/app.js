'use strict';
// >>> After deploying the server, put its public URL here (e.g. 'https://my-chat.onrender.com')
const DEFAULT_SERVER = 'http://localhost:3000';

const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const STATUS_PRESETS = ['Available', 'Busy', 'Working', 'In a meeting', 'At the gym', 'Sleeping', 'Urgent calls only'];
const api = window.chat;

const S = {
  server: '', token: null, me: null, lastError: '',
  users: {}, convs: {}, msgs: {}, hasMore: {},
  active: null, filter: 'all', search: '',
  replyTo: null, editing: null, typing: {}, uploads: [], recording: null,
  side: null, loadingOlder: false, infoRefresh: null, seenId: {}
};

function mountIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(el => el.replaceChildren(icon(el.dataset.icon, +el.dataset.size || 18)));
  root.querySelectorAll('[data-logo]').forEach(el => { const n = +el.dataset.size || 32; el.style.width = el.style.height = n + 'px'; el.replaceChildren(icon('logo', Math.round(n * 0.58))); });
}
mountIcons();

/* ============================================================ helpers */
const me = () => S.me;
const isMe = id => S.me && id === S.me.id;
const user = id => S.users[id] || { id, displayName: 'Unknown', username: '?', avatar: null };
const conv = () => S.convs[S.active];
const isAdmin = c => c && (c.role === 'owner' || c.role === 'admin');
const canSend = c => c && (c.type === 'direct' || (!c.onlyAdminsSend && c.type !== 'channel') || isAdmin(c));
const normalizeUrl = u => { u = u.trim().replace(/\/+$/, ''); return /^https?:\/\//i.test(u) ? u : 'http://' + u; };
const nameOf = c => c.type === 'direct' && c.otherId ? user(c.otherId).displayName : (c.name || 'Chat');
const avOf = c => c.type === 'direct' && c.otherId ? user(c.otherId).avatar : c.avatar;

async function req(ev, data, quiet) {
  const r = await api.request(ev, data);
  if (!r.ok && !quiet) toast(r.error || 'Something went wrong');
  return r;
}

function previewText(m) {
  if (!m) return '';
  if (m.deleted) return 'This message was deleted';
  if (m.type === 'system') return m.text;
  if (m.type === 'poll') return 'Poll: ' + m.text;
  if (m.file) {
    const k = fileKind(m.file.mime, m.file.name);
    if (k === 'audio' && /^voice-/.test(m.file.name)) return 'Voice message';
    const label = k === 'image' ? 'Photo' : k === 'video' ? 'Video' : k === 'audio' ? 'Audio' : 'File';
    return m.text ? label + ': ' + m.text : (k === 'doc' || k === 'audio' ? label + ': ' + m.file.name : label);
  }
  return m.text;
}

function mergeUser(u) {
  const { role, ...rest } = u;
  S.users[u.id] = { ...(S.users[u.id] || {}), ...rest };
}

function setConv(c) {
  c.members.forEach(mergeUser);
  if (c.id === S.active && document.hasFocus()) c.unread = 0;
  S.convs[c.id] = c;
}

/* ============================================================ theme */
function applyTheme() {
  const pref = localStorage.getItem('theme') || 'dark';
  const sys = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', pref === 'system' ? sys : pref);
}
if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

/* ============================================================ auth + startup */
let authMode = 'login';
function setAuthMode(m) {
  authMode = m;
  $('#tabLogin').classList.toggle('active', m === 'login');
  $('#tabRegister').classList.toggle('active', m === 'register');
  $('#fieldName').classList.toggle('hidden', m === 'login');
  $('#authBtn').textContent = m === 'login' ? 'Log in' : 'Create account';
  $('#authTitle').textContent = m === 'login' ? 'Log in' : 'Create your account';
  $('#authErr').textContent = '';
}
function showAuth() { $('#splash').classList.add('hidden'); $('#app').classList.add('hidden'); $('#auth').classList.remove('hidden'); }
function showApp() { $('#splash').classList.add('hidden'); $('#auth').classList.add('hidden'); $('#app').classList.remove('hidden'); }

$('#tabLogin').onclick = () => setAuthMode('login');
$('#tabRegister').onclick = () => setAuthMode('register');
$('#authForm').addEventListener('submit', async e => {
  e.preventDefault();
  const server = normalizeUrl($('#server').value);
  $('#authErr').textContent = '';
  $('#authBtn').disabled = true; $('#authBtn').textContent = 'Connecting… (first time can take up to a minute)';
  try {
    const res = await fetch(server + '/api/' + (authMode === 'login' ? 'login' : 'register'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('#username').value.trim(), password: $('#password').value, displayName: $('#displayName').value.trim() })
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || 'Failed');
    localStorage.setItem('server', server); localStorage.setItem('token', j.token);
    if (!(await start(server, j.token))) throw new Error(S.lastError || 'Could not connect');
    $('#password').value = '';
  } catch (err) {
    $('#authErr').textContent = /Failed to fetch|NetworkError/i.test(err.message) ? 'Cannot reach server. Check the URL (a free server may need ~1 minute to wake up, then try again).' : err.message;
  }
  $('#authBtn').disabled = false; setAuthMode(authMode);
});

async function start(server, token) {
  S.server = server; window.__server = server;
  const r = await api.connect(server, token);
  if (!r.ok) { S.lastError = r.error; if (r.unauthorized) localStorage.removeItem('token'); return false; }
  S.token = token;
  await bootstrap();
  showApp();
  return true;
}

async function bootstrap() {
  const r = await req('bootstrap', {}, true);
  if (!r.ok) throw new Error(r.error || 'Could not load chats');
  S.me = r.me; S.users[r.me.id] = { ...(S.users[r.me.id] || {}), ...r.me };
  S.convs = {};
  r.conversations.forEach(setConv);
  renderMe(); renderList();
  if (S.active && S.convs[S.active]) { await loadConv(S.active, true); renderHeader(); renderPinned(); renderComposerState(); }
  else closeChat();
}

function logout() {
  Calls.end(true);
  api.disconnect();
  localStorage.removeItem('token');
  Object.assign(S, { token: null, me: null, users: {}, convs: {}, msgs: {}, hasMore: {}, active: null, replyTo: null, editing: null, typing: {} });
  closeSide(); closeChat();
  showAuth();
}

/* ============================================================ socket events */
api.on('status', s => {
  const el = $('#offlineBanner');
  if (s === 'offline') {
    if (!el) $('.sidebar').prepend(h('div', { id: 'offlineBanner', class: 'offline-banner' }, 'Reconnecting…'));
  } else if (s === 'online') {
    if (el) el.remove();
    bootstrap().catch(console.error);
  }
});

api.on('msg:new', m => {
  const c = S.convs[m.convId]; if (!c) return;
  c.last = m;
  if (S.msgs[m.convId]) upsertMsg(m);
  const mine = isMe(m.senderId), isActive = S.active === m.convId;
  if (m.type !== 'system' && !mine) {
    if (isActive && document.hasFocus()) markRead(c.id, m.id);
    else { c.unread = (c.unread || 0) + 1; notify(c, m); }
    if (S.typing[m.convId]) delete S.typing[m.convId][m.senderId];
    if (isActive) $('#sr').textContent = (m.senderName || '') + ': ' + previewText(m);
  }
  if (isActive) { renderMessages('stick'); renderHeader(); }
  renderList();
});

api.on('msg:update', m => {
  const c = S.convs[m.convId]; if (!c) return;
  if (c.last && c.last.id === m.id) c.last = m;
  if (c.pinned && c.pinned.id === m.id && !m.pinned) c.pinned = null;
  if (S.msgs[m.convId]) upsertMsg(m);
  if (S.active === m.convId) { renderMessages('keep'); renderPinned(); }
  renderList();
});

api.on('msg:removed', ({ id, convId }) => {
  if (S.msgs[convId]) S.msgs[convId] = S.msgs[convId].filter(m => m.id !== id);
  const c = S.convs[convId];
  if (c && c.last && c.last.id === id) c.last = (S.msgs[convId] || []).slice(-1)[0] || null;
  if (S.active === convId) renderMessages('keep');
  renderList();
});

api.on('conv:update', c => {
  const old = S.convs[c.id];
  if (old && c.id !== S.active) c.unread = c.unread; // server value is authoritative
  setConv(c);
  if (S.active === c.id) { renderHeader(); renderPinned(); renderComposerState(); renderMessages('keep'); }
  if (S.infoRefresh && S.infoRefresh.id === c.id) S.infoRefresh.fn();
  renderList();
});

api.on('conv:removed', ({ convId }) => {
  delete S.convs[convId]; delete S.msgs[convId];
  if (S.active === convId) closeChat();
  if (S.infoRefresh && S.infoRefresh.id === convId) S.infoRefresh.close();
  renderList();
});

api.on('read', ({ convId, messageId }) => {
  const c = S.convs[convId];
  if (c && (!c.last || messageId >= c.last.id)) { c.unread = 0; renderList(); }
});

api.on('draft', ({ convId, text }) => {
  const c = S.convs[convId]; if (!c) return;
  c.draft = text;
  if (S.active === convId && document.activeElement !== $('#input')) { $('#input').value = text; autosize(); toggleSendMic(); }
});

api.on('typing', ({ convId, userId }) => {
  (S.typing[convId] = S.typing[convId] || {})[userId] = Date.now();
  setTimeout(refreshTyping, 2700);
  refreshTyping();
});

api.on('presence', ({ userId, online, lastSeen }) => {
  const u = S.users[userId]; if (!u) return;
  u.online = online; if (lastSeen) u.lastSeen = lastSeen;
  renderList(); if (S.active) renderHeader();
});

api.on('profile', u => {
  S.users[u.id] = { ...(S.users[u.id] || {}), ...u };
  if (isMe(u.id)) S.me = { ...S.me, ...u };
  renderMe(); renderList();
  if (S.active) { renderHeader(); renderMessages('keep'); }
});

api.on('deeplink', url => joinByLink(url));
api.on('call:incoming', d => Calls.onIncoming(d));
api.on('call:accepted', d => Calls.onAccepted(d));
api.on('call:signal', d => Calls.onSignal(d));
api.on('call:ended', d => Calls.onEnded(d));

function refreshTyping() {
  const now = Date.now();
  for (const cid of Object.keys(S.typing)) for (const uid of Object.keys(S.typing[cid])) if (now - S.typing[cid][uid] > 2600) delete S.typing[cid][uid];
  renderList(); if (S.active) renderHeader();
}
const typingNames = cid => Object.keys(S.typing[cid] || {}).map(id => user(+id).displayName.split(' ')[0]);

function upsertMsg(m) {
  const arr = S.msgs[m.convId];
  const i = arr.findIndex(x => x.id === m.id);
  if (i >= 0) arr[i] = m; else { arr.push(m); if (arr.length > 1 && arr[arr.length - 2].id > m.id) arr.sort((a, b) => a.id - b.id); }
}

function notify(c, m) {
  if (localStorage.getItem('notify') === 'off' || c.muted || m.type === 'system') return;
  try {
    const body = (c.type !== 'direct' ? m.senderName + ': ' : '') + previewText(m);
    const n = new Notification(nameOf(c), { body });
    n.onclick = () => { window.focus(); openConv(c.id); };
  } catch (_) {}
}

function markRead(convId, messageId) {
  const c = S.convs[convId]; if (!c) return;
  c.unread = 0;
  api.emit('read', { convId, messageId });
  renderList();
}
window.addEventListener('focus', () => {
  const c = conv(); if (!c) return;
  const arr = S.msgs[c.id] || [], last = arr[arr.length - 1];
  if (c.unread && last) markRead(c.id, last.id);
});

/* ============================================================ sidebar */
function renderMe() {
  if (!S.me) return;
  $('#meAv').replaceChildren(avatarEl(S.me.displayName, S.me.avatar, 36));
  $('#meName').textContent = S.me.displayName;
  $('#meStatus').textContent = S.me.status || '';
}

function lastLine(c) {
  const typers = typingNames(c.id);
  if (typers.length) return { text: c.type === 'direct' ? 'typing…' : typers.join(', ') + ' typing…', typing: true };
  const m = c.last;
  if (!m) return { text: c.type === 'direct' ? (user(c.otherId).status || '') : (c.description || 'No messages yet') };
  let prefix = '';
  if (m.type !== 'system' && !m.deleted) prefix = isMe(m.senderId) ? 'You: ' : (c.type !== 'direct' && m.senderName ? m.senderName.split(' ')[0] + ': ' : '');
  return { text: prefix + previewText(m) };
}

function renderList() {
  const list = $('#convList'); if (!list) return;
  list.replaceChildren();
  const q = S.search.toLowerCase();
  let items = Object.values(S.convs).filter(c => !q || nameOf(c).toLowerCase().includes(q));
  if (S.filter === 'unread') items = items.filter(c => c.unread > 0);
  if (S.filter === 'groups') items = items.filter(c => c.type !== 'direct');
  items.sort((a, b) => ((b.last && b.last.createdAt) || b.createdAt) - ((a.last && a.last.createdAt) || a.createdAt));

  items.forEach(c => {
    const ll = lastLine(c);
    const isOnline = c.type === 'direct' && user(c.otherId).online;
    const open = () => openConv(c.id);
    list.append(h('div', { class: 'conv' + (c.id === S.active ? ' active' : '') + (c.unread ? ' has-unread' : ''), role: 'button', tabindex: 0, onclick: open,
      onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } } },
      avatarEl(nameOf(c), avOf(c), 44, isOnline, c.type !== 'direct'),
      h('div', { class: 'body' },
        h('div', { class: 'row' }, c.type === 'channel' ? h('span', { class: 'kind', title: 'Channel' }, icon('megaphone', 14)) : null, h('div', { class: 'name' }, nameOf(c)),
          h('div', { class: 'time' }, c.last ? listTime(c.last.createdAt) : '')),
        h('div', { class: 'row' }, h('div', { class: 'preview' + (ll.typing ? ' typing' : '') }, ll.text),
          c.muted ? h('span', { class: 'kind', title: 'Muted' }, icon('mute', 14)) : null,
          c.unread ? h('div', { class: 'badge' + (c.muted ? ' muted' : '') }, c.unread > 99 ? '99+' : c.unread) : null))));
  });
  if (!items.length) list.append(h('div', { class: 'empty-list' }, S.filter === 'all' && !q ? 'No chats yet. Use the compose button to start one.' : 'Nothing here.'));

  const total = Object.values(S.convs).reduce((n, c) => n + (c.muted ? 0 : c.unread || 0), 0);
  document.title = (total ? `(${total}) ` : '') + 'Chattrix';
}

$('#listSearch').addEventListener('input', e => { S.search = e.target.value; renderList(); });
document.querySelectorAll('.chip').forEach(b => b.addEventListener('click', () => {
  S.filter = b.dataset.f;
  document.querySelectorAll('.chip').forEach(x => { x.classList.toggle('active', x === b); x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
  renderList();
}));

/* ============================================================ open / close chat */
function closeChat() {
  S.active = null; S.replyTo = null; S.editing = null;
  $('#chatView').classList.add('hidden'); $('#welcome').classList.remove('hidden'); $('#app').classList.remove('chat-open');
  closeSide(); renderList();
}

async function openConv(id) {
  if (!S.convs[id]) return;
  if (S.active === id) { $('#input').focus(); return; }
  saveDraftNow();
  S.active = id; S.replyTo = null; S.editing = null;
  closeSide();
  $('#welcome').classList.add('hidden'); $('#chatView').classList.remove('hidden'); $('#app').classList.add('chat-open');
  renderHeader(); renderPinned(); renderComposerState(); renderReplyBar();
  $('#input').value = S.convs[id].draft || ''; autosize(); toggleSendMic();
  renderList();
  await loadConv(id);
  if (S.active === id && canSend(S.convs[id])) $('#input').focus();
}

async function loadConv(id, fresh = false) {
  if (!S.msgs[id] || fresh) {
    const r = await req('conv:open', { convId: id });
    if (!r.ok) return;
    S.msgs[id] = r.messages; S.hasMore[id] = r.hasMore;
  }
  if (S.active !== id) return;
  renderMessages('bottom');
  const arr = S.msgs[id], last = arr[arr.length - 1];
  if (last && (S.convs[id].unread || fresh)) markRead(id, last.id);
}

async function loadOlder() {
  const id = S.active;
  if (!id || S.loadingOlder || !S.hasMore[id] || !S.msgs[id].length) return;
  S.loadingOlder = true;
  const r = await req('conv:open', { convId: id, before: S.msgs[id][0].id }, true);
  if (r.ok && S.active === id) { S.msgs[id] = [...r.messages, ...S.msgs[id]]; S.hasMore[id] = r.hasMore; renderMessages('prepend'); }
  S.loadingOlder = false;
}
function updateToBottom() {
  const box = $('#messages');
  $('#toBottom').classList.toggle('hidden', box.scrollHeight - box.scrollTop - box.clientHeight < 320);
}
$('#messages').addEventListener('scroll', e => { if (e.target.scrollTop < 80) loadOlder(); updateToBottom(); });
$('#toBottom').onclick = () => { const box = $('#messages'); box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' }); };

async function jumpTo(convId, msgId) {
  if (S.active !== convId) { await openConv(convId); }
  const present = (S.msgs[convId] || []).some(m => m.id === msgId);
  if (!present) {
    const r = await req('conv:open', { convId, around: msgId });
    if (!r.ok) return;
    S.msgs[convId] = r.messages; S.hasMore[convId] = r.hasMore;
    renderMessages('keep');
  }
  const el = document.querySelector(`[data-id="${msgId}"]`);
  if (el) { el.scrollIntoView({ block: 'center' }); const b = el.querySelector('.bubble'); if (b) { b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash'); } }
  else toast('Message not found');
}

/* ============================================================ header / pinned */
function headerSub(c) {
  const typers = typingNames(c.id);
  if (typers.length) return typers.join(', ') + ' typing…';
  if (c.type === 'direct') { const u = user(c.otherId); return u.online ? 'online' : lastSeenText(u.lastSeen); }
  if (c.type === 'channel') return c.members.length + ' subscriber' + (c.members.length === 1 ? '' : 's');
  return c.members.map(m => (isMe(m.id) ? 'You' : user(m.id).displayName.split(' ')[0])).join(', ');
}
function renderHeader() {
  const c = conv(); if (!c) return;
  $('#headAv').replaceChildren(avatarEl(nameOf(c), avOf(c), 38, c.type === 'direct' && user(c.otherId).online, c.type !== 'direct'));
  $('#headName').textContent = nameOf(c);
  $('#headSub').textContent = headerSub(c);
  $('#btnAudio').classList.toggle('hidden', c.type !== 'direct');
  $('#btnVideo').classList.toggle('hidden', c.type !== 'direct');
}
function renderPinned() {
  const c = conv(), el = $('#pinned');
  if (!c || !c.pinned) return el.classList.add('hidden');
  el.classList.remove('hidden');
  el.replaceChildren(icon('pin', 14), h('span', {}, previewText(c.pinned)));
  el.setAttribute('aria-label', 'Pinned message: ' + previewText(c.pinned));
  el.onclick = () => jumpTo(c.id, c.pinned.id);
  el.onkeydown = e => { if (e.key === 'Enter') jumpTo(c.id, c.pinned.id); };
}

/* ============================================================ messages */
function renderMessages(mode = 'keep') {
  const box = $('#messages'), c = conv(); if (!c) return;
  const prevTop = box.scrollTop, prevH = box.scrollHeight;
  const nearBottom = prevH - prevTop - box.clientHeight < 120;
  box.replaceChildren();
  const msgs = S.msgs[c.id] || [];
  const seen = S.seenId[c.id]; // only messages newer than this animate in
  if (!msgs.length) box.append(h('div', { class: 'empty' }, c.type === 'channel' ? 'No posts yet.' : 'No messages yet. Say hello.'));
  let prev = null;
  for (const m of msgs) {
    const newDay = !prev || !sameDay(prev.createdAt, m.createdAt);
    if (newDay) box.append(h('div', { class: 'day-sep' }, dayLabel(m.createdAt)));
    const grouped = !newDay && prev.type !== 'system' && m.type !== 'system' && prev.senderId === m.senderId && m.createdAt - prev.createdAt < 5 * 60 * 1000;
    const row = msgEl(m, c, !grouped);
    if (seen !== undefined && m.id > seen && mode !== 'prepend') row.classList.add('enter');
    box.append(row);
    prev = m;
  }
  if (msgs.length) S.seenId[c.id] = Math.max(S.seenId[c.id] || 0, msgs[msgs.length - 1].id);
  if (mode === 'bottom' || (mode === 'stick' && nearBottom)) box.scrollTop = box.scrollHeight;
  else if (mode === 'prepend') box.scrollTop = prevTop + (box.scrollHeight - prevH);
  else box.scrollTop = prevTop;
  updateToBottom();
}

function msgEl(m, c, first = true) {
  if (m.type === 'system') return h('div', { class: 'sys', 'data-id': m.id }, m.text);
  const mine = isMe(m.senderId);
  const b = h('div', { class: 'bubble' + (m.type === 'poll' ? ' card' : ''), oncontextmenu: e => { e.preventDefault(); showMsgMenu(m, e.clientX, e.clientY); } });
  if (!mine && c.type !== 'direct' && first) b.append(h('div', { class: 'from', style: '--h:' + hueFor(m.senderName) }, m.senderName || ''));

  if (m.deleted) b.append(h('div', { class: 'deleted' }, 'This message was deleted'));
  else {
    if (m.replyTo) b.append(h('div', { class: 'quote', onclick: () => jumpTo(c.id, m.replyTo.id) },
      h('div', { class: 'q-name' }, m.replyTo.senderName || ''),
      h('div', { class: 'q-text' }, m.replyTo.deleted ? 'Deleted message' : (m.replyTo.fileName ? m.replyTo.fileName : m.replyTo.text))));
    if (m.file) b.append(fileEl(m));
    if (m.type === 'poll') b.append(pollEl(m));
    else if (m.text) b.append(h('div', { class: 'text' }, m.text));
  }
  b.append(h('div', { class: 'meta' }, m.pinned ? icon('pin', 12) : null, m.editedAt && !m.deleted ? 'edited' : null, h('time', {}, fmtTime(m.createdAt))));
  if (!m.deleted) {
    b.append(h('button', { class: 'more', 'aria-label': 'Message options', title: 'Options', onclick: e => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); showMsgMenu(m, r.left, r.bottom); } }, icon('chevron', 14)));
    if (m.reactions.length) b.append(h('div', { class: 'reactions' }, m.reactions.map(r =>
      h('span', { class: 'react-chip' + (r.userIds.includes(S.me.id) ? ' mine' : ''), title: r.userIds.map(id => user(id).displayName).join(', '),
        onclick: () => api.emit('msg:react', { id: m.id, emoji: r.emoji }) }, r.emoji + (r.userIds.length > 1 ? ' ' + r.userIds.length : '')))));
  }
  return h('div', { class: 'msg-row ' + (mine ? 'me' : 'them') + (first ? ' first' : ''), 'data-id': m.id }, b);
}

function fileEl(m) {
  const f = m.file, url = absUrl(f.url), kind = fileKind(f.mime, f.name);
  if (kind === 'image') return h('img', { class: 'media', src: url, alt: f.name, onclick: () => { const lb = $('#lightbox'); $('img', lb).src = url; lb.classList.remove('hidden'); } });
  if (kind === 'video') return h('video', { class: 'media', src: url, controls: true, preload: 'metadata' });
  if (kind === 'audio') return h('div', {}, h('audio', { src: url, controls: true, preload: 'metadata' }),
    h('div', { class: 'sub' }, (/^voice-/.test(f.name) ? 'Voice message' : f.name) + ' · ' + fmtSize(f.size) + ' ', h('button', { class: 'mini', onclick: () => downloadFile(f) }, 'Download')));
  return h('div', { class: 'file-card' }, h('div', { class: 'ico-t' }, fileIcon(f.name)),
    h('div', { class: 'info' }, h('div', { class: 'fname', title: f.name }, f.name), h('div', { class: 'sub' }, fmtSize(f.size))),
    f.mime === 'application/pdf' ? h('button', { class: 'mini', onclick: () => window.open(url) }, 'Open') : null,
    h('button', { class: 'icon', 'aria-label': 'Download ' + f.name, title: 'Download', onclick: () => downloadFile(f) }, icon('download', 18)));
}

function pollEl(m) {
  const total = new Set(m.poll.options.flatMap(o => o.votes)).size;
  return h('div', { class: 'poll' }, h('div', { class: 'q' }, m.text),
    h('div', { class: 'hint' }, m.poll.multiple ? 'Select one or more' : 'Select one'),
    m.poll.options.map(o => h('div', { class: 'opt' + (o.votes.includes(S.me.id) ? ' voted' : ''), role: 'button', tabindex: 0, onclick: () => api.emit('poll:vote', { messageId: m.id, optionId: o.id }),
      onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); api.emit('poll:vote', { messageId: m.id, optionId: o.id }); } } },
      h('div', { class: 'bar', style: `width:${total ? Math.round(o.votes.length / total * 100) : 0}%` }), h('span', {}, o.text), h('span', {}, o.votes.length))),
    h('div', { class: 'hint' }, total + ' vote' + (total === 1 ? '' : 's') + ' · ' + m.poll.options.filter(o => o.votes.length).map(o => o.text + ': ' + o.votes.map(id => user(id).displayName.split(' ')[0]).join(', ')).join(' · ')));
}

function downloadFile(f) {
  const hist = JSON.parse(localStorage.getItem('downloads') || '[]');
  hist.unshift({ name: f.name, size: f.size, url: f.url, time: Date.now() });
  localStorage.setItem('downloads', JSON.stringify(hist.slice(0, 100)));
  if (/^https?:/i.test(f.url)) window.open(f.url + (f.url.includes('?') ? '&' : '?') + 'download=' + encodeURIComponent(f.name)); // Supabase public URL -> forces download
  else window.open(S.server + '/download/' + encodeURIComponent(f.url.split('/').pop()) + '?name=' + encodeURIComponent(f.name)); // local-disk dev mode
}

/* ---- message context menu ---- */
function showMsgMenu(m, x, y) {
  const c = conv(); if (!c || m.deleted) return;
  const mine = isMe(m.senderId);
  const row = h('div', { class: 'emoji-row' }, REACTIONS.map(e => h('span', { role: 'button', 'aria-label': 'React ' + e, onclick: () => { closeMenu(); api.emit('msg:react', { id: m.id, emoji: e }); } }, e)));
  const items = [
    canSend(c) && { icon: 'reply', label: 'Reply', fn: () => { S.replyTo = m; S.editing = null; renderReplyBar(); $('#input').focus(); } },
    mine && m.type === 'text' && { icon: 'edit', label: 'Edit', fn: () => { S.editing = m; S.replyTo = null; renderReplyBar(); $('#input').value = m.text; autosize(); toggleSendMic(); $('#input').focus(); } },
    m.text && { icon: 'copy', label: 'Copy', fn: () => navigator.clipboard.writeText(m.text).then(() => toast('Copied')).catch(() => {}) },
    m.file && { icon: 'download', label: 'Download', fn: () => downloadFile(m.file) },
    (c.type === 'direct' || isAdmin(c)) && { icon: m.pinned ? 'unpin' : 'pin', label: m.pinned ? 'Unpin' : 'Pin', fn: () => req('msg:pin', { id: m.id, pin: !m.pinned }) },
    { icon: 'trash', label: 'Delete for me', fn: () => req('msg:delete', { id: m.id, scope: 'me' }) },
    (mine || (c.type !== 'direct' && isAdmin(c))) && { icon: 'trash', label: 'Delete for everyone', danger: true, fn: async () => { if (await confirmBox('Delete this message for everyone?', 'Delete', true)) req('msg:delete', { id: m.id, scope: 'all' }); } }
  ].filter(Boolean);
  const node = h('div', { role: 'menu' }, row, items.map(i => h('div', { class: 'item' + (i.danger ? ' danger' : ''), role: 'menuitem', tabindex: 0,
    onclick: () => { closeMenu(); i.fn(); }, onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); closeMenu(); i.fn(); } } }, icon(i.icon, 16), i.label)));
  popup(node, x, y);
}

/* ============================================================ composer */
const input = $('#input');
let lastTypingSent = 0;
function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 140) + 'px'; input.style.overflowY = input.scrollHeight > 140 ? 'auto' : 'hidden'; }
function toggleSendMic() { const has = input.value.trim().length > 0; $('#btnSend').classList.toggle('hidden', !has); $('#btnMic').classList.toggle('hidden', has); }

function renderComposerState() {
  const c = conv(); if (!c) return;
  const can = canSend(c);
  $('#composer').classList.toggle('hidden', !can || !!S.recording);
  const ns = $('#noSend'); ns.classList.toggle('hidden', can);
  ns.textContent = c.type === 'channel' ? 'Only admins can post in this channel.' : 'Only admins can send messages in this group.';
}

function renderReplyBar() {
  const bar = $('#replyBar'), m = S.editing || S.replyTo;
  if (!m) return bar.classList.add('hidden');
  bar.classList.remove('hidden');
  bar.replaceChildren(
    h('div', { class: 'quote' }, h('div', { class: 'q-name' }, S.editing ? 'Editing message' : 'Replying to ' + (isMe(m.senderId) ? 'yourself' : m.senderName)), h('div', { class: 'q-text' }, previewText(m))),
    h('button', { class: 'icon', onclick: cancelReply, title: 'Cancel', 'aria-label': 'Cancel' }, icon('close', 16)));
}
function cancelReply() {
  if (S.editing) { input.value = ''; autosize(); toggleSendMic(); }
  S.replyTo = null; S.editing = null; renderReplyBar();
}

async function sendCurrent() {
  const c = conv(); if (!c) return;
  const text = input.value.trim(); if (!text) return;
  if (S.editing) {
    const r = await req('msg:edit', { id: S.editing.id, text });
    if (r.ok) { S.editing = null; input.value = ''; autosize(); toggleSendMic(); renderReplyBar(); }
    return;
  }
  const replyTo = S.replyTo && S.replyTo.id;
  input.value = ''; S.replyTo = null; autosize(); toggleSendMic(); renderReplyBar();
  const r = await req('msg:send', { convId: c.id, text, replyTo });
  if (!r.ok) { input.value = text; autosize(); toggleSendMic(); }
}

const saveDraft = debounce(() => saveDraftNow(), 700);
function saveDraftNow() {
  const c = conv(); if (!c || S.editing) return;
  const t = input.value;
  if (t !== (c.draft || '')) { c.draft = t; api.emit('draft', { convId: c.id, text: t }); }
}

input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendCurrent(); }
  else if (e.key === 'Escape') cancelReply();
});
input.addEventListener('input', () => {
  autosize(); toggleSendMic();
  const c = conv(); if (!c) return;
  if (!S.editing) { saveDraft(); if (Date.now() - lastTypingSent > 2000 && input.value) { lastTypingSent = Date.now(); api.emit('typing', { convId: c.id }); } }
});
$('#btnSend').onclick = sendCurrent;

/* emoji + attach menus */
$('#btnEmoji').onclick = e => {
  const r = e.currentTarget.getBoundingClientRect();
  const grid = h('div', { class: 'emoji-grid' }, EMOJIS.map(em => h('span', { onclick: () => { input.setRangeText(em, input.selectionStart, input.selectionEnd, 'end'); input.focus(); autosize(); toggleSendMic(); } }, em)));
  popup(grid, r.left, r.top - 250);
};
$('#btnAttach').onclick = e => {
  const r = e.currentTarget.getBoundingClientRect();
  menuItems([{ icon: 'image', label: 'Photo / file', fn: () => $('#fileInput').click() }, { icon: 'poll', label: 'Poll', fn: pollModal }], r.left, r.top - 96);
};
$('#fileInput').addEventListener('change', e => { const files = [...e.target.files]; e.target.value = ''; if (files.length) sendFiles(files); });

/* ============================================================ uploads (with progress) */
function uploadFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', S.server + '/api/upload');
    xhr.setRequestHeader('Authorization', 'Bearer ' + S.token);
    xhr.upload.onprogress = e => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => { try { const j = JSON.parse(xhr.responseText); xhr.status < 300 ? resolve(j) : reject(new Error(j.error || 'Upload failed')); } catch { reject(new Error('Upload failed')); } };
    xhr.onerror = () => reject(new Error('Network error'));
    const fd = new FormData(); fd.append('file', file, file.name); xhr.send(fd);
  });
}

function renderTray() {
  const t = $('#uploadTray');
  t.classList.toggle('hidden', !S.uploads.length);
  t.replaceChildren(...S.uploads.map(u => h('div', { class: 'upl' }, `Uploading ${u.name} — ${Math.round(u.pct * 100)}%`, h('div', { class: 'bar' }, h('i', { style: `width:${Math.round(u.pct * 100)}%` })))));
}

async function sendFiles(files, convId = S.active) {
  const c = S.convs[convId]; if (!c) return;
  if (!canSend(c)) return toast('You cannot send messages here');
  let caption = (convId === S.active && !S.editing) ? input.value.trim() : '';
  if (caption) { input.value = ''; autosize(); toggleSendMic(); }
  for (const file of files) {
    if (file.size > 25 * 1024 * 1024) { toast(`${file.name} is larger than 25 MB`); continue; }
    const up = { name: file.name, pct: 0 }; S.uploads.push(up); renderTray();
    try {
      const info = await uploadFile(file, p => { up.pct = p; renderTray(); });
      const replyTo = S.replyTo && convId === S.active ? S.replyTo.id : undefined;
      await req('msg:send', { convId, text: caption, file: info, replyTo });
      S.replyTo = null; renderReplyBar(); caption = '';
    } catch (e) { toast(`${file.name}: ${e.message}`); }
    S.uploads = S.uploads.filter(x => x !== up); renderTray();
  }
}

/* drag & drop */
let dragDepth = 0;
const hasFiles = e => [...((e.dataTransfer && e.dataTransfer.types) || [])].includes('Files');
const mainEl = $('#main');
mainEl.addEventListener('dragenter', e => { if (!conv() || !hasFiles(e)) return; e.preventDefault(); dragDepth++; $('#dropOverlay').classList.remove('hidden'); });
mainEl.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
mainEl.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#dropOverlay').classList.add('hidden'); });
mainEl.addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; $('#dropOverlay').classList.add('hidden');
  if (conv()) sendFiles([...e.dataTransfer.files]);
});
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => e.preventDefault());

/* ============================================================ voice messages */
async function startRecording() {
  if (S.recording || !conv()) return;
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { return toast('Microphone permission denied or not available'); }
  const rec = new MediaRecorder(stream), chunks = [];
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  const r = S.recording = { rec, stream, chunks, start: Date.now(), convId: S.active, timer: null };
  rec.start();
  $('#composer').classList.add('hidden');
  const bar = $('#recordBar'); bar.classList.remove('hidden');
  const t = h('span', { class: 'rec' }, '0:00');
  bar.replaceChildren(h('button', { class: 'icon', title: 'Cancel', 'aria-label': 'Cancel recording', onclick: () => stopRecording(false) }, icon('trash', 18)), t, h('div', { class: 'grow sub' }, 'Recording voice message'),
    h('button', { class: 'icon send', title: 'Send', 'aria-label': 'Send voice message', onclick: () => stopRecording(true) }, icon('send', 18)));
  r.timer = setInterval(() => { const s = Math.floor((Date.now() - r.start) / 1000); t.textContent = Math.floor(s / 60) + ':' + pad(s % 60); }, 300);
}
function stopRecording(send) {
  const r = S.recording; if (!r) return;
  S.recording = null; clearInterval(r.timer);
  r.rec.onstop = async () => {
    r.stream.getTracks().forEach(t => t.stop());
    if (send && Date.now() - r.start > 800) {
      const type = (r.rec.mimeType || 'audio/webm').split(';')[0];
      const file = new File([new Blob(r.chunks, { type })], `voice-${Date.now()}.${type.includes('ogg') ? 'ogg' : 'webm'}`, { type });
      await sendFiles([file], r.convId);
    }
  };
  try { r.rec.stop(); } catch (_) {}
  $('#recordBar').classList.add('hidden');
  renderComposerState();
}
$('#btnMic').onclick = startRecording;

/* ============================================================ side panel: search */
function closeSide() { S.side = null; $('#sidepanel').classList.add('hidden'); $('#sidepanel').replaceChildren(); }
function openSide(title, body) {
  const p = $('#sidepanel'); p.classList.remove('hidden');
  p.replaceChildren(h('div', { class: 'sp-head' }, h('button', { class: 'icon', 'aria-label': 'Close', onclick: closeSide }, icon('close', 18)), title), h('div', { class: 'sp-body' }, body));
}

function openSearch() {
  const c = conv(); if (!c) return;
  if (S.side === 'search') return closeSide();
  S.side = 'search';
  const qIn = h('input', { placeholder: 'Search messages…' });
  const scope = h('select', {}, h('option', { value: 'this' }, 'This chat'), h('option', { value: 'all' }, 'All chats'));
  const sender = h('select', {}, h('option', { value: '' }, 'Anyone'), c.members.map(m => h('option', { value: m.id }, user(m.id).displayName)));
  const type = h('select', {}, [['', 'Any type'], ['text', 'Text'], ['image', 'Photos'], ['video', 'Videos'], ['audio', 'Audio / voice'], ['document', 'Documents'], ['poll', 'Polls']].map(([v, l]) => h('option', { value: v }, l)));
  const from = h('input', { type: 'date' }), to = h('input', { type: 'date' });
  const results = h('div', { style: 'display:flex;flex-direction:column;gap:8px' }, h('div', { class: 'sub' }, 'Type to search, or use filters.'));
  const run = debounce(async () => {
    const f = { q: qIn.value.trim(), convId: scope.value === 'this' ? c.id : undefined, sender: +sender.value || undefined, type: type.value || undefined,
      from: from.value ? new Date(from.value + 'T00:00:00').getTime() : undefined, to: to.value ? new Date(to.value + 'T23:59:59').getTime() : undefined };
    if (!f.q && !f.sender && !f.type && !f.from && !f.to) return results.replaceChildren(h('div', { class: 'sub' }, 'Type to search, or use filters.'));
    const r = await req('search', f, true);
    if (!r.ok) return;
    results.replaceChildren(...(r.results.length ? r.results.map(m => h('div', { class: 'result', onclick: () => jumpTo(m.convId, m.id) },
      h('div', { class: 'r-top' }, h('span', {}, (m.senderName || '') + (scope.value === 'all' && S.convs[m.convId] ? ' · ' + nameOf(S.convs[m.convId]) : '')), h('span', {}, new Date(m.createdAt).toLocaleDateString() + ' ' + fmtTime(m.createdAt))),
      h('div', { class: 'r-text' }, previewText(m)))) : [h('div', { class: 'sub' }, 'No messages found')]));
  }, 300);
  [qIn, scope, sender, type, from, to].forEach(el => { el.addEventListener('input', run); el.addEventListener('change', run); });
  openSide('Search messages', [qIn, h('label', {}, 'Where', scope), h('label', {}, 'Sender', sender), h('label', {}, 'Type', type),
    h('div', { style: 'display:flex;gap:8px' }, h('label', { style: 'flex:1' }, 'From', from), h('label', { style: 'flex:1' }, 'To', to)), results]);
  qIn.focus();
}

/* ============================================================ people picker + modals */
function userPicker(excludeIds = []) {
  const selected = new Map();
  const chips = h('div', { class: 'chips-sel' });
  const list = h('div');
  const q = h('input', { placeholder: 'Search people by name or username' });
  const drawChips = () => chips.replaceChildren(...[...selected.values()].map(u => h('span', { class: 'sel', title: 'Remove', onclick: () => { selected.delete(u.id); drawChips(); } }, u.displayName, icon('close', 12))));
  const load = debounce(async () => {
    const r = await req('users:search', { q: q.value.trim() }, true);
    if (!r.ok) return;
    const users = r.users.filter(u => !excludeIds.includes(u.id));
    users.forEach(mergeUser);
    list.replaceChildren(...(users.length ? users.map(u => h('div', { class: 'person pick', onclick: () => { selected.set(u.id, u); drawChips(); } },
      avatarEl(u.displayName, u.avatar, 36), h('div', { class: 'grow' }, h('div', { class: 'name' }, u.displayName), h('div', { class: 'sub' }, '@' + u.username)))) : [h('div', { class: 'sub' }, 'No users found')]));
  }, 250);
  q.addEventListener('input', load); load();
  return { el: h('div', { style: 'display:flex;flex-direction:column;gap:8px' }, chips, q, list), selected };
}

async function ensureConv(id) { for (let i = 0; i < 40 && !S.convs[id]; i++) await new Promise(r => setTimeout(r, 50)); }

function newChatModal() {
  const q = h('input', { placeholder: 'Search people by name or username' }), list = h('div');
  const m = modal('New chat', [
    h('div', { class: 'person pick', role: 'button', tabindex: 0, onclick: () => { m.close(); groupModal('group'); } }, h('div', { class: 'avatar sq', style: 'width:40px;height:40px;background:var(--raised);color:var(--text)' }, icon('users', 18)), h('div', { class: 'name' }, 'New group')),
    h('div', { class: 'person pick', role: 'button', tabindex: 0, onclick: () => { m.close(); groupModal('channel'); } }, h('div', { class: 'avatar sq', style: 'width:40px;height:40px;background:var(--raised);color:var(--text)' }, icon('megaphone', 18)), h('div', { class: 'name' }, 'New channel')),
    q, list]);
  const load = debounce(async () => {
    const r = await req('users:search', { q: q.value.trim() }, true); if (!r.ok) return;
    r.users.forEach(mergeUser);
    list.replaceChildren(...(r.users.length ? r.users.map(u => h('div', { class: 'person pick', onclick: async () => {
      const d = await req('dm:open', { userId: u.id }); if (!d.ok) return;
      m.close(); await ensureConv(d.convId); openConv(d.convId);
    } }, avatarEl(u.displayName, u.avatar, 40, u.online), h('div', { class: 'grow' }, h('div', { class: 'name' }, u.displayName), h('div', { class: 'sub' }, '@' + u.username + ' · ' + (u.status || '')))))
      : [h('div', { class: 'sub' }, 'No users found. Ask your friend to sign up first.')]));
  }, 250);
  q.addEventListener('input', load); load(); q.focus();
}

function groupModal(type) {
  const name = h('input', { placeholder: type === 'channel' ? 'Channel name' : 'Group name', maxLength: 50 });
  const desc = h('input', { placeholder: 'Description (optional)', maxLength: 300 });
  const pub = h('input', { type: 'checkbox' });
  const picker = userPicker();
  const m = modal(type === 'channel' ? 'New channel' : 'New group', [
    h('label', {}, 'Name', name), h('label', {}, 'Description', desc),
    type === 'channel' ? h('label', { class: 'row chk' }, pub, 'Public channel (anyone can find and join it)') : null,
    type === 'channel' ? h('div', { class: 'sub' }, 'Channels are one-to-many: only admins can post, subscribers can read and react.') : null,
    h('div', { class: 'sub' }, 'Add people'), picker.el
  ], { actions: [h('button', { class: 'primary', onclick: async () => {
    const r = await req('group:create', { name: name.value, description: desc.value, type, isPublic: pub.checked, memberIds: [...picker.selected.keys()] });
    if (r.ok) { m.close(); await ensureConv(r.convId); openConv(r.convId); }
  } }, 'Create')] });
  name.focus();
}

function browseChannels() {
  const list = h('div', {}, h('div', { class: 'sub' }, 'Loading…'));
  modal('Public channels', list);
  req('channels:list', {}).then(r => {
    if (!r.ok) return;
    list.replaceChildren(...(r.channels.length ? r.channels.map(ch => h('div', { class: 'person' }, avatarEl(ch.name, ch.avatar, 40, false, true),
      h('div', { class: 'grow' }, h('div', { class: 'name' }, ch.name), h('div', { class: 'sub' }, ch.members + ' subscribers' + (ch.description ? ' · ' + ch.description : ''))),
      ch.joined ? h('button', { class: 'mini', onclick: () => { modals.forEach(x => x.close()); openConv(ch.id); } }, 'Open') :
        h('button', { class: 'primary', onclick: async e => { const j = await req('channel:join', { convId: ch.id }); if (j.ok) { modals.forEach(x => x.close()); await ensureConv(ch.id); openConv(ch.id); } } }, 'Join'))) : [h('div', { class: 'sub' }, 'No public channels yet.')]));
  });
}

async function joinByLink(text) {
  const code = String(text || '').trim().match(/([a-f0-9]{8,})\/?$/i);
  if (!code) return toast('That does not look like an invite link');
  const r = await req('group:join', { code: code[1] });
  if (r.ok) { modals.forEach(x => x.close()); await ensureConv(r.convId); openConv(r.convId); toast('Joined!'); }
}
function joinModal() {
  const inp = h('input', { placeholder: 'https://your-server/join/abc123  or  abc123' });
  const m = modal('Join via invite link', [h('div', { class: 'sub' }, 'Paste an invite link or code.'), inp], { actions: [h('button', { class: 'primary', onclick: () => joinByLink(inp.value) }, 'Join')] });
  inp.focus();
}

function downloadsModal() {
  const hist = JSON.parse(localStorage.getItem('downloads') || '[]');
  const body = h('div', {}, hist.length ? hist.map(d => h('div', { class: 'person' }, h('div', { class: 'ico-t' }, fileIcon(d.name)),
    h('div', { class: 'grow' }, h('div', { class: 'name' }, d.name), h('div', { class: 'sub' }, fmtSize(d.size) + ' · ' + new Date(d.time).toLocaleString())),
    h('button', { class: 'mini', onclick: () => downloadFile(d) }, 'Download again'))) : h('div', { class: 'sub' }, 'No downloads yet.'));
  modal('Download history', body, { actions: hist.length ? [h('button', { class: 'secondary', onclick: () => { localStorage.removeItem('downloads'); m.close(); } }, 'Clear history')] : null });
  var m = modals[modals.length - 1];
}

function pickImage(cb) {
  const f = h('input', { type: 'file', accept: 'image/*' });
  f.addEventListener('change', async () => {
    if (!f.files[0]) return;
    try { toast('Uploading…'); const info = await uploadFile(f.files[0]); cb(info.url); } catch (e) { toast(e.message); }
  });
  f.click();
}

function profileModal() {
  const u = S.me;
  let avatar = u.avatar;
  const avBox = h('div', { class: 'clickable', title: 'Change photo', style: 'align-self:center' });
  const drawAv = () => avBox.replaceChildren(avatarEl(u.displayName, avatar, 96));
  drawAv();
  avBox.onclick = () => pickImage(url => { avatar = url; drawAv(); });
  const nm = h('input', { value: u.displayName, maxLength: 30 });
  const st = h('input', { value: u.status || '', maxLength: 80 });
  const m = modal('Profile', [avBox, h('div', { class: 'sub', style: 'text-align:center' }, '@' + u.username + ' · click the photo to change it'),
    h('label', {}, 'Name', nm), h('label', {}, 'Status', st),
    h('div', { class: 'chips-sel' }, STATUS_PRESETS.map(p => h('span', { class: 'preset', onclick: () => { st.value = p; } }, p)))],
    { actions: [h('button', { class: 'primary', onclick: async () => {
      const r = await req('profile:update', { displayName: nm.value, status: st.value, avatar: avatar || '' });
      if (r.ok) { m.close(); toast('Profile updated'); }
    } }, 'Save')] });
}

function settingsModal() {
  const theme = h('select', {}, [['system', 'System default'], ['dark', 'Dark'], ['light', 'Light']].map(([v, l]) => h('option', { value: v, selected: (localStorage.getItem('theme') || 'dark') === v }, l)));
  theme.onchange = () => { localStorage.setItem('theme', theme.value); applyTheme(); };
  const nt = h('input', { type: 'checkbox', checked: localStorage.getItem('notify') !== 'off' });
  nt.onchange = () => localStorage.setItem('notify', nt.checked ? 'on' : 'off');
  modal('Settings', [h('label', {}, 'Theme', theme), h('label', { class: 'row chk' }, nt, 'Desktop notifications'),
    h('div', { class: 'sub' }, 'Server: ' + S.server)]);
}

function pollModal() {
  const c = conv(); if (!c) return;
  const q = h('input', { placeholder: 'Ask a question', maxLength: 300 });
  const opts = h('div', { style: 'display:flex;flex-direction:column;gap:8px' });
  const addOpt = () => { if (opts.children.length < 10) opts.append(h('input', { placeholder: 'Option ' + (opts.children.length + 1), maxLength: 100 })); };
  addOpt(); addOpt();
  const multi = h('input', { type: 'checkbox' });
  const m = modal('Create poll', [h('label', {}, 'Question', q), h('label', {}, 'Options', opts), h('button', { class: 'mini', style: 'align-self:flex-start', onclick: addOpt }, '+ Add option'),
    h('label', { class: 'row chk' }, multi, 'Allow multiple answers')],
    { actions: [h('button', { class: 'primary', onclick: async () => {
      const r = await req('poll:create', { convId: c.id, question: q.value, options: [...opts.children].map(i => i.value), multiple: multi.checked });
      if (r.ok) m.close();
    } }, 'Send poll')] });
  q.focus();
}

/* ============================================================ chat / group info */
function infoModal() {
  const c0 = conv(); if (!c0) return;
  const cid = c0.id, body = h('div', { style: 'display:flex;flex-direction:column;gap:14px' });
  const m = modal(c0.type === 'direct' ? 'Contact info' : c0.type === 'channel' ? 'Channel info' : 'Group info', body, { wide: true, onClose: () => { S.infoRefresh = null; } });
  const draw = () => { const c = S.convs[cid]; if (!c) return m.close(); body.replaceChildren(...buildInfo(c)); };
  S.infoRefresh = { id: cid, fn: draw, close: m.close };
  draw();
}

function buildInfo(c) {
  const out = [];
  const admin = isAdmin(c), owner = c.role === 'owner';
  const muteRow = h('label', { class: 'row chk' }, h('input', { type: 'checkbox', checked: c.muted, onchange: e => req('mute', { convId: c.id, muted: e.target.checked }) }), 'Mute notifications');

  if (c.type === 'direct') {
    const u = user(c.otherId);
    out.push(h('div', { style: 'display:flex;flex-direction:column;align-items:center;gap:6px' }, avatarEl(u.displayName, u.avatar, 96, u.online),
      h('div', { style: 'font-size:20px;font-weight:600' }, u.displayName), h('div', { class: 'sub' }, '@' + u.username),
      h('div', {}, u.status || ''), h('div', { class: 'sub' }, u.online ? 'online' : lastSeenText(u.lastSeen))), muteRow);
    return out;
  }

  const avBox = h('div', { class: admin ? 'clickable' : '', title: admin ? 'Change picture' : '' }, avatarEl(c.name, c.avatar, 84, false, true));
  if (admin) avBox.onclick = () => pickImage(url => req('group:update', { convId: c.id, avatar: url }));
  if (admin) {
    const nm = h('input', { value: c.name, maxLength: 50 });
    const ds = h('textarea', { rows: 2, maxLength: 300, placeholder: 'Description' }); ds.value = c.description || '';
    out.push(h('div', { style: 'display:flex;gap:14px;align-items:flex-start' }, avBox,
      h('div', { style: 'flex:1;display:flex;flex-direction:column;gap:8px' }, nm, ds,
        h('button', { class: 'primary', style: 'align-self:flex-start', onclick: async () => { const r = await req('group:update', { convId: c.id, name: nm.value, description: ds.value }); if (r.ok) toast('Saved'); } }, 'Save'))));
  } else {
    out.push(h('div', { style: 'display:flex;gap:14px;align-items:center' }, avBox, h('div', {}, h('div', { style: 'font-size:20px;font-weight:600' }, nameOf(c)), h('div', { class: 'sub' }, c.description || ''))));
  }
  out.push(muteRow);
  if (admin && c.type === 'group') out.push(h('label', { class: 'row chk' }, h('input', { type: 'checkbox', checked: c.onlyAdminsSend, onchange: e => req('group:update', { convId: c.id, onlyAdminsSend: e.target.checked }) }), 'Only admins can send messages'));

  if (admin) {
    const link = c.inviteCode ? S.server + '/join/' + c.inviteCode : null;
    out.push(h('div', { style: 'display:flex;flex-direction:column;gap:6px' }, h('div', { class: 'sub' }, 'Invite link'),
      link ? h('div', { class: 'row' }, h('input', { value: link, readOnly: true, style: 'flex:1' }),
        h('button', { class: 'mini', onclick: () => navigator.clipboard.writeText(link).then(() => toast('Link copied')).catch(() => toast(link)) }, 'Copy'),
        h('button', { class: 'mini danger', onclick: () => req('group:invite', { convId: c.id, action: 'revoke' }) }, 'Revoke'))
        : h('button', { class: 'secondary', style: 'align-self:flex-start', onclick: () => req('group:invite', { convId: c.id, action: 'create' }) }, 'Create invite link')));
  }

  out.push(h('div', { class: 'row between' }, h('div', { class: 'sub' }, (c.type === 'channel' ? 'Subscribers' : 'Members') + ' · ' + c.members.length),
    admin ? h('button', { class: 'mini', onclick: () => addMembersModal(c) }, '+ Add') : null));
  out.push(h('div', {}, c.members.map(mem => {
    const u = user(mem.id), self = isMe(mem.id);
    return h('div', { class: 'person' }, avatarEl(u.displayName, u.avatar, 38, u.online),
      h('div', { class: 'grow' }, h('div', { class: 'name' }, u.displayName + (self ? ' (You)' : '')), h('div', { class: 'sub' }, u.status || '')),
      mem.role !== 'member' ? h('span', { class: 'tag' }, mem.role) : null,
      owner && !self && mem.role !== 'owner' ? h('button', { class: 'mini', onclick: () => req('group:setRole', { convId: c.id, userId: mem.id, role: mem.role === 'admin' ? 'member' : 'admin' }) }, mem.role === 'admin' ? 'Dismiss admin' : 'Make admin') : null,
      admin && !self && mem.role !== 'owner' && (owner || mem.role === 'member') ? h('button', { class: 'mini danger', onclick: async () => { if (await confirmBox(`Remove ${u.displayName}?`, 'Remove', true)) req('group:removeMember', { convId: c.id, userId: mem.id }); } }, 'Remove') : null);
  })));

  out.push(h('div', { class: 'row', style: 'justify-content:space-between' },
    h('button', { class: 'secondary danger', onclick: async () => { if (await confirmBox(`Leave “${c.name}”?`, 'Leave', true)) { const r = await req('group:leave', { convId: c.id }); if (r.ok) S.infoRefresh && S.infoRefresh.close(); } } }, 'Leave'),
    owner ? h('button', { class: 'secondary danger', onclick: async () => { if (await confirmBox(`Delete “${c.name}” for everyone? This cannot be undone.`, 'Delete', true)) { const r = await req('group:delete', { convId: c.id }); if (r.ok) S.infoRefresh && S.infoRefresh.close(); } } }, 'Delete') : null));
  return out;
}

function addMembersModal(c) {
  const picker = userPicker(c.members.map(m => m.id));
  const m = modal('Add members', picker.el, { actions: [h('button', { class: 'primary', onclick: async () => {
    const r = await req('group:addMembers', { convId: c.id, userIds: [...picker.selected.keys()] }); if (r.ok) m.close();
  } }, 'Add')] });
}

/* ============================================================ menus + wiring */
$('#btnNewChat').onclick = newChatModal;
$('#meRow').onclick = profileModal;
$('#btnMenu').onclick = e => {
  const r = e.currentTarget.getBoundingClientRect();
  menuItems([
    { icon: 'users', label: 'New group', fn: () => groupModal('group') }, { icon: 'megaphone', label: 'New channel', fn: () => groupModal('channel') },
    { icon: 'search', label: 'Browse channels', fn: browseChannels }, { icon: 'link', label: 'Join via link', fn: joinModal },
    { icon: 'download', label: 'Download history', fn: downloadsModal }, { icon: 'user', label: 'Profile', fn: profileModal }, { icon: 'settings', label: 'Settings', fn: settingsModal },
    { icon: 'logout', label: 'Log out', danger: true, fn: logout }
  ], r.left - 150, r.bottom + 4);
};
$('#headInfo').onclick = infoModal;
$('#headInfo').onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); infoModal(); } };
$('#btnBack').onclick = closeChat;
document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if (S.me) { if (S.active) closeChat(); $('#listSearch').focus(); } } });
$('#server').addEventListener('input', () => { $('#serverLabel').textContent = $('#server').value; });
$('#btnInfo').onclick = infoModal;
$('#btnSearch').onclick = openSearch;
$('#btnAudio').onclick = () => { const c = conv(); if (c && c.type === 'direct') Calls.start(c.otherId, false); };
$('#btnVideo').onclick = () => { const c = conv(); if (c && c.type === 'direct') Calls.start(c.otherId, true); };
$('#lightbox').onclick = () => $('#lightbox').classList.add('hidden');
window.addEventListener('beforeunload', saveDraftNow);

(async function init() {
  applyTheme();
  $('#server').value = localStorage.getItem('server') || DEFAULT_SERVER;
  $('#serverLabel').textContent = $('#server').value;
  const token = localStorage.getItem('token');
  if (token) {
    $('#splashText').textContent = 'Connecting… (can take up to a minute if the server is asleep)';
    try { if (await start(normalizeUrl($('#server').value), token)) return; } catch (e) { console.error(e); S.lastError = 'Could not load your chats'; }
    $('#authErr').textContent = S.lastError || '';
  }
  showAuth();
})();
