'use strict';
/* 三國風雲　連線伺服器（Node.js，無外部套件）
 *
 * 遊戲引擎在伺服器執行；每位玩家的瀏覽器只會收到「自己眼中的局面」與自己的題目，
 * 因此他人的手牌不會傳到你的瀏覽器。
 *
 * 安全：本版本只供本機測試，只接受 127.0.0.1／::1／localhost。
 * 座位代碼（token）只用來把瀏覽器分頁對應到座位，不是登入驗證；
 * 要讓其他電腦的朋友加入，必須先部署到個人主機並接上正式的登入服務（見 README.md）。
 *
 * 執行：node server/server.js　（可用 SANGUO_PORT 改埠號，預設 8765）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const E = require('../engine.js');
const { makeForm } = require('./form.js');

const HOST = process.env.SANGUO_HOST || '127.0.0.1';
const PORT = +process.env.SANGUO_PORT || 8765;
const LOOPBACK = ['127.0.0.1', '::1', 'localhost'];
if (!LOOPBACK.includes(HOST)) {
  console.error(`拒絕在 ${HOST} 上啟動：本版本沒有登入驗證，只允許本機位址（127.0.0.1）。`);
  console.error('要開放給其他電腦，請先依 README.md 部署到個人主機並接上正式登入。');
  process.exit(1);
}

/* ---- 靜態檔案：只提供白名單內的檔案 ---- */
const ROOT = path.join(__dirname, '..');
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/engine.js': ['engine.js', 'text/javascript; charset=utf-8'],
  '/client.js': ['client.js', 'text/javascript; charset=utf-8'],
  '/cards.js': ['cards.js', 'text/javascript; charset=utf-8'],
  '/themes.js': ['themes.js', 'text/javascript; charset=utf-8'],
  '/texts.js': ['texts.js', 'text/javascript; charset=utf-8'],
};
// 每個主題的棋盤圖與卡圖檔（名單取自 themes.js，不提供名單以外的檔案）
for (const th of Object.values(E.THEMES)) {
  FILES['/' + th.board] = [th.board, 'image/svg+xml'];
  const art = `theme-${th.key}-art.js`;
  if (fs.existsSync(path.join(ROOT, art))) FILES['/' + art] = [art, 'text/javascript; charset=utf-8'];
}

/* ---- 大廳與連線 ---- */
const NSEATS = 4;
const lobby = { seats: Array.from({ length: NSEATS }, () => ({ state: 'open' })), host: null, speed: 450, theme: 'sanguo', started: false };
const clients = new Set(); // { res, token }
let game = null;           // { seatOf: 座位→引擎玩家 id, pending: Map, logs: [], over }

const seatByToken = t => t ? lobby.seats.findIndex(s => s.token === t) : -1;
const online = token => [...clients].some(c => c.token === token);
function send(c, msg) { c.res.write(`data: ${JSON.stringify(msg)}\n\n`); }
function lobbyFor(token) {
  const mySeat = seatByToken(token);
  return {
    type: 'lobby',
    lobby: { started: lobby.started, speed: lobby.speed, theme: lobby.theme,
      seats: lobby.seats.map(s => ({ state: s.state, cmd: s.cmd, mine: !!token && s.token === token, host: !!s.token && s.token === lobby.host, online: s.state !== 'human' || online(s.token) })) },
    you: { seat: mySeat >= 0 ? mySeat : null, host: !!token && token === lobby.host },
  };
}
const broadcastLobby = () => clients.forEach(c => send(c, lobbyFor(c.token)));
// 引擎玩家 id（只有已開局才有）
const pidOf = token => { const s = seatByToken(token); return game && s >= 0 ? game.seatOf[s] : undefined; };

/* ---- 連線版 UI 轉接器 ---- */
let renderQueued = false;
function sendViews() {
  renderQueued = false;
  if (!game) return;
  for (const c of clients) {
    const pid = pidOf(c.token);
    send(c, { type: 'view', view: E.viewFor(pid ?? 'all') });
  }
}
function pendingFor(pid) { return [...game.pending.values()].filter(q => q.pid === pid); }
function sendPending(c) {
  const pid = pidOf(c.token);
  if (pid == null) return;
  for (const q of pendingFor(pid)) send(c, q.msg);
}
const toSeat = (pid, msg) => clients.forEach(c => { if (pidOf(c.token) === pid) send(c, msg); });
const broadcast = msg => clients.forEach(c => send(c, msg));
const netUI = {
  sleep: ms => new Promise(r => setTimeout(r, ms)),
  // meta：電腦回合消息的停留時間（{ dur, wait }，毫秒），畫面據此逐條顯示
  log: (html, meta) => { game.logs.push(html); if (game.logs.length > 400) game.logs.shift(); broadcast({ type: 'log', html, meta }); },
  render: () => { if (!renderQueued) { renderQueued = true; setImmediate(sendViews); } },
  dice: r => broadcast({ type: 'dice', r }),
  flash: k => broadcast({ type: 'flash', k }),
  handoff: async () => {},
  ask: (p, title, body, buttons) => new Promise(resolve => {
    const id = crypto.randomUUID();
    const msg = { type: 'ask', id, title, body, buttons: buttons.map(b => ({ label: b.label, cls: b.cls, disabled: !!b.disabled })) };
    game.pending.set(id, { id, pid: p.id, msg, buttons, resolve });
    toSeat(p.id, msg);
  }),
  turn: (p, opts) => new Promise(resolve => {
    const id = crypto.randomUUID();
    const msg = { type: 'turn', id, opts };
    game.pending.set(id, { id, pid: p.id, msg, turn: true, resolve });
    toSeat(p.id, msg);
  }),
  gameOver: (w, html) => {
    game.over = { type: 'over', title: w ? '🏆 勝利' : '遊戲結束', html };
    netUI.render();
    setImmediate(() => broadcast(game.over));
  },
};

function startGame() {
  const seated = lobby.seats.map((s, k) => ({ s, k })).filter(x => x.s.state !== 'open');
  game = { seatOf: {}, pending: new Map(), logs: [], over: null };
  seated.forEach((x, pid) => { game.seatOf[x.k] = pid; });
  lobby.started = true;
  E.newGame(seated.map(x => ({ ai: x.s.state === 'ai', cmd: x.s.cmd })), { aiDelay: lobby.speed, ...E.PACE[lobby.speed], theme: lobby.theme }, netUI);
  broadcastLobby();
  sendViews();
  E.gameLoop().catch(err => { console.error('遊戲錯誤：', err); netUI.log('（伺服器錯誤，本局中止）'); });
}

/* ---- HTTP ---- */
function readJson(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', d => { n += d.length; if (n > 64 * 1024) { reject(new Error('too large')); req.destroy(); } else chunks.push(d); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
  });
}
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/events') {
    const token = url.searchParams.get('token') || '';
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const c = { res, token: seatByToken(token) >= 0 ? token : '' };
    clients.add(c);
    send(c, lobbyFor(c.token));
    if (game) {
      game.logs.forEach(html => send(c, { type: 'log', html }));
      send(c, { type: 'view', view: E.viewFor(pidOf(c.token) ?? 'all') });
      sendPending(c);
      if (game.over) send(c, game.over);
    }
    broadcastLobby();
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(c); broadcastLobby(); });
    return;
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method' });
  let body;
  try { body = await readJson(req); } catch { return json(res, 400, { error: '格式錯誤' }); }
  const token = typeof body.token === 'string' ? body.token : '';
  const seat = seatByToken(token);

  if (url.pathname === '/api/join') {
    const k = body.seat, cmd = body.cmd;
    if (lobby.started) return json(res, 409, { error: '遊戲已經開始' });
    if (seat >= 0) return json(res, 409, { error: '你已經有座位了' });
    if (!Number.isInteger(k) || !lobby.seats[k] || lobby.seats[k].state !== 'open') return json(res, 409, { error: '這個座位已有人' });
    if (!Number.isInteger(cmd) || cmd < 0 || cmd > 3 || lobby.seats.some(s => s.state !== 'open' && s.cmd === cmd)) return json(res, 409, { error: '這位主帥已被選走' });
    const t = crypto.randomBytes(16).toString('hex');
    lobby.seats[k] = { state: 'human', cmd, token: t };
    if (!lobby.host || seatByToken(lobby.host) < 0) lobby.host = t;
    broadcastLobby();
    return json(res, 200, { token: t });
  }

  if (url.pathname === '/api/lobby') {
    const isHost = !!token && token === lobby.host && seat >= 0;
    const op = body.op;
    if (op === 'reset') {
      // 遊戲結束後任何已入座的玩家都可回到大廳（避免房主離開後卡住）
      if (seat < 0 || !(game && game.over)) return json(res, 403, { error: '遊戲結束後才能開新局' });
      game = null; lobby.started = false;
      broadcast({ type: 'reset' }); broadcastLobby();
      return json(res, 200, { ok: true });
    }
    if (lobby.started) return json(res, 409, { error: '遊戲已經開始' });
    const k = body.seat;
    if (op === 'open') {
      if (!lobby.seats[k]) return json(res, 400, { error: '座位錯誤' });
      const s = lobby.seats[k];
      if (!(s.token && s.token === token) && !(isHost && s.state === 'ai')) return json(res, 403, { error: '無權變更此座位' });
      lobby.seats[k] = { state: 'open' };
      if (s.token && s.token === lobby.host) { const h = lobby.seats.find(x => x.state === 'human'); lobby.host = h ? h.token : null; }
    } else if (op === 'ai') {
      if (!isHost) return json(res, 403, { error: '只有房主可設定電腦' });
      const cmd = body.cmd;
      if (!lobby.seats[k] || lobby.seats[k].state !== 'open') return json(res, 409, { error: '座位不是空的' });
      if (!Number.isInteger(cmd) || cmd < 0 || cmd > 3 || lobby.seats.some(s => s.state !== 'open' && s.cmd === cmd)) return json(res, 409, { error: '沒有可用的主帥' });
      lobby.seats[k] = { state: 'ai', cmd };
    } else if (op === 'theme') {
      if (!isHost) return json(res, 403, { error: '只有房主可選擇主題' });
      if (!Object.hasOwn(E.THEMES, body.theme)) return json(res, 400, { error: '未知的主題' });
      lobby.theme = body.theme;
    } else if (op === 'start') {
      if (!isHost) return json(res, 403, { error: '只有房主可開始遊戲' });
      if (lobby.seats.filter(s => s.state !== 'open').length < 2) return json(res, 409, { error: '至少需要 2 位' });
      lobby.speed = [120, 450, 900].includes(+body.speed) ? +body.speed : 450;
      if (Object.hasOwn(E.THEMES, body.theme)) lobby.theme = body.theme;
      startGame();
      return json(res, 200, { ok: true });
    } else return json(res, 400, { error: '未知的操作' });
    broadcastLobby();
    return json(res, 200, { ok: true });
  }

  if (url.pathname === '/api/answer') {
    const pid = pidOf(token);
    const q = game && game.pending.get(body.id);
    if (pid == null || !q || q.pid !== pid) return json(res, 403, { error: '這題不是給你的' });
    if (q.turn) {
      if (!['roll', 'reserve', 'sell', 'hand'].includes(body.btn)) return json(res, 400, { error: '未知的動作' });
      game.pending.delete(q.id); q.resolve(body.btn);
      return json(res, 200, { ok: true });
    }
    const b = q.buttons[body.btn];
    if (!b || b.disabled) return json(res, 400, { error: '按鈕錯誤' });
    let v = b.value;
    if (typeof v === 'function') {
      const inputs = Array.isArray(body.inputs) ? body.inputs.slice(0, 200).map(i => ({
        id: typeof i.id === 'string' ? i.id : undefined, name: typeof i.name === 'string' ? i.name : undefined,
        type: typeof i.type === 'string' ? i.type : undefined, value: String(i.value ?? '').slice(0, 40), checked: !!i.checked,
        k: typeof i.k === 'string' ? i.k : undefined })) : [];
      const form = makeForm(inputs);
      try { v = v(form); } catch (e) { return json(res, 400, { error: '表單錯誤' }); }
      if (v === undefined) return json(res, 200, { errors: form.errors });
    }
    game.pending.delete(q.id);
    q.resolve(v);
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch(err => { console.error(err); if (!res.headersSent) json(res, 500, { error: 'server' }); });
    return;
  }
  const f = FILES[url.pathname];
  if (!f || req.method !== 'GET') { res.writeHead(404); res.end('not found'); return; }
  fs.readFile(path.join(ROOT, f[0]), (err, data) => {
    if (err) { res.writeHead(500); res.end(); return; }
    res.writeHead(200, { 'Content-Type': f[1], 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});
server.listen(PORT, HOST, () => console.log(`三國風雲連線伺服器：http://${HOST === '::1' ? '[::1]' : HOST}:${PORT}/（只限本機）`));
