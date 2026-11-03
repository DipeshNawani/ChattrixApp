'use strict';
const $ = (sel, root = document) => root.querySelector(sel);

// tiny DOM builder: h('div', {class:'x', onclick: fn}, child, 'text', ...)
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function hueFor(s) { let x = 0; for (const c of String(s || '?')) x = (x * 31 + c.charCodeAt(0)) >>> 0; return x % 360; }
const initials = n => (String(n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('') || '?').toUpperCase();
const absUrl = u => (!u ? '' : /^https?:|^blob:|^data:/i.test(u) ? u : (window.__server || '') + u);

function avatarEl(name, url, size = 40, online = false, square = false) {
  const el = h('div', { class: 'avatar' + (square ? ' sq' : '') });
  el.style.width = el.style.height = size + 'px';
  el.style.fontSize = Math.round(size * 0.4) + 'px';
  const fallback = () => { el.style.background = 'hsl(' + hueFor(name) + ' 26% 34%)'; el.textContent = initials(name); };
  if (url) {
    const img = h('img', { src: absUrl(url), alt: '' });
    img.addEventListener('error', () => { img.remove(); fallback(); });
    el.append(img);
  } else fallback();
  if (online) el.append(h('span', { class: 'dot-online' }));
  return el;
}

const pad = n => String(n).padStart(2, '0');
const fmtTime = ts => { const d = new Date(ts); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
function dayLabel(ts) {
  const now = Date.now();
  if (sameDay(ts, now)) return 'Today';
  if (sameDay(ts, now - 864e5)) return 'Yesterday';
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
function listTime(ts) {
  if (!ts) return '';
  if (sameDay(ts, Date.now())) return fmtTime(ts);
  if (sameDay(ts, Date.now() - 864e5)) return 'Yesterday';
  return new Date(ts).toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: '2-digit' });
}
function lastSeenText(ts) {
  if (!ts) return 'offline';
  if (sameDay(ts, Date.now())) return 'last seen today at ' + fmtTime(ts);
  if (sameDay(ts, Date.now() - 864e5)) return 'last seen yesterday at ' + fmtTime(ts);
  return 'last seen ' + new Date(ts).toLocaleDateString() + ' at ' + fmtTime(ts);
}
function fmtSize(b) {
  if (!b && b !== 0) return '';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}
function fileKind(mime, name) {
  mime = mime || '';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/') && !/^voice-/.test(name || '')) return 'video';
  if (mime.startsWith('audio/') || /^voice-.*\.webm$/.test(name || '')) return 'audio';
  return 'doc';
}
function fileIcon(name) { // short type label, e.g. PDF, DOCX
  const e = (String(name || '').split('.').pop() || '').toUpperCase();
  return e && e.length <= 4 && e !== String(name || '').toUpperCase() ? e : 'FILE';
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

const EMOJIS = '😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 😉 😍 🥰 😘 😋 😎 🤩 🥳 😏 😒 😞 😔 😢 😭 😤 😡 🤯 😱 🤔 🤗 🙄 😴 🤒 🤝 👍 👎 👏 🙌 🙏 💪 👀 🔥 ✨ 🎉 ❤️ 💔 💯 ✅ ❌ ⭐ 🚀 💡 📌 📎 📷 🎵 ☕ 🍕 🎂'.split(' ');

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), ms);
}

/* modals & menus */
const modals = [];
function modal(title, body, { wide = false, actions = null, onClose = null } = {}) {
  const opener = document.activeElement;
  const close = () => { back.remove(); const i = modals.indexOf(api); if (i >= 0) modals.splice(i, 1); if (onClose) onClose(); if (opener && opener.focus && document.contains(opener)) opener.focus(); };
  const back = h('div', { class: 'modal-back', onmousedown: e => { if (e.target === back) close(); } },
    h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'modal-head' }, h('h3', {}, title), h('button', { class: 'icon', 'aria-label': 'Close', title: 'Close', onclick: close }, icon('close', 18))),
      h('div', { class: 'modal-body' }, body),
      actions ? h('div', { class: 'modal-actions' }, actions) : null));
  const api = { close, el: back };
  modals.push(api);
  document.body.append(back);
  const focusable = back.querySelector('.modal-body input, .modal-body textarea, .modal-body select, .modal-actions .primary') || back.querySelector('.modal-head .icon');
  if (focusable) focusable.focus();
  return api;
}
function confirmBox(text, okLabel = 'OK', danger = false) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); m.close(); } };
    const m = modal('Confirm', h('div', {}, text), {
      actions: [h('button', { class: 'secondary', onclick: () => finish(false) }, 'Cancel'), h('button', { class: 'primary' + (danger ? ' danger' : ''), onclick: () => finish(true) }, okLabel)],
      onClose: () => { if (!done) { done = true; resolve(false); } }
    });
  });
}
let openMenu = null;
function closeMenu() { if (openMenu) { openMenu.remove(); openMenu = null; } }
function popup(node, x, y) {
  closeMenu();
  const m = h('div', { class: 'menu' }, node);
  m.style.left = '0px'; m.style.top = '0px'; m.style.visibility = 'hidden';
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(6, Math.min(x, innerWidth - r.width - 6)) + 'px';
  m.style.top = Math.max(6, Math.min(y, innerHeight - r.height - 6)) + 'px';
  m.style.visibility = 'visible';
  openMenu = m;
  return m;
}
function menuItems(items, x, y) {
  const node = h('div', { role: 'menu' }, items.filter(Boolean).map(i => h('div', { class: 'item' + (i.danger ? ' danger' : ''), role: 'menuitem', tabindex: 0,
    onclick: () => { closeMenu(); i.fn(); }, onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); closeMenu(); i.fn(); } } },
    i.icon ? icon(i.icon, 16) : null, i.label)));
  const m = popup(node, x, y);
  const first = node.querySelector('.item'); if (first) first.focus();
  return m;
}
document.addEventListener('mousedown', e => { if (openMenu && !openMenu.contains(e.target) && !e.target.closest('[data-keepmenu]')) closeMenu(); });
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (openMenu) return closeMenu();
  if (modals.length) return modals[modals.length - 1].close();
  const lb = $('#lightbox'); if (lb && !lb.classList.contains('hidden')) lb.classList.add('hidden');
});
