// ===== オンライン対戦（PeerJSによるP2P通信。サーバー不要）=====
// ホストの端末がゲームを進行し、ゲストには画面の更新内容を送る。ゲストは「サイコロを振る」だけ送る。
const Net = {
  on: false, host: false, seat: 0, peer: null, conn: null, conns: [], lobby: [], started: false, over: false,
  bc(m) { if (this.host) this.conns.forEach(c => c.open && c.send(m)); },
  sync() { // ゲーム状態を全員に送る（写真は開始時に1回だけ送るので除く）
    if (!this.host || !this.started || !G) return;
    this.bc({ k: 'state', s: { t: G.t, round: G.round, turns: G.turns, stage: G.stage, order: G.order, quiz: G.quiz, hid: G.hid, fog: G.fog, ask: G.ask || null, global: G.global, rules: G.rules, busy: G.busy, over: G.over, ps: G.ps.map(p => ({ ...p, img: undefined })) } });
  }
};
let IMGS = [];

// 合言葉 → 部屋ID（日本語もOK。ハッシュ化してPeerJSのIDにする）
async function roomId(phrase) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('vrc-life:' + phrase));
  return 'vrclife-' + [...new Uint8Array(b)].slice(0, 10).map(x => x.toString(16).padStart(2, '0')).join('');
}
// 受信したプロフィールの検証（名前は8文字まで、写真はJPEGのdata URLのみ）
const cleanQs = a => (Array.isArray(a) ? a : []).slice(0, QMAX).map(q => {
  if (!q || typeof q.text !== 'string') return null; const text = q.text.trim().slice(0, 60); if (!text) return null;
  if (q.t === 'num') return typeof q.ans === 'number' && isFinite(q.ans) && Math.abs(q.ans) <= 1e9 ? { t: 'num', text, ans: q.ans } : null;
  if (q.t !== 'mc' || !Array.isArray(q.choices)) return null;
  const choices = q.choices.slice(0, 4).map(c => String(c).trim().slice(0, 24)); if (choices.length < 2 || choices.some(c => !c)) return null;
  return Number.isInteger(q.ans) && q.ans >= 0 && q.ans < choices.length ? { t: 'mc', text, choices, ans: q.ans } : null;
}).filter(Boolean);
const cleanProfile = (m, def) => ({
  qs: m.qs === undefined ? undefined : cleanQs(m.qs),
  name: String(m.name || def).slice(0, 8) || def,
  color: typeof m.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(m.color) ? m.color.toLowerCase() : null,
  img: typeof m.img === 'string' && m.img.length < 80000 && /^data:image\/jpeg;base64,[A-Za-z0-9+\/=]+$/.test(m.img) ? m.img : null
});
const pushLobby = () => Net.bc({ k: 'lobby', list: Net.lobby.map(p => ({ name: p.name, img: p.img, color: p.color, qn: (p.qs || []).length })) }); // 問題の中身（正解）は送らない

function hostRoom(phrase, me, ui) {
  roomId(phrase).then(id => {
    const peer = new Peer(id);
    Object.assign(Net, { peer, on: true, host: true, seat: 0, lobby: [cleanProfile(me, 'ホスト')], conns: [], started: false });
    peer.on('open', () => ui.update(Net.lobby));
    peer.on('error', e => ui.error(e.type === 'unavailable-id' ? 'その合言葉は使われています。別の合言葉にしてください' : '接続エラー: ' + e.type));
    peer.on('connection', c => {
      c.on('data', m => {
        if (m.k === 'join') {
          if (Net.started || Net.lobby.length >= 4) return c.send({ k: 'deny', why: Net.started ? 'すでに開始しています' : '満員です' });
          c.seat = Net.lobby.length; c.prof = cleanProfile(m, 'ゲスト'); c.prof.qs = c.prof.qs || []; Net.lobby.push(c.prof); Net.conns.push(c);
          c.send({ k: 'seat', seat: c.seat }); pushLobby(); ui.update(Net.lobby);
        } else if (m.k === 'profile' && c.seat) {
          const pf = cleanProfile(m, 'ゲスト'); pf.qs = pf.qs || (c.prof ? c.prof.qs : []) || []; c.prof = pf;
          if (Net.started) setProfile(c.seat, pf); else { Net.lobby[c.seat] = pf; pushLobby(); ui.update(Net.lobby); }
        } else if (m.k === 'ans' && Net.started) quizAnswer(c.seat, m.v);
        else if (m.k === 'back') { // 結果画面から「ルームに戻る」
          if (Net.started) c.back = true;
          else if (!Net.conns.includes(c) && Net.lobby.length < 4 && c.prof) {
            Net.pending = (Net.pending || []).filter(x => x !== c);
            c.seat = Net.lobby.length; Net.lobby.push(c.prof); Net.conns.push(c);
            c.send({ k: 'seat', seat: c.seat }); pushLobby(); ui.update(Net.lobby);
          }
        }
        else if (m.k === 'pick' && G.ask) submitAns(c.seat, m.v);
        else if (m.k === 'roll' && Net.started && G.t === c.seat) turn(m.i === undefined ? -1 : m.i);
      });
      c.on('close', () => {
        if (!c.seat) { Net.pending = (Net.pending || []).filter(x => x !== c); return; }
        if (Net.started) { // ゲーム中の退出：自動で進行
          G.ps[c.seat].auto = true; log(`${N(G.ps[c.seat])}が退出（自動で進行）`);
          if (G.t === c.seat && !G.busy) turn();
        } else { // 開始前の退出：席を詰める
          const i = Net.conns.indexOf(c); if (i < 0) return; Net.conns.splice(i, 1); Net.lobby.splice(i + 1, 1);
          Net.conns.forEach((x, j) => { x.seat = j + 1; x.open && x.send({ k: 'seat', seat: j + 1 }); });
          pushLobby(); ui.update(Net.lobby);
        }
      });
    });
  });
}

function startOnline() {
  const ps = Net.lobby.map((p, i) => ({ name: p.name, img: p.img, color: p.color || COLORS[i] }));
  const turns = clampTurns($('#tn').value), rules = readRules(), psq = ps.map((p, i) => ({ ...p, qs: Net.lobby[i].qs || [] }));
  Net.started = true; Net.conns.forEach(c => c.back = false); Net.bc({ k: 'start', ps, turns, rules });
  initUI(psq, turns, rules); afterStart();
}

function joinRoom(phrase, me, ui) {
  roomId(phrase).then(id => {
    const peer = new Peer();
    Object.assign(Net, { peer, on: true, host: false });
    peer.on('error', e => ui.error(e.type === 'peer-unavailable' ? 'ルームが見つかりません。合言葉を確認してください' : '接続エラー: ' + e.type));
    peer.on('open', () => {
      const c = Net.conn = peer.connect(id, { reliable: true });
      c.on('open', () => c.send({ k: 'join', name: me.name, img: me.img }));
      c.on('data', m => onGuestMsg(m, ui));
      c.on('close', () => { if (!Net.over) alert('ホストとの接続が切れました。ページを再読み込みしてください'); });
    });
  });
}

function onGuestMsg(m, ui) {
  switch (m.k) {
    case 'deny': ui.error(m.why); Net.peer.destroy(); break;
    case 'seat': Net.seat = m.seat; if (ui.seat) ui.seat(m.seat); break;
    case 'lobby': ui.update(m.list); break;
    case 'start': IMGS = m.ps.map(p => p.img); Net.over = false; initUI(m.ps, m.turns, m.rules); break;
    case 'prof': { const p = G.ps[m.i]; p.name = m.name; p.color = m.color; p.img = IMGS[m.i] = m.img; setPlayerStyles(); renderStat(); renderTokens(); break; }
    case 'state':
      const ch = G.stage !== m.s.stage;
      G.t = m.s.t; G.round = m.s.round; G.turns = m.s.turns; G.stage = m.s.stage; G.busy = m.s.busy; G.ask = m.s.ask; G.global = m.s.global; G.rules = m.s.rules; G.order = m.s.order; G.fog = m.s.fog; G.quiz = m.s.quiz;
      const hc = JSON.stringify(G.hid) !== JSON.stringify(m.s.hid); G.hid = m.s.hid; G.over = m.s.over;
      if (ch) renderBoard(); else if (hc) updateFog();
      G.ps = m.s.ps.map((p, i) => ({ ...p, img: IMGS[i] })); renderTokens(); renderStat(); break;
    case 'say': _say(m.v); break;
    case 'head': _head(m.v, m.ty); break;
    case 'fx': _sign(m.v); break;
    case 'hold': _hold(m.ms); break;
    case 'log': _log(m.v); break;
    case 'dice': $('#dice').textContent = m.v; break;
    case 'end': finish(); break;
  }
}

// ゲーム中のプロフィール変更（ホストが反映して全員に配信）
function setProfile(seat, pf) {
  const p = G.ps[seat]; p.name = pf.name; p.img = pf.img; p.color = pf.color || COLORS[seat]; pf.qs = (Net.lobby[seat] && Net.lobby[seat].qs) || []; Net.lobby[seat] = pf;
  setPlayerStyles(); Net.bc({ k: 'prof', i: seat, name: pf.name, img: pf.img, color: p.color });
  log(`${N(p)}が名前・写真を変更した`); renderStat(); renderTokens();
}
function applyProfile(pf) {
  if (Net.host) setProfile(Net.seat, pf); else Net.conn.send({ k: 'profile', ...pf });
}

// 結果画面から「ルームに戻る」。ホストが戻ると、戻ってきた人が同じルームに集まる
function backToRoom() {
  $('#result').close(); $('#game').hidden = true; $('#setup').hidden = false; if (document.body) document.body.classList.remove('playing');
  if (!Net.on) return; // 同じ端末プレイ：設定画面に戻る（名前・写真はそのまま）
  Net.over = false;
  if (Net.host) {
    const keep = Net.conns.filter(c => c.open && c.back), rest = Net.conns.filter(c => c.open && !c.back);
    rest.forEach(c => c.seat = 0); Net.pending = rest; Net.conns = keep; Net.started = false;
    Net.lobby = [Net.lobby[0]];
    keep.forEach((c, j) => { c.seat = j + 1; Net.lobby.push(c.prof); c.send({ k: 'seat', seat: c.seat }); });
    pushLobby(); Net.ui.update(Net.lobby);
  } else {
    Net.conn.send({ k: 'back' });
    $('#lob').innerHTML = '<p class="lead">ホストがルームに戻るのを待っています…</p>';
  }
}
window.VER_NET = '2026.10.23-a';
