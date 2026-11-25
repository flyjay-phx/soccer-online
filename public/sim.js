// =====================================================================
// 축구 시뮬레이션 (서버·클라이언트 공용, 외부 라이브러리 없음)
// - 서버가 이 코드로 경기를 계산하고(서버 권한), 클라이언트는 상수만 가져다 씀
// - 60Hz 고정 틱, 공 물리는 직접 계산
// =====================================================================

// ----------------------------- 상수 -----------------------------
export const DT = 1 / 60;
export const FIELD_L = 50, FIELD_W = 32;
export const HALF_L = FIELD_L / 2, HALF_W = FIELD_W / 2;
export const GOAL_W = 5, GOAL_H = 2.2, GOAL_D = 1.6;
export const ARENA_X = HALF_L + 3, ARENA_Z = HALF_W + 2;
export const BALL_R = 0.11, POST_R = 0.06;
export const G = 9.81;
export const MATCH_TIME = 180;
export const DEG = Math.PI / 180;
export const STATES = ['normal', 'slide', 'recover', 'stun', 'skill', 'cut', 'trip'];   // trip: 숏태클(커트)에 걸려 휘청
export const KSTATES = ['guard', 'dive', 'hold', 'recover', 'setup', 'kick'];          // setup: 골킥 준비, kick: 차는 중
export const KICKS = [null, 'lob', 'ground', 'shot'];
// 세트피스 (축구 규칙에 따른 재개)
export const SP_TYPES = ['kickoff', 'throw', 'corner', 'goalkick', 'free', 'penalty'];
export const SP_NAMES = { kickoff: '킥오프', throw: '스로인', corner: '코너킥', goalkick: '골킥', free: '프리킥', penalty: '페널티킥' };
export const BOX_DEPTH = 8, BOX_HALF_W = 8, PEN_SPOT = 6, SP_DIST = 5;   // 페널티 박스, 페널티 지점, 상대가 떨어져야 할 거리

const SPD = { slow: 1.8, walk: 3.4, run: 6.8, runBall: 6.0, tired: 4.6 };
// 공 물리 상수
// dragLo/dragHi: 느릴 때·빠를 때 공기저항 (빠르면 공 표면 공기 흐름이 바뀌어 저항이 줄어듦)
// muBounce: 튈 때 잔디 마찰, muSlide: 미끄러질 때 잔디 마찰, rolling: 구를 때 감속(m/s²)
const PHYS = { dragLo: 0.0135, dragHi: 0.0095, magnus: 0.003, restitution: 0.58, muBounce: 0.45, muSlide: 0.32, rolling: 2.2 };
const GA_DEPTH = 2.5, GA_Z = 2;   // 골 에어리어 깊이, 골킥 공 놓는 위치(옆으로)
const mix = (a, b, t) => a + (b - a) * t;

// 팀 진형 (자기 팀 공격 방향 기준 x, z). 슬롯 0은 사람이 먼저 들어가는 자리
const FORMATION = [
  { x: -4, z: 0 },     // 중앙
  { x: -10, z: -7 },   // 왼쪽 뒤
  { x: -10, z: 7 },    // 오른쪽 뒤
];

// ----------------------------- 유틸 -----------------------------
export class V3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new V3(this.x, this.y, this.z); }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  length() { return Math.hypot(this.x, this.y, this.z); }
  lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  normalize() { const l = this.length() || 1; return this.multiplyScalar(1 / l); }
  lerp(v, t) { this.x += (v.x - this.x) * t; this.y += (v.y - this.y) * t; this.z += (v.z - this.z) * t; return this; }
  crossVectors(a, b) { return this.set(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x); }
  distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
}
export const rand = (a, b) => a + Math.random() * (b - a);
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const wrap = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
export const hdist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
export const hlen = v => Math.hypot(v.x, v.z);
const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const _v = new V3(), _w = new V3();

// ============================== 공 ==============================
class Ball {
  constructor() {
    this.pos = new V3(0, BALL_R, 0); this.prev = this.pos.clone();
    this.vel = new V3(); this.spin = new V3();
    this.owner = null; this.keeper = null; this.lastTouch = null; this.kickId = 0; this.knuckle = 0; this.bounces = 0;
  }
  get airborne() { return this.pos.y > BALL_R + 0.03; }
  speed() { return this.vel.length(); }
  release(vel, by) { this.owner = null; this.keeper = null; this.vel.copy(vel); this.spin.set(0, 0, 0); this.lastTouch = by; this.kickId++; this.knuckle = Math.random() * 6; this.bounces = 0; }
  // 빠른 공은 한 틱을 잘게 나눠 계산 (골대·그물·벽을 뚫고 지나가지 않게)
  step(dt) {
    const n = clamp(Math.ceil(this.vel.length() * dt / 0.06), 1, 10), h = dt / n;
    for (let i = 0; i < n; i++) this.substep(h);
  }
  substep(dt) {
    this.prev.copy(this.pos);
    const v = this.vel, w = this.spin;
    v.y -= G * dt;
    const sp = v.length();
    if (sp > 0) v.addScaledVector(v, -mix(PHYS.dragLo, PHYS.dragHi, clamp((sp - 12) / 10, 0, 1)) * sp * dt);
    if (this.airborne) {
      if (w.lengthSq() > 0) { _v.crossVectors(w, v).multiplyScalar(PHYS.magnus * dt); v.add(_v); }   // 마그누스: 회전 방향으로 휘어짐
      // 너클: 회전 거의 없는 강슛은 공기 흐름이 불안정해 좌우로 살짝 흔들림
      const hs = hlen(v);
      if (sp > 22 && w.lengthSq() < 16 && hs > 1) {
        this.knuckle += dt * 7;
        const a = Math.sin(this.knuckle) * 2.2 * dt, px = -v.z / hs, pz = v.x / hs;
        v.x += px * a; v.z += pz * a;
      }
      w.multiplyScalar(Math.exp(-0.25 * dt));
    }
    this.pos.addScaledVector(v, dt);
    if (this.pos.y < BALL_R) {
      this.pos.y = BALL_R;
      if (v.y < -0.8) this.bounce(); else v.y = 0;
    }
    if (this.pos.y <= BALL_R + 1e-4 && v.y === 0) this.roll(dt);
    collideGoals(this); collideArena(this);
  }
  // 땅에 튈 때: 접점이 미끄러지는 만큼 마찰이 속도와 회전을 바꿈 (백스핀은 멈칫, 탑스핀은 앞으로 튐)
  bounce() {
    const v = this.vel, w = this.spin, R = BALL_R, e = PHYS.restitution;
    const vn = -v.y; this.bounces++;
    v.y = vn * e;
    const sx = v.x + w.z * R, sz = v.z - w.x * R, sl = Math.hypot(sx, sz);
    if (sl > 1e-4) {
      const dv = Math.min(PHYS.muBounce * (1 + e) * vn, sl * 2 / 7);
      const dx = -sx / sl * dv, dz = -sz / sl * dv;
      v.x += dx; v.z += dz; w.x += 2.5 / R * -dz; w.z += 2.5 / R * dx;
    }
    w.y *= 0.7;
  }
  // 땅에서: 미끄러지는 동안은 운동마찰로 굴러가는 상태가 되고, 그 다음엔 구름 저항으로 멈춤
  roll(dt) {
    const v = this.vel, w = this.spin, R = BALL_R;
    const sx = v.x + w.z * R, sz = v.z - w.x * R, sl = Math.hypot(sx, sz);
    if (sl > 0.05) {
      const dv = Math.min(PHYS.muSlide * G * dt, sl * 2 / 7);
      const dx = -sx / sl * dv, dz = -sz / sl * dv;
      v.x += dx; v.z += dz; w.x += 2.5 / R * -dz; w.z += 2.5 / R * dx;
    } else {
      const h = hlen(v);
      if (h > 0) { const dec = Math.min(h, PHYS.rolling * dt); v.x -= v.x / h * dec; v.z -= v.z / h * dec; }
      w.set(v.z / R, w.y * Math.exp(-3 * dt), -v.x / R);
    }
  }
  // 굴러가는 상태에 맞는 회전 (패스·드리블용)
  setRolling(k = 1) { this.spin.set(this.vel.z / BALL_R * k, 0, -this.vel.x / BALL_R * k); }
}
function bounceOff(b, nx, ny, nz, e) {
  const vn = b.vel.x * nx + b.vel.y * ny + b.vel.z * nz;
  if (vn < 0) { b.vel.x -= (1 + e) * vn * nx; b.vel.y -= (1 + e) * vn * ny; b.vel.z -= (1 + e) * vn * nz; }
}
function collideArena(b) {
  const p = b.pos, v = b.vel, lx = ARENA_X - BALL_R, lz = ARENA_Z - BALL_R;
  if (p.x > lx) { p.x = lx; if (v.x > 0) v.x *= -0.55; }
  if (p.x < -lx) { p.x = -lx; if (v.x < 0) v.x *= -0.55; }
  if (p.z > lz) { p.z = lz; if (v.z > 0) v.z *= -0.55; }
  if (p.z < -lz) { p.z = -lz; if (v.z < 0) v.z *= -0.55; }
}
function collideGoals(b) {
  const p = b.pos, r = BALL_R + POST_R;
  for (const s of [-1, 1]) {
    const gx = s * HALF_L;
    if (p.y < GOAL_H + r) for (const zp of [-GOAL_W / 2, GOAL_W / 2]) {
      const dx = p.x - gx, dz = p.z - zp, d = Math.hypot(dx, dz);
      if (d < r && d > 1e-6) { const nx = dx / d, nz = dz / d; p.x = gx + nx * r; p.z = zp + nz * r; bounceOff(b, nx, 0, nz, 0.7); }
    }
    if (Math.abs(p.z) < GOAL_W / 2) {
      const dx = p.x - gx, dy = p.y - GOAL_H, d = Math.hypot(dx, dy);
      if (d < r && d > 1e-6) { const nx = dx / d, ny = dy / d; p.x = gx + nx * r; p.y = GOAL_H + ny * r; bounceOff(b, nx, ny, 0, 0.7); }
    }
    const depth = s * p.x - HALF_L, pd = s * b.prev.x - HALF_L;
    if (depth > -BALL_R && depth < GOAL_D + 0.3) {
      const inside = Math.abs(p.z) < GOAL_W / 2 && p.y < GOAL_H;
      const wasInside = Math.abs(b.prev.z) < GOAL_W / 2 && b.prev.y < GOAL_H;
      if (wasInside && pd > 0) {
        if (depth > GOAL_D - BALL_R) { p.x = s * (HALF_L + GOAL_D - BALL_R); b.vel.x *= -0.15; b.vel.z *= 0.6; b.vel.y *= 0.6; }
        if (Math.abs(p.z) > GOAL_W / 2 - BALL_R) { p.z = Math.sign(p.z) * (GOAL_W / 2 - BALL_R); b.vel.z *= -0.15; b.vel.x *= 0.6; }
        if (p.y > GOAL_H - BALL_R) { p.y = GOAL_H - BALL_R; if (b.vel.y > 0) b.vel.y *= -0.1; }
      } else if (!wasInside && depth > 0.05 && inside) {
        if (Math.abs(b.prev.z) >= GOAL_W / 2) { p.z = Math.sign(b.prev.z) * (GOAL_W / 2 + BALL_R); b.vel.z *= -0.2; b.vel.x *= 0.5; }
        else { p.y = GOAL_H + BALL_R; if (b.vel.y < 0) b.vel.y *= -0.2; }
      }
    }
  }
}

// ---------- 클릭 패스: 파워별 도달 거리 표 (실제 공 물리로 미리 계산) ----------
export const TAP_T = 0.18;                       // 이보다 짧게 누르면 '클릭'
export const TAP_MAX = { ground: 16, lob: 20 };  // 클릭으로 보낼 수 있는 최대 거리(m), 더 멀면 게이지 사용
function kickVel(type, power) {
  if (type === 'ground') return { vh: 4 + power * 16, vy: 0.15, spin: 0 };
  if (type === 'lob') return { vh: 6 + power * 14, vy: 3.5 + power * 7.5, spin: 18 };
  return { vh: 12 + power * 20, vy: 0.6 + power * 2.4, spin: 0 };
}
function kickReach(type, power) {
  const b = new Ball(), k = kickVel(type, power);
  b.pos.set(-20, BALL_R + 0.01, 0); b.vel.set(k.vh, k.vy, 0); b.spin.set(0, 0, k.spin);
  if (type === 'ground') b.setRolling(0.7);
  let flew = false;
  for (let i = 0; i < 1500; i++) {
    b.step(DT);
    if (b.pos.y > BALL_R + 0.05) flew = true;
    if (type === 'lob' && flew && b.bounces > 0) break;                         // 로빙: 첫 착지 지점
    if (type === 'ground' && hlen(b.vel) < 3) break;                         // 땅볼: 받기 좋은 속도(3m/s)로 도착
  }
  return b.pos.x + 20;
}
// 골키퍼 골킥·패스용: 거리 d로 보내는 파워 (최대 거리 제한 없음)
function powerFor(type, d) { return quickPower(type, d, 60); }
// 키퍼 스로: 1.9m 높이에서 위로 vy로 던질 때 dist에 처음 떨어지는 수평 속도 (이분 탐색)
function throwSpeed(vy, dist) {
  let lo = 2, hi = 28;
  for (let it = 0; it < 14; it++) {
    const mid = (lo + hi) / 2, b = new Ball();
    b.pos.set(0, 1.9, 0); b.vel.set(mid, vy, 0);
    for (let i = 0; i < 600 && b.bounces === 0; i++) b.step(DT);
    if (b.pos.x < dist) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
const REACH = {};
function quickPower(type, dist, max = TAP_MAX[type]) {
  if (!REACH[type]) REACH[type] = Array.from({ length: 51 }, (_, i) => kickReach(type, i / 50));
  const tb = REACH[type], d = Math.min(dist, max);
  if (d <= tb[0]) return 0;
  for (let i = 1; i < tb.length; i++) if (tb[i] >= d) return (i - 1 + (d - tb[i - 1]) / (tb[i] - tb[i - 1])) / 50;
  return 1;
}

// ============================== 필드 선수 ==============================
class Player {
  constructor(game, id, team, slot) {
    this.game = game; this.id = id; this.team = team; this.slot = slot;
    this.humanId = null; this.name = '';
    this.dir = team === 0 ? 1 : -1;
    this.pos = new V3(); this.vel = new V3();
    this.yaw = team === 0 ? 0 : Math.PI; this.face = new V3(Math.cos(this.yaw), 0, Math.sin(this.yaw));
    this.y = 0; this.vy = 0; this.stamina = 1;
    this.state = 'normal'; this.stateT = 0;
    this.cd = { cut: 0, slide: 0, shoulder: 0, skill: 0, noTouch: 0 };
    this.charge = null; this.pendingKick = null;
    this.headerT = 0; this.kickAnim = 0; this.leanT = 0; this.headAnim = 0; this.stateT0 = 1;
    this.offset = 0.5; this.touchT = 0; this.slide = null; this.skillDir = new V3();
    this.input = { target: new V3(), run: false, slow: false };
    this.actions = [];
    this.brain = new AIBrain(this, game);
  }
  get isHuman() { return this.humanId !== null; }
  get hasBall() { return this.game.ball.owner === this; }
  isRunning() { return this.input.run && !this.input.slow && this.stamina > 0.05; }
  setYaw(y) { this.yaw = wrap(y); this.face.set(Math.cos(this.yaw), 0, Math.sin(this.yaw)); }
  turnTo(y, max) { this.setYaw(this.yaw + clamp(wrap(y - this.yaw), -max, max)); }
  setState(s, t) {
    this.state = s; this.stateT = t; this.stateT0 = t;
    if (s === 'stun' || s === 'recover' || s === 'trip') {
      this.charge = null; this.pendingKick = null;
      if ((s === 'stun' || s === 'trip') && this.hasBall) this.game.ball.release(new V3(this.face.x * 2, 0.3, this.face.z * 2), this);
    }
  }
  startCharge(type) { if (!this.charge && this.state === 'normal') this.charge = { type, t: 0 }; }
  chargePower() { return this.charge ? clamp(this.charge.t / 1.0, 0, 1) : 0; }
  releaseCharge(type) {
    const c = this.charge;
    if (!c || (type && c.type !== type)) return;
    this.charge = null;
    if (!this.hasBall) return;
    const t = this.input.target;
    // 짧게 클릭(탭)하면 커서까지 거리에 맞춰 자동 파워 (가까운 땅볼·로빙만). 길게 누르면 게이지 그대로
    const tap = c.t < TAP_T && c.type !== 'shot' && c.want === undefined;
    let power = tap ? quickPower(c.type, hdist(t, this.pos)) : clamp(c.t / 1.0, 0.05, 1);
    if (this.isTaker('throw')) power = Math.min(power, 0.55);   // 스로인은 손으로 던지므로 멀리 못 감
    const yaw = Math.atan2(t.z - this.pos.z, t.x - this.pos.x);
    this.pendingKick = { type: c.type, power, target: t.clone(), yaw, turned: Math.abs(wrap(yaw - this.yaw)), t: 0 };
  }
  // 스페이스: 공이 있으면 슛 충전, 없으면 날아오는 공을 바로 슛 (높이에 따라 헤딩슛·발리슛·원터치슛)
  spaceDown() {
    if (this.isTaker('throw')) return;   // 스로인은 슛 불가 (클릭 패스로 던짐)
    if (this.hasBall) this.startCharge('shot'); else this.actions.push('airshot');
  }
  // 세트피스 키커인지 (type을 주면 그 종류일 때만)
  isTaker(type) { const sp = this.game.setPiece; return !!sp && sp.taker === this && (!type || sp.type === type); }

  doAction(a) {
    const g = this.game, ball = g.ball, ground = this.y === 0;
    switch (a) {
      case 'jump': if (ground) { this.vy = 3.3; this.stamina = Math.max(0, this.stamina - 0.03); } break;   // 태클 피하기 점프 (최고 약 0.55m)
      case 'cut': if (this.cd.cut === 0 && ground) { this.cd.cut = 0.9; this.setState('cut', 0.22); g.tryCut(this); } break;
      case 'slide':
        if (this.cd.slide === 0 && ground && !this.hasBall) {
          this.cd.slide = 1.6;
          const t = this.input.target;
          if (hdist(t, this.pos) > 0.3) this.setYaw(Math.atan2(t.z - this.pos.z, t.x - this.pos.x));
          this.slide = { t: 0.55, dir: this.face.clone(), touched: false, hit: false, dodged: false };
          this.state = 'slide'; this.charge = null;
          this.stamina = Math.max(0, this.stamina - 0.06);
        }
        break;
      case 'shoulder': if (this.cd.shoulder === 0) { this.cd.shoulder = 0.9; this.leanT = 0.25; g.tryShoulder(this); } break;
      case 'skillL': case 'skillR':
        if (this.hasBall && this.cd.skill === 0 && ground) {
          this.cd.skill = 0.9;
          this.setYaw(this.yaw + (a === 'skillL' ? -70 : 70) * DEG);
          this.skillDir.copy(this.face); this.setState('skill', 0.28); this.offset = 0.45;
        }
        break;
      case 'header': case 'airshot': {
        this.headerT = 0.45;   // 이 시간 안에 공이 오면 슛
        const hs = Math.max(1, hlen(ball.vel));
        const t = Math.min(0.6, hdist(ball.pos, this.pos) / hs);
        const yAt = ball.pos.y + ball.vel.y * t - 0.5 * G * t * t;
        if (yAt > 1.95 && ground) this.vy = clamp(Math.sqrt(2 * G * (yAt - 1.65)), 2, 4.3);
        break;
      }
    }
  }

  update(dt) {
    const g = this.game;
    for (const k in this.cd) this.cd[k] = Math.max(0, this.cd[k] - dt);
    this.headerT = Math.max(0, this.headerT - dt);
    this.kickAnim = Math.max(0, this.kickAnim - dt);
    this.leanT = Math.max(0, this.leanT - dt);
    this.headAnim = Math.max(0, this.headAnim - dt);
    if (this.charge) {
      this.charge.t += dt;
      if (this.charge.want !== undefined && this.chargePower() >= this.charge.want) this.releaseCharge();
    }
    if (this.pendingKick) { this.pendingKick.t += dt; if (!this.hasBall || this.pendingKick.t > 0.9) this.pendingKick = null; }
    if (this.state === 'normal') for (const a of this.actions) this.doAction(a);
    this.actions.length = 0;

    if (this.y > 0 || this.vy > 0) { this.vy -= G * dt; this.y += this.vy * dt; if (this.y <= 0) { this.y = 0; this.vy = 0; } }
    const air = this.y > 0;
    switch (this.state) {
      case 'slide': {
        const sl = this.slide; sl.t -= dt;
        const sp = 8.5 * Math.max(0.25, sl.t / 0.55);
        this.vel.set(sl.dir.x * sp, 0, sl.dir.z * sp);
        if (sl.t <= 0) this.setState('recover', 0.7);
        break;
      }
      case 'trip':   // 휘청: 밀리던 힘이 조금 남아 미끄러지다 멈춤
        this.vel.multiplyScalar(Math.pow(0.12, dt));
        this.stateT -= dt; if (this.stateT <= 0) this.state = 'normal';
        break;
      case 'recover': case 'stun':
        this.vel.multiplyScalar(Math.pow(0.02, dt));
        this.stateT -= dt; if (this.stateT <= 0) this.state = 'normal';
        break;
      case 'skill':
        this.vel.set(this.skillDir.x * 7.5, 0, this.skillDir.z * 7.5);
        this.stateT -= dt; if (this.stateT <= 0) this.state = 'normal';
        break;
      case 'cut':
        this.vel.set(this.face.x * 3.5, 0, this.face.z * 3.5);
        this.stateT -= dt; if (this.stateT <= 0) this.state = 'normal';
        break;
      default:
        if (!air) this.move(dt);
    }
    const sprinting = this.state === 'normal' && this.isRunning() && hlen(this.vel) > 4.5;
    this.stamina = clamp(this.stamina + (sprinting ? -0.15 : 0.09) * dt, 0, 1);
    this.pos.addScaledVector(this.vel, dt);
    this.pos.x = clamp(this.pos.x, -ARENA_X + 0.4, ARENA_X - 0.4);
    this.pos.z = clamp(this.pos.z, -ARENA_Z + 0.4, ARENA_Z - 0.4);
    const k = this.pendingKick;
    if (k && this.hasBall && Math.abs(wrap(k.yaw - this.yaw)) < 25 * DEG) g.executeKick(this, k);
  }

  move(dt) {
    const has = this.hasBall, t = this.input.target;
    _v.set(t.x - this.pos.x, 0, t.z - this.pos.z);
    const dist = _v.length();
    let speed = this.input.slow ? SPD.slow
      : this.isRunning() ? (this.stamina < 0.2 ? SPD.tired : has ? SPD.runBall : SPD.run) : SPD.walk;
    if (dist < 0.5) speed = 0; else if (dist < 1.5) speed *= dist - 0.5;
    if (this.pendingKick) speed *= 0.45;
    // 세트피스 키커는 제자리에서 방향만 돌릴 수 있음 (킥오프는 예외)
    if (this.isTaker() && this.game.setPiece.type !== 'kickoff') speed = 0;
    const desiredYaw = this.pendingKick ? this.pendingKick.yaw : dist > 0.3 ? Math.atan2(_v.z, _v.x) : this.yaw;
    this.turnTo(desiredYaw, (has ? (this.isRunning() ? 5.5 : 8.5) : 12) * dt);
    if (has) {
      const cur = hlen(this.vel), ns = cur + clamp(speed - cur, -12 * dt, 8 * dt);
      this.vel.set(this.face.x * ns, 0, this.face.z * ns);
    } else {
      if (dist > 0.01) _v.multiplyScalar(speed / dist); else _v.set(0, 0, 0);
      // 관성: 가속은 초당 9m/s²까지, 감속·급한 방향 전환은 14m/s²까지 (순간 정지·순간 반대 방향 불가)
      _w.set(_v.x - this.vel.x, 0, _v.z - this.vel.z);
      const need = hlen(_w), cur = hlen(this.vel), want = hlen(_v);
      const braking = want < cur || (this.vel.x * _v.x + this.vel.z * _v.z) < cur * want * 0.5;
      const lim = (braking ? 14 : 9) * dt;
      if (need > lim) _w.multiplyScalar(lim / need);
      this.vel.add(_w);
    }
  }
}

// ============================== 골키퍼 (AI 전담) ==============================
class Keeper {
  constructor(game, team) {
    this.game = game; this.team = team; this.side = team === 0 ? -1 : 1;
    this.pos = new V3(this.side * (HALF_L - 0.6), 0, 0);
    this.yaw = team === 0 ? 0 : Math.PI;
    this.state = 'guard'; this.t = 0; this.decision = null; this.diveTarget = new V3(); this.diveY = 1; this.gk = null;
  }
  reset() { this.pos.set(this.side * (HALF_L - 0.6), 0, 0); this.state = 'guard'; this.decision = null; this.gk = null; }
  // 패스 받을 사람: 같은 팀 사람 우선, 없으면 가까운 같은 팀
  receiver() {
    const mates = this.game.players.filter(p => p.team === this.team && p.state !== 'stun');
    return mates.find(p => p.isHuman) || mates.sort((a, c) => hdist(a.pos, this.pos) - hdist(c.pos, this.pos))[0] || null;
  }
  // 받는 사람이 뛰어가는 쪽으로 조금 앞을 노림
  leadPoint(p, t) { return new V3(clamp(p.pos.x + p.vel.x * t * 0.8, -HALF_L + 1, HALF_L - 1), 0, clamp(p.pos.z + p.vel.z * t * 0.8, -HALF_W + 1, HALF_W - 1)); }
  // 골킥 시작: 공 뒤로 물러났다가(도움닫기) 받을 사람을 보고 달려와서 참
  startGoalKick(spot) {
    this.state = 'setup';
    const dir = new V3(-this.side, 0, -Math.sign(spot.z) * 0.35).normalize();   // 대략 경기장 안쪽
    this.gk = { phase: 'walk', spot: spot.clone(), dir, t: 0 };
  }
  updateGoalKick(dt) {
    const k = this.gk;
    k.t += dt;
    const move = (tx, tz, speed) => {
      _v.set(tx - this.pos.x, 0, tz - this.pos.z);
      const d = _v.length(), st = speed * dt;
      if (d > st) _v.multiplyScalar(st / d);
      this.pos.add(_v); return d;
    };
    if (this.state === 'kick') { this.t -= dt; if (this.t <= 0) { this.state = 'guard'; this.gk = null; } return; }
    if (k.phase === 'walk') {          // 도움닫기 자리로 (공 뒤 2.4m)
      const d = move(k.spot.x - k.dir.x * 2.4, k.spot.z - k.dir.z * 2.4, 3.2);
      this.yaw = Math.atan2(k.spot.z - this.pos.z, k.spot.x - this.pos.x);
      if (d < 0.1 || k.t > 4) { k.phase = 'look'; k.t = 0; }
    } else if (k.phase === 'look') {   // 고개 들어 받을 사람 확인
      const r = this.receiver();
      if (r) this.yaw = Math.atan2(r.pos.z - this.pos.z, r.pos.x - this.pos.x);
      if (k.t > 0.8) { k.phase = 'run'; k.t = 0; }
    } else if (k.phase === 'run') {    // 달려와서 공 옆에 디딤발
      const d = move(k.spot.x - k.dir.x * 0.4, k.spot.z - k.dir.z * 0.4, 5.5);
      this.yaw = Math.atan2(k.spot.z - this.pos.z, k.spot.x - this.pos.x);
      if (d < 0.08 || k.t > 2) this.kickGoalKick();
    }
  }
  kickGoalKick() {
    const g = this.game, b = g.ball, r = this.receiver();
    let aim, type;
    if (r) {
      const d0 = hdist(r.pos, b.pos);
      type = d0 < 14 ? 'ground' : 'lob';
      aim = this.leadPoint(r, type === 'ground' ? d0 / 11 : d0 / 14);
    } else { type = 'lob'; aim = new V3(-this.side * 3, 0, rand(-6, 6)); }
    _v.set(aim.x - b.pos.x, 0, aim.z - b.pos.z);
    const d = _v.length() || 1; _v.multiplyScalar(1 / d);
    const a = gauss() * 1.5 * DEG, c = Math.cos(a), s = Math.sin(a);
    const dx = _v.x * c - _v.z * s, dz = _v.x * s + _v.z * c;
    const { vh, vy, spin } = kickVel(type, powerFor(type, d));
    b.release(new V3(dx * vh, vy, dz * vh), this);
    if (type === 'ground') b.setRolling(0.7); else b.spin.set(-dz * spin, 0, dx * spin);
    g.ballLocked = false;
    this.decision = { id: b.kickId, save: false };
    this.yaw = Math.atan2(dz, dx);
    this.state = 'kick'; this.t = 0.45;
    g.msg(type === 'ground' ? '골킥 - 짧은 패스' : '골킥 - 롱킥', 0.9);
  }
  update(dt) {
    const g = this.game, b = g.ball, gx = this.side * HALF_L;
    if (this.gk) { this.updateGoalKick(dt); return; }
    if (this.state === 'hold') {
      this.t -= dt; b.pos.set(this.pos.x - this.side * 0.35, 1.1, this.pos.z); b.vel.set(0, 0, 0);
      if (this.t <= 0) this.distribute();
      return;
    }
    if (this.state === 'dive') {
      this.t -= dt;
      _v.set(this.diveTarget.x - this.pos.x, 0, this.diveTarget.z - this.pos.z);
      const d = _v.length(), step = 7.5 * dt; if (d > step) _v.multiplyScalar(step / d);
      this.pos.add(_v); this.tryTouch();
      if (this.t <= 0) { this.state = 'recover'; this.t = 0.6; }
      return;
    }
    if (this.state === 'recover') { this.t -= dt; if (this.t <= 0) this.state = 'guard'; return; }

    _v.set(b.pos.x - gx, 0, b.pos.z);
    const L = _v.length() || 1;
    const inBox = Math.abs(b.pos.x - gx) < 7 && Math.abs(b.pos.z) < 8;
    const radius = inBox ? Math.min(2.6, L * 0.45) : Math.min(1.4, L * 0.5);
    let tx = gx + _v.x / L * radius, tz = clamp(_v.z / L * radius, -(GOAL_W / 2 + 0.6), GOAL_W / 2 + 0.6);
    if (this.side * tx > HALF_L - 0.3) tx = this.side * (HALF_L - 0.3);
    const free = !b.owner && !b.keeper;
    if (free && inBox && b.speed() < 7 && b.pos.y < 1.2) {
      const nearestOpp = Math.min(...g.players.filter(p => p.team !== this.team).map(p => hdist(b.pos, p.pos)));
      if (hdist(b.pos, this.pos) < nearestOpp + 1) { tx = b.pos.x; tz = b.pos.z; }
    }
    _v.set(tx - this.pos.x, 0, tz - this.pos.z);
    const d = _v.length(), step = 5.2 * dt; if (d > step) _v.multiplyScalar(step / d);
    this.pos.add(_v);
    this.yaw = Math.atan2(b.pos.z - this.pos.z, b.pos.x - this.pos.x);

    if (free && b.vel.x * this.side > 2 && (!this.decision || this.decision.id !== b.kickId)) {
      const lineX = this.side * (HALF_L - 0.4), t = (lineX - b.pos.x) / b.vel.x;
      if (t > 0 && t < 1.0) {
        const zp = b.pos.z + b.vel.z * t, yp = Math.max(BALL_R, b.pos.y + b.vel.y * t - 0.5 * G * t * t);
        if (Math.abs(zp) < GOAL_W / 2 + 0.6 && yp < GOAL_H + 0.4) {
          const lateral = Math.abs(zp - this.pos.z), sp = b.speed();
          const reachable = lateral < 0.7 + 5 * t + 1.6;
          const chance = reachable ? clamp(1.25 - sp / 38 - lateral * 0.13 - (yp > 1.8 ? 0.15 : 0), 0.1, 0.95) : 0;
          const save = Math.random() < chance;
          this.decision = { id: b.kickId, save };
          if (lateral > 0.6 || yp > 1.9) {
            this.state = 'dive'; this.t = Math.max(0.5, t + 0.25);
            const dz = Math.sign(zp - this.pos.z) || 1;
            this.diveTarget.set(lineX, 0, save ? zp : zp - dz * rand(0.9, 1.4));
            this.diveY = clamp(yp, 0.4, 2.0);
          }
        }
      }
    }
    if (b.owner && b.owner.team !== this.team && hdist(b.pos, this.pos) < 0.9 && Math.random() < 2.0 * dt) this.catchBall();
    this.tryTouch();
  }
  tryTouch() {
    const b = this.game.ball;
    if (b.owner || b.keeper) return;
    if (this.decision && this.decision.id === b.kickId && !this.decision.save) return;
    const cy = this.state === 'dive' ? this.diveY : 1.0;
    if (hdist(b.pos, this.pos) < 0.75 && Math.abs(b.pos.y - cy) < 1.1) {
      if (b.speed() < 19) this.catchBall();
      else {
        b.vel.x = -b.vel.x * 0.35; b.vel.z += rand(-5, 5); b.vel.y = Math.abs(b.vel.y) * 0.3 + 2.5;
        b.lastTouch = this; b.kickId++; this.decision = { id: b.kickId, save: false };
        this.game.msg('펀칭!', 0.9);
      }
    }
  }
  catchBall() {
    const b = this.game.ball;
    if (b.owner) b.owner.cd.noTouch = 0.6;
    b.owner = null; b.keeper = this; b.vel.set(0, 0, 0); b.lastTouch = this;
    this.game.offside = null;
    this.state = 'hold'; this.t = 0.55;   // 잡자마자 곧 패스
    this.game.msg('키퍼 선방!', 1.0);
  }
  // 잡은 공을 같은 팀(사람 우선)에게 바로 줌: 가까우면 굴려주고, 멀면 던지기
  distribute() {
    const g = this.game, b = g.ball, r = this.receiver();
    b.keeper = null; this.state = 'recover'; this.t = 0.4;
    let aim, type;
    if (r) {
      const d0 = hdist(r.pos, this.pos);
      type = d0 < 20 ? 'ground' : 'lob';
      aim = this.leadPoint(r, type === 'ground' ? d0 / 10 : d0 / 13);
    } else { type = 'lob'; aim = new V3(-this.side * 3, 0, rand(-6, 6)); }
    _v.set(aim.x - this.pos.x, 0, aim.z - this.pos.z);
    const d = _v.length() || 1, ux = _v.x / d, uz = _v.z / d;   // (_v는 공 계산에서 다시 쓰이므로 방향을 따로 보관)
    if (type === 'ground') {          // 굴려주기: 받는 곳에서 초속 3m 정도로 도착
      const v0 = Math.sqrt(9 + 2 * PHYS.rolling * d) * 1.06;
      b.pos.set(this.pos.x + ux * 0.6, BALL_R + 0.01, this.pos.z + uz * 0.6);
      b.release(new V3(ux * v0, 0, uz * v0), this); b.setRolling(1);
      g.msg('키퍼 패스', 0.8);
    } else {                          // 던지기: 어깨 높이에서 포물선
      // 받는 사람 3m 앞에 떨어져 한두 번 튀며 발 앞으로 가도록, 공기저항까지 넣어 세기를 찾음
      const vy = clamp(2.5 + d * 0.08, 3, 6), vh = throwSpeed(vy, Math.max(4, d - 3));
      b.pos.set(this.pos.x + ux * 0.6, 1.9, this.pos.z + uz * 0.6);
      b.release(new V3(ux * vh, vy, uz * vh), this);
      g.msg('키퍼 스로', 0.8);
    }
    this.yaw = Math.atan2(uz, ux);
    this.decision = { id: b.kickId, save: false };
    g.offside = null;
  }
}

// ============================== AI 필드 선수 ==============================
class AIBrain {
  constructor(p, game) { this.p = p; this.g = game; this.think = Math.random() * 0.25; this.lastSlide = null; }

  homeSpot(out) {
    const p = this.p, b = this.g.ball, f = FORMATION[p.slot % FORMATION.length];
    const ours = (b.owner && b.owner.team === p.team) || (b.keeper && b.keeper.team === p.team);
    const shift = ours ? 6 : -2;            // 공격할 땐 올라가고, 수비할 땐 내려옴
    const x = p.dir * (f.x + shift) + b.pos.x * 0.55;
    const z = f.z + b.pos.z * 0.35;
    return out.set(clamp(x, -HALF_L + 3, HALF_L - 3), 0, clamp(z, -HALF_W + 2, HALF_W - 2));
  }

  // 이 선수가 공을 쫓아야 하는지 (팀에서 공에 가장 가까운 선수만)
  isChaser() {
    const p = this.p, b = this.g.ball;
    let best = null, bd = 1e9;
    for (const q of this.g.players) {
      if (q.team !== p.team) continue;
      const d = hdist(q.pos, b.pos) - (q.isHuman ? 1.5 : 0);   // 사람 쪽에 조금 우선권
      if (d < bd) { bd = d; best = q; }
    }
    return best === p;
  }

  openTeammate() {
    const p = this.p, g = this.g;
    let best = null, bestScore = 2.5;
    for (const q of g.players) {
      if (q === p || q.team !== p.team) continue;
      const d = hdist(q.pos, p.pos);
      if (d < 5 || d > 28) continue;
      let free = 1e9;
      for (const o of g.players) {
        if (o.team === p.team) continue;
        free = Math.min(free, hdist(o.pos, q.pos));
        // 패스 길목에 상대가 있으면 감점
        const t = clamp(((o.pos.x - p.pos.x) * (q.pos.x - p.pos.x) + (o.pos.z - p.pos.z) * (q.pos.z - p.pos.z)) / (d * d), 0, 1);
        const lx = p.pos.x + (q.pos.x - p.pos.x) * t, lz = p.pos.z + (q.pos.z - p.pos.z) * t;
        if (Math.hypot(o.pos.x - lx, o.pos.z - lz) < 1.3) free = Math.min(free, 0.5);
      }
      const forward = (q.pos.x - p.pos.x) * p.dir;
      const score = free + forward * 0.08;
      if (score > bestScore) { bestScore = score; best = q; }
    }
    return best;
  }

  update(dt) {
    const p = this.p, g = this.g, b = g.ball, inp = p.input;
    const goalX = p.dir * HALF_L;
    this.think -= dt;
    const decide = this.think <= 0;
    if (decide) this.think = 0.25;
    inp.slow = false;

    // 상대 슬라이딩 점프 회피
    if (b.owner === p) for (const o of g.players) {
      if (o.team !== p.team && o.state === 'slide' && o.slide !== this.lastSlide && hdist(o.pos, p.pos) < 2.6) {
        this.lastSlide = o.slide; if (Math.random() < 0.45) p.actions.push('jump');
      }
    }

    if (b.owner === p) {
      if (p.charge || p.pendingKick) return;
      const dGoal = Math.hypot(goalX - p.pos.x, p.pos.z);
      // --- 세트피스 키커 ---
      const sp = g.setPiece;
      if (sp && sp.taker === p && sp.type !== 'kickoff') {
        if (sp.t < 1.0) return;   // 잠깐 준비
        if (sp.type === 'penalty' || (sp.type === 'free' && dGoal < 20 && Math.random() < 0.6)) {
          inp.target.set(goalX, 0, (Math.random() < 0.5 ? -1 : 1) * (GOAL_W / 2 - 0.5));
          p.charge = { type: 'shot', t: 0, want: rand(0.6, 0.85) };
        } else if (sp.type === 'corner') {
          inp.target.set(p.dir * (HALF_L - 5), 0, rand(-3, 3));
          p.charge = { type: 'lob', t: 0, want: clamp((hdist(inp.target, p.pos) - 2) / 32, 0.15, 0.95) };
        } else {
          let mate = this.openTeammate();
          if (!mate) { let bd = 1e9; for (const q of g.players) if (q !== p && q.team === p.team) { const d = hdist(q.pos, p.pos); if (d < bd) { bd = d; mate = q; } } }
          inp.target.set(mate.pos.x + mate.dir * 1.5, 0, mate.pos.z);
          const d = hdist(inp.target, p.pos);
          if (sp.type === 'throw' && d > 12) p.charge = { type: 'lob', t: 0, want: clamp((d - 2) / 32, 0.15, 0.55) };
          else p.charge = { type: 'ground', t: 0, want: clamp((Math.sqrt(2 * 2.6 * d) + 2.5 - 4) / 16, 0.1, sp.type === 'throw' ? 0.55 : 0.95) };
        }
        return;
      }
      let nearOpp = null, dOpp = 1e9;
      for (const o of g.players) if (o.team !== p.team) { const d = hdist(o.pos, p.pos); if (d < dOpp) { dOpp = d; nearOpp = o; } }
      if (dGoal < 17 && decide && Math.random() < 0.5) {
        const k = g.keepers[1 - p.team];
        inp.target.set(goalX, 0, ((k ? k.pos.z : -p.pos.z) > 0 ? -1 : 1) * (GOAL_W / 2 - 0.6));
        p.charge = { type: 'shot', t: 0, want: rand(0.55, 0.85) };
        return;
      }
      if (decide && dOpp < 3 && Math.random() < 0.6) {
        const mate = this.openTeammate();
        if (mate) {
          const lead = 0.6;
          inp.target.set(mate.pos.x + mate.vel.x * lead, 0, mate.pos.z + mate.vel.z * lead);
          const d = hdist(inp.target, p.pos);
          const v = Math.sqrt(2 * 2.6 * d) + 2.5;
          p.charge = { type: 'ground', t: 0, want: clamp((v - 4) / 16, 0.1, 0.95) };
          return;
        }
      }
      const away = nearOpp && nearOpp.pos.z > p.pos.z ? -1 : 1;
      inp.target.set(goalX, 0, clamp(p.pos.z + away * 3, -HALF_W + 3, HALF_W - 3) * 0.6);
      inp.run = p.stamina > 0.25;
      if (nearOpp) {
        _v.set(nearOpp.pos.x - p.pos.x, 0, nearOpp.pos.z - p.pos.z);
        const front = _v.dot(p.face) / Math.max(dOpp, 0.01);
        if (dOpp < 2.2 && front > 0.5 && p.cd.skill === 0 && decide && Math.random() < 0.35) p.actions.push(Math.random() < 0.5 ? 'skillL' : 'skillR');
      }
      return;
    }

    if (b.keeper) { this.homeSpot(inp.target); inp.run = false; return; }

    const chaser = this.isChaser();
    if (b.owner && b.owner.team !== p.team) {
      if (chaser) {
        const ownX = -p.dir * HALF_L;
        _v.set(ownX - b.pos.x, 0, -b.pos.z).normalize();
        inp.target.set(b.pos.x + _v.x * 0.9, 0, b.pos.z + _v.z * 0.9);
        inp.run = true;
        const d = hdist(b.pos, p.pos);
        if (decide) {
          if (d < 1.3 && p.cd.cut === 0 && Math.random() < 0.45) p.actions.push('cut');
          else if (d < 2.6 && d > 1.4 && p.cd.slide === 0 && Math.random() < 0.08) { inp.target.copy(b.pos); p.actions.push('slide'); }
          else if (hdist(b.owner.pos, p.pos) < 1.1 && Math.random() < 0.2) p.actions.push('shoulder');
        }
      } else { this.homeSpot(inp.target); inp.run = hdist(inp.target, p.pos) > 4; }
      return;
    }

    if (b.owner && b.owner.team === p.team) {
      // 우리 팀 공: 공간으로 달려가 패스 받을 준비
      this.homeSpot(inp.target); inp.run = hdist(inp.target, p.pos) > 3;
      return;
    }

    // 루즈볼
    if (chaser) {
      const t = Math.min(0.6, hdist(b.pos, p.pos) / 7);
      inp.target.set(b.pos.x + b.vel.x * t, 0, b.pos.z + b.vel.z * t);
      inp.run = true;
      if (b.pos.y > 1.4 && hdist(b.pos, p.pos) < 2.2 && p.headerT === 0 && decide) { inp.target.set(goalX, 0, 0); p.actions.push('header'); }
    } else { this.homeSpot(inp.target); inp.run = hdist(inp.target, p.pos) > 4; }
  }
}

// ============================== 경기 ==============================
export class Game {
  // opts.ai: 빈 자리를 AI가 채움 / opts.keepers: AI 골키퍼 사용
  constructor(teamSize = 3, opts = {}) {
    this.teamSize = teamSize;
    this.ai = opts.ai ?? true; this.useKeepers = opts.keepers ?? true;
    this.ball = new Ball();
    this.slots = [];               // 모든 자리 (번호 = 선수 id)
    for (let team = 0; team < 2; team++) for (let s = 0; s < teamSize; s++) this.slots.push(new Player(this, this.slots.length, team, s));
    this.keepers = this.useKeepers ? [new Keeper(this, 0), new Keeper(this, 1)] : [];
    this.score = [0, 0]; this.timeLeft = MATCH_TIME;
    this.state = 'lobby';          // lobby | play | end
    this.freezeT = 0; this.freezeKind = null; this.afterFreeze = null;
    this.msgText = ''; this.msgT = 0;
    this.setPiece = null;          // 진행 중인 세트피스 { type, team, taker, spot, kickId, t }
    this.offside = null;           // 패스 순간 오프사이드 위치에 있던 선수들 { team, ids }
    this.ballLocked = false;       // 골킥 준비 중에는 아무도 공을 못 건드림
    this.placeForKickoff(0);
  }
  // 경기에 실제로 뛰는 선수 (AI가 꺼져 있으면 사람만)
  get players() { return this.ai ? this.slots : this.slots.filter(p => p.isHuman); }
  msg(text, dur = 1.2) { this.msgText = text; this.msgT = dur; }

  start() {
    this.score = [0, 0]; this.timeLeft = MATCH_TIME; this.state = 'play';
    for (const p of this.players) p.stamina = 1;
    this.kickoff(Math.random() < 0.5 ? 0 : 1);
  }

  placeForKickoff(team) {
    const b = this.ball;
    b.owner = null; b.keeper = null; b.vel.set(0, 0, 0); b.spin.set(0, 0, 0); b.pos.set(0, BALL_R, 0);
    for (const k of this.keepers) k.reset();
    for (const p of this.slots) {
      p.vel.set(0, 0, 0); p.y = 0; p.vy = 0; p.state = 'normal'; p.charge = null; p.pendingKick = null; p.actions.length = 0;
      p.setYaw(p.team === 0 ? 0 : Math.PI);
      for (const k in p.cd) p.cd[k] = 0;
      const f = FORMATION[p.slot % FORMATION.length];
      if (p.team === team && p.slot === 0) p.pos.set(-p.dir * 0.6, 0, 0);
      else p.pos.set(p.dir * Math.min(f.x - (p.team === team ? 0 : 4), -5), 0, f.z);
      p.input.target.set(p.pos.x + p.dir * 3, 0, p.pos.z);
    }
  }

  kickoff(team) {
    this.placeForKickoff(team);
    const pick = t => this.players.find(p => p.team === t && p.slot === 0) || this.players.find(p => p.team === t);
    const taker = pick(team) || pick(1 - team);   // 혼자 연습할 때는 있는 사람이 킥오프
    this.offside = null; this.setPiece = null;
    if (taker) {
      this.giveBall(taker);
      this.setPiece = { type: 'kickoff', team, taker, spot: new V3(0, 0, 0), kickId: this.ball.kickId, t: 0 };
    }
    this.freeze(0.9, 'kickoff');
    this.msg('킥오프', 0.9);
  }

  // ---------- 축구 규칙: 세트피스 ----------
  // type: throw | corner | goalkick | free | penalty, team: 공을 차는 팀
  setupSetPiece(type, team, spot, taker = null) {
    const b = this.ball;
    b.owner = null; b.keeper = null; b.vel.set(0, 0, 0); b.spin.set(0, 0, 0);
    this.offside = null; this.setPiece = null;
    for (const p of this.players) { p.charge = null; p.pendingKick = null; if (p.state === 'slide') p.setState('recover', 0.3); }
    if (type === 'goalkick') {      // 골킥은 골키퍼가 잡고 있다가 찬다
      const k = this.keepers[team];
      k.reset(); k.state = 'hold'; k.t = 1.6; b.keeper = k;
      b.pos.set(k.pos.x, 1.1, k.pos.z);
      this.msg(`골킥 - ${team === 0 ? '블루' : '레드'}`, 1.4);
      return;
    }
    const sideOf = t => this.players.filter(p => p.team === t && p.state !== 'stun');
    if (!taker) {   // 가장 가까운 선수가 찬다 (사람 우선)
      let best = null, bd = 1e9;
      for (const p of sideOf(team)) { const d = hdist(p.pos, spot) - (p.isHuman ? 4 : 0); if (d < bd) { bd = d; best = p; } }
      taker = best || this.players.find(p => p.team === team);
    }
    // 키커가 향할 방향
    const goalX = taker.dir * HALF_L;
    let aimX, aimZ;
    if (type === 'throw') { aimX = spot.x + taker.dir * 2; aimZ = 0; }
    else if (type === 'corner') { aimX = taker.dir * (HALF_L - PEN_SPOT); aimZ = 0; }
    else { aimX = goalX; aimZ = 0; }
    taker.setYaw(Math.atan2(aimZ - spot.z, aimX - spot.x));
    taker.state = 'normal'; taker.vel.set(0, 0, 0); taker.y = 0; taker.vy = 0;
    taker.pos.set(spot.x - taker.face.x * 0.5, 0, spot.z - taker.face.z * 0.5);
    taker.input.target.set(aimX, 0, aimZ);
    b.pos.set(spot.x, BALL_R, spot.z);
    this.giveBall(taker);
    if (type === 'penalty') {
      // 키커와 골키퍼를 뺀 모두는 페널티 박스 밖으로
      const s = taker.dir;
      for (const p of this.players) if (p !== taker && s * p.pos.x > HALF_L - BOX_DEPTH - 1) p.pos.x = s * (HALF_L - BOX_DEPTH - 1.5);
      this.keepers[1 - team]?.reset();
    }
    this.setPiece = { type, team, taker, spot: spot.clone(), kickId: b.kickId, t: 0 };
    this.msg(`${SP_NAMES[type]} - ${team === 0 ? '블루' : '레드'}`, 1.4);
  }

  // 골킥: 골 에어리어 안(공이 나간 쪽)에 공을 놓고 골키퍼가 도움닫기 후 참. 상대는 페널티 박스 밖
  setupGoalKick(team, sz) {
    const b = this.ball, k = this.keepers[team], s = team === 0 ? -1 : 1;   // 지키는 골대 쪽
    const spot = new V3(s * (HALF_L - GA_DEPTH), 0, (sz || 1) * GA_Z);
    b.owner = null; b.keeper = null; b.vel.set(0, 0, 0); b.spin.set(0, 0, 0); b.pos.set(spot.x, BALL_R, spot.z);
    this.offside = null; this.setPiece = null;
    for (const p of this.players) { p.charge = null; p.pendingKick = null; if (p.state === 'slide') p.setState('recover', 0.3); }
    if (!k) { this.setupSetPiece('free', team, spot); if (this.setPiece) this.setPiece.type = 'goalkick'; return; }
    k.reset(); k.pos.set(s * (HALF_L - 0.6), 0, spot.z * 0.5);
    k.startGoalKick(spot);
    this.ballLocked = true;
    this.setPiece = { type: 'goalkick', team, taker: k, spot, kickId: b.kickId, t: 0 };
    this.msg(`골킥 - ${team === 0 ? '블루' : '레드'}`, 1.4);
  }
  // 공이 골문 밖으로 골라인을 넘었는지: 공격팀이 마지막 → 골킥, 수비팀이 마지막 → 코너킥
  checkGoalLine() {
    const b = this.ball, p = b.pos;
    if (b.owner || b.keeper || this.freezeT > 0 || this.ballLocked) return;
    if (Math.abs(p.x) <= HALF_L + BALL_R) return;
    if (Math.abs(p.z) < GOAL_W / 2 && p.y < GOAL_H) return;      // 골문 안쪽은 골 판정에서 처리
    const s = Math.sign(p.x), defending = s === 1 ? 1 : 0;       // +x 골대는 레드가 지킴
    const last = b.lastTouch ? b.lastTouch.team : 1 - defending;
    const sz = Math.sign(p.z) || 1;
    if (last === defending) {
      const team = 1 - defending, spot = new V3(s * (HALF_L - 0.4), 0, sz * (HALF_W - 0.4));
      this.msg(`${team === 0 ? '블루' : '레드'} 코너킥`, 1.0);
      this.freeze(1.0, 'out', () => this.setupSetPiece('corner', team, spot));
    } else {
      this.msg('골라인 아웃', 1.0);
      this.freeze(1.0, 'out', () => this.setupGoalKick(defending, sz));
    }
  }

  // 세트피스 진행 관리: 상대 거리 유지, 끝났는지 판단
  updateSetPiece(dt) {
    const sp = this.setPiece, b = this.ball;
    if (!sp) return;
    sp.t += dt;
    const gk = sp.type === 'goalkick' && this.ballLocked;
    const done = b.kickId !== sp.kickId || (!gk && b.owner !== sp.taker && !b.keeper) || (sp.type === 'kickoff' && hdist(b.pos, sp.spot) > 1.0) || sp.t > 20;
    if (done) { this.setPiece = null; this.ballLocked = false; return; }
    if (gk) {   // 골킥: 상대는 페널티 박스 밖으로
      const s = sp.team === 0 ? -1 : 1;
      for (const q of this.players) {
        if (q.team === sp.team || Math.abs(q.pos.z) > BOX_HALF_W + 0.5) continue;
        if (s * q.pos.x > HALF_L - BOX_DEPTH - 0.5) q.pos.x = s * (HALF_L - BOX_DEPTH - 0.5);
      }
      return;
    }
    // 사람이 10초 동안 안 차면 자동으로 땅볼 패스
    if (sp.taker.isHuman && sp.type !== 'kickoff' && sp.t > 10 && !sp.taker.charge && !sp.taker.pendingKick) {
      sp.taker.charge = { type: sp.type === 'penalty' ? 'shot' : 'ground', t: 0, want: 0.45 };
    }
    const R = sp.type === 'kickoff' ? 4 : SP_DIST;
    for (const q of this.players) {
      if (q === sp.taker) continue;
      if (sp.type === 'penalty') {
        const s = sp.taker.dir;
        if (s * q.pos.x > HALF_L - BOX_DEPTH - 1) q.pos.x = s * (HALF_L - BOX_DEPTH - 1);
      } else if (q.team !== sp.team) {
        const dx = q.pos.x - sp.spot.x, dz = q.pos.z - sp.spot.z, d = Math.hypot(dx, dz);
        if (d < R) { const k = d > 1e-3 ? R / d : 1; q.pos.x = sp.spot.x + (d > 1e-3 ? dx * k : -q.dir * R); q.pos.z = sp.spot.z + (d > 1e-3 ? dz * k : 0); }
      }
    }
  }

  // ---------- 축구 규칙: 오프사이드 ----------
  // 패스(킥·헤딩) 순간, 상대 진영에서 공과 뒤에서 두 번째 수비수보다 앞에 있던 같은 팀 선수를 기록
  markOffside(kicker) {
    if (this.teamSize < 2) { this.offside = null; return; }   // 1대1은 오프사이드 없음
    const sp = this.setPiece;
    if (sp && ['throw', 'corner', 'goalkick'].includes(sp.type)) { this.offside = null; return; }   // 이 재개에서는 오프사이드 없음
    const d = kicker.dir;
    const defs = [...this.players.filter(o => o.team !== kicker.team).map(o => o.pos.x * d), ...this.keepers.filter(k => k.team !== kicker.team).map(k => k.pos.x * d)].sort((a, c) => c - a);
    const second = defs[1] ?? -1e9, bx = this.ball.pos.x * d;
    const ids = new Set();
    for (const q of this.players) {
      if (q === kicker || q.team !== kicker.team) continue;
      const qx = q.pos.x * d;
      if (qx > 0 && qx > bx + 0.3 && qx > second + 0.3) ids.add(q.id);
    }
    this.offside = ids.size ? { team: kicker.team, ids } : null;
  }
  // 선수가 공을 건드릴 때 호출. 오프사이드면 반칙을 선언하고 true
  touchCheck(p) {
    const o = this.offside;
    if (!o) return false;
    if (p.team === o.team && o.ids.has(p.id)) {
      this.offside = null;
      const team = 1 - p.team, spot = new V3(clamp(p.pos.x, -HALF_L + 1, HALF_L - 1), 0, clamp(p.pos.z, -HALF_W + 1, HALF_W - 1));
      const b = this.ball; b.owner = null; b.vel.set(0, 0, 0);
      this.msg(`오프사이드! ${p.name || ''}`.trim(), 1.4);
      this.freeze(1.2, 'foul', () => this.setupSetPiece('free', team, spot));
      return true;
    }
    this.offside = null;   // 다른 선수가 먼저 건드리면 해제
    return false;
  }
  freeze(t, kind, after = null) { this.freezeT = t; this.freezeKind = kind; this.afterFreeze = after; }
  giveBall(p) {
    const b = this.ball, prev = b.owner;
    if (prev && prev !== p) prev.cd.noTouch = 0.5;
    b.owner = p; b.keeper = null; b.lastTouch = p; b.vel.set(0, 0, 0); b.spin.set(0, 0, 0);
    p.offset = 0.5; p.touchT = 0;
  }

  executeKick(p, k) {
    const b = this.ball;
    _v.set(k.target.x - p.pos.x, 0, k.target.z - p.pos.z);
    if (_v.lengthSq() < 1e-4) _v.copy(p.face);
    _v.normalize();
    let err = 1.5;
    if (hlen(p.vel) > 5) err += 6;
    if (k.power > 0.9) err += 5;
    if (p.stamina < 0.2) err += 4;
    if (p.y > 0) err += 6;
    if (k.turned > 90 * DEG) err += 3;
    const a = gauss() * err * DEG, c = Math.cos(a), s = Math.sin(a);
    const dx = _v.x * c - _v.z * s, dz = _v.x * s + _v.z * c;
    let { vh, vy, spin } = kickVel(k.type, k.power);
    if (k.power > 0.9) vy += k.type === 'ground' ? rand(1, 3) : k.type === 'shot' ? rand(1.5, 4) : 0;
    this.markOffside(p);
    b.pos.set(p.pos.x + dx * 0.55, BALL_R + 0.01, p.pos.z + dz * 0.55);
    b.release(new V3(dx * vh, vy, dz * vh), p);
    if (spin) b.spin.set(-dz * spin, 0, dx * spin);
    else if (k.type === 'ground') b.setRolling(0.7);   // 땅볼은 굴러가는 회전으로 출발 (덜 미끄러짐)
    p.cd.noTouch = 0.3; p.pendingKick = null; p.kickAnim = 0.25;
  }

  tryCut(p) {
    const b = this.ball, o = b.owner;
    _w.set(p.pos.x + p.face.x * 0.7, 0, p.pos.z + p.face.z * 0.7);
    if (o && o.team !== p.team) {
      if (hdist(b.pos, _w) < 1.0 || hdist(b.pos, p.pos) < 1.1) {
        let ch = 0.55;
        if (o.input.slow) ch = 0.3;
        if (o.offset > 0.95) ch = 0.85;
        if (o.state === 'skill') ch = 0.15;
        if (Math.random() < ch) {
          if (Math.random() < 0.55) this.giveBall(p);
          else { o.cd.noTouch = 0.4; b.release(new V3(p.face.x * 4 + rand(-1, 1), 0.4, p.face.z * 4 + rand(-1, 1)), p); }
          o.setState('trip', 1.0);   // 숏태클에 걸려 1초 휘청
          this.msg('커트 성공!', 0.8);
        } else this.msg('커트 실패', 0.6);
      }
    } else if (!o && !b.keeper && !this.ballLocked && b.pos.y < 1.0 && hdist(b.pos, _w) < 1.1) { if (!this.touchCheck(p)) this.giveBall(p); }
  }

  tryShoulder(p) {
    const b = this.ball;
    for (const o of this.players) {
      if (o.team === p.team || hdist(o.pos, p.pos) > 1.2) continue;
      _v.set(o.pos.x - p.pos.x, 0, o.pos.z - p.pos.z).normalize();
      o.vel.addScaledVector(_v, 3.5);
      p.stamina = Math.max(0, p.stamina - 0.05);
      if (b.owner === o) {
        let ch = hlen(o.vel) > 5 ? 0.5 : 0.3;
        if (o.input.slow) ch *= 0.6;
        if (Math.random() < ch) { o.cd.noTouch = 0.5; b.release(new V3(_v.x * 3, 0.3, _v.z * 3), p); this.msg('몸싸움 승리!', 0.8); }
      }
    }
  }

  // 파울: 파울한 팀의 페널티 박스 안이면 페널티킥, 아니면 그 자리에서 프리킥
  foul(by, victim) {
    victim.setState('stun', 1.5);   // 반칙당한 선수도 넘어짐 (세트피스 시작 때 일어남)
    by.setState('recover', 1.6);
    const ownGoalX = -by.dir * HALF_L;
    const inBox = Math.abs(victim.pos.x - ownGoalX) < BOX_DEPTH && Math.abs(victim.pos.z) < BOX_HALF_W;
    const b = this.ball; b.owner = null; b.vel.set(0, 0, 0);
    if (inBox) {
      this.msg('파울! 페널티킥', 1.6);
      const spot = new V3(-by.dir * (HALF_L - PEN_SPOT), 0, 0);
      this.freeze(1.5, 'foul', () => this.setupSetPiece('penalty', victim.team, spot, victim));
    } else {
      this.msg('파울! 프리킥', 1.5);
      const spot = new V3(clamp(victim.pos.x, -HALF_L + 1, HALF_L - 1), 0, clamp(victim.pos.z, -HALF_W + 1, HALF_W - 1));
      this.freeze(1.3, 'foul', () => this.setupSetPiece('free', victim.team, spot, victim));
    }
  }

  step(dt) {
    if (this.msgT > 0) this.msgT -= dt;
    if (this.state !== 'play') return;
    if (this.freezeT > 0) {
      this.freezeT -= dt;
      if ((this.freezeKind === 'goal' || this.freezeKind === 'out') && !this.ball.owner && !this.ball.keeper) this.ball.step(dt);
      if (this.freezeT <= 0 && this.afterFreeze) { const f = this.afterFreeze; this.afterFreeze = null; f(); }
      this.syncOwnedBall(dt);
      return;
    }
    this.timeLeft -= dt;
    if (this.timeLeft <= 0) {
      this.timeLeft = 0; this.state = 'end';
      this.msg(this.score[0] === this.score[1] ? '경기 종료 - 무승부' : `경기 종료 - ${this.score[0] > this.score[1] ? '블루' : '레드'} 승리`, 9999);
      return;
    }
    if (this.ai) for (const p of this.players) if (!p.isHuman) p.brain.update(dt);
    for (const p of this.players) p.update(dt);
    for (const k of this.keepers) k.update(dt);
    this.updateSetPiece(dt);
    const b = this.ball;
    if (b.owner) this.syncOwnedBall(dt); else if (!b.keeper) b.step(dt);
    this.handleSlides();
    if (this.freezeT > 0) return;    // 파울이 선언되면 이번 틱은 여기서 멈춤
    this.handleAirShots(); this.handleCapture(); this.handleBodyBlocks();
    if (this.freezeT > 0) return;    // 오프사이드
    this.checkGoal(); this.checkGoalLine();   // 터치라인은 아웃 없음(벽에 튕김), 골라인은 골킥·코너킥
  }

  syncOwnedBall(dt) {
    const b = this.ball, p = b.owner;
    if (!p) return;
    const sp = hlen(p.vel);
    p.touchT += dt;
    if (sp > 4.6) { const ph = (p.touchT % 0.5) / 0.5; p.offset = 0.5 + (1 - ph) * (0.45 + (sp - 4.6) * 0.35); }
    else p.offset += (0.5 - p.offset) * Math.min(1, 6 * dt);
    if (p.input.slow) p.offset = Math.min(p.offset, 0.42);
    _v.set(p.pos.x + p.face.x * p.offset, BALL_R, p.pos.z + p.face.z * p.offset);
    b.prev.copy(b.pos);
    b.pos.lerp(_v, 1 - Math.exp(-20 * dt));
    b.pos.y = BALL_R + p.y * 0.9;
    b.vel.set(p.vel.x, 0, p.vel.z); b.setRolling(1);
  }

  handleSlides() {
    const b = this.ball;
    for (const p of this.players) {
      if (p.state !== 'slide') continue;
      const sl = p.slide;
      for (const o of this.players) {
        if (o.team === p.team || sl.hit || hdist(o.pos, p.pos) > 0.8) continue;
        if (o.y > 0.2) { if (!sl.dodged) { sl.dodged = true; this.msg('점프로 태클 회피!', 0.9); } continue; }
        sl.hit = true;
        if (sl.touched) o.setState('stun', 1.5); else { this.foul(p, o); return; }   // 깊은 태클: 넘어져 1.5초
      }
      _w.set(p.pos.x + sl.dir.x * 0.6, 0, p.pos.z + sl.dir.z * 0.6);
      if (!sl.touched && !b.keeper && !this.ballLocked && b.pos.y < 0.35 && hdist(b.pos, _w) < 0.55) {
        sl.touched = true;
        if (!b.owner && this.touchCheck(p)) return;
        const o = b.owner;
        if (o && o !== p) o.cd.noTouch = 0.5;
        const side = rand(-2, 2);
        b.release(new V3(sl.dir.x * 6 - sl.dir.z * side, 0.4, sl.dir.z * 6 + sl.dir.x * side), p);
        if (o && o !== p) this.msg('태클 성공!', 0.9);
      }
    }
  }

  // Space를 누른 뒤 0.45초 안에 공이 오면 바로 슛
  // - 공이 머리 근처(1.2m 이상): 헤딩슛 / 발~허리 높이: 발리슛 / 땅볼: 원터치 슛
  handleAirShots() {
    const b = this.ball;
    if (b.owner || b.keeper || this.ballLocked) return;
    for (const p of this.players) {
      if (p.headerT <= 0 || p.state !== 'normal') continue;
      const t = p.input.target;
      _v.set(t.x - p.pos.x, 0, t.z - p.pos.z);
      const d = _v.length() || 1; _v.multiplyScalar(1 / d);
      const incoming = Math.min(b.speed(), 30);
      _w.set(p.pos.x + p.face.x * 0.12, 1.65 + p.y, p.pos.z + p.face.z * 0.12);
      const head = b.pos.y >= 1.2 && b.pos.distanceTo(_w) < 0.7;
      const h = b.pos.y - p.y;
      _w.set(p.pos.x + p.face.x * 0.55, 0, p.pos.z + p.face.z * 0.55);
      const foot = !head && h < 1.25 && hdist(b.pos, _w) < 0.8;
      if (!head && !foot) continue;
      if (this.touchCheck(p)) return;
      this.markOffside(p);
      let err, sp, vy, name;
      if (head) {               // 헤딩슛: 오던 공의 힘을 조금 이용, 골문 가까우면 아래로 찍음
        err = 4 + (p.y > 0 ? 1 : 0); sp = 11 + incoming * 0.35; vy = d > 14 ? 2 : -1.2; name = '헤딩슛!';
        p.headAnim = 0.3;
      } else if (h > 0.25) {    // 발리슛: 공이 높을수록 뜨기 쉽고 부정확
        err = 3 + h * 4 + (incoming > 15 ? 3 : 0) + (p.y > 0 ? 3 : 0); sp = clamp(20 + incoming * 0.25, 20, 31); vy = 0.6 + h * 1.6 + rand(-0.5, 0.8); name = '발리슛!';
        p.kickAnim = 0.25;
      } else {                  // 원터치 슛: 굴러오는 공을 멈추지 않고 바로
        err = 2.5 + (incoming > 12 ? 2 : 0); sp = clamp(19 + incoming * 0.2, 19, 28); vy = 1.0 + rand(-0.3, 0.6); name = '원터치 슛!';
        p.kickAnim = 0.25;
      }
      if (hlen(p.vel) > 5) err += 2;
      const a = gauss() * err * DEG, c = Math.cos(a), sn = Math.sin(a);
      const dx = _v.x * c - _v.z * sn, dz = _v.x * sn + _v.z * c;
      p.setYaw(Math.atan2(dz, dx));
      b.release(new V3(dx * sp, vy, dz * sp), p);
      if (!head) b.spin.set(dz * 6, 0, -dx * 6);   // 발등으로 찬 약한 탑스핀
      p.headerT = 0; p.cd.noTouch = 0.3;
      this.msg(name, 0.8);
      return;
    }
  }

  handleCapture() {
    const b = this.ball;
    if (b.owner || b.keeper || this.ballLocked) return;
    let best = null, bd = 1e9;
    for (const p of this.players) {
      if (p.cd.noTouch > 0 || p.headerT > 0 || !['normal', 'cut', 'skill'].includes(p.state)) continue;   // Space 누른 선수는 받지 않고 바로 참
      _w.set(p.pos.x + p.face.x * 0.35, 0, p.pos.z + p.face.z * 0.35);
      const rel = Math.hypot(b.vel.x - p.vel.x, b.vel.z - p.vel.z);
      // 발 앞이 기본이지만, 느린 공은 옆·뒤에서 와도 몸 근처면 받아냄 (키퍼 패스를 서서 기다릴 때)
      const d = Math.min(hdist(b.pos, _w), rel < 12 ? hdist(b.pos, p.pos) - 0.1 : 9);
      // 발 높이 기준 (점프 중이면 몸이 뜬 만큼 높아짐) → 점프해서 높은 공을 가슴·발로 받기 가능
      const h = b.pos.y - p.y;
      const low = (h > -0.2 && h < 0.6) || (h >= 0.6 && h < 1.4 && rel < 10);
      if (!low || d > 0.6) continue;
      if (rel < 17) { if (d < bd) { bd = d; best = p; } }
      else { b.vel.x *= -0.25; b.vel.z *= -0.25; b.vel.y = Math.abs(b.vel.y) * 0.3 + 0.5; b.lastTouch = p; p.cd.noTouch = 0.15; }
    }
    if (best && !this.touchCheck(best)) this.giveBall(best);
  }

  handleBodyBlocks() {
    const b = this.ball;
    if (!b.owner && !b.keeper && !this.ballLocked) for (const p of this.players) {
      if (b.lastTouch === p && p.cd.noTouch > 0) continue;
      if (b.pos.y > 1.9 + p.y || b.pos.y < p.y) continue;
      const dx = b.pos.x - p.pos.x, dz = b.pos.z - p.pos.z, d = Math.hypot(dx, dz), R = 0.3 + BALL_R;
      if (d < R && d > 1e-6) {
        if (this.touchCheck(p)) return;
        b.lastTouch = p;
        const nx = dx / d, nz = dz / d;
        b.pos.x = p.pos.x + nx * R; b.pos.z = p.pos.z + nz * R;
        const rv = (b.vel.x - p.vel.x) * nx + (b.vel.z - p.vel.z) * nz;
        if (rv < 0) { b.vel.x -= 1.35 * rv * nx; b.vel.z -= 1.35 * rv * nz; }
      }
    }
    // 선수끼리 겹치지 않게
    const ps = this.players;
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
      const a = ps[i], c = ps[j];
      const dx = c.pos.x - a.pos.x, dz = c.pos.z - a.pos.z, d = Math.hypot(dx, dz);
      if (d < 0.6 && d > 1e-6) { const push = (0.6 - d) / 2, nx = dx / d, nz = dz / d; a.pos.x -= nx * push; a.pos.z -= nz * push; c.pos.x += nx * push; c.pos.z += nz * push; }
    }
  }

  checkGoal() {
    const p = this.ball.pos;
    if (Math.abs(p.z) >= GOAL_W / 2 || p.y >= GOAL_H) return;
    for (const s of [-1, 1]) {
      if (s * p.x > HALF_L + BALL_R) {
        const scorer = s === 1 ? 0 : 1;
        this.score[scorer]++;
        const who = this.ball.lastTouch?.name;
        this.msg(`골!!! ${scorer === 0 ? '블루' : '레드'} 득점${who ? ' - ' + who : ''}`, 2.4);
        this.freeze(2.5, 'goal', () => this.kickoff(1 - scorer));
        return;
      }
    }
  }

  // ---------- 네트워크용 ----------
  // 사람을 빈 자리에 배치 (사람이 적은 팀 우선). 자리가 없으면 null
  addHuman(humanId, name, preferTeam = null) {
    const humans = t => this.slots.filter(p => p.team === t && p.isHuman).length;
    const order = preferTeam !== null ? [preferTeam, 1 - preferTeam] : humans(0) <= humans(1) ? [0, 1] : [1, 0];
    for (const t of order) {
      const p = this.slots.filter(q => q.team === t && !q.isHuman).sort((a, b) => a.slot - b.slot)[0];
      if (p) { p.humanId = humanId; p.name = name; p.input.run = false; p.input.slow = false; p.charge = null; return p; }
    }
    return null;
  }
  removeHuman(humanId) {
    const p = this.slots.find(q => q.humanId === humanId);
    if (p) { p.humanId = null; p.name = ''; p.charge = null; p.input.run = false; p.input.slow = false; }
  }

  snapshot() {
    const r = v => Math.round(v * 100) / 100;
    const b = this.ball;
    return {
      t: 's', st: this.state, tm: Math.ceil(this.timeLeft), sc: this.score,
      m: this.msgT > 0 ? this.msgText : '',
      o: b.owner ? b.owner.id : -1, k: b.keeper ? b.keeper.team : -1,
      sp: this.setPiece ? [SP_TYPES.indexOf(this.setPiece.type), this.setPiece.team, this.setPiece.taker.id ?? -1] : 0,
      b: [r(b.pos.x), r(b.pos.y), r(b.pos.z), r(b.vel.x), r(b.vel.y), r(b.vel.z)],
      p: this.slots.map(p => [r(p.pos.x), r(p.pos.z), r(p.y), r(p.yaw), r(p.vel.x), r(p.vel.z),
        STATES.indexOf(p.state), r(p.stamina), p.charge ? KICKS.indexOf(p.charge.type) : 0, r(p.chargePower()),
        p.kickAnim > 0 ? 1 : 0, p.headAnim > 0 || (p.headerT > 0 && p.y > 0.1) ? 1 : 0, p.leanT > 0 ? 1 : 0,
        (p.state === 'stun' || p.state === 'trip') ? r(clamp(p.stateT / p.stateT0, 0, 1)) : 0]),
      g: this.keepers.map(k => [r(k.pos.x), r(k.pos.z), r(k.yaw), KSTATES.indexOf(k.state), r(k.diveTarget.z - k.pos.z), r(k.diveY)]),
    };
  }
  roster() {
    return { t: 'roster', teamSize: this.teamSize, ai: this.ai, players: this.slots.map(p => ({ id: p.id, team: p.team, human: p.isHuman, name: p.name })) };
  }
}
