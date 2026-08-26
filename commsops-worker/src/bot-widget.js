// Staff-gated web chat widget (S312). Served as ONE self-contained script from
// GET /web/widget.js?bot=<id> — no framework, no external assets, inline styles.
//
// ⚠️ THE GATE IS THE FIRST STATEMENT. Until Afshaan un-gates it, the widget renders
// NOTHING unless the URL carries ?lotchat=1 (which also sets the staff flag for later
// visits) or localStorage.lot_chat_staff === '1'. Going public = deleting the gate
// check — one line — nothing else changes.
function widgetJs(botId, workerBase) {
  const B = JSON.stringify(String(botId || ''));
  const W = JSON.stringify(String(workerBase || 'https://commsops.afshaan.workers.dev'));
  return `(function () {
  'use strict';
  var staff = false;
  try {
    if (/[?&]lotchat=1/.test(location.search)) { localStorage.setItem('lot_chat_staff', '1'); staff = true; }
    else staff = localStorage.getItem('lot_chat_staff') === '1';
  } catch (e) { staff = /[?&]lotchat=1/.test(location.search); }
  if (!staff) return;   // STAFF GATE (S312) — delete this line to go public

  var BOT = ${B}, BASE = ${W};
  var sessionId = null, status = 'active', lastAgentId = 0, pollTimer = null, busy = false;

  // ── DOM ──────────────────────────────────────────────────────────────────────
  var css = 'position:fixed;z-index:2147483000;';
  var btn = document.createElement('button');
  btn.setAttribute('aria-label', 'Chat with us');
  btn.style.cssText = css + 'right:18px;bottom:18px;width:54px;height:54px;border-radius:50%;border:none;cursor:pointer;background:#F2CD1A;box-shadow:0 4px 14px rgba(0,0,0,.25);font-size:24px;line-height:1;';
  btn.textContent = '\\uD83D\\uDCAC';
  var panel = document.createElement('div');
  panel.style.cssText = css + 'right:18px;bottom:84px;width:min(360px,calc(100vw - 36px));height:min(520px,calc(100vh - 120px));background:#fff;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.3);display:none;flex-direction:column;overflow:hidden;font-family:system-ui,-apple-system,sans-serif;';
  panel.innerHTML =
    '<div style="background:#111;color:#F2CD1A;padding:12px 14px;font-weight:700;font-size:15px;display:flex;justify-content:space-between;align-items:center;">' +
      '<span>Legend of Toys</span><button id="lotchat-x" aria-label="Close chat" style="background:none;border:none;color:#F2CD1A;font-size:18px;cursor:pointer;">\\u2715</button></div>' +
    '<div id="lotchat-msgs" style="flex:1;overflow-y:auto;padding:12px;background:#f7f7f7;"></div>' +
    '<form id="lotchat-form" style="display:flex;gap:6px;padding:10px;border-top:1px solid #e5e5e5;background:#fff;">' +
      '<input id="lotchat-inp" autocomplete="off" placeholder="Type a message\\u2026" style="flex:1;border:1px solid #ddd;border-radius:8px;padding:9px 11px;font-size:14px;outline:none;" />' +
      '<button type="submit" style="border:none;border-radius:8px;background:#F2CD1A;font-weight:700;padding:0 14px;cursor:pointer;">Send</button></form>';
  document.body.appendChild(btn);
  document.body.appendChild(panel);
  var msgs = panel.querySelector('#lotchat-msgs');
  var form = panel.querySelector('#lotchat-form');
  var inp = panel.querySelector('#lotchat-inp');

  function bubble(text, who, agentName) {
    var d = document.createElement('div');
    d.style.cssText = 'margin-bottom:8px;display:flex;justify-content:' + (who === 'you' ? 'flex-end' : 'flex-start') + ';';
    var b = document.createElement('div');
    b.style.cssText = 'max-width:85%;padding:8px 11px;border-radius:10px;font-size:14px;white-space:pre-wrap;word-break:break-word;' +
      (who === 'you' ? 'background:#F2CD1A;color:#111;' : 'background:#fff;border:1px solid #e2e2e2;color:#222;');
    if (agentName) { var n = document.createElement('div'); n.style.cssText = 'font-size:11px;font-weight:700;margin-bottom:2px;color:#666;'; n.textContent = agentName; b.appendChild(n); }
    var t = document.createElement('div'); t.textContent = text; b.appendChild(t);
    d.appendChild(b); msgs.appendChild(d); msgs.scrollTop = msgs.scrollHeight;
    return b;
  }

  function renderButtons(buttons) {
    var wrap = document.createElement('div');
    wrap.style.cssText = 'margin:-2px 0 10px;display:flex;flex-wrap:wrap;gap:6px;';
    buttons.forEach(function (bt) {
      var el = document.createElement('button');
      el.type = 'button'; el.textContent = bt.label;
      el.style.cssText = 'border:1.5px solid #111;background:#fff;color:#111;border-radius:16px;padding:6px 12px;font-size:13px;cursor:pointer;';   // explicit color: the storefront theme is white-on-dark and the chips inherited it (S312 smoke)
      el.onclick = function () { if (!busy) { disableChips(); send({ buttonId: bt.id, text: bt.label }); } };
      wrap.appendChild(el);
    });
    msgs.appendChild(wrap); msgs.scrollTop = msgs.scrollHeight;
  }
  function disableChips() {
    msgs.querySelectorAll('button').forEach(function (b) { b.disabled = true; b.style.opacity = '.5'; b.style.cursor = 'default'; });
  }

  function showReplies(replies) {
    (replies || []).forEach(function (r) {
      bubble(r.text, 'bot');
      if (r.buttons && r.buttons.length) renderButtons(r.buttons);
    });
  }

  function onStatus(s) {
    status = s;
    if (s === 'handed_off' && !pollTimer) pollTimer = setInterval(poll, 5000);
    if (s === 'ended') {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      inp.disabled = true; inp.placeholder = 'Chat over \\u2014 reopen to start again';
    }
  }

  function api(path, opts) {
    return fetch(BASE + path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts))
      .then(function (r) { return r.json(); });
  }

  function start() {
    api('/web/session', { method: 'POST', body: JSON.stringify({ botId: BOT }) }).then(function (d) {
      if (!d || d.ok === false) { bubble('Chat is unavailable right now \\u2014 please email support@legendoftoys.com.', 'bot'); return; }
      var dd = d.data || d;
      sessionId = dd.session_id; showReplies(dd.replies); onStatus(dd.status);
    }).catch(function () { bubble('Chat could not connect.', 'bot'); });
  }

  function send(payload) {
    if (!sessionId || busy) return;
    busy = true;
    if (payload.text) bubble(payload.text, 'you');
    api('/web/message', { method: 'POST', body: JSON.stringify(Object.assign({ session_id: sessionId }, payload)) })
      .then(function (d) {
        var dd = (d && (d.data || d)) || {};
        showReplies(dd.replies); if (dd.status) onStatus(dd.status);
      })
      .catch(function () { bubble('Message failed \\u2014 try again.', 'bot'); })
      .then(function () { busy = false; });
  }

  function poll() {
    if (!sessionId) return;
    api('/web/poll?session_id=' + encodeURIComponent(sessionId) + '&after=' + lastAgentId, { method: 'GET' })
      .then(function (d) {
        var dd = (d && (d.data || d)) || {};
        (dd.messages || []).forEach(function (m) { lastAgentId = Math.max(lastAgentId, m.id); bubble(m.text, 'bot', m.agent_name || 'LOT Support'); });
        if (dd.status) status = dd.status;
      }).catch(function () {});
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var t = inp.value.trim();
    if (t) { inp.value = ''; send({ text: t }); }
  });
  btn.addEventListener('click', function () {
    var open = panel.style.display === 'flex';
    panel.style.display = open ? 'none' : 'flex';
    if (!open && !sessionId) start();
    if (!open) inp.focus();
  });
  panel.querySelector('#lotchat-x').addEventListener('click', function () { panel.style.display = 'none'; });
})();`;
}

module.exports = { widgetJs };
