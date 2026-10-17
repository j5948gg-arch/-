'use strict';
// 九路棋盤連線伺服器：零依賴（只用 Node 內建模組），伺服器端驗證所有走法。
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const Rules = require('./public/rules.js');
const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const DATA = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'players.json');
const MIME = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.webp':'image/webp','.gif':'image/gif'};

// ---------- 玩家（固定 ID：ID 綁定第一次登記時的金鑰，伺服器只存雜湊）----------
let players = {}; try { players = JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch (e) {}
function savePlayers(){ fs.mkdirSync(path.dirname(DATA), {recursive:true}); fs.writeFileSync(DATA + '.tmp', JSON.stringify(players)); fs.renameSync(DATA + '.tmp', DATA); }
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const same = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');

// ---------- 靜態檔案 ----------
const server = http.createServer((req, res) => {
  let u; try { u = decodeURIComponent((req.url || '/').split('?')[0]); } catch (e) { u = '/'; }
  if (u === '/') u = '/index.html';
  const f = path.normalize(path.join(PUB, u));
  if (!f.startsWith(PUB + path.sep) || !MIME[path.extname(f)]) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(f, (e, b) => {
    if (e) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {'Content-Type': MIME[path.extname(f)], 'Cache-Control': 'no-cache'}); res.end(b);
  });
});

// ---------- 最小 WebSocket（RFC 6455：文字訊息、ping/pong、close）----------
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11', all = new Set();
function frame(op, p){
  const n = p.length; let h;
  if (n < 126) h = Buffer.from([0x80 | op, n]);
  else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([h, p]);
}
const send = (ws, o) => { if (ws && !ws.socket.destroyed) ws.socket.write(frame(1, Buffer.from(JSON.stringify(o)))); };
const fail = (ws, msg, fatal) => send(ws, {t:'error', msg, fatal: !!fatal});
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') return socket.destroy();
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
    crypto.createHash('sha1').update(key + GUID).digest('base64') + '\r\n\r\n');
  const ws = {socket, player: null, alive: true, buf: Buffer.alloc(0), frag: []};
  all.add(ws);
  socket.on('data', d => { ws.buf = Buffer.concat([ws.buf, d]); parse(ws); });
  socket.on('close', () => { all.delete(ws); onClose(ws); });
  socket.on('error', () => socket.destroy());
});
function parse(ws){
  for (;;) {
    const b = ws.buf; if (b.length < 2) return;
    const fin = b[0] & 0x80, op = b[0] & 0x0f, masked = b[1] & 0x80; let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
    if (len > 65536 || !masked) return ws.socket.destroy();
    if (b.length < off + 4 + len) return;
    const mask = b.subarray(off, off + 4), data = Buffer.from(b.subarray(off + 4, off + 4 + len));
    for (let i = 0; i < len; i++) data[i] ^= mask[i & 3];
    ws.buf = b.subarray(off + 4 + len);
    if (op === 8) { ws.socket.end(frame(8, Buffer.alloc(0))); return; }
    if (op === 9) { ws.socket.write(frame(10, data)); continue; }
    if (op === 10) { ws.alive = true; continue; }
    if (op === 1 || op === 0) {
      if (op === 1) ws.frag = [];
      ws.frag.push(data);
      if (fin) { const s = Buffer.concat(ws.frag).toString('utf8'); ws.frag = []; try { handle(ws, s); } catch (e) { console.error(e); } }
    }
  }
}

// ---------- 房間 ----------
const rooms = new Map(), playerRoom = new Map(), conns = new Map();   // 房名(小寫)→房間；玩家→房名；玩家→連線
const rkey = n => n.toLowerCase();
const pname = id => players[id].name;
function meta(r, id){
  const rk = rkey(r.name), on = x => !!x && conns.has(x) && playerRoom.get(x) === rk;
  return {name: r.name, locked: r.locked, status: r.status, host: pname(r.host),
    sides: r.sides && {w: {id: r.sides.w, name: pname(r.sides.w)}, b: {id: r.sides.b, name: pname(r.sides.b)}},
    you: r.sides ? (r.sides.w === id ? 'w' : 'b') : null,
    online: r.sides ? {w: on(r.sides.w), b: on(r.sides.b)} : null};
}
const roomMsg = (r, id) => ({t:'room', room: meta(r, id), state: r.G, now: Date.now()});
const sendRoom = r => [r.host, r.guest].forEach(id => { if (id && playerRoom.get(id) === rkey(r.name)) send(conns.get(id), roomMsg(r, id)); });
const roomsList = () => [...rooms.values()].filter(r => r.status === 'waiting').map(r => ({name: r.name, locked: r.locked, host: pname(r.host)}));
function broadcastRooms(){ const list = roomsList(); conns.forEach((ws, id) => { if (!playerRoom.has(id)) send(ws, {t:'rooms', list}); }); }
function dropRoom(r){
  clearTimeout(r.timer); rooms.delete(rkey(r.name));
  [r.host, r.guest].forEach(id => { if (id && playerRoom.get(id) === rkey(r.name)) { playerRoom.delete(id); send(conns.get(id), {t:'left'}); send(conns.get(id), {t:'rooms', list: roomsList()}); } });
}

function schedule(r){   // 在時間到的那一刻由伺服器結算，不依賴玩家送出動作
  clearTimeout(r.timer); const G = r.G; if (!G || !G.clock || G.over) return;
  r.timer = setTimeout(() => { if (rooms.get(rkey(r.name)) !== r) return; if (Rules.timeUp(G, Date.now())) sendRoom(r); else schedule(r); }, Math.max(50, Rules.deadline(G) - Date.now() + 30));
  r.timer.unref();
}
function handle(ws, s){
  let m; try { m = JSON.parse(s); } catch (e) { return; }
  if (!m || typeof m.t !== 'string') return;
  if (m.t === 'hello') return hello(ws, m);
  const id = ws.player; if (!id) return fail(ws, '請先登入');
  const rk = playerRoom.get(id), r = rk && rooms.get(rk);
  if (m.t === 'create') return create(ws, id, m, r);
  if (m.t === 'join') return join(ws, id, m, r);
  if (m.t === 'leave') return leave(id, r);
  if (!r || r.status !== 'playing') return fail(ws, '不在對局中');
  const res = Rules.play(r.G, r.sides.w === id ? 'w' : 'b', m, Date.now()); r.ts = Date.now(); schedule(r);
  if (!res.ok && !res.ended) { fail(ws, res.error); send(ws, roomMsg(r, id)); }
  else sendRoom(r);
}
function hello(ws, m){
  const name = String(m.id || '').trim(), key = String(m.key || '');
  if (!name || name.length > 16 || /[\u0000-\u001f<>&"]/.test(name) || !/^[0-9a-f]{32,128}$/.test(key)) return fail(ws, 'ID 或金鑰格式不正確', true);
  const k = name.toLowerCase(), kh = sha(key);
  if (players[k]) { if (!same(players[k].keyHash, kh)) return fail(ws, '這個 ID 已被其他人使用', true); }
  else { players[k] = {name, keyHash: kh}; savePlayers(); }
  const old = conns.get(k);
  if (old && old !== ws) { fail(old, '你的 ID 已在別處登入', true); old.player = null; old.socket.end(); }
  ws.player = k; conns.set(k, ws);
  send(ws, {t:'hello_ok', name: pname(k)});
  const rk = playerRoom.get(k), r = rk && rooms.get(rk);
  if (r) sendRoom(r); else send(ws, {t:'rooms', list: roomsList()});
}
function create(ws, id, m, r){
  if (r) return fail(ws, '你已在房間中，請先離開');
  const name = String(m.name || '').trim().slice(0, 20); if (!name) return fail(ws, '請輸入房間名稱');
  if (rooms.has(rkey(name))) return fail(ws, '房間名稱已被使用');
  const pw = String(m.pw || '').slice(0, 64), salt = crypto.randomBytes(8).toString('hex');
  const room = {name, locked: !!pw, salt, pwHash: pw ? hashPw(pw, salt) : '', host: id, guest: null, status: 'waiting', sides: null, G: null, ts: Date.now()};
  rooms.set(rkey(name), room); playerRoom.set(id, rkey(name)); sendRoom(room); broadcastRooms();
}
function join(ws, id, m, r){
  if (r) return fail(ws, '你已在房間中，請先離開');
  const rk = rkey(String(m.name || '').trim()), room = rooms.get(rk);
  if (!room) return fail(ws, '找不到這個房間');
  if (room.host === id || room.guest === id) { playerRoom.set(id, rk); return sendRoom(room); }   // 成員重新進入
  if (room.guest) return fail(ws, '房間已滿');
  if (room.locked && !same(hashPw(String(m.pw || '').slice(0, 64), room.salt), room.pwHash)) return fail(ws, '密碼錯誤');
  const hostWhite = Math.random() < 0.5;   // 隨機分配黑白
  room.guest = id; room.sides = hostWhite ? {w: room.host, b: id} : {w: id, b: room.host};
  room.G = Rules.create(); room.status = 'playing'; room.ts = Date.now();
  const env = process.env;   // 棋鐘：每手 8 秒、自由時間 301 秒、開局緩衝 5 秒（測試時可用環境變數調短）
  room.G.clock = Rules.clockInit(Date.now(), {moveMs: +env.CHESS_MOVE_MS || 8000, freeMs: +env.CHESS_FREE_MS || 301000, graceMs: env.CHESS_GRACE_MS === undefined ? 5000 : +env.CHESS_GRACE_MS});
  schedule(room);
  playerRoom.set(id, rk); sendRoom(room); broadcastRooms();
}
function leave(id, r){
  if (!r) return;
  const ws = conns.get(id), rk = rkey(r.name);
  playerRoom.delete(id);
  if (r.status === 'waiting' || ![r.host, r.guest].some(x => playerRoom.get(x) === rk)) dropRoom(r); else sendRoom(r);
  send(ws, {t:'left'}); send(ws, {t:'rooms', list: roomsList()}); broadcastRooms();
}
function onClose(ws){
  const id = ws.player; if (!id || conns.get(id) !== ws) return;
  conns.delete(id);
  const rk = playerRoom.get(id), r = rk && rooms.get(rk);
  if (r && r.status === 'playing') sendRoom(r);
}

// ---------- 維護：心跳、清理過期房間 ----------
setInterval(() => all.forEach(ws => { if (!ws.alive) return ws.socket.destroy(); ws.alive = false; if (!ws.socket.destroyed) ws.socket.write(frame(9, Buffer.alloc(0))); }), 30000).unref();
setInterval(() => rooms.forEach(r => {
  const idle = Date.now() - r.ts, offline = ![r.host, r.guest].some(x => x && conns.has(x));
  if ((r.status === 'waiting' && !conns.has(r.host) && idle > 10 * 60e3) || (offline && idle > 2 * 3600e3)) { dropRoom(r); broadcastRooms(); }
}), 60000).unref();

if (require.main === module) server.listen(PORT, () => console.log(`九路棋盤伺服器已啟動： http://localhost:${PORT}`));
module.exports = {server, Rules};
