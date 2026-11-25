// =====================================================================
// 축구 온라인 클라이언트
// - 서버가 보낸 상태를 100ms 늦게 보간해서 부드럽게 그림
// - 내 선수는 가장 최신 상태 + 속도로 살짝 앞당겨 그려 반응을 빠르게
// - 입력(커서·키·클릭)은 서버로 보내고, 판정은 서버가 함
// =====================================================================
import * as THREE from 'three';
import { makePlayerMesh, animatePlayer, animateKeeper } from './anim.js';
import { HALF_L, HALF_W, FIELD_L, FIELD_W, GOAL_W, GOAL_H, GOAL_D, ARENA_X, ARENA_Z, BALL_R, POST_R, STATES, KSTATES, KICKS, SP_TYPES, SP_NAMES, clamp, wrap } from './sim.js';

const INTERP_MS = 100;
const $ = id => document.getElementById(id);
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* 저장 불가 환경 */ } } };

// ============================== 장면 ==============================
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fb8e0); scene.fog = new THREE.Fog(0x8fb8e0, 80, 160);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 300);
scene.add(new THREE.HemisphereLight(0xdfefff, 0x35502a, 0.9));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(-20, 40, 25); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -ARENA_X - 2, right: ARENA_X + 2, top: ARENA_Z + 4, bottom: -ARENA_Z - 4, near: 1, far: 120 });
scene.add(sun);

(function buildPitch() {
  const PX = 20, W = ARENA_X * 2, H = ARENA_Z * 2;
  const cv = document.createElement('canvas'); cv.width = W * PX; cv.height = H * PX;
  const c = cv.getContext('2d');
  c.fillStyle = '#2f7a3a'; c.fillRect(0, 0, cv.width, cv.height);
  for (let i = 0; i < 10; i++) if (i % 2) { c.fillStyle = '#358a41'; c.fillRect((ARENA_X - HALF_L + i * FIELD_L / 10) * PX, (ARENA_Z - HALF_W) * PX, FIELD_L / 10 * PX, FIELD_W * PX); }
  const X = x => (x + ARENA_X) * PX, Z = z => (z + ARENA_Z) * PX;
  c.strokeStyle = 'rgba(255,255,255,.92)'; c.lineWidth = 0.12 * PX; c.fillStyle = '#fff';
  c.strokeRect(X(-HALF_L), Z(-HALF_W), FIELD_L * PX, FIELD_W * PX);
  c.beginPath(); c.moveTo(X(0), Z(-HALF_W)); c.lineTo(X(0), Z(HALF_W)); c.stroke();
  c.beginPath(); c.arc(X(0), Z(0), 4 * PX, 0, Math.PI * 2); c.stroke();
  for (const s of [-1, 1]) {
    const x0 = s * HALF_L;
    c.strokeRect(Math.min(X(x0), X(x0 - s * 8)), Z(-8), 8 * PX, 16 * PX);
    c.strokeRect(Math.min(X(x0), X(x0 - s * 3)), Z(-4.5), 3 * PX, 9 * PX);
    c.beginPath(); c.arc(X(x0 - s * 6), Z(0), 0.15 * PX, 0, Math.PI * 2); c.fill();
  }
  c.beginPath(); c.arc(X(0), Z(0), 0.15 * PX, 0, Math.PI * 2); c.fill();
  const tex = new THREE.CanvasTexture(cv); tex.anisotropy = 8; tex.colorSpace = THREE.SRGBColorSpace;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
  const outer = new THREE.Mesh(new THREE.PlaneGeometry(W + 60, H + 60), new THREE.MeshStandardMaterial({ color: 0x24402a }));
  outer.rotation.x = -Math.PI / 2; outer.position.y = -0.02; scene.add(outer);
  const boardM = new THREE.MeshStandardMaterial({ color: 0x1f3d7a });
  for (const [w, d, x, z] of [[W, 0.15, 0, ARENA_Z], [W, 0.15, 0, -ARENA_Z], [0.15, H, ARENA_X, 0], [0.15, H, -ARENA_X, 0]]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.8, d), boardM); m.position.set(x, 0.4, z); m.castShadow = true; scene.add(m);
  }
  const postM = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 });
  const netM = new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.35 });
  for (const s of [-1, 1]) {
    const gx = s * HALF_L;
    for (const z of [-GOAL_W / 2, GOAL_W / 2]) { const post = new THREE.Mesh(new THREE.CylinderGeometry(POST_R, POST_R, GOAL_H, 12), postM); post.position.set(gx, GOAL_H / 2, z); post.castShadow = true; scene.add(post); }
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(POST_R, POST_R, GOAL_W, 12), postM); bar.rotation.x = Math.PI / 2; bar.position.set(gx, GOAL_H, 0); scene.add(bar);
    const back = new THREE.Mesh(new THREE.PlaneGeometry(GOAL_W, GOAL_H, 12, 6), netM); back.rotation.y = Math.PI / 2; back.position.set(gx + s * GOAL_D, GOAL_H / 2, 0); scene.add(back);
    const top = new THREE.Mesh(new THREE.PlaneGeometry(GOAL_D, GOAL_W, 4, 12), netM); top.rotation.x = Math.PI / 2; top.position.set(gx + s * GOAL_D / 2, GOAL_H, 0); scene.add(top);
    for (const z of [-GOAL_W / 2, GOAL_W / 2]) { const side = new THREE.Mesh(new THREE.PlaneGeometry(GOAL_D, GOAL_H, 4, 6), netM); side.position.set(gx + s * GOAL_D / 2, GOAL_H / 2, z); scene.add(side); }
  }
})();

function makeLabel(text, color) {
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 64;
  const c = cv.getContext('2d');
  c.font = 'bold 30px "Malgun Gothic", sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.lineWidth = 6; c.strokeStyle = 'rgba(0,0,0,.85)'; c.strokeText(text, 128, 34);
  c.fillStyle = color; c.fillText(text, 128, 34);
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sp.scale.set(2.3, 0.575, 1); sp.position.y = 2.35; sp.renderOrder = 10;
  return sp;
}

const ballMesh = (() => {
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 128;
  const c = cv.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, 256, 128); c.fillStyle = '#111';
  for (let i = 0; i < 12; i++) { c.beginPath(); c.arc((i % 6) * 44 + (i < 6 ? 12 : 34), i < 6 ? 34 : 94, 13, 0, Math.PI * 2); c.fill(); }
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 20, 14), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.4 }));
  mesh.castShadow = true; scene.add(mesh); return mesh;
})();
const ballBlob = new THREE.Mesh(new THREE.CircleGeometry(0.16, 20), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4 }));
ballBlob.rotation.x = -Math.PI / 2; ballBlob.position.y = 0.012; scene.add(ballBlob);
const ring = (r1, r2, color, y) => { const m = new THREE.Mesh(new THREE.RingGeometry(r1, r2, 32), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 })); m.rotation.x = -Math.PI / 2; m.position.y = y; scene.add(m); return m; };
const meRing = ring(0.45, 0.55, 0x5ee3ff, 0.015), ownRing = ring(0.62, 0.68, 0xffe066, 0.016), cursorMark = ring(0.22, 0.3, 0xffffff, 0.02);
meRing.visible = false;
const aimLineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
const aimLine = new THREE.Line(aimLineGeo, new THREE.LineBasicMaterial({ color: 0xffffff })); aimLine.visible = false; scene.add(aimLine);

const keeperMeshes = [makePlayerMesh(0x19a974, 0x1d1d1d, true), makePlayerMesh(0xe8b91a, 0x1d1d1d, true)];
keeperMeshes.forEach(k => scene.add(k));
let playerMeshes = [];   // 선수 수는 서버가 알려줌
let roster = [], rosterAI = true;

function buildPlayers(r) {
  for (const m of playerMeshes) scene.remove(m);
  playerMeshes = r.players.map(p => {
    const m = p.team === 0 ? makePlayerMesh(0x2f6fde, 0x16244a) : makePlayerMesh(0xd8342c, 0x3d0f0f);
    scene.add(m); return m;
  });
}
// 이름표 색: 나 = 노랑, 우리 팀 = 초록, 상대 = 팀 색, AI = 회색
function labelColor(p) {
  if (!p.human) return '#c8ced6';
  if (p.id === net.you) return '#ffe066';
  const mine = roster.find(q => q.id === net.you);
  if (mine && mine.team === p.team) return '#8dff9a';
  return p.team === 0 ? '#9fc0ff' : '#ffb0a8';
}
function applyRoster(r) {
  if (playerMeshes.length !== r.players.length) buildPlayers(r);
  roster = r.players; rosterAI = r.ai !== false;
  r.players.forEach((p, i) => {
    const m = playerMeshes[i];
    if (m.userData.label) { m.remove(m.userData.label); m.userData.label = null; }
    const text = `[${p.team === 0 ? 'BLUE' : 'RED'}]${p.human ? p.name : 'AI'}`;
    m.userData.label = makeLabel(text, labelColor(p));
    m.add(m.userData.label);
  });
  renderLobby();
}

// ============================== 네트워크 ==============================
const net = { ws: null, you: -1, room: '', snaps: [], ping: 0, connected: false };

function connect(name, room) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?room=${encodeURIComponent(room)}&name=${encodeURIComponent(name)}`);
  net.ws = ws; net.room = room;
  ws.onopen = () => { net.connected = true; };
  ws.onclose = () => { net.connected = false; $('status').textContent = '서버와 연결이 끊겼습니다. 새로고침해서 다시 들어오세요.'; };
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.t === 's') { net.snaps.push({ at: performance.now(), s: m }); if (net.snaps.length > 40) net.snaps.shift(); onSnapshot(m); }
    else if (m.t === 'welcome') { net.you = m.you; net.room = m.room; if (roster.length) applyRoster({ players: roster, ai: rosterAI }); else renderLobby(); }
    else if (m.t === 'roster') applyRoster(m);
    else if (m.t === 'pong') net.ping = Math.round(performance.now() - m.c);
  };
  setInterval(() => send({ t: 'ping', c: performance.now() }), 2000);
}
function send(obj) { if (net.ws && net.ws.readyState === 1) net.ws.send(JSON.stringify(obj)); }

let lastState = '';
function onSnapshot(s) {
  if (s.st !== lastState) {
    lastState = s.st;
    if (s.st === 'play') lobbyView.hidden = true;
    else { lobbyView.hidden = false; renderLobby(); }
  }
}

// ============================== 접속 / 대기실 UI ==============================
const joinView = $('joinView'), lobbyView = $('lobbyView');
const params = new URLSearchParams(location.search);
$('nameInput').value = store.get('soccer-name') || '';
$('roomInput').value = params.get('room') || 'main';
$('joinForm').addEventListener('submit', e => {
  e.preventDefault();
  const name = $('nameInput').value.trim() || '선수', room = $('roomInput').value.trim() || 'main';
  store.set('soccer-name', name);
  joinView.hidden = true; lobbyView.hidden = false;
  history.replaceState(null, '', `?room=${encodeURIComponent(room)}`);
  connect(name, room);
});
$('startBtn').addEventListener('click', () => send({ t: 'start' }));
$('toBlue').addEventListener('click', () => send({ t: 'team', team: 0 }));
$('toRed').addEventListener('click', () => send({ t: 'team', team: 1 }));
$('closeLobby').addEventListener('click', () => { if (lastState === 'play') lobbyView.hidden = true; });

function renderLobby() {
  const s = net.snaps.at(-1)?.s;
  const st = s?.st || 'lobby';
  $('lobbyTitle').textContent = st === 'end' ? '경기 종료' : st === 'play' ? '팀 · 초대' : '대기실';
  $('result').textContent = st === 'end' && s ? `블루 ${s.sc[0]} : ${s.sc[1]} 레드 — ${s.sc[0] === s.sc[1] ? '무승부' : s.sc[0] > s.sc[1] ? '블루 승리' : '레드 승리'}` : '';
  $('startBtn').textContent = st === 'end' ? '다시 시작' : '경기 시작';
  $('startBtn').hidden = st === 'play';
  for (const [team, el] of [[0, $('teamB')], [1, $('teamR')]]) {
    el.replaceChildren(...roster.filter(p => p.team === team).map(p => {
      const li = document.createElement('li');
      li.textContent = p.human ? p.name + (p.id === net.you ? ' (나)' : '') : rosterAI ? 'AI' : '빈 자리 (친구 대기)';
      li.className = p.human ? (p.id === net.you ? 'me' : '') : 'ai';
      return li;
    }));
  }
  $('inviteLink').textContent = `${location.origin}${location.pathname}?room=${encodeURIComponent(net.room || 'main')}`;
}

// ============================== 입력 ==============================
const mouse = new THREE.Vector2(0, 0), raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const cursorPoint = new THREE.Vector3(5, 0, 0), _w = new THREE.Vector3();
const input = { run: false, slow: false };
let localCharge = null;   // 내 화면에 보여줄 파워 게이지 (판정은 서버)
const playing = () => net.connected && lastState === 'play' && lobbyView.hidden;
const myHasBall = () => net.snaps.at(-1)?.s.o === net.you;

addEventListener('mousemove', e => { mouse.x = e.clientX / innerWidth * 2 - 1; mouse.y = -(e.clientY / innerHeight) * 2 + 1; });
addEventListener('contextmenu', e => e.preventDefault());
renderer.domElement.addEventListener('mousedown', e => {
  if (!playing() || localCharge) return;
  const k = e.button === 0 ? 'lob' : e.button === 2 ? 'ground' : null;
  if (!k) return;
  localCharge = { k, t0: performance.now() }; send({ t: 'c', k });
});
addEventListener('mouseup', e => {
  const k = e.button === 0 ? 'lob' : e.button === 2 ? 'ground' : null;
  if (k && localCharge?.k === k) { localCharge = null; sendInput(); send({ t: 'r', k }); }
});
addEventListener('keydown', e => {
  // F1~F5 카메라 (브라우저 기본 동작인 도움말·새로고침은 막음)
  if (/^F[1-5]$/.test(e.code)) { e.preventDefault(); if (!e.repeat && joinView.hidden) setCam(Number(e.code.slice(1)) - 1); return; }
  if (['Space', 'ShiftLeft', 'ShiftRight', 'Tab'].includes(e.code) && joinView.hidden) e.preventDefault();
  if (e.repeat || !joinView.hidden) return;
  if (e.code === 'Tab') { lobbyView.hidden = lastState === 'play' ? !lobbyView.hidden : false; renderLobby(); return; }
  if (e.code === 'KeyH') { $('help').hidden = !$('help').hidden; return; }
  if (!playing()) return;
  // 키 배치: Shift 달리기 / Z 슬라이딩 태클 / X 커트 / C 점프 / V 몸싸움 / A 천천히 걷기 / Q·E 개인기
  const act = { KeyZ: 'slide', KeyX: 'cut', KeyC: 'jump', KeyV: 'shoulder', KeyQ: 'skillL', KeyE: 'skillR' }[e.code];
  if (act) { sendInput(); send({ t: 'a', a: act }); return; }
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') { input.run = true; sendInput(); }
  if (e.code === 'KeyA') { input.slow = true; sendInput(); }
  if (e.code === 'Space') {
    sendInput();
    if (myHasBall() && !localCharge) localCharge = { k: 'shot', t0: performance.now() };
    send({ t: 'sp', d: 1 });
  }
});
addEventListener('keyup', e => {
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') { input.run = false; sendInput(); }
  if (e.code === 'KeyA') { input.slow = false; sendInput(); }
  if (e.code === 'Space') { if (localCharge?.k === 'shot') localCharge = null; sendInput(); send({ t: 'sp', d: 0 }); }
});
addEventListener('blur', () => { input.run = input.slow = false; sendInput(); });

let lastSent = 0;
function sendInput() {
  send({ t: 'i', x: Math.round(cursorPoint.x * 100) / 100, z: Math.round(cursorPoint.z * 100) / 100, r: input.run ? 1 : 0, s: input.slow ? 1 : 0 });
  lastSent = performance.now();
}

// ============================== 보간 ==============================
const lerp = (a, b, t) => a + (b - a) * t;
const lerpAng = (a, b, t) => a + wrap(b - a) * t;
const view = { players: [], keepers: [], ball: new THREE.Vector3(), ballVel: new THREE.Vector3(), s: null };

function interpolate(now) {
  const snaps = net.snaps;
  if (!snaps.length) return false;
  const latest = snaps.at(-1);
  const rt = now - INTERP_MS;
  let a = snaps[0], b = latest;
  for (let i = snaps.length - 1; i > 0; i--) if (snaps[i - 1].at <= rt) { a = snaps[i - 1]; b = snaps[i]; break; }
  const t = b.at === a.at ? 1 : clamp((rt - a.at) / (b.at - a.at), 0, 1);
  const A = a.s, B = b.s, L = latest.s;
  view.s = L;
  view.players = B.p.map((pb, i) => {
    const pa = A.p[i] || pb;
    if (i === net.you) {   // 내 선수: 최신 상태 + 속도로 앞당김
      const pl = L.p[i], age = Math.min(0.1, (now - latest.at) / 1000);
      return { x: pl[0] + pl[4] * age, z: pl[1] + pl[5] * age, y: pl[2], yaw: pl[3], vx: pl[4], vz: pl[5], st: pl[6], stam: pl[7], ck: pl[8], cp: pl[9], kick: pl[10], head: pl[11], lean: pl[12] };
    }
    return { x: lerp(pa[0], pb[0], t), z: lerp(pa[1], pb[1], t), y: lerp(pa[2], pb[2], t), yaw: lerpAng(pa[3], pb[3], t), vx: pb[4], vz: pb[5],
      st: pb[6], stam: pb[7], ck: pb[8], cp: pb[9], kick: pb[10], head: pb[11], lean: pb[12] };
  });
  view.keepers = B.g.map((kb, i) => { const ka = A.g[i] || kb; return { x: lerp(ka[0], kb[0], t), z: lerp(ka[1], kb[1], t), yaw: lerpAng(ka[2], kb[2], t), st: kb[3], dz: kb[4], dy: kb[5] }; });
  if (L.o === net.you && L.o >= 0) {   // 내가 공을 가지면 공도 내 선수 기준으로
    const me = view.players[net.you], pl = L.p[net.you];
    view.ball.set(L.b[0] - pl[0] + me.x, L.b[1], L.b[2] - pl[1] + me.z);
  } else view.ball.set(lerp(A.b[0], B.b[0], t), lerp(A.b[1], B.b[1], t), lerp(A.b[2], B.b[2], t));
  view.ballVel.set(B.b[3], B.b[4], B.b[5]);
  return true;
}

// ============================== 그리기 ==============================
// 카메라 5종 (F1~F5). 모두 화면 방향이 고정이고, 선수·공을 따라 위치만 움직임 (화면이 돌지 않음)
const CAMS = ['높은 쿼터뷰', '가까운 쿼터뷰', '측면 방송', '탑뷰', '골대 뒤'];
let camMode = Number(store.get('soccer-cam3') ?? 0); if (!(camMode >= 0 && camMode < CAMS.length)) camMode = 0;
function setCam(i) { camMode = i; store.set('soccer-cam3', i); updateHUD(); }
const camLook = new THREE.Vector3();
function updateCamera(dt) {
  const me = view.players[net.you] || { x: 0, z: 0 }, b = view.ball;
  const want = new THREE.Vector3(), look = new THREE.Vector3();
  const focus = new THREE.Vector3(lerp(me.x, b.x, 0.3), 0, lerp(me.z, b.z, 0.3));
  if (camMode === 0) { look.copy(focus); want.set(focus.x - 3, 21, focus.z + 15); }                       // F1 높은 쿼터뷰: 넓게
  else if (camMode === 1) { look.copy(focus); want.set(focus.x - 2, 11, focus.z + 9); }                   // F2 가까운 쿼터뷰: 선수 크게
  else if (camMode === 2) { look.set(b.x * 0.75 + me.x * 0.25, 0, (b.z + me.z) * 0.25); want.set(look.x, 20, ARENA_Z + 17); }   // F3 측면 방송: TV 중계처럼 옆에서
  else if (camMode === 3) { look.copy(focus); want.set(focus.x, 34, focus.z + 0.01); }                    // F4 탑뷰: 바로 위
  else {                                                                                                   // F5 골대 뒤: 내 골대 쪽 뒤에서 공격 방향을 봄
    const d = roster[net.you]?.team === 1 ? -1 : 1;
    look.set(focus.x + d * 6, 0, focus.z); want.set(focus.x - d * 14, 12, focus.z);
  }
  const k = 1 - Math.exp(-4.5 * dt);
  camera.position.lerp(want, k); camLook.lerp(look, k); camera.lookAt(camLook);
}

function syncPlayerMesh(m, p, dt) {
  m.position.set(p.x, p.y, p.z); m.rotation.y = -p.yaw;
  animatePlayer(m, p, STATES[p.st], dt);   // 관절 애니메이션 (anim.js)
}
function syncKeeperMesh(m, k, dt) {
  m.position.set(k.x, 0, k.z); m.rotation.y = -k.yaw;
  animateKeeper(m, k, KSTATES[k.st], dt);
}

const rollAxis = new THREE.Vector3();
const KICK_NAMES = { lob: '로빙패스', ground: '땅볼패스', shot: '슛' };
const KICK_COLORS = { lob: 0x7fd3ff, ground: 0x9cff8a, shot: 0xffd166 };

// ---------- 미니맵 (하단 가운데) ----------
const mini = $('mini'), mctx = mini.getContext('2d');
function drawMini() {
  const W = mini.width, H = mini.height, pad = 16, sx = (W - pad * 2) / FIELD_L, sz = (H - pad * 2) / FIELD_W;
  const X = x => pad + (x + HALF_L) * sx, Z = z => pad + (z + HALF_W) * sz;
  mctx.fillStyle = '#2c6b34'; mctx.fillRect(0, 0, W, H);
  mctx.fillStyle = '#327a3b';
  for (let i = 0; i < 10; i += 2) mctx.fillRect(X(-HALF_L + i * FIELD_L / 10), Z(-HALF_W), FIELD_L / 10 * sx, FIELD_W * sz);
  mctx.strokeStyle = 'rgba(255,255,255,.85)'; mctx.lineWidth = 2;
  mctx.strokeRect(X(-HALF_L), Z(-HALF_W), FIELD_L * sx, FIELD_W * sz);
  mctx.beginPath(); mctx.moveTo(X(0), Z(-HALF_W)); mctx.lineTo(X(0), Z(HALF_W)); mctx.stroke();
  mctx.beginPath(); mctx.arc(X(0), Z(0), 4.5 * sx, 0, Math.PI * 2); mctx.stroke();
  mctx.fillStyle = '#fff';
  for (const s of [-1, 1]) {   // 페널티 박스와 골대
    mctx.strokeRect(s < 0 ? X(-HALF_L) : X(HALF_L - 8), Z(-8), 8 * sx, 16 * sz);
    mctx.fillRect(s < 0 ? X(-HALF_L) - 6 : X(HALF_L), Z(-GOAL_W / 2), 6, GOAL_W * sz);
  }
  view.players.forEach((p, i) => {
    const info = roster[i]; if (!info || !(rosterAI || info.human)) return;
    const me = i === net.you;
    mctx.beginPath(); mctx.arc(X(p.x), Z(p.z), me ? 8 : 6, 0, Math.PI * 2);
    mctx.fillStyle = info.team === 0 ? '#3d7cf0' : '#e0463c'; mctx.fill();
    mctx.lineWidth = me ? 3 : 1.5; mctx.strokeStyle = me ? '#ffe066' : 'rgba(0,0,0,.6)'; mctx.stroke();
  });
  view.keepers.forEach((k, i) => { mctx.beginPath(); mctx.arc(X(k.x), Z(k.z), 6, 0, Math.PI * 2); mctx.fillStyle = i === 0 ? '#19a974' : '#e8b91a'; mctx.fill(); });
  mctx.beginPath(); mctx.arc(X(clamp(view.ball.x, -ARENA_X, ARENA_X)), Z(clamp(view.ball.z, -ARENA_Z, ARENA_Z)), 4.5, 0, Math.PI * 2);
  mctx.fillStyle = '#fff'; mctx.fill(); mctx.lineWidth = 1.5; mctx.strokeStyle = '#111'; mctx.stroke();
}

function updateHUD() {
  const s = view.s; if (!s) return;
  $('ping').textContent = `PING ${net.ping}`; $('ping').classList.toggle('bad', net.ping > 150);
  $('sb').textContent = s.sc[0]; $('sr').textContent = s.sc[1];
  $('timer').textContent = `${Math.floor(s.tm / 60)}:${String(s.tm % 60).padStart(2, '0')}`;
  const me = roster.find(p => p.id === net.you);
  const humans = roster.filter(p => p.human).length;
  const ballTxt = s.o === net.you ? '내 공' : s.o >= 0 ? (roster[s.o]?.team === me?.team ? '우리 팀 공' : '상대 공') : s.k >= 0 ? (s.k === me?.team ? '우리 키퍼' : '상대 키퍼') : '루즈볼';
  let spTxt = '';
  if (s.sp) {
    const type = SP_TYPES[s.sp[0]];
    spTxt = `\n${SP_NAMES[type]} - ${s.sp[1] === 0 ? '블루' : '레드'}`;
    if (s.sp[2] === net.you && type !== 'kickoff') spTxt += type === 'throw' ? '\n내가 던짐: 클릭으로 패스 (제자리)' : '\n내가 참: 클릭 패스 / Space 슛 (제자리)';
  }
  $('status').textContent = `방: ${net.room} · 접속 ${humans}명\n공: ${ballTxt}${spTxt}`;
  $('status').style.whiteSpace = 'pre';
  $('cam').textContent = `카메라: F${camMode + 1} ${CAMS[camMode]} (F1~F5)\n${me ? (me.team === 0 ? '블루 팀' : '레드 팀') : '관전 중'} · Tab: 팀·초대`;
  $('cam').style.whiteSpace = 'pre';
  const my = view.players[net.you];
  if (localCharge && my) {
    $('gaugeWrap').style.visibility = 'visible';
    const pw = clamp((performance.now() - localCharge.t0) / 1000, 0, 1);
    $('gauge').firstElementChild.style.width = (pw * 100) + '%';
    $('gaugeLabel').textContent = `${KICK_NAMES[localCharge.k]} 파워 ${Math.round(pw * 100)}%`;
    $('gaugeLabel').style.color = pw > 0.9 ? '#ff7b72' : '#f2f5fa';
  } else $('gaugeWrap').style.visibility = 'hidden';
  if (my) { const f = $('stam').firstElementChild; f.style.width = (my.stam * 100) + '%'; f.style.background = my.stam < 0.2 ? '#ff7b72' : '#4fc3f7'; }
  $('msg').textContent = s.m; $('msg').style.opacity = s.m ? 1 : 0;
}

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  raycaster.setFromCamera(mouse, camera);
  if (raycaster.ray.intersectPlane(groundPlane, _w)) cursorPoint.set(clamp(_w.x, -ARENA_X, ARENA_X), 0, clamp(_w.z, -ARENA_Z, ARENA_Z));
  if (playing() && now - lastSent > 50) sendInput();

  if (interpolate(now)) {
    view.players.forEach((p, i) => { const m = playerMeshes[i]; if (!m) return; m.visible = rosterAI || !!roster[i]?.human; if (m.visible) syncPlayerMesh(m, p, dt); });
    keeperMeshes.forEach((m, i) => { m.visible = !!view.keepers[i]; if (m.visible) syncKeeperMesh(m, view.keepers[i], dt); });
    ballMesh.position.copy(view.ball);
    drawMini();
    const sp = Math.hypot(view.ballVel.x, view.ballVel.z);
    if (sp > 0.01) { rollAxis.set(view.ballVel.z, 0, -view.ballVel.x).normalize(); ballMesh.rotateOnWorldAxis(rollAxis, sp * dt / BALL_R); }
    ballBlob.position.set(view.ball.x, 0.012, view.ball.z);
    const hgt = view.ball.y - BALL_R; ballBlob.scale.setScalar(1 + hgt * 0.25); ballBlob.material.opacity = Math.max(0.12, 0.45 - hgt * 0.06);
    const me = view.players[net.you];
    meRing.visible = !!me; if (me) meRing.position.set(me.x, 0.015, me.z);
    const s = view.s;
    const holder = s.o >= 0 ? view.players[s.o] : s.k >= 0 ? view.keepers[s.k] : null;
    ownRing.visible = !!holder; if (holder) ownRing.position.set(holder.x, 0.016, holder.z);
    aimLine.visible = !!(localCharge && me);
    if (aimLine.visible) {
      aimLineGeo.setFromPoints([new THREE.Vector3(me.x, 0.05, me.z), new THREE.Vector3(cursorPoint.x, 0.05, cursorPoint.z)]);
      aimLine.material.color.setHex(KICK_COLORS[localCharge.k]);
    }
    updateHUD();
  }
  cursorMark.position.set(cursorPoint.x, 0.02, cursorPoint.z);
  updateCamera(dt);
  renderer.render(scene, camera);
}
camera.position.set(-7, 16, 13); camLook.set(0, 0, 0);
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
requestAnimationFrame(frame);
window.__net = net;   // 테스트용
