// =====================================================================
// 축구 온라인 대전 서버 (Node 18+, 외부 패키지 없음)
// - 정적 파일 제공 + 웹소켓 (/ws)
// - 방(room)마다 서버가 60Hz로 경기를 계산하고, 30Hz로 상태를 보냄 (서버 권한)
// 실행: node server.js   →  http://localhost:8080
// =====================================================================
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Game, DT, V3, clamp, ARENA_X, ARENA_Z } from './public/sim.js';

const PORT = Number(process.env.PORT) || 8080;
const TEAM_SIZE = Number(process.env.TEAM_SIZE) || 1;          // 기본 1대1
const AI = process.env.AI === '1';                               // 빈 자리 AI (기본 끔)
const KEEPERS = process.env.KEEPERS === '1';                     // AI 골키퍼 (기본 끔)
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

// ----------------------------- HTTP -----------------------------
const server = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') url = '/index.html';
  if (url === '/health') { res.writeHead(200); return res.end('ok'); }
  const file = path.normalize(path.join(PUBLIC, url));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

// ----------------------------- 웹소켓 (최소 구현) -----------------------------
class WSConn {
  constructor(sock) {
    this.sock = sock; this.buf = Buffer.alloc(0); this.open = true;
    sock.setNoDelay(true);
    sock.on('data', d => this.onData(d));
    sock.on('close', () => { if (this.open) { this.open = false; } this.onclose?.(); });
    sock.on('error', () => sock.destroy());
  }
  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      if (this.buf.length < 2) return;
      const op = this.buf[0] & 0x0f, masked = this.buf[1] & 0x80;
      let len = this.buf[1] & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (len > 64 * 1024) { this.sock.destroy(); return; }
      const maskOff = off; if (masked) off += 4;
      if (this.buf.length < off + len) return;
      let payload = Buffer.from(this.buf.subarray(off, off + len));
      if (masked) { const m = this.buf.subarray(maskOff, maskOff + 4); for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3]; }
      this.buf = this.buf.subarray(off + len);
      if (op === 0x8) { this.close(); return; }
      if (op === 0x9) { this.frame(0xA, payload); continue; }
      if (op === 0x1) this.onmessage?.(payload.toString('utf8'));
    }
  }
  frame(op, payload) {
    if (!this.open || this.sock.destroyed) return;
    const len = payload.length; let h;
    if (len < 126) h = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(len, 2); }
    else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); }
    this.sock.write(Buffer.concat([h, payload]));
  }
  send(obj) { this.frame(0x1, Buffer.from(JSON.stringify(obj))); }
  close() { if (this.open) { this.frame(0x8, Buffer.alloc(0)); this.open = false; this.sock.end(); } }
}

server.on('upgrade', (req, sock) => {
  const u = new URL(req.url, 'http://x');
  const key = req.headers['sec-websocket-key'];
  if (u.pathname !== '/ws' || !key) return sock.destroy();
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const room = getRoom((u.searchParams.get('room') || 'main').slice(0, 20).replace(/[^\w가-힣-]/g, '') || 'main');
  const name = (u.searchParams.get('name') || '').trim().slice(0, 12) || '선수';
  room.join(new WSConn(sock), name);
});

// ----------------------------- 방 -----------------------------
const rooms = new Map();
let nextClientId = 1;
function getRoom(code) {
  if (!rooms.has(code)) rooms.set(code, new Room(code));
  return rooms.get(code);
}

class Room {
  constructor(code) {
    this.code = code; this.game = new Game(TEAM_SIZE, { ai: AI, keepers: KEEPERS }); this.clients = new Map();
    this.last = process.hrtime.bigint(); this.acc = 0; this.tick = 0;
    this.timer = setInterval(() => this.loop(), 1000 / 120);
    console.log(`[방 생성] ${code}`);
  }
  join(conn, name) {
    const id = nextClientId++;
    const player = this.game.addHuman(id, name);
    const client = { id, conn, name, player };
    this.clients.set(id, client);
    conn.send({ t: 'welcome', you: player ? player.id : -1, room: this.code, teamSize: this.game.teamSize });
    this.broadcast(this.game.roster());
    this.game.msg(`${name} 입장${player ? (player.team === 0 ? ' (블루)' : ' (레드)') : ' (관전)'}`, 1.5);
    console.log(`[입장] ${this.code} ${name} → ${player ? '선수 ' + player.id : '관전'}`);
    conn.onmessage = txt => { try { this.onMessage(client, JSON.parse(txt)); } catch { /* 잘못된 메시지는 무시 */ } };
    conn.onclose = () => this.leave(client);
  }
  leave(c) {
    if (!this.clients.has(c.id)) return;
    this.clients.delete(c.id);
    this.game.removeHuman(c.id);
    this.broadcast(this.game.roster());
    this.game.msg(`${c.name} 퇴장`, 1.2);
    console.log(`[퇴장] ${this.code} ${c.name}`);
    if (this.clients.size === 0) { clearInterval(this.timer); rooms.delete(this.code); console.log(`[방 삭제] ${this.code}`); }
  }
  onMessage(c, m) {
    const g = this.game, p = c.player;
    switch (m.t) {
      case 'start': if (g.state !== 'play') g.start(); return;
      case 'team': {   // 팀 바꾸기
        const t = m.team === 1 ? 1 : 0;
        if (p && p.team === t) return;
        g.removeHuman(c.id);
        c.player = g.addHuman(c.id, c.name, t) || g.addHuman(c.id, c.name);
        c.conn.send({ t: 'welcome', you: c.player ? c.player.id : -1, room: this.code, teamSize: g.teamSize });
        this.broadcast(g.roster());
        return;
      }
      case 'ping': c.conn.send({ t: 'pong', c: m.c }); return;
    }
    if (!p) return;
    switch (m.t) {
      case 'i':   // 입력 상태: 커서 위치, 달리기, 걷기
        if (Number.isFinite(m.x) && Number.isFinite(m.z)) p.input.target.set(clamp(m.x, -ARENA_X, ARENA_X), 0, clamp(m.z, -ARENA_Z, ARENA_Z));
        p.input.run = !!m.r; p.input.slow = !!m.s;
        return;
      case 'a':
        if (['jump', 'cut', 'slide', 'shoulder', 'skillL', 'skillR'].includes(m.a)) p.actions.push(m.a);
        return;
      case 'c': if (['lob', 'ground'].includes(m.k)) p.startCharge(m.k); return;
      case 'r': if (['lob', 'ground', 'shot'].includes(m.k)) p.releaseCharge(m.k); return;
      case 'sp': if (m.d) p.spaceDown(); else p.releaseCharge('shot'); return;
    }
  }
  loop() {
    const now = process.hrtime.bigint();
    this.acc += Math.min(0.25, Number(now - this.last) / 1e9); this.last = now;
    while (this.acc >= DT) {
      this.game.step(DT); this.acc -= DT; this.tick++;
      if (this.tick % 2 === 0) { const s = this.game.snapshot(); s.n = this.tick; this.broadcast(s); }
    }
  }
  broadcast(obj) {
    const data = Buffer.from(JSON.stringify(obj));
    for (const c of this.clients.values()) c.conn.frame(0x1, data);
  }
}

server.listen(PORT, () => {
  console.log(`축구 온라인 서버 실행 중: http://localhost:${PORT}  (팀당 ${TEAM_SIZE}명, AI ${AI ? "켬" : "끔"}, 골키퍼 ${KEEPERS ? "있음" : "없음"})`);
});
