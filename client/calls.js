'use strict';
// 1-to-1 audio / video calls over WebRTC. The server only relays signalling messages.
const Calls = (() => {
  const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };
  let pc = null, local = null, peerId = null, isCaller = false, withVideo = false;
  let pendingIce = [], ringModal = null, timer = null, startedAt = 0, active = false;
  const chat = () => window.chat;

  let hasLocalVideo = false;

  function mediaError(e) {
    const n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') return 'Permission denied. Windows: Settings > Privacy & security > Camera / Microphone > allow desktop apps.';
    if (n === 'NotReadableError' || n === 'AbortError') return 'Camera/microphone is already in use by another app (or another Chattrix window on this PC).';
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'No microphone/camera found.';
    return 'Could not access microphone/camera.';
  }

  // Tries audio+video; if the camera is busy/missing it falls back to audio-only instead of failing the call.
  async function media(wantVideo) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw Object.assign(new Error('unsupported'), { name: 'NotFoundError' });
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: wantVideo ? { width: 640, height: 480 } : false });
      hasLocalVideo = !!wantVideo;
      return s;
    } catch (e) {
      if (wantVideo && ['NotReadableError', 'AbortError', 'NotFoundError', 'OverconstrainedError'].includes(e.name)) {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); // throws if the mic fails too
        hasLocalVideo = false;
        toast('Camera is busy or missing - continuing with audio only', 4500);
        return s;
      }
      throw e;
    }
  }
  const peer = () => (typeof S !== 'undefined' && S.users[peerId]) || { displayName: 'User', avatar: null };

  function showUI(status) {
    const u = peer();
    $('#callUI').classList.remove('hidden');
    $('#callName').textContent = u.displayName;
    $('#callStatus').textContent = status;
    const av = $('#callAvatar'); av.replaceChildren(avatarEl(u.displayName, u.avatar, 96));
    $('#localVideo').classList.toggle('hidden', !hasLocalVideo);
    $('#callCam').classList.toggle('hidden', !hasLocalVideo);
    $('#localVideo').srcObject = local;
    $('#callMute').classList.remove('off'); $('#callCam').classList.remove('off');
    $('#callMute').replaceChildren(icon('mic', 22)); $('#callCam').replaceChildren(icon('video', 22));
  }
  const setStatus = t => { $('#callStatus').textContent = t; };

  function cleanup() {
    clearInterval(timer); timer = null;
    if (ringModal) { const m = ringModal; ringModal = null; m.close(); }
    if (pc) { try { pc.close(); } catch (_) {} pc = null; }
    if (local) { local.getTracks().forEach(t => t.stop()); local = null; }
    $('#remoteVideo').srcObject = null; $('#localVideo').srcObject = null;
    $('#callUI').classList.add('hidden');
    pendingIce = []; peerId = null; isCaller = false; active = false;
  }

  function createPc() {
    pc = new RTCPeerConnection(ICE);
    local.getTracks().forEach(t => pc.addTrack(t, local));
    pc.onicecandidate = e => { if (e.candidate) chat().emit('call:signal', { to: peerId, data: { candidate: e.candidate } }); };
    pc.ontrack = e => { $('#remoteVideo').srcObject = e.streams[0]; };
    pc.onconnectionstatechange = () => {
      if (!pc) return;
      if (pc.connectionState === 'connected') {
        active = true; startedAt = Date.now(); clearInterval(timer);
        timer = setInterval(() => { const s = Math.floor((Date.now() - startedAt) / 1000); setStatus(pad(Math.floor(s / 60)) + ':' + pad(s % 60)); }, 500);
        if (!hasLocalVideo) $('#callCam').classList.add('hidden');
      } else if (['failed', 'closed'].includes(pc.connectionState)) { toast('Call disconnected'); end(false); }
    };
  }

  async function start(userId, video) {
    if (peerId) return toast('You are already in a call');
    try { local = await media(video); } catch (e) { return toast(mediaError(e), 6000); }
    peerId = userId; isCaller = true; withVideo = !!video;
    showUI('Calling…');
    chat().emit('call:invite', { to: userId, video: !!video });
  }

  function onIncoming({ from, video }) {
    if (peerId) { chat().emit('call:reject', { to: from.id, reason: 'Busy' }); return; }
    S.users[from.id] = { ...(S.users[from.id] || {}), ...from };
    peerId = from.id; withVideo = !!video; isCaller = false;
    ringModal = modal((video ? 'Video' : 'Voice') + ' call', h('div', { class: 'ring' },
      h('div', { style: 'display:flex;justify-content:center;margin-bottom:10px' }, avatarEl(from.displayName, from.avatar, 80)),
      h('div', { class: 'name' }, from.displayName + ' is calling…'),
      h('div', { class: 'row', style: 'display:flex;gap:12px;justify-content:center;margin-top:14px' },
        h('button', { class: 'secondary danger', onclick: () => { chat().emit('call:reject', { to: from.id, reason: 'Call declined' }); cleanup(); } }, 'Decline'),
        h('button', { class: 'primary', onclick: accept }, 'Accept'))),
      { onClose: () => { if (ringModal && !active && !local) { chat().emit('call:reject', { to: from.id, reason: 'Call declined' }); ringModal = null; peerId = null; } } });
  }

  async function accept() {
    const from = peerId;
    try { local = await media(withVideo); } catch (e) { toast(mediaError(e), 6000); chat().emit('call:reject', { to: from, reason: 'Could not access microphone' }); if (ringModal) { const m = ringModal; ringModal = null; m.close(); } peerId = null; return; }
    if (ringModal) { const m = ringModal; ringModal = null; m.close(); }
    showUI('Connecting…');
    createPc();
    chat().emit('call:accept', { to: from });
  }

  async function onAccepted({ from }) {
    if (!isCaller || from !== peerId || !local) return;
    setStatus('Connecting…');
    createPc();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    chat().emit('call:signal', { to: peerId, data: { sdp: pc.localDescription } });
  }

  async function onSignal({ from, data }) {
    if (from !== peerId || !pc) return;
    try {
      if (data.sdp) {
        await pc.setRemoteDescription(data.sdp);
        for (const c of pendingIce) await pc.addIceCandidate(c);
        pendingIce = [];
        if (data.sdp.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          chat().emit('call:signal', { to: peerId, data: { sdp: pc.localDescription } });
        }
      } else if (data.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(data.candidate); else pendingIce.push(data.candidate);
      }
    } catch (e) { console.error('signal error', e); }
  }

  function onEnded({ from, reason }) { if (from === peerId) { toast(reason || 'Call ended'); cleanup(); } }
  function end(notify = true) { if (notify && peerId) chat().emit('call:end', { to: peerId }); cleanup(); }

  $('#callEnd').addEventListener('click', () => end(true));
  $('#callMute').addEventListener('click', e => {
    const t = local && local.getAudioTracks()[0]; if (!t) return;
    t.enabled = !t.enabled; const b = e.currentTarget;
    b.classList.toggle('off', !t.enabled); b.replaceChildren(icon(t.enabled ? 'mic' : 'micOff', 22)); b.setAttribute('aria-label', t.enabled ? 'Mute microphone' : 'Unmute microphone');
  });
  $('#callCam').addEventListener('click', e => {
    const t = local && local.getVideoTracks()[0]; if (!t) return;
    t.enabled = !t.enabled; const b = e.currentTarget;
    b.classList.toggle('off', !t.enabled); b.replaceChildren(icon(t.enabled ? 'video' : 'videoOff', 22)); b.setAttribute('aria-label', t.enabled ? 'Turn camera off' : 'Turn camera on');
  });

  return { start, onIncoming, onAccepted, onSignal, onEnded, end };
})();
