// =====================================================================
// 선수 관절 모델 + 절차적 애니메이션
// - 뼈대: 몸 → 골반 → 허리 → 가슴 → 목 → 머리 / 어깨 → 팔꿈치 → 손 / 엉덩이 → 무릎 → 발목 → 발
// - 매 프레임 상태(속도·동작)로 관절 목표 각도를 계산하고, 부드럽게 따라가게 섞음
// 좌표: 선수는 로컬 +x를 바라봄, +z가 오른쪽, +y가 위
//   관절 rotation.z 양수 = 앞으로 굽힘(엉덩이 굴곡·팔 앞으로), 무릎은 음수로 접힘
// =====================================================================
import * as THREE from 'three';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const mix = (a, b, t) => a + (b - a) * t;
const wrap = a => { while (a > Math.PI) a -= TAU; while (a < -Math.PI) a += TAU; return a; };

// 한쪽 끝이 관절에 붙은 막대 (아래로 len 만큼)
function limb(len, r1, r2, mat) {
  const g = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, len, 10), mat);
  g.position.y = -len / 2; g.castShadow = true;
  return g;
}
function joint(parent, x, y, z) { const j = new THREE.Group(); j.position.set(x, y, z); parent.add(j); return j; }

export function makePlayerMesh(shirt, shorts, isKeeper = false) {
  const m = c => new THREE.MeshStandardMaterial({ color: c, roughness: 0.65 });
  const shirtM = m(shirt), shortsM = m(shorts), skinM = m(0xe2b48a), bootM = m(0x151515);
  const sockM = m(isKeeper ? 0x222222 : shirt), hairM = m(0x2b1d14), gloveM = m(0xf4f4f4);

  const root = new THREE.Group();
  const body = joint(root, 0, 0.94, 0);              // 몸 전체. 엉덩이 높이를 축으로 통째로 기울임 (슬라이딩·다이빙·넘어짐)
  const pelvis = joint(body, 0, 0, 0);               // 골반
  const hips = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.2, 0.36), shortsM); hips.position.y = -0.02; pelvis.add(hips);
  const spine = joint(pelvis, 0, 0.06, 0);           // 허리
  const chest = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.3, 4, 12), shirtM); chest.position.y = 0.25; chest.scale.set(0.95, 1, 1.35); spine.add(chest);
  const neck = joint(spine, 0, 0.53, 0);             // 목
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.115, 16, 12), skinM); head.position.y = 0.13; neck.add(head);
  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 8, 0, TAU, 0, Math.PI * 0.55), hairM); hair.position.set(-0.01, 0.145, 0); neck.add(hair);
  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.04, 0.035), skinM); nose.position.set(0.115, 0.12, 0); neck.add(nose);

  const arm = side => {   // side: -1 왼쪽, +1 오른쪽
    const sh = joint(spine, 0, 0.44, side * 0.24);
    sh.add(limb(0.28, 0.055, 0.048, isKeeper ? shirtM : shirtM));
    const el = joint(sh, 0, -0.28, 0);
    el.add(limb(0.25, 0.045, 0.038, isKeeper ? shirtM : skinM));
    const hand = new THREE.Mesh(new THREE.SphereGeometry(isKeeper ? 0.065 : 0.045, 10, 8), isKeeper ? gloveM : skinM); hand.position.y = -0.27; el.add(hand);
    return { sh, el };
  };
  const leg = side => {
    const hip = joint(pelvis, 0, -0.06, side * 0.1);
    hip.add(limb(0.44, 0.075, 0.058, skinM));
    const shortLeg = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.08, 0.16, 10), shortsM); shortLeg.position.y = -0.06; hip.add(shortLeg);
    const knee = joint(hip, 0, -0.44, 0);
    knee.add(limb(0.41, 0.058, 0.042, sockM));
    const ankle = joint(knee, 0, -0.41, 0);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.07, 0.1), bootM); foot.position.set(0.06, -0.035, 0); foot.castShadow = true; ankle.add(foot);
    return { hip, knee, ankle };
  };
  const L = { arm: arm(-1), leg: leg(-1) }, R = { arm: arm(1), leg: leg(1) };
  root.traverse(o => { if (o.isMesh) o.castShadow = true; });
  root.userData = {
    body, pelvis, spine, neck, L, R, isKeeper,
    phase: 0, kickT: -1, prevKick: 0, prevYaw: null, prevX: null, prevZ: null, spd: 0, bank: 0,
    cur: {},   // 현재 관절 각도 (부드럽게 따라감)
  };
  return root;
}

// ---------- 관절 각도 묶음 ----------
const JOINTS = ['hipL', 'hipR', 'kneeL', 'kneeR', 'ankL', 'ankR', 'shL', 'shR', 'abL', 'abR', 'elL', 'elR',
  'spZ', 'spY', 'spX', 'nkZ', 'bdZ', 'bdX', 'bdY', 'pvY', 'pvR'];
function blank() { const o = {}; for (const k of JOINTS) o[k] = 0; o.abL = 0.1; o.abR = 0.1; return o; }

// 걷기·달리기 보행 주기. sp: 속도(m/s)
function gait(t, ud, sp, dt) {
  const freq = sp < 0.15 ? 0 : 0.75 + sp * 0.15;          // 초당 걸음 주기 (걷기 0.9, 전력질주 1.8)
  ud.phase = (ud.phase + freq * TAU * dt) % TAU;
  const on = clamp(sp / 1.0, 0, 1);                       // 멈춰 있으면 0
  const run = clamp((sp - 2) / 4, 0, 1);                   // 걷기 0 → 달리기 1
  const ph = ud.phase;
  for (const [s, off] of [['L', 0], ['R', Math.PI]]) {
    const f = ph + off;
    const hip = mix(0.32, 0.72, run) * Math.sin(f) * on;
    // 무릎은 다리를 앞으로 내미는 중간에 가장 많이 접히고, 땅을 디딜 때는 거의 펴짐
    const swing = Math.pow(Math.max(0, Math.cos(f)), 1.4);
    const knee = -(mix(0.06, 0.22, run) + mix(0.55, 1.65, run) * swing) * on;
    t['hip' + s] = hip;
    t['knee' + s] = knee;
    t['ank' + s] = (-0.35 * hip - 0.25 * knee) * on;       // 발이 땅과 대략 평행하게
  }
  // 팔은 반대쪽 다리와 같은 박자로 흔듦, 달릴수록 팔꿈치를 더 굽힘
  const arm = mix(0.22, 0.75, run) * on;
  t.shL = -arm * Math.sin(ph);
  t.shR = -arm * Math.sin(ph + Math.PI);
  const elb = mix(0.25, 1.45, run);
  t.elL = elb + 0.25 * run * Math.max(0, Math.sin(ph + Math.PI));
  t.elR = elb + 0.25 * run * Math.max(0, Math.sin(ph));
  t.abL = t.abR = mix(0.1, 0.18, run);
  // 몸통: 달릴수록 앞으로 숙이고, 골반 반대로 비틀고, 위아래로 들썩임
  t.spZ = -(0.04 + 0.2 * run) * on;
  t.spY = 0.16 * run * Math.sin(ph) * on;
  t.pvR = -0.1 * run * Math.sin(ph) * on;
  t.pvY = (-0.03 * run + mix(0.012, 0.045, run) * Math.cos(2 * ph)) * on;
  t.nkZ = -t.spZ * 0.6;                                     // 고개는 앞을 봄
  if (sp < 0.15) {                                          // 서 있을 때: 숨쉬기, 살짝 굽힌 무릎
    const br = Math.sin(performance.now() / 600);
    t.kneeL = t.kneeR = -0.08; t.hipL = t.hipR = 0.04;
    t.elL = t.elR = 0.2 + br * 0.03; t.spZ = -0.03 + br * 0.01;
  }
}

function applyJoints(ud, t, dt, rate = 18) {
  const k = 1 - Math.exp(-rate * dt), c = ud.cur;
  for (const j of JOINTS) c[j] = c[j] === undefined ? t[j] : c[j] + (t[j] - c[j]) * k;
  const { L, R } = ud;
  L.leg.hip.rotation.z = c.hipL; R.leg.hip.rotation.z = c.hipR;
  L.leg.knee.rotation.z = c.kneeL; R.leg.knee.rotation.z = c.kneeR;
  L.leg.ankle.rotation.z = c.ankL; R.leg.ankle.rotation.z = c.ankR;
  L.arm.sh.rotation.z = c.shL; R.arm.sh.rotation.z = c.shR;
  L.arm.sh.rotation.x = c.abL; R.arm.sh.rotation.x = -c.abR;     // 팔 벌림 (바깥쪽이 양수)
  L.arm.el.rotation.z = c.elL; R.arm.el.rotation.z = c.elR;
  ud.spine.rotation.set(c.spX, c.spY, c.spZ);
  ud.neck.rotation.z = c.nkZ;
  ud.pelvis.position.y = c.pvY; ud.pelvis.rotation.y = c.pvR;
  ud.body.rotation.set(c.bdX, 0, c.bdZ); ud.body.position.y = 0.94 + c.bdY;
}

// 이동 속도: 서버가 준 속도가 있으면 그걸, 없으면 위치 변화로 계산
function speedOf(ud, x, z, vx, vz, dt) {
  if (vx !== undefined) return Math.hypot(vx, vz);
  let sp = 0;
  if (ud.prevX !== null && dt > 0) sp = Math.hypot(x - ud.prevX, z - ud.prevZ) / dt;
  ud.prevX = x; ud.prevZ = z;
  ud.spd += (Math.min(sp, 9) - ud.spd) * (1 - Math.exp(-10 * dt));
  return ud.spd;
}
// 방향을 틀 때 안쪽으로 기울기
function turnBank(ud, yaw, sp, dt) {
  const rate = ud.prevYaw === null || dt <= 0 ? 0 : wrap(yaw - ud.prevYaw) / dt;
  ud.prevYaw = yaw;
  ud.bank += (clamp(rate * sp * 0.025, -0.3, 0.3) - ud.bank) * (1 - Math.exp(-8 * dt));
  return ud.bank;
}

// ---------- 필드 선수 ----------
// p: { x, z, y, yaw, vx, vz, st(상태 이름), ck(충전 종류 0없음·1로빙·2땅볼·3슛), cp(충전 0~1), kick, head, lean }
export function animatePlayer(m, p, st, dt) {
  const ud = m.userData, t = blank();
  const sp = Math.hypot(p.vx, p.vz);
  gait(t, ud, st === 'normal' ? sp : 0, dt);
  t.bdX = turnBank(ud, p.yaw, sp, dt);
  let rate = 18;

  // 킥: 서버가 kick 신호를 주면 0.45초 동안 뒤로 들었다가 차고 따라 나가는 동작
  if (p.kick && !ud.prevKick) ud.kickT = 0;
  ud.prevKick = p.kick;
  if (p.ck && p.cp > 0 && st === 'normal') {               // 충전 중: 차는 다리를 뒤로 당겨 준비
    const c = clamp(p.cp, 0, 1);
    t.hipR = -0.25 - 0.45 * c; t.kneeR = -0.5 - 0.9 * c; t.ankR = 0.3;
    t.hipL = 0.1; t.kneeL = -0.25;
    t.shL = 0.5 * c; t.abL = 0.5 + 0.3 * c; t.shR = -0.4 * c; t.abR = 0.4;
    t.spZ = 0.05 * c; t.spY = -0.25 * c;
    rate = 12;
  }
  if (ud.kickT >= 0) {
    ud.kickT += dt;
    const k = ud.kickT;
    if (k < 0.08) { t.hipR = -0.7; t.kneeR = -1.5; }                         // 뒤로 들기
    else if (k < 0.22) { t.hipR = 1.25; t.kneeR = -0.15; t.ankR = -0.3; }   // 차기
    else if (k < 0.45) { t.hipR = 0.9; t.kneeR = -0.35; }                    // 따라 나가기
    else ud.kickT = -1;
    if (ud.kickT >= 0) {
      t.hipL = 0.15; t.kneeL = -0.3; t.pvY = -0.06; t.spZ = k < 0.08 ? 0.12 : -0.18; t.spY = k < 0.08 ? -0.3 : 0.25;
      t.shL = 0.6; t.abL = 0.7; t.shR = -0.5; t.abR = 0.5;
      rate = 30;
    }
  }

  if (p.head) {                                         // 헤딩: 몸을 젖혔다가 이마로 받기
    t.spZ = -0.35; t.nkZ = -0.45; t.shL = t.shR = 0.5; t.abL = t.abR = 0.6; t.elL = t.elR = 0.8; rate = 22;
  }
  if (p.y > 0.05 && st === 'normal') {                  // 점프: 무릎을 당기고 팔을 들어 균형
    t.hipL = 0.75; t.kneeL = -1.3; t.hipR = 0.45; t.kneeR = -1.0; t.ankL = t.ankR = 0.3;
    t.shL = 1.3; t.shR = 1.1; t.abL = t.abR = 0.45; t.elL = t.elR = 0.4; t.spZ = -0.1; rate = 20;
  }
  if (p.lean) {                                         // 몸싸움: 어깨를 내밀어 옆으로 기대기
    t.bdX = 0.32; t.spX = 0.2; t.shR = 0.2; t.abR = 0.5; t.elR = 1.2; t.kneeL = t.kneeR = -0.5; t.hipL = t.hipR = 0.3; t.pvY = -0.08; rate = 22;
  }

  switch (st) {
    case 'slide':      // 슬라이딩 태클: 뒤로 누우며 앞다리 쭉, 뒷다리 접고, 손으로 땅 짚기
      t.bdZ = 1.05; t.bdY = -0.79; t.bdX = 0;
      t.hipR = 0.5; t.kneeR = -0.05; t.ankR = -0.4;
      t.hipL = 1.15; t.kneeL = -1.7; t.ankL = 0.3;   // 뒷다리는 무릎을 세워 접음
      t.shL = -1.0; t.abL = 0.6; t.elL = 0.2; t.shR = 0.6; t.abR = 0.4;
      t.spZ = -0.35; t.nkZ = -0.5; rate = 16;
      break;
    case 'cut':        // 커트: 한 발을 앞으로 길게 뻗어 공을 찔러 뺏기
      t.hipR = 1.05; t.kneeR = -0.25; t.ankR = -0.3; t.hipL = -0.2; t.kneeL = -0.3;
      t.pvY = -0.14; t.spZ = -0.32; t.shL = 0.7; t.abL = 0.6; t.shR = -0.5; t.abR = 0.5; rate = 26;
      break;
    case 'stun':       // 깊은 태클에 넘어짐 (1.5초): 처음엔 다리가 걸려 쓰러져 누워 있다가, 남은 시간 35% 아래면 무릎 짚고 일어남
      if (p.sf > 0.35) {
        const fall = p.sf > 0.85;                     // 막 걸린 순간: 다리가 쓸려 몸이 뜨며 넘어가는 중
        t.bdZ = fall ? 0.9 : 1.45; t.bdY = fall ? -0.45 : -0.8; t.bdX = 0.1;
        t.hipL = fall ? -0.3 : 0.75; t.kneeL = fall ? -0.4 : -1.7; t.hipR = fall ? 0.9 : 0.1; t.kneeR = -0.1;
        t.shL = 1.6; t.abL = 1.0; t.shR = 1.9; t.abR = 0.9; t.elL = 0.4; t.elR = 0.3; t.nkZ = -0.3; rate = fall ? 14 : 9;
      } else {
        t.pvY = -0.42; t.hipL = 1.4; t.kneeL = -1.4; t.hipR = -0.2; t.kneeR = -1.9; t.ankR = 0.6; t.ankL = 0.6;
        t.spZ = -0.45; t.shL = t.shR = 0.5; t.elL = t.elR = 0.6; t.abL = t.abR = 0.3; rate = 6;
        if (p.sf < 0.12) { t.pvY = -0.15; t.hipL = 0.5; t.kneeL = -0.7; t.kneeR = -0.8; t.hipR = 0.3; t.spZ = -0.25; }   // 거의 다 일어남
      }
      break;
    case 'trip':       // 숏태클(커트)에 걸림 (1초): 발이 걸려 앞으로 휘청, 팔을 허우적대다 중심 잡기
      if (p.sf > 0.4) {
        const w = Math.sin(performance.now() / 70);
        t.spZ = -0.6; t.bdZ = -0.25; t.pvY = -0.2; t.nkZ = 0.2;
        t.hipL = 0.7; t.kneeL = -0.9; t.hipR = -0.55; t.kneeR = -0.6; t.ankR = 0.4;
        t.shL = 1.2 + w * 0.5; t.shR = 0.3 - w * 0.5; t.abL = 0.9; t.abR = 1.1; t.elL = t.elR = 0.5; rate = 16;
      } else {
        t.spZ = -0.3; t.pvY = -0.12; t.hipL = t.hipR = 0.35; t.kneeL = t.kneeR = -0.55;
        t.shL = t.shR = 0.3; t.abL = t.abR = 0.6; t.elL = t.elR = 0.4; rate = 8;
      }
      break;
    case 'recover':    // 일어나기: 한쪽 무릎을 꿇었다 일어서는 자세
      t.pvY = -0.42; t.hipL = 1.4; t.kneeL = -1.4; t.hipR = -0.2; t.kneeR = -1.9; t.ankR = 0.6; t.ankL = 0.6;
      t.spZ = -0.45; t.shL = t.shR = 0.5; t.elL = t.elR = 0.6; t.abL = t.abR = 0.3; rate = 7;
      break;
    case 'skill':      // 개인기: 옆으로 빠르게 끌며 상체 비틀기
      t.spY = 0.45; t.bdX = -0.25; t.hipR = 0.6; t.kneeR = -0.8; t.hipL = -0.2; t.kneeL = -0.4;
      t.shL = 0.4; t.abL = 0.9; t.shR = -0.3; t.abR = 0.8; t.pvY = -0.06; rate = 24;
      break;
  }
  applyJoints(ud, t, dt, rate);
}

// ---------- 골키퍼 ----------
// k: { x, z, yaw, st('guard'|'dive'|'hold'|'recover'), dz(다이빙 방향), dy(다이빙 높이) }
export function animateKeeper(m, k, st, dt) {
  const ud = m.userData, t = blank();
  const sp = speedOf(ud, k.x, k.z, undefined, undefined, dt);
  gait(t, ud, sp, dt);
  let rate = 14;
  if (st === 'guard' || st === 'recover') {   // 준비 자세: 무릎 굽히고 상체 숙이고 손을 앞으로
    t.pvY = -0.12 + (sp > 0.3 ? t.pvY : 0);
    t.kneeL += -0.55; t.kneeR += -0.55; t.hipL += 0.35; t.hipR += 0.35; t.ankL += 0.2; t.ankR += 0.2;
    t.spZ = -0.32; t.nkZ = 0.25;
    t.shL = t.shR = 0.65; t.abL = t.abR = 0.55; t.elL = t.elR = 0.7;
    if (st === 'recover') { t.pvY = -0.35; t.kneeL = t.kneeR = -1.6; t.hipL = t.hipR = 1.0; rate = 6; }
  } else if (st === 'dive') {                  // 다이빙: 몸을 옆으로 날리고 두 팔을 머리 위로 쭉
    const left = k.dz * Math.cos(k.yaw) < 0;
    t.bdX = left ? -1.3 : 1.3; t.bdY = Math.max(0.25, (k.dy || 1) - 0.35) - 0.94;
    t.shL = t.shR = 2.9; t.abL = t.abR = 0.15; t.elL = t.elR = 0.05;
    t.hipL = 0.15; t.hipR = -0.1; t.kneeL = -0.3; t.kneeR = -0.15; t.spZ = 0.1; rate = 16;
  } else if (st === 'hold') {                 // 공 잡고 있음: 가슴에 끌어안기
    t.shL = t.shR = 0.85; t.abL = t.abR = 0.05; t.elL = t.elR = 1.75; t.spZ = -0.12; rate = 12;
  } else if (st === 'setup') {                // 골킥 준비: 똑바로 서서 걷거나 달려옴 (기본 걸음새)
    rate = 16;
  }
  // 골킥: 차는 순간 'kick' 상태가 되면 뒤로 들었다가 길게 차고 따라 나감
  if (st === 'kick' && ud.prevKst !== 'kick') ud.kickT = 0;
  ud.prevKst = st;
  if (st === 'kick' && ud.kickT >= 0) {
    ud.kickT += dt;
    const q = ud.kickT;
    if (q < 0.08) { t.hipR = -0.8; t.kneeR = -1.6; }
    else if (q < 0.25) { t.hipR = 1.45; t.kneeR = -0.1; t.ankR = -0.35; }
    else { t.hipR = 1.1; t.kneeR = -0.3; }
    t.hipL = 0.15; t.kneeL = -0.3; t.pvY = -0.06; t.spZ = q < 0.08 ? 0.15 : -0.22; t.spY = q < 0.08 ? -0.35 : 0.3;
    t.shL = 0.8; t.abL = 0.9; t.shR = -0.5; t.abR = 0.6; rate = 30;
  }
  applyJoints(ud, t, dt, rate);
}
