/* factory-scene.js — 首頁 AI Agent 閉環智慧製造 3D 場景（Factory IO 風格）
 *
 * 維護說明
 *   · 場景是「捲動進度 p 的純函式」：update(p) 不讀時鐘、不累積狀態，倒捲畫面一致。
 *   · 每個構件一個具名函式（floorPlate / conveyor / inspectionGantry / chipVariants …），
 *     尺寸集中在各函式頂端的 D 常數；不要用臨時數字微調位置。
 *   · 材質按角色分槽（M），每個 mesh 具名，方便匯出後在其他軟體選取。
 *   · 文案在 assets/data/story-data.js，不在這裡。
 *
 * 目前包含：地板、直線輸送帶（帶面橫紋隨進度移動）、晶片（良品／裂痕／缺角）、檢測相機龍門架與環形補光、
 * 檢測後的 O／X 標示、紅框與信心分數（ticket 03）；機械手臂取出瑕疵品並裝箱（ticket 04，輸送帶在
 * 全程持續運轉）。後續各幕的設備在這個檔案往下加。
 *
 * 用法
 *   const THREE = await import('https://unpkg.com/three@0.184.0/build/three.module.js');
 *   const scene = buildScene(THREE, { detail:'high', shadows:true });
 *   root.add(scene.group); scene.update(p);   // p = 0..1
 *   scene.shots(mobile) → { wide, detect, pick, route, pad, console, monitor, monitor2, party }     // 鏡頭取景點（供時間軸關鍵影格）
 *   scene.bounds        → { center, radius, box, contentRadius }
 *   scene.dispose()
 *
 * 座標：公尺、y 軸向上；輸送帶沿 +x 前進，檢測相機在 x = CAM_X。
 */

/* ---------- 版面常數 ---------- */
export const DECK_Y = 0.62;            // 輸送帶中心高度
export const BELT_TOP = DECK_Y + 0.05; // 帶面高度（晶片擺放面）
export const BELT_X0 = -8;             // 帶尾（進料端）
export const CAM_X = 0;                // 檢測相機位置
export const PICK_X = 4.5;             // 機械手臂取件位置（相機下游）
export const PITCH = 1.3;              // 晶片間距
export const SLOTS = 14;               // 同時在帶上的晶片數
export const CYCLE = PITCH * SLOTS;    // 循環長度（= 可見帶長 18.2 m，帶尾 x = 10.2）
export const TRAVEL_PER_P = 60;        // 輸送帶每單位進度的位移（公尺）；輸送帶全程持續運轉，不再停住
export const P_RESUME = 0.775;         // 工程師核准新參數的時間；第 05 幕螢幕的連續良品計數從這裡起算
export const N_FIX = 7;                // 序號 ≥ N_FIX 的晶片一律良品（過場之後沒有新的瑕疵，也是「調參後全是良品」）
export const PACK_X = 7.2;             // 第二支手臂（合格品裝箱）的取件位置

/* 手臂一次取放循環涵蓋的「帶面位移」（相對晶片抵達取件點的位置 Δ，公尺）；
   關鍵點之間用 smoothstep 插值。循環總長 3.7 m < 3 個晶片間距 3.9 m，所以兩顆瑕疵品不會同時占用手臂。 */
const T = { start: -0.8, hover: -0.4, grasp: -0.05, closed: 0.2, lift: 0.6, above: 1.3, down: 1.6, open: 1.85, up: 2.1, home: 2.9 };

/* ---------- 第 02 幕：AGV 與最佳化運送 ---------- */
export const BIN_POS = { x: PICK_X + 1.7, z: -1.7 };   // 收納箱（AGV 取貨點）
export const STATION_POS = { x: 12.6, z: 4.6 };        // 分析站（ticket 06 在此蓋設備）
const AGV_PARK = { x: 9.8, z: BIN_POS.z };
/* 進度時間表（p）：駛入 → 頂起 → 候選路線浮現 → 逐一淘汰 → 最佳路線發亮 → 運送 → 放下 */
export const AGV_T = {
  drive0: 0.370, drive1: 0.392, lift1: 0.400,
  appear0: 0.400, appearStep: 0.0045, appearDur: 0.013,
  fade: { 2: [0.428, 0.436], 3: [0.436, 0.444], 1: [0.444, 0.452] },   // 路線編號 → 淡出區間
  glow0: 0.452, glow1: 0.458,
  go0: 0.458, go1: 0.502, lower1: 0.510
};
/* 四條候選路線：0 = 沿輸送帶尾端繞行（可行且最短）、1 = 外圈繞行（可行但長）、
   2 = 直穿輸送帶（被擋）、3 = 中途穿越輸送帶（被擋）。座標為 [x, z]。 */
const S0 = [BIN_POS.x, BIN_POS.z], G0 = [STATION_POS.x, STATION_POS.z];
export const ROUTES = [
  { id: 'best',   blocked: false, pts: [S0, [11.2, S0[1]], [11.2, G0[1]], G0] },
  { id: 'wide',   blocked: false, pts: [S0, [S0[0], -4.6], [13.8, -4.6], [13.8, G0[1]], G0] },
  { id: 'direct', blocked: true,  pts: [S0, G0], cross: [S0[0] + (0 - S0[1]) / (G0[1] - S0[1]) * (G0[0] - S0[0]), 0] },
  { id: 'mid',    blocked: true,  pts: [S0, [8.6, S0[1]], [8.6, G0[1]], G0], cross: [8.6, 0] }
];
const ROUTE_RADIUS = 0.8;

const hyp = (x, z) => Math.hypot(x, z);
/* 折線倒圓角 → 稠密取樣點 [[x,z],...] */
export function roundedPath(pts, r, arcN = 10) {
  const out = [pts[0].slice()];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    const l1 = hyp(a[0] - b[0], a[1] - b[1]), l2 = hyp(c[0] - b[0], c[1] - b[1]);
    const u1 = [(a[0] - b[0]) / l1, (a[1] - b[1]) / l1], u2 = [(c[0] - b[0]) / l2, (c[1] - b[1]) / l2];
    const ang = Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1])));
    if (ang > Math.PI - 1e-3) { out.push(b.slice()); continue; }
    const d = Math.min(r / Math.tan(ang / 2), l1 / 2, l2 / 2), rr = d * Math.tan(ang / 2);
    const p1 = [b[0] + u1[0] * d, b[1] + u1[1] * d], p2 = [b[0] + u2[0] * d, b[1] + u2[1] * d];
    const bis = [u1[0] + u2[0], u1[1] + u2[1]], bl = hyp(bis[0], bis[1]);
    const cd = rr / Math.sin(ang / 2), C = [b[0] + bis[0] / bl * cd, b[1] + bis[1] / bl * cd];
    const t1 = Math.atan2(p1[1] - C[1], p1[0] - C[0]);
    let dt = Math.atan2(p2[1] - C[1], p2[0] - C[0]) - t1;
    while (dt > Math.PI) dt -= 2 * Math.PI;
    while (dt < -Math.PI) dt += 2 * Math.PI;
    for (let k = 0; k <= arcN; k++) {
      const t = t1 + dt * k / arcN;
      out.push([C[0] + rr * Math.cos(t), C[1] + rr * Math.sin(t)]);
    }
  }
  out.push(pts[pts.length - 1].slice());
  return out;
}
export function pathMeta(samples) {
  const cum = [0];
  for (let i = 1; i < samples.length; i++) cum.push(cum[i - 1] + hyp(samples[i][0] - samples[i - 1][0], samples[i][1] - samples[i - 1][1]));
  return { pts: samples, cum, length: cum[cum.length - 1] };
}
/* 沿路徑走 s 公尺 → 位置與切線 */
export function pathAtDist(meta, s) {
  s = Math.max(0, Math.min(meta.length, s));
  let i = 1;
  while (i < meta.cum.length - 1 && meta.cum[i] < s) i++;
  const a = meta.pts[i - 1], b = meta.pts[i], seg = Math.max(1e-9, meta.cum[i] - meta.cum[i - 1]);
  const u = (s - meta.cum[i - 1]) / seg, dx = (b[0] - a[0]) / seg, dz = (b[1] - a[1]) / seg;
  return { x: a[0] + (b[0] - a[0]) * u, z: a[1] + (b[1] - a[1]) * u, tx: dx, tz: dz };
}

/* ---------- 第 03–06 幕：角色、控制室、數位孿生 ---------- */
export const CONSOLE = { x: 6.4, z: 5.2 };       // 控制台螢幕牆（螢幕朝 +z）
export const TWIN = { x: 10.0, z: 7.0 };         // 數位孿生桌（控制台右側，與分析站之間）
/* 四句對話的出現區間（依 story-data.js 的 dialogue 順序：工程師、AI、AI、工程師） */
export const LINES = [
  { who: 'worker', from: 0.530, to: 0.575 },
  { who: 'ai',     from: 0.575, to: 0.625 },
  { who: 'ai',     from: 0.715, to: 0.755 },
  { who: 'worker', from: 0.755, to: 0.790 }
];
export const EVIDENCE_WIN = [0.545, 0.640];       // 證據面板（瑕疵影像、感測曲線、SOP 引用）
export const SIM = { appear: [0.655, 0.685], run: [0.700, 0.750] };   // 數位孿生：浮現、模擬跑完
export const PRESS = [0.765, 0.775];              // 工程師按下核准鈕
export const ANDON = { amber: 0.700, green: P_RESUME };   // 燈塔：紅 → 黃（模擬中）→ 綠（核准後）
export const CELEBRATE = { clap: [0.925, 0.950], dance: [0.950, 1.0] };

const lerpN = (a, b, t) => a + (b - a) * t;
const ssp = (a, b, p) => { const t = Math.max(0, Math.min(1, (p - a) / (b - a))); return t * t * (3 - 2 * t); };
const angDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
const GAIT = 7.4;   // 每走 1 m 的步態相位（rad）

const CH = {
  worker: { pad: [11.3, 4.6], yaw: Math.PI / 2,  desk: [5.3, 6.6], aside: [4.0, 6.5], dance: [5.3, 7.1],
    seg: { turn1: [0.650, 0.658], walk1: [0.658, 0.700], turn2: [0.700, 0.712], aside: [0.780, 0.795], turn3: [0.795, 0.805], turnF: [0.885, 0.905], walkF: [0.905, 0.925] } },
  ai:     { pad: [13.9, 4.6], yaw: -Math.PI / 2, desk: [7.7, 6.5], aside: [8.8, 6.5], dance: [7.5, 7.1],
    seg: { turn1: [0.652, 0.662], walk1: [0.662, 0.702], turn2: [0.702, 0.714], aside: [0.782, 0.797], turn3: [0.797, 0.807], turnF: [0.887, 0.907], walkF: [0.907, 0.927] } }
};

/* 依序執行「轉向／走路」片段，回傳位置、朝向與步態；只取決於 p */
function runSegments(start, segs, p) {
  let x = start[0], z = start[1], yaw = start[2], gait = 0, amp = 0;
  for (const sg of segs) {
    if (p <= sg.p[0]) break;
    const u = ssp(sg.p[0], sg.p[1], p);
    if (sg.turn != null) yaw = yaw + angDiff(yaw, sg.turn) * u;
    else {
      const d = Math.hypot(sg.to[0] - x, sg.to[1] - z);
      gait += u * d * GAIT;
      amp = Math.max(amp, Math.max(0, Math.min(1, Math.min(u, 1 - u) * 12)));
      x = lerpN(x, sg.to[0], u); z = lerpN(z, sg.to[1], u);
    }
    if (u < 1) break;
    if (sg.turn != null) yaw = sg.turn; else { x = sg.to[0]; z = sg.to[1]; }
  }
  return { x, z, yaw, gait, amp };
}

/* 角色姿態（純函式）：kind = 'worker' | 'ai'。arm*f = 手臂向前舉、arm*s = 向外舉（rad） */
export function charPose(kind, p) {
  const c = CH[kind], S = c.seg, ai = kind === 'ai';
  const y1 = Math.atan2(c.desk[0] - c.pad[0], c.desk[1] - c.pad[1]);
  const yAside = Math.atan2(c.aside[0] - c.desk[0], c.aside[1] - c.desk[1]);
  const segs = [
    { p: S.turn1, turn: y1 }, { p: S.walk1, to: c.desk },
    { p: S.turn2, turn: Math.PI },
    { p: S.aside, to: c.aside },      // 走到一旁時朝向沿用「面向控制台」，側步不轉身
    { p: S.turnF, turn: 0 }, { p: S.walkF, to: c.dance }
  ];
  /* 側步：把 aside 段的朝向暫時鎖為面向控制台，避免走路時身體突然轉向 */
  const r = runSegments([c.pad[0], c.pad[1], c.yaw], segs, p);
  const pose = { x: r.x, z: r.z, yaw: r.yaw, gait: r.gait, amp: r.amp * 0.6, armLf: 0, armLs: 0.06, armRf: 0, armRs: 0.06, head: 0, bob: 0, twist: 0 };

  /* 說話：說話者手勢加點頭；另一人微微偏頭聆聽 */
  for (const L of LINES) {
    const on = ssp(L.from, L.from + 0.008, p) * (1 - ssp(L.to - 0.008, L.to, p));
    if (on <= 0) continue;
    if (L.who === kind) { pose.armRf += (0.9 + 0.22 * Math.sin(p * 900)) * on; pose.head += 0.12 * Math.sin(p * 700) * on; }
    else pose.head += 0.14 * on;
  }
  /* 機器人（AI 化身）指向數位孿生 */
  if (ai) { const t = ssp(0.715, 0.722, p) * (1 - ssp(0.748, 0.755, p)); pose.armRs += 1.25 * t; pose.armRf += 0.25 * t; }   // 面向控制台時，機器人的右手臂朝東 = 朝向孿生桌
  /* 工程師按下核准鈕 */
  if (!ai) { const pr = ssp(PRESS[0], PRESS[0] + 0.004, p) * (1 - ssp(PRESS[1] - 0.004, PRESS[1], p)); pose.armRf += 1.3 * pr; pose.twist += 0.1 * pr; }
  /* 慶祝：拍手 → 跳舞 */
  const cl = ssp(CELEBRATE.clap[0], CELEBRATE.clap[0] + 0.005, p) * (1 - ssp(CELEBRATE.clap[1] - 0.002, CELEBRATE.clap[1] + 0.003, p));
  if (cl > 0) {
    const ph = (p - CELEBRATE.clap[0]) * 2400;
    pose.armLf += 1.15 * cl; pose.armRf += 1.15 * cl;
    const spread = 0.05 + 0.2 * (0.5 + 0.5 * Math.sin(ph));
    pose.armLs = spread * cl + pose.armLs * (1 - cl); pose.armRs = spread * cl + pose.armRs * (1 - cl);
    pose.bob += 0.03 * Math.abs(Math.sin(ph / 2)) * cl;
  }
  const dn = ssp(CELEBRATE.dance[0] - 0.002, CELEBRATE.dance[0] + 0.006, p);
  if (dn > 0) {
    const ph = (p - CELEBRATE.dance[0]) * 1500, sw = Math.sin(ph);
    pose.bob += (ai ? 0.13 : 0.09) * Math.abs(sw) * dn;
    pose.armLf = pose.armLf * (1 - dn) + dn * (1.7 + 0.8 * sw);
    pose.armRf = pose.armRf * (1 - dn) + dn * (1.7 - 0.8 * sw);
    pose.armLs = 0.25 * dn + pose.armLs * (1 - dn); pose.armRs = 0.25 * dn + pose.armRs * (1 - dn);
    pose.twist += 0.35 * Math.sin(ph * 0.5) * dn;
    pose.gait = ph; pose.amp = 0.35 * dn;
    if (ai) pose.yaw += 2 * Math.PI * ssp(0.972, 0.992, p);
  }
  return pose;
}

/* 第 05 幕螢幕：核准（P_RESUME）之後通過相機的連續良品件數（只取決於 p） */
export function okCountAt(p) {
  const f = q => Math.floor((TRAVEL_PER_P * q - (CAM_X - BELT_X0)) / PITCH);   // 到 q 為止已通過相機的晶片數
  return Math.max(0, f(Math.max(p, 0)) - f(P_RESUME));
}

/* ---------- 確定性瑕疵序列（不用 Math.random） ---------- */
export function hash01(n) {
  let h = (n * 374761393 + 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const CONF = [0.87, 0.89, 0.91, 0.93, 0.94, 0.96, 0.97, 0.98];
export function chipConfidenceIndex(n) { return Math.floor(hash01(n + 9001) * CONF.length); }

/* 晶片流水號 n（第 n 顆進料，可為負：捲動開始時已在帶上的晶片）。
   序號 < N_MIN 的晶片在 p=0 時已過了取件點（或取件循環已開始），一律視為良品，手臂才不會在第一格就「跳」在半空。 */
export const N_MIN = Math.ceil((BELT_X0 - PICK_X - T.start) / PITCH);

/* 種子 → 晶片種類函式。規則：原始機率抽到瑕疵，且前兩顆都不是瑕疵，才算瑕疵
   （瑕疵品至少相隔 3 顆，手臂才來得及取放）。改動 PITCH／TRAVEL／T 後要重挑種子。 */
export function makeKinds(seed) {
  const cache = new Map();
  const raw = n => {
    const r = hash01(n + seed);
    if (r >= 0.42) return 'ok';
    return hash01(n + seed + 5555) < 0.5 ? 'crack' : 'chip';
  };
  const kind = n => {
    if (n < N_MIN || n >= N_FIX) return 'ok';
    if (cache.has(n)) return cache.get(n);
    const k = (raw(n) !== 'ok' && kind(n - 1) === 'ok' && kind(n - 2) === 'ok') ? raw(n) : 'ok';
    cache.set(n, k);
    return k;
  };
  return kind;
}
const KIND_SEED = 5;   // 種子搜尋條件：第 01 幕通過相機的晶片含裂痕與缺角；取件在 p≈0.057、0.230、0.295；所有取放循環在 AGV 頂起箱子（p 0.39）前結束
export const chipKind = makeKinds(KIND_SEED);

/* 輸送帶位移（進度 p → 公尺）：全程持續運轉 */
export function travelAt(p) { return TRAVEL_PER_P * Math.max(p, 0); }
/* 晶片 n 的 x 位置 */
export const chipX = (n, p) => BELT_X0 + travelAt(p) - n * PITCH;
/* 第 i 個槽位在進度 p 時的晶片流水號與 x 位置 */
export function slotAt(i, p) {
  const t = travelAt(p), m = Math.floor(t / PITCH);
  const n = m - ((((m - i) % SLOTS) + SLOTS) % SLOTS);
  return { x: BELT_X0 + t - n * PITCH, id: n };
}

/* 第二支手臂（合格品裝箱）的取放循環：總長 1.3 m = 一個晶片間距，連續合格品時首尾相接、不會重疊 */
export const T2 = { start: -0.5, hover: -0.25, grasp: -0.02, closed: 0.08, lift: 0.2, above: 0.35, down: 0.5, open: 0.6, up: 0.7, home: 0.8 };
export const N_PACK0 = Math.ceil((BELT_X0 - PACK_X - T2.start) / PITCH);   // p=0 時取放循環尚未開始的第一顆
export const BOX_PER = 9;                                                    // 每箱 3×3 顆
/* 會抵達 PACK_X 被裝箱的合格品清單（依抵達順序）：k = 裝箱順序 */
export function goodList(kindFn) {
  const out = [];
  const nMax = Math.floor(TRAVEL_PER_P / PITCH) + 1;
  for (let n = N_PACK0; n <= nMax; n++) if (kindFn(n) === 'ok') out.push({ n, k: out.length });
  return out;
}

/* 全程的瑕疵品清單（依取件順序）：k = 進箱順序，供箱內位置與晶片外型使用 */
export function defectList(kindFn) {
  const out = [];
  const nMax = Math.floor(TRAVEL_PER_P / PITCH) + 1;
  for (let n = N_MIN; n <= nMax; n++) {
    const kd = kindFn(n);
    if (kd !== 'ok') out.push({ n, k: out.length, kind: kd });
  }
  return out;
}

const clamp01 = x => Math.max(0, Math.min(1, x));
const smooth = x => x * x * (3 - 2 * x);

export function buildScene(THREE, opts = {}) {
  const low = opts.detail === 'low';
  const shadows = opts.shadows !== false && !low;
  const seg = (hi, lo) => (low ? lo : hi);
  const pad = n => String(n).padStart(2, '0');

  /* ---------- 材質槽（Factory IO 配色：藍框、橘標、綠通過、紅瑕疵） ---------- */
  const mk = (name, hex, rough, metal, extra) =>
    new THREE.MeshStandardMaterial(Object.assign({ name, color: hex, roughness: rough, metalness: metal }, extra || {}));
  const M = {
    floor:    mk('floor_plate',    0xdde1e5, 0.75, 0.05),
    kerb:     mk('floor_kerb',     0xf2b233, 0.60, 0.10),
    frame:    mk('frame_blue',     0x2f6fb2, 0.45, 0.30),
    steel:    mk('steel_silver',   0xb9c2ca, 0.35, 0.70),
    belt:     mk('belt_rubber',    0x30363d, 0.90, 0.00),
    beltMark: mk('belt_mark',      0x5b6673, 0.90, 0.00),
    dark:     mk('housing_dark',   0x27313b, 0.50, 0.25),
    lens:     mk('lens_glass',     0x8fd3ff, 0.10, 0.10, { emissive: new THREE.Color(0x2b6f9c), emissiveIntensity: 0.5 }),
    ring:     mk('ring_light',     0xdff3ff, 0.30, 0.10, { emissive: new THREE.Color(0xbfe6ff), emissiveIntensity: 1.1 }),
    chipBody: mk('chip_body',      0x20272e, 0.55, 0.20),
    chipPin:  mk('chip_pin',       0xd5dbe0, 0.30, 0.85),
    chipMark: mk('chip_marker',    0xf28c28, 0.50, 0.10),
    fracture: mk('chip_fracture',  0xeef1f3, 0.55, 0.05, { emissive: new THREE.Color(0xffffff), emissiveIntensity: 0.25 }),
    arm:      mk('arm_orange',     0xf28c28, 0.45, 0.25),
    skin:     mk('skin',           0xf0c8a0, 0.70, 0.00),
    overall:  mk('overall_blue',   0x2f6fb2, 0.60, 0.05),
    vest:     mk('vest_orange',    0xf28c28, 0.55, 0.05),
    hat:      mk('hardhat_yellow', 0xf2c230, 0.45, 0.10),
    robotW:   mk('robot_white',    0xe9eff3, 0.40, 0.25),
    robotG:   mk('robot_grey',     0x7d8b97, 0.45, 0.45),
    eye:      mk('robot_eye',      0x66e0ff, 0.30, 0.10, { emissive: new THREE.Color(0x66e0ff), emissiveIntensity: 1.0 }),
    holo:     new THREE.MeshBasicMaterial({ name: 'holo_cyan', color: 0x66e0ff, transparent: true, opacity: 0.6, depthWrite: false }),
    lampR:    mk('andon_red',      0xe5423b, 0.4, 0.1, { emissive: new THREE.Color(0xe5423b), emissiveIntensity: 0.08 }),
    lampA:    mk('andon_amber',    0xffb020, 0.4, 0.1, { emissive: new THREE.Color(0xffa000), emissiveIntensity: 0.08 }),
    lampG:    mk('andon_green',    0x2fa85a, 0.4, 0.1, { emissive: new THREE.Color(0x2fa85a), emissiveIntensity: 0.08 }),
    button:   mk('approve_button', 0x2fa85a, 0.4, 0.1, { emissive: new THREE.Color(0x2fa85a), emissiveIntensity: 0.1 }),
    box:      mk('box_cardboard',  0xc9a26b, 0.75, 0.03),
    boxTag:   mk('box_tag_ok',     0x2fa85a, 0.5, 0.05),
    frameBad: mk('defect_frame',   0xe5423b, 0.50, 0.10, { emissive: new THREE.Color(0xe5423b), emissiveIntensity: 0.6 }),
    beam:     new THREE.MeshBasicMaterial({ name: 'scan_beam', color: 0x66e0ff, transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide })
  };

  const geos = [], texs = [], mats = [];
  const keep = g => { geos.push(g); return g; };
  const mesh = (geo, m, name) => {
    const o = new THREE.Mesh(keep(geo), m);
    o.name = name;
    if (shadows) { o.castShadow = true; o.receiveShadow = true; }
    return o;
  };

  /* ---------- 幾何工具 ---------- */
  function roundedRect(w, h, r) {
    const s = new THREE.Shape(), x = -w / 2, y = -h / 2;
    r = Math.max(0.001, Math.min(r, w / 2 - 0.001, h / 2 - 0.001));
    s.moveTo(x + r, y);
    s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
    s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
    s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
    return s;
  }
  /* 導角方盒：可見外殼一律用它，不留刀口邊 */
  function beveledBox(w, h, d, o) {
    o = o || {};
    if (low && !o.keepBevel) return new THREE.BoxGeometry(w, h, d);
    const f = Math.min(o.fillet == null ? 0.022 : o.fillet, w / 2.6, h / 2.6);
    const b = Math.min(o.bevel == null ? 0.014 : o.bevel, d / 2.6, f);
    const g = new THREE.ExtrudeGeometry(roundedRect(w, h, f), {
      depth: Math.max(0.001, d - 2 * b), bevelEnabled: true,
      bevelThickness: b, bevelSize: b, bevelSegments: 1, curveSegments: seg(3, 1), steps: 1
    });
    g.translate(0, 0, -(d - 2 * b) / 2);
    return g;
  }
  const bbox = (w, h, d, m, name, o) => mesh(beveledBox(w, h, d, o), m, name);

  const group = new THREE.Group();
  group.name = 'ai_manufacturing_scene';
  const anim = { marks: [], beam: null, ring: null, slots: [], arm: null, arm2: null, boxes: [], packChips: [], bin: [], routes: [], agv: null, agv2: null, rig: null };

  /* ---------- 廠房地板（預留後續各幕的空間） ---------- */
  function floorPlate() {
    const D = { w: 30, d: 16, cx: 1, thick: 0.14, kerb: 0.16 };
    const g = new THREE.Group(); g.name = 'floor';
    const plate = mesh(new THREE.BoxGeometry(D.w, D.thick, D.d), M.floor, 'floor_plate');
    plate.position.set(D.cx, D.thick / 2, 0); plate.castShadow = false; g.add(plate);
    for (const s of [-1, 1]) {
      const kx = bbox(D.w, D.kerb, 0.14, M.kerb, 'floor_kerb_' + (s > 0 ? 'front' : 'back'), { fillet: 0.03 });
      kx.position.set(D.cx, D.thick + D.kerb / 2 - 0.02, s * (D.d / 2 - 0.07)); g.add(kx);
      const kz = bbox(D.d, D.kerb, 0.14, M.kerb, 'floor_kerb_' + (s > 0 ? 'right' : 'left'), { fillet: 0.03 });
      kz.rotation.y = Math.PI / 2; kz.position.set(D.cx + s * (D.w / 2 - 0.07), kx.position.y, 0); g.add(kz);
    }
    return g;
  }

  /* ---------- 直線輸送帶 ---------- */
  function conveyor() {
    const D = { len: CYCLE, half: 0.4, railH: 0.16, railT: 0.07, markPitch: 0.55 };
    const g = new THREE.Group(); g.name = 'conveyor';
    const cx = BELT_X0 + D.len / 2;
    const slab = mesh(new THREE.BoxGeometry(D.len, 0.08, D.half * 2), M.belt, 'belt_surface');
    slab.position.set(cx, DECK_Y, 0); g.add(slab);
    for (const s of [-1, 1]) {
      const rail = bbox(D.len, D.railH, D.railT, M.frame, 'conveyor_rail_' + (s > 0 ? 'front' : 'back'), { fillet: 0.02 });
      rail.position.set(cx, DECK_Y + 0.02, s * (D.half + D.railT / 2 + 0.01)); g.add(rail);
    }
    /* 帶面橫紋：位置由 update(p) 依帶面位移決定，讓輸送帶「看得出在動」 */
    const nMark = Math.floor(D.len / D.markPitch);
    for (let i = 0; i < nMark; i++) {
      const m = mesh(new THREE.BoxGeometry(0.05, 0.004, D.half * 2 - 0.1), M.beltMark, 'belt_mark_' + pad(i + 1));
      m.castShadow = false; m.position.set(BELT_X0, DECK_Y + 0.042, 0); g.add(m); anim.marks.push(m);
    }
    /* 支撐腳 */
    const hLeg = DECK_Y - 0.14 - 0.04;
    for (let i = 0; i <= 11; i++) {
      for (const s of [-1, 1]) {
        const leg = bbox(0.1, hLeg, 0.1, M.frame, 'conveyor_leg_' + pad(i + 1) + (s > 0 ? 'f' : 'b'), { fillet: 0.014 });
        leg.position.set(BELT_X0 + 0.3 + i * (D.len - 0.6) / 11, 0.14 + hLeg / 2, s * (D.half + 0.06)); g.add(leg);
      }
    }
    return g;
  }

  /* ---------- 檢測相機龍門架 + 環形補光 + 掃描光束 ---------- */
  function inspectionGantry() {
    const D = { postH: 2.05, span: 0.9, camY: 1.78, ringY: 1.22 };
    const g = new THREE.Group(); g.name = 'inspection_gantry';
    g.position.set(CAM_X, 0, 0);
    for (const s of [-1, 1]) {
      const post = bbox(0.14, D.postH, 0.14, M.frame, 'gantry_post_' + (s > 0 ? 'front' : 'back'), { fillet: 0.018 });
      post.position.set(0, 0.14 + D.postH / 2, s * D.span); g.add(post);
    }
    const beam = bbox(0.2, 0.16, D.span * 2 + 0.14, M.frame, 'gantry_beam', { fillet: 0.02 });
    beam.position.set(0, 0.14 + D.postH, 0); g.add(beam);
    const mount = bbox(0.16, 0.34, 0.16, M.steel, 'camera_mount', { fillet: 0.02 });
    mount.position.set(0, D.camY + 0.36, 0); g.add(mount);
    const body = bbox(0.34, 0.34, 0.4, M.dark, 'camera_body', { fillet: 0.028 });
    body.position.set(0, D.camY, 0); g.add(body);
    const barrel = mesh(new THREE.CylinderGeometry(0.13, 0.15, 0.3, seg(24, 10)), M.steel, 'camera_lens_barrel');
    barrel.position.set(0, D.camY - 0.3, 0); g.add(barrel);
    const glass = mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.03, seg(24, 10)), M.lens, 'camera_lens_glass');
    glass.position.set(0, D.camY - 0.46, 0); g.add(glass);
    const ring = mesh(new THREE.TorusGeometry(0.34, 0.06, seg(14, 6), seg(44, 18)), M.ring, 'ring_light');
    ring.rotation.x = Math.PI / 2; ring.position.set(0, D.ringY, 0); g.add(ring);
    anim.ring = ring;
    if (!low) for (const s of [-1, 1]) {
      const brk = bbox(0.05, 0.42, 0.05, M.steel, 'ring_bracket_' + (s > 0 ? 'front' : 'back'), { fillet: 0.01 });
      brk.position.set(0, D.ringY + 0.21, s * 0.32); g.add(brk);
    }
    /* 掃描光束：錐形半透明，強度由 update(p) 依晶片位置決定 */
    const h = D.ringY - BELT_TOP;
    const beam2 = mesh(new THREE.CylinderGeometry(0.1, 0.34, h, seg(28, 12), 1, true), M.beam, 'scan_beam');
    beam2.castShadow = false; beam2.receiveShadow = false;
    beam2.position.set(0, BELT_TOP + h / 2, 0); g.add(beam2);
    anim.beam = beam2;
    return g;
  }

  /* ---------- 晶片：良品／裂痕（裂成兩半）／缺角 ---------- */
  const CHIP = { w: 0.56, h: 0.1, pinLen: 0.07, pinW: 0.045, pinH: 0.02, pinN: 5 };

  function chipPins(parent, filter, prefix) {
    const step = CHIP.w / (CHIP.pinN + 0.5);
    for (let i = 0; i < CHIP.pinN; i++) {
      const o = (i - (CHIP.pinN - 1) / 2) * step;
      for (const [sx, sz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = sx ? sx * (CHIP.w / 2 + CHIP.pinLen / 2 - 0.012) : o;
        const z = sz ? sz * (CHIP.w / 2 + CHIP.pinLen / 2 - 0.012) : o;
        if (filter && !filter(x, z)) continue;
        const pin = mesh(new THREE.BoxGeometry(sx ? CHIP.pinLen : CHIP.pinW, CHIP.pinH, sx ? CHIP.pinW : CHIP.pinLen),
          M.chipPin, prefix + '_pin_' + (sx > 0 ? 'e' : sx < 0 ? 'w' : sz > 0 ? 's' : 'n') + (i + 1));
        pin.position.set(x, -0.005, z); parent.add(pin);
      }
    }
  }
  const chipMarker = (parent, name, x, z) => {
    const m = mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.012, seg(14, 6)), M.chipMark, name);
    m.position.set(x, CHIP.h / 2 + 0.004, z); parent.add(m);
  };

  function chipOk() {
    const g = new THREE.Group(); g.name = 'chip_ok';
    g.add(bbox(CHIP.w, CHIP.h, CHIP.w, M.chipBody, 'chip_ok_body', { fillet: 0.02, bevel: 0.012 }));   // x×y 為斷面，沿 z 擠出 = 薄板
    chipPins(g, null, 'chip_ok');
    chipMarker(g, 'chip_ok_marker', -CHIP.w / 2 + 0.07, -CHIP.w / 2 + 0.07);
    return g;
  }

  /* 裂痕：本體沿 z 向中線裂成兩半，兩半錯位、略微旋轉，斷面淺色 */
  function chipCrack() {
    const g = new THREE.Group(); g.name = 'chip_crack';
    const half = 0.5 * CHIP.w - 0.03;
    for (const s of [-1, 1]) {
      const h = new THREE.Group(); h.name = 'chip_crack_half_' + (s < 0 ? 'a' : 'b');
      h.position.set(s * 0.08, s > 0 ? -0.012 : 0.004, s * (half / 2 + 0.1));   // 兩半明顯分開、錯位
      h.rotation.y = s * 0.2;
      h.add(bbox(CHIP.w, CHIP.h, half, M.chipBody, h.name + '_body', { fillet: 0.02, bevel: 0.01 }));
      const face = mesh(new THREE.BoxGeometry(CHIP.w - 0.02, CHIP.h - 0.012, 0.012), M.fracture, h.name + '_fracture');
      face.position.z = -s * (half / 2 - 0.004); h.add(face);
      /* 各半邊只帶自己那一側的接腳；接腳座標由整顆晶片座標換到半邊局部座標 */
      const before = h.children.length;
      chipPins(h, (x, z) => (s < 0 ? z < -0.02 : z > 0.02), h.name);
      for (let k = before; k < h.children.length; k++) {
        h.children[k].position.x -= h.position.x; h.children[k].position.z -= h.position.z;
      }
      g.add(h);
    }
    chipMarker(g.children[0], 'chip_crack_marker', -CHIP.w / 2 + 0.07, -0.03);
    return g;
  }

  /* 缺角：一個角被斜切掉，斷面淺色，旁邊掉一塊碎片 */
  function chipChipped() {
    const g = new THREE.Group(); g.name = 'chip_chipped';
    const a = CHIP.w / 2, c = 0.22;
    const shape = new THREE.Shape();
    shape.moveTo(-a, -a); shape.lineTo(a, -a); shape.lineTo(a, a - c); shape.lineTo(a - c, a); shape.lineTo(-a, a); shape.closePath();
    const geo = keep(new THREE.ExtrudeGeometry(shape, { depth: CHIP.h, bevelEnabled: false }));
    const body = new THREE.Mesh(geo, M.chipBody); body.name = 'chip_chipped_body';
    body.rotation.x = Math.PI / 2; body.position.y = CHIP.h / 2;      // 斷面 y→+z，擠出向下
    if (shadows) { body.castShadow = true; body.receiveShadow = true; }
    g.add(body);
    const cut = mesh(new THREE.BoxGeometry(c * Math.SQRT2, CHIP.h - 0.008, 0.012), M.fracture, 'chip_chipped_fracture');
    cut.position.set(a - c / 2, 0, a - c / 2); cut.rotation.y = Math.PI / 4; g.add(cut);
    chipPins(g, (x, z) => Math.min(x, a) + Math.min(z, a) <= 2 * a - c - 0.01, 'chip_chipped');   // 斷面線 x+z = 2a-c 之外的接腳一併缺失
    chipMarker(g, 'chip_chipped_marker', -a + 0.07, -a + 0.07);
    const shard = mesh(new THREE.BoxGeometry(0.11, 0.05, 0.11), M.chipBody, 'chip_chipped_shard');
    shard.position.set(a + 0.05, -CHIP.h / 2 + 0.025, a + 0.06); shard.rotation.y = 0.6; g.add(shard);
    return g;
  }

  /* ---------- 檢測結果標示：O／X + 信心分數（貼圖精靈）與紅框 ---------- */
  function labelTexture(kind, conf) {
    const cv = document.createElement('canvas'); cv.width = 160; cv.height = 200;
    const c = cv.getContext('2d');
    const good = kind === 'ok';
    c.fillStyle = good ? '#2fa85a' : '#e5423b';
    c.beginPath(); c.arc(80, 82, 66, 0, Math.PI * 2); c.fill();
    c.lineWidth = 6; c.strokeStyle = '#ffffff'; c.stroke();
    c.fillStyle = '#ffffff'; c.font = '700 84px system-ui, "Noto Sans TC", sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(good ? 'O' : 'X', 80, 86);
    if (!good) {
      c.fillStyle = 'rgba(29,45,61,.92)';
      c.beginPath(); c.roundRect ? c.roundRect(28, 156, 104, 36, 10) : c.rect(28, 156, 104, 36); c.fill();
      c.fillStyle = '#ffffff'; c.font = '600 26px system-ui, "Noto Sans TC", sans-serif';
      c.fillText(conf.toFixed(2), 80, 175);
    }
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace; texs.push(t);
    const m = new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false });
    mats.push(m);
    return m;
  }
  const labelMats = { ok: null, bad: [] };
  const labelMat = (kind, id) => {
    if (kind === 'ok') return labelMats.ok || (labelMats.ok = labelTexture('ok'));
    const i = chipConfidenceIndex(id);
    return labelMats.bad[i] || (labelMats.bad[i] = labelTexture('bad', CONF[i]));
  };

  const frameGeoX = keep(new THREE.BoxGeometry(0.88, 0.03, 0.04));
  const frameGeoZ = keep(new THREE.BoxGeometry(0.04, 0.03, 0.88));
  function defectFrame(tag) {
    const g = new THREE.Group(); g.name = 'defect_frame_' + tag;
    for (const s of [-1, 1]) {
      const a = new THREE.Mesh(frameGeoX, M.frameBad); a.name = g.name + '_x' + (s > 0 ? 'p' : 'n'); a.position.z = s * 0.44; g.add(a);
      const b = new THREE.Mesh(frameGeoZ, M.frameBad); b.name = g.name + '_z' + (s > 0 ? 'p' : 'n'); b.position.x = s * 0.44; g.add(b);
    }
    return g;
  }

  /* ---------- 取件站：機械手臂 + 收納箱 ---------- */
  const ARM = { x: PICK_X, z: -1.7, baseY: 0.64, H0: 0.47, L1: 1.15, L2: 1.05, Lg: 0.25 };
  const BIN = { x: BIN_POS.x, z: BIN_POS.z, w: 1.6, d: 1.5, h: 0.42, floor: 0.06, base: 0.14 + 0.22 };   // base：托盤高度，AGV 從下方頂起
  const CHIP_Y = BELT_TOP + CHIP.h / 2;   // 晶片在帶面上的中心高度

  function pickArm(ARM) {
    const g = new THREE.Group(); g.name = 'pick_arm';
    const ped = bbox(0.8, 0.5, 0.8, M.frame, 'arm_pedestal', { fillet: 0.03 });
    ped.position.set(ARM.x, 0.14 + 0.25, ARM.z); g.add(ped);
    const yawG = new THREE.Group(); yawG.name = 'arm_yaw'; yawG.position.set(ARM.x, ARM.baseY, ARM.z); g.add(yawG);
    const plate = mesh(new THREE.CylinderGeometry(0.34, 0.38, 0.12, seg(24, 10)), M.dark, 'arm_turntable');
    plate.position.y = 0.06; yawG.add(plate);
    const col = bbox(0.3, ARM.H0 - 0.12, 0.3, M.arm, 'arm_column', { fillet: 0.03 });
    col.position.y = 0.12 + (ARM.H0 - 0.12) / 2; yawG.add(col);

    const joint = (parent, name, r, len) => {
      const j = mesh(new THREE.CylinderGeometry(r, r, len, seg(20, 8)), M.dark, name);
      j.rotation.z = Math.PI / 2; parent.add(j); return j;
    };
    const shoulder = new THREE.Group(); shoulder.name = 'arm_shoulder'; shoulder.position.y = ARM.H0; yawG.add(shoulder);
    joint(shoulder, 'arm_shoulder_joint', 0.17, 0.4);
    const l1 = bbox(0.2, ARM.L1, 0.24, M.arm, 'arm_link_1', { fillet: 0.03 }); l1.position.y = ARM.L1 / 2; shoulder.add(l1);
    const elbow = new THREE.Group(); elbow.name = 'arm_elbow'; elbow.position.y = ARM.L1; shoulder.add(elbow);
    joint(elbow, 'arm_elbow_joint', 0.15, 0.34);
    const l2 = bbox(0.17, ARM.L2, 0.2, M.arm, 'arm_link_2', { fillet: 0.03 }); l2.position.y = ARM.L2 / 2; elbow.add(l2);
    const wrist = new THREE.Group(); wrist.name = 'arm_wrist'; wrist.position.y = ARM.L2; elbow.add(wrist);
    joint(wrist, 'arm_wrist_joint', 0.11, 0.28);
    const gripYaw = new THREE.Group(); gripYaw.name = 'arm_gripper'; wrist.add(gripYaw);
    const palm = bbox(0.8, 0.07, 0.2, M.dark, 'gripper_palm', { fillet: 0.015 }); palm.position.y = -0.05; gripYaw.add(palm);
    const fingers = [];
    for (const sgn of [-1, 1]) {
      const f = bbox(0.05, 0.32, 0.16, M.steel, 'gripper_finger_' + (sgn > 0 ? 'r' : 'l'), { fillet: 0.01 });
      f.position.y = -0.2; f.userData.sign = sgn; gripYaw.add(f); fingers.push(f);
    }
    return { g, yawG, shoulder, elbow, wrist, gripYaw, fingers };
  }

  function binCrate() {
    const g = new THREE.Group(); g.name = 'reject_bin';
    /* 托盤：兩條滑軌，底下留出 AGV 的空間 */
    for (const sgn of [-1, 1]) {
      const run = bbox(BIN.w, BIN.base - 0.14, 0.24, M.steel, 'pallet_runner_' + (sgn > 0 ? 'front' : 'back'), { fillet: 0.015 });
      run.position.set(BIN.x, 0.14 + (BIN.base - 0.14) / 2, BIN.z + sgn * (BIN.d / 2 - 0.22)); g.add(run);
    }
    const fl = bbox(BIN.w, BIN.floor, BIN.d, M.frame, 'bin_floor', { fillet: 0.01 });
    fl.position.set(BIN.x, BIN.base + BIN.floor / 2, BIN.z); g.add(fl);
    for (const sgn of [-1, 1]) {
      const wz = bbox(BIN.w, BIN.h, 0.06, M.frame, 'bin_wall_' + (sgn > 0 ? 'front' : 'back'), { fillet: 0.015 });
      wz.position.set(BIN.x, BIN.base + BIN.h / 2, BIN.z + sgn * (BIN.d / 2 - 0.03)); g.add(wz);
      const wx = bbox(0.06, BIN.h, BIN.d, M.frame, 'bin_wall_' + (sgn > 0 ? 'right' : 'left'), { fillet: 0.015 });
      wx.position.set(BIN.x + sgn * (BIN.w / 2 - 0.03), BIN.base + BIN.h / 2, BIN.z); g.add(wx);
    }
    const label = bbox(0.5, 0.16, 0.02, M.frameBad, 'bin_tag_x', { fillet: 0.01 });
    label.position.set(BIN.x, BIN.base + BIN.h * 0.62, BIN.z + BIN.d / 2 + 0.005); g.add(label);   // 紅色 X 收納箱標記
    return g;
  }
  /* 第 k 個進箱的瑕疵品在箱內的位置：2×2 一層，滿了疊第二層 */
  const BIN_CAP = 8, BIN_SCALE = 0.8;
  function binSlot(k) {
    const i = k % 4, layer = Math.floor(k / 4) % 2;
    return {
      x: BIN.x + (i % 2 ? 0.38 : -0.38),
      z: BIN.z + (i < 2 ? -0.36 : 0.36),
      y: BIN.base + BIN.floor + (CHIP.h * BIN_SCALE) / 2 + layer * 0.1,
      yaw: (hash01(k + 77) - 0.5) * 0.9
    };
  }

  /* 取放循環的取件點（帶面）、待命點與過渡高度 */
  const HOME = [PICK_X - 0.7, 1.55, -0.6];
  const HOVER_Y = CHIP_Y + 0.6, HIGH_Y = 1.35;
  const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const ss = (a, b, x) => smooth(clamp01((x - a) / (b - a)));

  /* Δ = 晶片相對取件點的位置（= 帶面位移）→ 夾爪中心點與夾合度；全程只取決於 Δ 與進箱序號 k */
  function tipAt(d, k) {
    const bin = binSlot(k);
    const grasp = [PICK_X + T.closed, CHIP_Y, 0];
    const lifted = [PICK_X + T.closed + 0.15, HIGH_Y, -0.15];
    if (d <= T.start) return { pos: HOME, grip: 0 };
    if (d < T.hover) return { pos: lerp3(HOME, [PICK_X + T.hover, HOVER_Y, 0], ss(T.start, T.hover, d)), grip: 0 };
    if (d < T.grasp) return { pos: [PICK_X + d, HOVER_Y + (CHIP_Y - HOVER_Y) * ss(T.hover, T.grasp, d), 0], grip: 0 };
    if (d < T.closed) return { pos: [PICK_X + d, CHIP_Y, 0], grip: ss(T.grasp, T.closed, d) };
    if (d < T.lift) return { pos: lerp3(grasp, lifted, ss(T.closed, T.lift, d)), grip: 1 };
    if (d < T.above) return { pos: lerp3(lifted, [bin.x, HIGH_Y, bin.z], ss(T.lift, T.above, d)), grip: 1 };
    if (d < T.down) return { pos: lerp3([bin.x, HIGH_Y, bin.z], [bin.x, bin.y, bin.z], ss(T.above, T.down, d)), grip: 1 };
    if (d < T.open) return { pos: [bin.x, bin.y, bin.z], grip: 1 - ss(T.down, T.open, d) };
    if (d < T.up) return { pos: lerp3([bin.x, bin.y, bin.z], [bin.x, HIGH_Y, bin.z], ss(T.open, T.up, d)), grip: 0 };
    if (d < T.home) return { pos: lerp3([bin.x, HIGH_Y, bin.z], HOME, ss(T.up, T.home, d)), grip: 0 };
    return { pos: HOME, grip: 0 };
  }

  /* 二連桿解析解：夾爪中心點（世界座標）→ 底座迴轉、肩、肘角 */
  function solveArm(ARM, tip) {
    const dx = tip[0] - ARM.x, dz = tip[2] - ARM.z;
    const yaw = Math.atan2(dx, dz), r = Math.hypot(dx, dz);
    const ey = tip[1] + ARM.Lg - (ARM.baseY + ARM.H0);
    const D = Math.min(ARM.L1 + ARM.L2 - 0.02, Math.max(Math.abs(ARM.L1 - ARM.L2) + 0.05, Math.hypot(r, ey)));
    const c = Math.max(-1, Math.min(1, (D * D - ARM.L1 * ARM.L1 - ARM.L2 * ARM.L2) / (2 * ARM.L1 * ARM.L2)));
    const th2 = Math.acos(c);
    const th1 = Math.atan2(r, ey) - Math.atan2(ARM.L2 * Math.sin(th2), ARM.L1 + ARM.L2 * Math.cos(th2));
    return { yaw, th1, th2 };
  }

  const DEFECTS = defectList(chipKind);

  function binChips() {
    const g = new THREE.Group(); g.name = 'bin_chips';
    for (let k = 0; k < BIN_CAP; k++) {
      const holder = new THREE.Group(); holder.name = 'bin_chip_' + pad(k + 1);
      const v = { crack: chipCrack(), chip: chipChipped() };
      for (const key in v) { v[key].visible = false; holder.add(v[key]); }
      holder.visible = false; g.add(holder);
      anim.bin.push({ holder, v, kind: null });
    }
    return g;
  }

  /* ---------- AGV：前後對稱（沒有「車頭」），倒車與前進外觀一致 ---------- */
  M.agvBeacon = mk('agv_beacon', 0xffb020, 0.4, 0.1, { emissive: new THREE.Color(0xffa000), emissiveIntensity: 0.9 });
  function agv(tag) {
    const g = new THREE.Group(); g.name = 'agv_' + tag;
    const body = bbox(1.2, 0.2, 0.8, M.dark, 'agv_body', { fillet: 0.03 }); body.position.y = 0.14 + 0.1; g.add(body);
    const band = bbox(1.23, 0.045, 0.83, M.arm, 'agv_band', { fillet: 0.015 }); band.position.y = 0.14 + 0.12; g.add(band);
    for (const sx of [-1, 1]) {
      const bump = bbox(0.06, 0.12, 0.7, M.kerb, 'agv_bumper_' + (sx > 0 ? 'e' : 'w'), { fillet: 0.01 });
      bump.position.set(sx * 0.63, 0.14 + 0.09, 0); g.add(bump);
      for (const sz of [-1, 1]) {
        const w = mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.08, seg(16, 8)), M.dark, 'agv_wheel_' + (sx > 0 ? 'e' : 'w') + (sz > 0 ? 'f' : 'b'));
        w.rotation.x = Math.PI / 2; w.position.set(sx * 0.45, 0.14 + 0.09, sz * 0.42); g.add(w);
      }
    }
    const lift = new THREE.Group(); lift.name = 'agv_lift'; g.add(lift);
    const plate = bbox(1.0, 0.03, 0.7, M.frame, 'agv_lift_plate', { fillet: 0.01 }); plate.position.y = 0.345; lift.add(plate);
    const beacon = mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.07, seg(12, 6)), M.agvBeacon, 'agv_beacon');
    beacon.position.set(0, 0.14 + 0.235, 0.36); g.add(beacon);
    return { g, lift };
  }

  /* ---------- 候選路線：地面光帶（可逐段「畫出」）、代價標籤、被擋處的 X ---------- */
  const routeVis = ROUTES.map(r => ({ ...r, meta: pathMeta(roundedPath(r.pts, ROUTE_RADIUS, seg(10, 5))) }));
  const ROUTE_TUBE_SEG = seg(160, 60), ROUTE_RADIAL = 6;
  function tagTexture(text, blocked) {
    const cv = document.createElement('canvas'); cv.width = 192; cv.height = 96;
    const c = cv.getContext('2d');
    if (blocked) {
      c.fillStyle = '#e5423b'; c.beginPath(); c.arc(96, 48, 40, 0, Math.PI * 2); c.fill();
      c.lineWidth = 5; c.strokeStyle = '#ffffff'; c.stroke();
      c.fillStyle = '#ffffff'; c.font = '700 54px system-ui, "Noto Sans TC", sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('X', 96, 52);
    } else {
      c.fillStyle = '#ffffff'; c.strokeStyle = 'rgba(29,45,61,.35)'; c.lineWidth = 4;
      c.beginPath(); c.roundRect ? c.roundRect(8, 16, 176, 64, 22) : c.rect(8, 16, 176, 64); c.fill(); c.stroke();
      c.fillStyle = '#1d2d3d'; c.font = '700 38px system-ui, "Noto Sans TC", sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(text, 96, 50);
    }
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; texs.push(t);
    const m = new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false, depthTest: false });
    mats.push(m); return m;
  }
  function pulseTexture() {
    const { cv, c, t } = canvasTex(256, 4);
    const gr = c.createLinearGradient(0, 0, 256, 0);
    gr.addColorStop(0, 'rgba(255,255,255,.3)'); gr.addColorStop(0.3, 'rgba(255,255,255,.3)');
    gr.addColorStop(0.5, 'rgba(255,255,255,1)'); gr.addColorStop(0.7, 'rgba(255,255,255,.3)'); gr.addColorStop(1, 'rgba(255,255,255,.3)');
    c.fillStyle = gr; c.fillRect(0, 0, 256, 4);
    t.wrapS = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }
  function routes() {
    const g = new THREE.Group(); g.name = 'routes';
    routeVis.forEach((r, i) => {
      const curve = new THREE.CatmullRomCurve3(r.meta.pts.map(q => new THREE.Vector3(q[0], 0, q[1])));
      const mat = new THREE.MeshBasicMaterial({ name: 'route_' + r.id, color: r.blocked ? 0xe5423b : 0x3aa0ff, transparent: true, opacity: 0, depthWrite: false, toneMapped: false });
      if (!r.blocked) {
        /* 可行路線：一道亮光沿路線流動（位移由 update(p) 決定） */
        const pt = pulseTexture(); pt.repeat.set(Math.max(2, r.meta.length / 2.2), 1); mat.map = pt;
      }
      mats.push(mat);
      const tube = new THREE.Mesh(keep(new THREE.TubeGeometry(curve, ROUTE_TUBE_SEG, 0.075, ROUTE_RADIAL, false)), mat);
      tube.name = 'route_' + r.id; tube.position.y = 0.17; tube.scale.y = 0.3; tube.visible = false;
      g.add(tube);
      const mid = pathAtDist(r.meta, r.meta.length * 0.45);
      const at = r.blocked ? r.cross : [mid.x, mid.z];
      const sp = new THREE.Sprite(tagTexture(r.meta.length.toFixed(1) + ' m', r.blocked));
      sp.name = 'route_tag_' + r.id; sp.position.set(at[0], 0.75, at[1]); sp.scale.set(r.blocked ? 0.62 : 1.05, r.blocked ? 0.62 : 0.52, 1); sp.visible = false;
      g.add(sp);
      anim.routes.push({ tube, mat, sprite: sp, r });
    });
    return g;
  }

  /* ---------- 分析站落點（設備由 ticket 06 建置） ---------- */
  function analysisPad() {
    const g = new THREE.Group(); g.name = 'analysis_pad';
    const pad = bbox(3.4, 0.03, 3.4, M.steel, 'analysis_pad_plate', { fillet: 0.01 });
    pad.position.set(STATION_POS.x, 0.14 + 0.015, STATION_POS.z); g.add(pad);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const c = bbox(0.5, 0.035, 0.5, M.kerb, 'analysis_pad_corner_' + (sx > 0 ? 'e' : 'w') + (sz > 0 ? 's' : 'n'), { fillet: 0.01 });
      c.position.set(STATION_POS.x + sx * 1.55, 0.14 + 0.02, STATION_POS.z + sz * 1.55); g.add(c);
    }
    return g;
  }

  /* ================= 第 03–06 幕：角色、對話、證據、控制室、數位孿生、燈塔 ================= */
  const rrect = (c, x, y, w, h, r) => { c.beginPath(); if (c.roundRect) c.roundRect(x, y, w, h, r); else c.rect(x, y, w, h); };
  /* 斷行：含中文時逐字，否則逐字詞 */
  function wrap(c, text, maxW) {
    const toks = /[㐀-鿿]/.test(text) ? Array.from(text) : text.split(/(?<= )/);
    const lines = []; let cur = '';
    for (const t of toks) {
      if (cur && c.measureText(cur + t).width > maxW) { lines.push(cur.trimEnd()); cur = t.trimStart(); } else cur += t;
    }
    if (cur) lines.push(cur.trimEnd());
    return lines;
  }
  const canvasTex = (w, h) => {
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; texs.push(t);
    return { cv, c: cv.getContext('2d'), t };
  };
  const spriteOf = (tex, name, w, h, opts2) => {
    const m = new THREE.SpriteMaterial(Object.assign({ map: tex, transparent: true, depthWrite: false, toneMapped: false }, opts2 || {}));
    mats.push(m);
    const sp = new THREE.Sprite(m); sp.name = name; sp.scale.set(w, h, 1); sp.visible = false;
    return sp;
  };

  /* ---------- 角色：工程師（藍色工作服、黃色安全帽）與 AI 機器人（白色機身、青色眼睛） ---------- */
  function makeChar(kind) {
    const ai = kind === 'ai';
    const g = new THREE.Group(); g.name = 'char_' + kind;
    const body = new THREE.Group(); body.name = kind + '_body'; g.add(body);
    const K = ai ? 0.86 : 1;                       // 機器人略矮
    const cap = (r, len, m, name) => mesh(new THREE.CapsuleGeometry(r, len, 4, seg(10, 6)), m, name);
    /* 軀幹 */
    const torso = new THREE.Group(); torso.name = kind + '_torso'; torso.position.y = 0.86 * K; body.add(torso);
    if (ai) {
      const t = bbox(0.5, 0.62, 0.34, M.robotW, 'ai_torso', { fillet: 0.08 }); t.position.y = 0.34; torso.add(t);
      const core = mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.03, seg(20, 8)), M.eye, 'ai_core_light');
      core.rotation.x = Math.PI / 2; core.position.set(0, 0.4, 0.18); torso.add(core);
    } else {
      const t = cap(0.21, 0.34, M.overall, 'worker_torso'); t.scale.z = 0.78; t.position.y = 0.34; torso.add(t);
      const vest = bbox(0.46, 0.5, 0.02, M.vest, 'worker_vest', { fillet: 0.03 }); vest.position.set(0, 0.36, 0.17); torso.add(vest);
    }
    /* 頭 */
    const head = new THREE.Group(); head.name = kind + '_head'; head.position.y = (ai ? 0.86 : 0.86) * K + 0.78; body.add(head);
    if (ai) {
      const h = bbox(0.44, 0.34, 0.36, M.robotW, 'ai_head', { fillet: 0.07 }); h.position.y = 0.02; head.add(h);
      const visor = bbox(0.34, 0.16, 0.02, M.dark, 'ai_visor', { fillet: 0.04 }); visor.position.set(0, 0.03, 0.19); head.add(visor);
      for (const sx of [-1, 1]) { const e = mesh(new THREE.SphereGeometry(0.035, 10, 8), M.eye, 'ai_eye_' + (sx > 0 ? 'r' : 'l')); e.position.set(sx * 0.08, 0.03, 0.205); head.add(e); }
      const ant = mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.16, 6), M.robotG, 'ai_antenna'); ant.position.y = 0.26; head.add(ant);
      const tip = mesh(new THREE.SphereGeometry(0.035, 10, 8), M.eye, 'ai_antenna_tip'); tip.position.y = 0.36; head.add(tip);
    } else {
      const h = mesh(new THREE.SphereGeometry(0.15, seg(16, 8), seg(12, 6)), M.skin, 'worker_head'); head.add(h);
      const hat = mesh(new THREE.SphereGeometry(0.17, seg(16, 8), seg(8, 5), 0, Math.PI * 2, 0, Math.PI / 2), M.hat, 'worker_hardhat'); hat.position.y = 0.03; head.add(hat);
      const brim = mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.02, seg(20, 8)), M.hat, 'worker_hat_brim'); brim.position.set(0, 0.03, 0.02); head.add(brim);
    }
    /* 手臂（肩軸在軀幹兩側，垂下為 -y） */
    const arms = [];
    for (const sx of [1, -1]) {
      const sh = new THREE.Group(); sh.name = kind + '_arm_' + (sx > 0 ? 'l' : 'r'); sh.position.set(sx * (ai ? 0.33 : 0.29) * 1, (ai ? 0.6 : 0.64) * K + 0.86 * K - 0.02, 0); body.add(sh);
      const a = cap(ai ? 0.05 : 0.06, ai ? 0.5 : 0.42, ai ? M.robotG : M.overall, sh.name + '_link'); a.position.y = -0.3 * K - 0.02; sh.add(a);
      const hand = mesh(new THREE.SphereGeometry(ai ? 0.06 : 0.065, 10, 8), ai ? M.robotW : M.skin, sh.name + '_hand'); hand.position.y = -0.64 * K; sh.add(hand);
      arms.push(sh);
    }
    /* 腿（髖軸在軀幹底） */
    const legs = [];
    for (const sx of [1, -1]) {
      const hp = new THREE.Group(); hp.name = kind + '_leg_' + (sx > 0 ? 'l' : 'r'); hp.position.set(sx * 0.11, 0.86 * K, 0); body.add(hp);
      const l = cap(ai ? 0.075 : 0.085, ai ? 0.5 : 0.56, ai ? M.robotG : M.overall, hp.name + '_link'); l.position.y = -0.42 * K; hp.add(l);
      const foot = bbox(0.14, 0.07, 0.26, M.dark, hp.name + '_foot', { fillet: 0.02 }); foot.position.set(0, -0.82 * K, 0.05); hp.add(foot);
      legs.push(hp);
    }
    return { g, body, torso, head, armL: arms[0], armR: arms[1], legL: legs[0], legR: legs[1], K };
  }
  function poseChar(ch, P) {
    ch.g.position.set(P.x, 0.14, P.z); ch.g.rotation.y = P.yaw;
    ch.body.position.y = P.bob;
    const sw = Math.sin(P.gait) * 0.6 * P.amp;
    ch.legL.rotation.x = sw; ch.legR.rotation.x = -sw;
    ch.armL.rotation.x = -(P.armLf - sw * 0.7); ch.armR.rotation.x = -(P.armRf + sw * 0.7);
    ch.armL.rotation.z = P.armLs; ch.armR.rotation.z = -P.armRs;
    ch.head.rotation.x = P.head; ch.torso.rotation.y = P.twist;
  }

  /* ---------- 對話框：中英同時呈現（模型只需一版） ---------- */
  function bubbleSprite(entry, who, idx) {
    const { cv, c, t } = canvasTex(640, 300);
    const col = who === 'ai' ? '#1aa6c9' : '#2f6fb2';
    rrect(c, 12, 30, 616, 214, 30); c.fillStyle = '#ffffff'; c.fill(); c.lineWidth = 6; c.strokeStyle = col; c.stroke();
    c.beginPath(); c.moveTo(70, 242); c.lineTo(118, 242); c.lineTo(84, 288); c.closePath(); c.fillStyle = '#ffffff'; c.fill();
    c.beginPath(); c.moveTo(66, 243); c.lineTo(84, 288); c.lineTo(122, 243); c.lineWidth = 6; c.strokeStyle = col; c.stroke();
    c.fillStyle = '#ffffff'; c.fillRect(74, 238, 44, 12);
    rrect(c, 34, 10, who === 'ai' ? 168 : 170, 38, 19); c.fillStyle = col; c.fill();
    c.fillStyle = '#fff'; c.font = '700 22px system-ui, "Noto Sans TC", sans-serif'; c.textBaseline = 'middle'; c.textAlign = 'left';
    c.fillText(who === 'ai' ? 'AI Agent' : '工程師 Engineer', 50, 30);
    c.fillStyle = '#1d2d3d'; c.font = '700 31px system-ui, "Noto Sans TC", sans-serif';
    let y = 84;
    for (const ln of wrap(c, entry.zh, 570).slice(0, 2)) { c.fillText(ln, 34, y); y += 38; }
    c.fillStyle = '#4a5a68'; c.font = '500 25px system-ui, "Noto Sans TC", sans-serif'; y += 6;
    for (const ln of wrap(c, entry.en, 570).slice(0, 3)) { c.fillText(ln, 34, y); y += 30; }
    const sp = spriteOf(t, 'dialogue_bubble_' + pad(idx + 1), 3.3, 1.55);
    sp.center.set(0.16, 0.06);
    return sp;
  }
  /* ---------- 證據面板：瑕疵影像、感測曲線、SOP 引用（示意） ---------- */
  function evidenceSprite() {
    const { c, t } = canvasTex(1024, 420);
    rrect(c, 8, 8, 1008, 404, 28); c.fillStyle = 'rgba(255,255,255,.96)'; c.fill(); c.lineWidth = 5; c.strokeStyle = '#1aa6c9'; c.stroke();
    c.fillStyle = '#1d2d3d'; c.font = '700 30px system-ui, "Noto Sans TC", sans-serif'; c.textBaseline = 'middle'; c.textAlign = 'left';
    c.fillText('證據 EVIDENCE', 36, 44);
    c.fillStyle = '#e5423b'; c.font = '600 22px system-ui, "Noto Sans TC", sans-serif'; c.textAlign = 'right'; c.fillText('示意 ILLUSTRATIVE', 990, 44); c.textAlign = 'left';
    const card = (x, title) => { rrect(c, x, 78, 300, 300, 18); c.fillStyle = '#f2f5f8'; c.fill(); c.strokeStyle = '#c9d3dc'; c.lineWidth = 3; c.stroke();
      c.fillStyle = '#4a5a68'; c.font = '600 21px system-ui, "Noto Sans TC", sans-serif'; c.fillText(title, x + 18, 106); };
    /* 1) 瑕疵影像 */
    card(34, '瑕疵影像 IMAGE');
    c.fillStyle = '#20272e'; rrect(c, 84, 150, 200, 190, 12); c.fill();
    c.strokeStyle = '#eef1f3'; c.lineWidth = 6; c.beginPath(); c.moveTo(184, 150); c.lineTo(168, 210); c.lineTo(198, 260); c.lineTo(180, 340); c.stroke();
    c.strokeStyle = '#e5423b'; c.lineWidth = 5; c.strokeRect(70, 138, 228, 214);
    c.fillStyle = '#e5423b'; c.font = '700 20px system-ui, "Noto Sans TC", sans-serif'; c.fillText('crack 0.98', 78, 128);
    /* 2) 感測曲線 */
    card(362, '感測曲線 SENSOR');
    c.fillStyle = 'rgba(47,168,90,.16)'; c.fillRect(392, 230, 240, 70);
    c.strokeStyle = '#2f6fb2'; c.lineWidth = 4; c.beginPath();
    const pts = [[392, 270], [430, 262], [468, 274], [506, 258], [544, 266], [566, 200], [590, 160], [632, 150]];
    pts.forEach((q, i) => i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1])); c.stroke();
    c.fillStyle = '#f28c28'; c.beginPath(); c.arc(590, 160, 9, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#4a5a68'; c.font = '500 19px system-ui, "Noto Sans TC", sans-serif'; c.fillText('feed rate ↑', 470, 340);
    /* 3) SOP 引用 */
    card(690, 'SOP 引用 CITATION');
    c.fillStyle = '#ffffff'; rrect(c, 738, 140, 200, 200, 10); c.fill(); c.strokeStyle = '#c9d3dc'; c.lineWidth = 3; c.stroke();
    c.fillStyle = '#1d2d3d'; c.font = '700 30px system-ui, "Noto Sans TC", sans-serif'; c.fillText('SOP 4.2', 754, 172);
    c.fillStyle = '#c9d3dc'; for (let i = 0; i < 4; i++) c.fillRect(754, 200 + i * 28, i === 3 ? 90 : 160, 10);
    c.strokeStyle = '#2fa85a'; c.lineWidth = 9; c.beginPath(); c.moveTo(838, 300); c.lineTo(860, 322); c.lineTo(906, 268); c.stroke();
    return spriteOf(t, 'evidence_panel', 3.9, 1.6);
  }

  /* ---------- 控制台：三面螢幕（參數／產線攝影機／SPC 與知識庫）、核准鈕 ---------- */
  const SCR_W = 512, SCR_H = 320;
  const screens = {};
  function makeScreen(key) { const o = canvasTex(SCR_W, SCR_H); o.key = null; screens[key] = o; return o; }
  function monitorUnit(name, w, h, mat) {
    const g = new THREE.Group(); g.name = name;
    const shell = bbox(w + 0.1, h + 0.1, 0.08, M.dark, name + '_shell', { fillet: 0.03 }); g.add(shell);
    const face = new THREE.Mesh(keep(new THREE.PlaneGeometry(w, h)), mat); face.name = name + '_screen'; face.position.z = 0.045; g.add(face);
    const stand = bbox(0.12, 0.2, 0.1, M.steel, name + '_stand', { fillet: 0.01 }); stand.position.set(0, -h / 2 - 0.1, -0.02); g.add(stand);
    return g;
  }
  const screenMat = t => { const m = new THREE.MeshBasicMaterial({ map: t, toneMapped: false }); mats.push(m); return m; };
  let feedMat = null, feedRT = null, feedLive = false;
  const feedCam = new THREE.PerspectiveCamera(42, SCR_W / SCR_H, 0.1, 60);
  feedCam.position.set(CAM_X - 2.6, 1.9, 2.7); feedCam.lookAt(CAM_X + 1.1, 0.75, 0);

  const btn = { mesh: null };
  function controlRoom() {
    const g = new THREE.Group(); g.name = 'control_room';
    const DESK = { w: 4.6, d: 0.8, top: 0.95 };
    const top = bbox(DESK.w, 0.08, DESK.d, M.steel, 'desk_top', { fillet: 0.02 }); top.position.set(CONSOLE.x, DESK.top, CONSOLE.z + 0.5); g.add(top);
    for (const sx of [-1, 1]) {
      const leg = bbox(0.1, DESK.top - 0.14, DESK.d - 0.1, M.frame, 'desk_leg_' + (sx > 0 ? 'e' : 'w'), { fillet: 0.015 });
      leg.position.set(CONSOLE.x + sx * (DESK.w / 2 - 0.1), 0.14 + (DESK.top - 0.14) / 2, CONSOLE.z + 0.5); g.add(leg);
    }
    const kb = bbox(0.9, 0.03, 0.3, M.dark, 'keyboard', { fillet: 0.01 }); kb.position.set(CONSOLE.x - 0.4, DESK.top + 0.055, CONSOLE.z + 0.72); g.add(kb);
    /* 核准鈕 */
    const base = mesh(new THREE.CylinderGeometry(0.13, 0.14, 0.04, seg(20, 8)), M.dark, 'approve_base'); base.position.set(CONSOLE.x - 1.3, DESK.top + 0.06, CONSOLE.z + 0.62); g.add(base);
    const b = mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.05, seg(20, 8)), M.button, 'approve_button'); b.position.set(CONSOLE.x - 1.3, DESK.top + 0.1, CONSOLE.z + 0.62); g.add(b); btn.mesh = b;
    /* 螢幕 */
    const sp = makeScreen('param'), ss2 = makeScreen('stat'), sf = makeScreen('feed');
    feedMat = screenMat(sf.t);
    const mid = monitorUnit('monitor_feed', 1.6, 1.0, feedMat); mid.position.set(CONSOLE.x, 1.62, CONSOLE.z + 0.25); g.add(mid);
    const left = monitorUnit('monitor_param', 1.28, 0.8, screenMat(sp.t)); left.position.set(CONSOLE.x - 1.55, 1.55, CONSOLE.z + 0.33); left.rotation.y = 0.28; g.add(left);
    const right = monitorUnit('monitor_stat', 1.28, 0.8, screenMat(ss2.t)); right.position.set(CONSOLE.x + 1.55, 1.55, CONSOLE.z + 0.33); right.rotation.y = -0.28; g.add(right);
    return g;
  }

  /* 螢幕內容：只在量化後的狀態改變時重畫 */
  function drawParam(st) {
    const o = screens.param, c = o.c;
    c.fillStyle = '#0f1a24'; c.fillRect(0, 0, SCR_W, SCR_H);
    c.fillStyle = '#66e0ff'; c.font = '700 26px system-ui, "Noto Sans TC", sans-serif'; c.textBaseline = 'middle'; c.textAlign = 'left'; c.fillText('PARAMETERS  參數', 24, 34);
    c.fillStyle = '#9fb2c2'; c.font = '500 22px system-ui, "Noto Sans TC", sans-serif'; c.fillText('進給速度 Feed rate', 24, 96);
    rrect(c, 24, 120, 464, 16, 8); c.fillStyle = '#26384a'; c.fill();
    const x = 24 + 464 * (0.92 - 0.35 * st.slide + 0.0), kx = 24 + 464 * (0.9 - 0.32 * st.slide);
    rrect(c, 24, 120, kx - 24, 16, 8); c.fillStyle = '#2f6fb2'; c.fill();
    c.fillStyle = '#ffffff'; c.beginPath(); c.arc(kx, 128, 16, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#9fb2c2'; c.font = '500 18px system-ui, "Noto Sans TC", sans-serif'; c.fillText('▼ 調降  lower', 24, 168);
    const label = st.stage >= 2 ? '已套用 APPLIED ✓' : st.stage === 1 ? '核准 APPROVE' : '模擬中 SIMULATING…';
    const col = st.stage >= 2 ? '#2fa85a' : st.stage === 1 ? '#f2b233' : '#4a5a68';
    rrect(c, 24, 214, 464, 66, 14); c.fillStyle = col; c.fill();
    c.fillStyle = '#ffffff'; c.font = '700 30px system-ui, "Noto Sans TC", sans-serif'; c.textAlign = 'center'; c.fillText(label, 256, 248); c.textAlign = 'left';
    c.fillStyle = '#e5423b'; c.font = '600 16px system-ui, "Noto Sans TC", sans-serif'; c.fillText('示意 ILLUSTRATIVE', 24, 300);
    o.t.needsUpdate = true;
  }
  function drawStat(st) {
    const o = screens.stat, c = o.c;
    c.fillStyle = '#0f1a24'; c.fillRect(0, 0, SCR_W, SCR_H);
    c.fillStyle = '#66e0ff'; c.font = '700 24px system-ui, "Noto Sans TC", sans-serif'; c.textBaseline = 'middle'; c.textAlign = 'left'; c.fillText('SPC  連續良品 CONSECUTIVE OK', 24, 34);
    c.fillStyle = st.n > 0 ? '#2fa85a' : '#4a5a68'; c.font = '700 120px system-ui, "Noto Sans TC", sans-serif'; c.fillText(st.n > 0 ? String(st.n) : '—', 24, 128);
    c.fillStyle = '#9fb2c2'; c.font = '500 22px system-ui, "Noto Sans TC", sans-serif'; c.fillText('瑕疵 DEFECTS  0', 250, 100);
    /* 機台狀態燈（與現場燈塔同步：紅 → 黃 → 綠） */
    c.font = '500 18px system-ui, "Noto Sans TC", sans-serif'; c.fillText('機台 MACHINES', 250, 136);
    const lampCol = st.lamp === 'green' ? '#2fa85a' : st.lamp === 'amber' ? '#ffb020' : '#e5423b';
    for (let i = 0; i < 3; i++) { c.fillStyle = lampCol; c.beginPath(); c.arc(266 + i * 40, 168, 13, 0, Math.PI * 2); c.fill(); c.lineWidth = 3; c.strokeStyle = 'rgba(255,255,255,.55)'; c.stroke(); }
    /* 知識庫：案例卡片滑入資料庫圖示 */
    rrect(c, 24, 196, 464, 92, 14); c.fillStyle = '#16283a'; c.fill();
    c.fillStyle = '#9fb2c2'; c.font = '600 20px system-ui, "Noto Sans TC", sans-serif'; c.fillText('知識庫 KNOWLEDGE BASE', 40, 220);
    c.fillStyle = '#2f6fb2'; c.beginPath(); c.ellipse(430, 250, 30, 10, 0, 0, Math.PI * 2); c.fill(); c.fillRect(400, 250, 60, 20);
    c.beginPath(); c.ellipse(430, 270, 30, 10, 0, 0, Math.PI); c.fill(); c.fillStyle = '#4c8fd6'; c.beginPath(); c.ellipse(430, 250, 30, 10, 0, 0, Math.PI * 2); c.fill();
    if (st.card < 1) { const cx = 60 + 320 * st.card; c.globalAlpha = 1 - Math.max(0, st.card - 0.85) / 0.15; rrect(c, cx, 232, 64, 42, 6); c.fillStyle = '#f2f5f8'; c.fill(); c.fillStyle = '#e5423b'; c.fillRect(cx + 8, 242, 30, 5); c.fillStyle = '#9fb2c2'; c.fillRect(cx + 8, 254, 46, 5); c.globalAlpha = 1; }
    if (st.saved) { c.fillStyle = '#2fa85a'; c.font = '700 22px system-ui, "Noto Sans TC", sans-serif'; c.fillText('已寫入 SAVED ✓', 40, 262); }
    o.t.needsUpdate = true;
  }
  /* 產線攝影機畫面：桌機為即時渲染；低階裝置與尚未啟用時用這張示意畫面（帶面、晶片、O） */
  function drawFeed(st) {
    const o = screens.feed, c = o.c;
    c.fillStyle = '#0f1a24'; c.fillRect(0, 0, SCR_W, SCR_H);
    c.fillStyle = '#66e0ff'; c.font = '700 22px system-ui, "Noto Sans TC", sans-serif'; c.textBaseline = 'middle'; c.textAlign = 'left'; c.fillText(st.live ? 'LINE CAM 01 · LIVE' : 'LINE CAM 01 · STANDBY', 20, 28);
    c.fillStyle = '#26323e'; c.fillRect(0, 130, SCR_W, 110);
    const off = (st.t * 0.9) % 1;
    for (let i = -1; i < 6; i++) {
      const x = ((i + off) * 96) + 20, ok = st.live;
      c.fillStyle = '#20272e'; c.fillRect(x, 160, 56, 50); c.fillStyle = '#c9d3dc'; for (let k = 0; k < 4; k++) { c.fillRect(x - 6, 166 + k * 11, 6, 5); c.fillRect(x + 56, 166 + k * 11, 6, 5); }
      if (ok && x > 190) { c.fillStyle = '#2fa85a'; c.beginPath(); c.arc(x + 28, 120, 20, 0, Math.PI * 2); c.fill(); c.fillStyle = '#fff'; c.font = '700 26px system-ui, "Noto Sans TC", sans-serif'; c.textAlign = 'center'; c.fillText('O', x + 28, 122); c.textAlign = 'left'; }
    }
    c.strokeStyle = '#66e0ff'; c.lineWidth = 3; c.setLineDash([8, 8]); c.beginPath(); c.moveTo(190, 100); c.lineTo(190, 250); c.stroke(); c.setLineDash([]);
    o.t.needsUpdate = true;
  }

  /* ---------- 數位孿生：桌上的半透明縮小產線，模擬跑完變綠 ---------- */
  const twinParts = { g: null, chips: [], bar: null, pass: null };
  function twinTable() {
    const g = new THREE.Group(); g.name = 'twin_table';
    const top = bbox(2.6, 0.06, 1.2, M.steel, 'twin_table_top', { fillet: 0.02 }); top.position.set(TWIN.x, 0.9, TWIN.z); g.add(top);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const l = bbox(0.08, 0.76, 0.08, M.frame, 'twin_table_leg', { fillet: 0.01 }); l.position.set(TWIN.x + sx * 1.15, 0.52, TWIN.z + sz * 0.5); g.add(l);
    }
    const holo = new THREE.Group(); holo.name = 'digital_twin'; holo.position.set(TWIN.x, 0.94, TWIN.z); g.add(holo); twinParts.g = holo;
    const hm = (geo, name) => { const o = new THREE.Mesh(keep(geo), M.holo); o.name = name; return o; };
    const belt = hm(new THREE.BoxGeometry(2.0, 0.05, 0.16), 'twin_belt'); belt.position.y = 0.04; holo.add(belt);
    for (const sz of [-1, 1]) { const post = hm(new THREE.BoxGeometry(0.04, 0.3, 0.04), 'twin_gantry_post'); post.position.set(-0.3, 0.19, sz * 0.14); holo.add(post); }
    const beam = hm(new THREE.BoxGeometry(0.05, 0.04, 0.32), 'twin_gantry_beam'); beam.position.set(-0.3, 0.34, 0); holo.add(beam);
    const arm = hm(new THREE.CylinderGeometry(0.05, 0.06, 0.2, 10), 'twin_arm_base'); arm.position.set(0.45, 0.14, -0.28); holo.add(arm);
    const armUp = hm(new THREE.BoxGeometry(0.05, 0.3, 0.05), 'twin_arm_link'); armUp.position.set(0.45, 0.34, -0.28); armUp.rotation.z = -0.5; holo.add(armUp);
    const bin = hm(new THREE.BoxGeometry(0.24, 0.12, 0.2), 'twin_bin'); bin.position.set(0.75, 0.08, -0.3); holo.add(bin);
    for (let i = 0; i < 8; i++) { const ch = hm(new THREE.BoxGeometry(0.075, 0.03, 0.075), 'twin_chip_' + pad(i + 1)); ch.position.y = 0.09; holo.add(ch); twinParts.chips.push(ch); }
    const bar = new THREE.Mesh(keep(new THREE.BoxGeometry(1, 0.03, 0.05)), M.holo); bar.name = 'twin_progress'; bar.position.set(TWIN.x - 1.0, 0.95, TWIN.z + 0.5); g.add(bar); twinParts.bar = bar;
    const { c, t } = canvasTex(256, 110);
    rrect(c, 6, 6, 244, 98, 24); c.fillStyle = '#2fa85a'; c.fill(); c.fillStyle = '#fff'; c.font = '700 44px system-ui, "Noto Sans TC", sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('PASS ✓', 128, 58);
    const pass = spriteOf(t, 'twin_pass', 0.9, 0.39); pass.position.set(TWIN.x, 1.5, TWIN.z); g.add(pass); twinParts.pass = pass;
    return g;
  }

  /* ---------- 燈塔：紅 → 黃 → 綠 ---------- */
  const towers = [];
  function andonTower(x, z, tag) {
    const g = new THREE.Group(); g.name = 'andon_' + tag;
    const pole = mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.1, 8), M.steel, 'andon_pole'); pole.position.set(x, 0.14 + 0.55, z); g.add(pole);
    const lamps = [M.lampR, M.lampA, M.lampG].map((m, i) => {
      const l = mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.13, seg(14, 8)), m, 'andon_lamp_' + i); l.position.set(x, 0.14 + 1.16 + i * 0.14, z); g.add(l); return l;
    });
    towers.push(lamps); return g;
  }

  /* ---------- 角色與對話的組裝 ---------- */
  const chars = { worker: makeChar('worker'), ai: makeChar('ai') };
  const dlg = (opts.dialogue || []).slice(0, LINES.length);
  const bubbles = dlg.map((e, i) => { const sp = bubbleSprite(e, LINES[i].who, i); return sp; });
  const evidence = evidenceSprite(); evidence.position.set(STATION_POS.x, 4.7, STATION_POS.z);
  const BSC = low ? 1.4 : 1;   // 手機鏡頭較遠，對話框放大一些才讀得到
  evidence.renderOrder = 10; bubbles.forEach(b => { b.renderOrder = 20; });
  evidence.scale.multiplyScalar(low ? 1.25 : 1);

  /* ================= 第二支手臂：把合格品裝箱，輸送帶因此一直運轉 ================= */
  const ARM2 = { x: PACK_X, z: 2.0, baseY: 0.64, H0: 0.47, L1: 1.15, L2: 1.05, Lg: 0.25 };
  const BOXP = { z: 3.6, w: 1.7, d: 1.55, h: 0.36, floor: 0.05, pitch: 2.3 };
  const RAIL_TOP = 0.14 + 0.06;
  const BOX_SCALE = 0.72, POOL = 3 * BOX_PER;
  const slotLocal = s2 => ({ x: ((s2 % 3) - 1) * 0.5, z: (Math.floor(s2 / 3) - 1) * 0.45 });
  const SLOT_Y = RAIL_TOP + BOXP.floor + (CHIP.h * BOX_SCALE) / 2;
  const HOME2 = [PACK_X - 0.55, 1.55, 1.15];
  const GOOD = goodList(chipKind);
  const slotAtFill = k => { const l = slotLocal(k % BOX_PER); return [PACK_X + l.x, SLOT_Y, BOXP.z + l.z]; };

  /* 取放循環（相對取件點的帶面位移 d）：待命 → 追著晶片下探 → 夾起 → 放進箱內格位 → 回待命 */
  function tipAt2(d, k) {
    const slot = slotAtFill(k);
    const grasp = [PACK_X + T2.closed, CHIP_Y, 0], lifted = [PACK_X + T2.closed + 0.1, HIGH_Y, 0.6];
    if (d <= T2.start) return { pos: HOME2, grip: 0 };
    if (d < T2.hover) return { pos: lerp3(HOME2, [PACK_X + T2.hover, HOVER_Y, 0], ss(T2.start, T2.hover, d)), grip: 0 };
    if (d < T2.grasp) return { pos: [PACK_X + d, HOVER_Y + (CHIP_Y - HOVER_Y) * ss(T2.hover, T2.grasp, d), 0], grip: 0 };
    if (d < T2.closed) return { pos: [PACK_X + d, CHIP_Y, 0], grip: ss(T2.grasp, T2.closed, d) };
    if (d < T2.lift) return { pos: lerp3(grasp, lifted, ss(T2.closed, T2.lift, d)), grip: 1 };
    if (d < T2.above) return { pos: lerp3(lifted, [slot[0], HIGH_Y, slot[2]], ss(T2.lift, T2.above, d)), grip: 1 };
    if (d < T2.down) return { pos: lerp3([slot[0], HIGH_Y, slot[2]], slot, ss(T2.above, T2.down, d)), grip: 1 };
    if (d < T2.open) return { pos: slot, grip: 1 - ss(T2.down, T2.open, d) };
    if (d < T2.up) return { pos: lerp3(slot, [slot[0], HIGH_Y, slot[2]], ss(T2.open, T2.up, d)), grip: 0 };
    if (d < T2.home) return { pos: lerp3([slot[0], HIGH_Y, slot[2]], HOME2, ss(T2.up, T2.home, d)), grip: 0 };
    return { pos: HOME2, grip: 0 };
  }

  function packArm() {
    const a = pickArm(ARM2);
    a.g.traverse(o => { o.name += '_pack'; });
    return a;
  }
  /* 箱子：紙箱 + 綠色 O 標籤；輸送軌在下方（箱子滿了往西滑走，新箱從東側滑入） */
  function packBox(i) {
    const g = new THREE.Group(); g.name = 'pack_box_' + pad(i + 1);
    const fl = bbox(BOXP.w, BOXP.floor, BOXP.d, M.box, 'pack_box_floor', { fillet: 0.01 }); fl.position.y = RAIL_TOP + BOXP.floor / 2; g.add(fl);
    for (const sgn of [-1, 1]) {
      const wz = bbox(BOXP.w, BOXP.h, 0.05, M.box, 'pack_box_wall_' + (sgn > 0 ? 'front' : 'back'), { fillet: 0.01 });
      wz.position.set(0, RAIL_TOP + BOXP.h / 2, sgn * (BOXP.d / 2 - 0.025)); g.add(wz);
      const wx = bbox(0.05, BOXP.h, BOXP.d, M.box, 'pack_box_wall_' + (sgn > 0 ? 'east' : 'west'), { fillet: 0.01 });
      wx.position.set(sgn * (BOXP.w / 2 - 0.025), RAIL_TOP + BOXP.h / 2, 0); g.add(wx);
    }
    const tag = bbox(0.4, 0.14, 0.02, M.boxTag, 'pack_box_tag_ok', { fillet: 0.01 });
    tag.position.set(0, RAIL_TOP + BOXP.h * 0.6, BOXP.d / 2 + 0.005); g.add(tag);
    return g;
  }
  function chipLite(i) {
    const g = new THREE.Group(); g.name = 'pack_chip_' + pad(i + 1);
    g.add(bbox(CHIP.w, CHIP.h, CHIP.w, M.chipBody, g.name + '_body', { fillet: 0.02, bevel: 0.012 }));
    for (const sx of [-1, 1]) {
      const pins = mesh(new THREE.BoxGeometry(0.05, 0.02, CHIP.w * 0.8), M.chipPin, g.name + '_pins_' + (sx > 0 ? 'e' : 'w'));
      pins.position.set(sx * (CHIP.w / 2 + 0.02), -0.005, 0); g.add(pins);
    }
    const mk2 = mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.012, seg(10, 6)), M.chipMark, g.name + '_marker');
    mk2.position.set(-CHIP.w / 2 + 0.07, CHIP.h / 2 + 0.004, -CHIP.w / 2 + 0.07); g.add(mk2);
    return g;
  }
  function packStation() {
    const g = new THREE.Group(); g.name = 'pack_station';
    const rail = bbox(7.4, 0.06, 1.3, M.steel, 'pack_rail', { fillet: 0.015 }); rail.position.set(PACK_X - 1.5, 0.14 + 0.03, BOXP.z); g.add(rail);
    for (let i = 0; i < 4; i++) { const b = packBox(i); b.position.set(PACK_X, 0, BOXP.z); b.visible = false; g.add(b); anim.boxes.push(b); }
    for (let i = 0; i < POOL; i++) { const c = chipLite(i); c.visible = false; g.add(c); anim.packChips.push(c); }
    return g;
  }

  /* 晶片池：每個槽位含三種外型、標示精靈與紅框，update(p) 只切換可見性 */
  function chipPool() {
    const g = new THREE.Group(); g.name = 'chips';
    for (let i = 0; i < SLOTS; i++) {
      const tag = pad(i + 1);
      const slot = new THREE.Group(); slot.name = 'chip_slot_' + tag;
      const variants = { ok: chipOk(), crack: chipCrack(), chip: chipChipped() };
      for (const k in variants) { variants[k].visible = false; slot.add(variants[k]); }
      const frame = defectFrame(tag); frame.position.y = -CHIP.h / 2 + 0.02; frame.visible = false; slot.add(frame);
      const sprite = new THREE.Sprite(labelMat('ok', 0)); sprite.name = 'chip_label_' + tag;
      sprite.position.y = 0.6; sprite.scale.set(0.44, 0.55, 1); sprite.visible = false; slot.add(sprite);
      g.add(slot);
      anim.slots.push({ slot, variants, frame, sprite, kind: null, id: null });   // 流水號可為負，哨兵值不能用 -1
    }
    return g;
  }

  anim.arm = pickArm(ARM);
  anim.arm2 = packArm();
  /* 收納箱 + 托盤 + 箱內晶片放進同一個 rig：AGV 頂起時整組跟著走（座標仍是靜止時的世界座標） */
  anim.rig = new THREE.Group(); anim.rig.name = 'bin_rig';
  anim.rig.add(binCrate(), binChips());
  anim.agv = agv('01'); anim.agv.g.position.set(AGV_PARK.x, 0, AGV_PARK.z);
  anim.agv2 = agv('02'); anim.agv2.g.position.set(AGV_PARK.x + 0.2, 0, BIN_POS.z - 1.5); anim.agv2.g.rotation.y = Math.PI / 2;   // 待命中的第二台，示意車隊
  group.add(floorPlate(), conveyor(), inspectionGantry(), chipPool(), anim.arm.g, anim.arm2.g, packStation(), anim.rig, analysisPad(), routes(), anim.agv.g, anim.agv2.g);
  group.add(controlRoom(), twinTable(), andonTower(CAM_X + 1.3, -1.2, 'gantry'), andonTower(PICK_X - 1.4, -2.9, 'arm'));
  group.add(chars.worker.g, chars.ai.g, evidence, ...bubbles);

  /* 取景用邊界（相機距離與光源範圍由此推導，不寫死數字） */
  const bb = new THREE.Box3().setFromObject(group);
  const sph = bb.getBoundingSphere(new THREE.Sphere());
  const bounds = {
    center: sph.center.clone(), radius: sph.radius, box: bb,
    contentRadius: 0.5 * Math.hypot(bb.max.x - bb.min.x, bb.max.z - bb.min.z) * 0.86
  };

  /* ---------- 角色、對話、證據、控制室、孿生、燈塔：全部只取決於 p ---------- */
  let lastP = 0;
  const FEED_ON = 0.68;   // 控制台進入畫面之前不必渲染產線攝影機
  function updateActors(p) {
    lastP = p;
    const poses = { worker: charPose('worker', p), ai: charPose('ai', p) };
    poseChar(chars.worker, poses.worker); poseChar(chars.ai, poses.ai);

    bubbles.forEach((sp, i) => {
      const L = LINES[i], a = ssp(L.from, L.from + 0.008, p) * (1 - ssp(L.to - 0.008, L.to, p));
      sp.visible = a > 0.01;
      if (!sp.visible) return;
      const P = poses[L.who];
      sp.position.set(P.x - 0.1, L.who === 'ai' ? 2.25 : 2.15, P.z);
      sp.material.opacity = a;
      const k = (0.9 + 0.1 * a) * BSC; sp.scale.set(3.3 * k, 1.55 * k, 1);
    });
    const ev = ssp(EVIDENCE_WIN[0], EVIDENCE_WIN[0] + 0.01, p) * (1 - ssp(EVIDENCE_WIN[1] - 0.01, EVIDENCE_WIN[1], p));
    evidence.visible = ev > 0.01; evidence.material.opacity = ev;

    /* 數位孿生：浮現 → 模擬（晶片在縮小產線上流動、進度條前進）→ 通過變綠 */
    const ap = ssp(SIM.appear[0], SIM.appear[1], p), run = ssp(SIM.run[0], SIM.run[1], p), pass = ssp(SIM.run[1] - 0.006, SIM.run[1], p);
    twinParts.g.visible = ap > 0.01; twinParts.g.scale.setScalar(Math.max(0.001, ap));
    M.holo.color.setRGB(0.4 * (1 - pass) + 0.18 * pass, 0.88 * (1 - pass) + 0.66 * pass, 1 - 0.65 * pass);
    twinParts.chips.forEach((ch, i) => { ch.position.x = -1.0 + (i * 0.25 + run * 2.4) % 2.0; });
    twinParts.bar.visible = ap > 0.5; twinParts.bar.scale.x = Math.max(0.001, run * 2.0); twinParts.bar.position.x = TWIN.x - 1.0 + run;
    twinParts.pass.visible = pass > 0.5 && ap > 0.5;

    /* 燈塔：紅 → 黃（模擬中）→ 綠（核准後） */
    const toAmber = ssp(ANDON.amber - 0.004, ANDON.amber, p), toGreen = ssp(ANDON.green - 0.004, ANDON.green, p);
    M.lampR.emissiveIntensity = 0.08 + 1.3 * (1 - toAmber);
    M.lampA.emissiveIntensity = 0.08 + 1.2 * toAmber * (1 - toGreen);
    M.lampG.emissiveIntensity = 0.08 + 1.3 * toGreen;

    /* 核准鈕：模擬通過後亮起，按下時下沉 */
    const ready = ssp(SIM.run[1] - 0.004, SIM.run[1] + 0.004, p);
    const press = ssp(PRESS[0], PRESS[0] + 0.004, p) * (1 - ssp(PRESS[1] - 0.004, PRESS[1], p));
    M.button.emissiveIntensity = 0.1 + 0.6 * ready + 0.6 * ssp(PRESS[0], PRESS[1], p);
    btn.mesh.position.y = 0.95 + 0.1 - 0.03 * press;

    /* 螢幕：狀態量化後才重畫 */
    const stage = p >= PRESS[1] ? 2 : p >= SIM.run[1] ? 1 : 0, slide = Math.round(ssp(0.735, 0.76, p) * 20) / 20;
    const kp = stage + '|' + slide;
    if (screens.param.key !== kp) { screens.param.key = kp; drawParam({ stage, slide }); }
    const n = okCountAt(p), card = Math.round(ssp(0.83, 0.86, p) * 12) / 12, saved = p >= 0.86;
    const lamp = p >= ANDON.green ? 'green' : p >= ANDON.amber ? 'amber' : 'red';
    const ks = n + '|' + card + '|' + saved + '|' + lamp;
    if (screens.stat.key !== ks) { screens.stat.key = ks; drawStat({ n, card, saved, lamp }); }
    const live = p >= FEED_ON, tq = Math.round(travelAt(p) * 5) / 5;
    if (feedLive && !live) { feedLive = false; feedMat.map = screens.feed.t; feedMat.needsUpdate = true; }
    const kf = live + '|' + tq;
    if (!feedLive && screens.feed.key !== kf) { screens.feed.key = kf; drawFeed({ live: p >= P_RESUME, t: tq / 1.3 }); }
  }
  /* 產線攝影機即時畫面：桌機把場景再渲染到小張貼圖；低階裝置維持示意畫面 */
  function renderFeed(renderer, threeScene) {
    if (low || lastP < FEED_ON) return;
    if (!feedRT) feedRT = new THREE.WebGLRenderTarget(768, 480);
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(feedRT); renderer.clear(); renderer.render(threeScene, feedCam); renderer.setRenderTarget(prev);
    if (!feedLive) { feedLive = true; feedMat.map = feedRT.texture; feedMat.needsUpdate = true; }
  }

  /* ---------- 第二支手臂與裝箱：只取決於 p ---------- */
  function updatePack(p) {
    /* 手臂：連續合格品時首尾相接；缺件時回待命點 */
    let tip = null, c = 0;
    for (const gd of GOOD) {
      const d = chipX(gd.n, p) - PACK_X;
      if (d >= T2.grasp) c++;
      if (!tip && d > T2.start && d < T2.home) tip = tipAt2(d, gd.k);
    }
    if (!tip) tip = { pos: HOME2, grip: 0 };
    const A = anim.arm2, ik = solveArm(ARM2, tip.pos);
    A.yawG.rotation.y = ik.yaw; A.shoulder.rotation.x = ik.th1; A.elbow.rotation.x = ik.th2;
    A.wrist.rotation.x = -(ik.th1 + ik.th2); A.gripYaw.rotation.y = -ik.yaw;
    for (const f of A.fingers) f.position.x = f.userData.sign * (0.37 - 0.06 * tip.grip);

    /* 箱子輸送：每箱第 9 顆放進去之後滑走，下一箱從東側滑入 */
    let S = 0;
    for (let b = 0; BOX_PER * b + BOX_PER - 1 < GOOD.length; b++) S += ss(0.75, 1.25, chipX(GOOD[BOX_PER * b + BOX_PER - 1].n, p) - PACK_X);
    const bIdx = Math.floor(S);
    anim.boxes.forEach(bx => { bx.visible = false; });
    for (let b = Math.max(0, bIdx - 1); b <= bIdx + 1; b++) {
      const rel = b - S, bx = anim.boxes[b % 4];
      bx.visible = rel > -1.5 && rel < 1.2;
      bx.position.x = PACK_X + rel * BOXP.pitch;
      bx.scale.setScalar(Math.max(0.001, 1 - ss(1.0, 1.5, -rel)));
    }
    /* 箱內晶片：夾起後跟著夾爪走，放下後隨箱子移動 */
    for (let j = 0; j < POOL; j++) {
      const o = anim.packChips[j];
      const k = c > 0 ? (c - 1) - ((((c - 1 - j) % POOL) + POOL) % POOL) : -1;
      if (k < 0 || k >= GOOD.length) { o.visible = false; continue; }
      const rel = Math.floor(k / BOX_PER) - S, fade = Math.max(0.001, 1 - ss(1.0, 1.5, -rel));
      if (rel <= -1.5) { o.visible = false; continue; }
      const d = chipX(GOOD[k].n, p) - PACK_X, l = slotLocal(k % BOX_PER);
      const pos = d < T2.down ? tipAt2(d, k).pos : [PACK_X + rel * BOXP.pitch + l.x, SLOT_Y, BOXP.z + l.z];
      const u = ss(T2.closed, T2.down, d);
      o.visible = true; o.position.set(pos[0], pos[1], pos[2]);
      o.rotation.y = 0; o.scale.setScalar((1 + (BOX_SCALE - 1) * u) * fade);
    }
  }

  /* ---------- AGV 與候選路線：全部只取決於 p ---------- */
  const bestMeta = routeVis[0].meta;
  function updateAgv(p) {
    let x, z, yaw, lift = 0, carry = false;
    const AT = AGV_T;
    if (p <= AT.drive1) {                                   // 停靠位 → 箱下（朝西，前後對稱所以外觀不變）
      const u = ss(AT.drive0, AT.drive1, p);
      x = AGV_PARK.x + (BIN_POS.x - AGV_PARK.x) * u; z = AGV_PARK.z; yaw = Math.PI;
    } else if (p <= AT.go0) {                               // 頂起、等待路線決定
      x = BIN_POS.x; z = BIN_POS.z; yaw = 0; lift = ss(AT.drive1, AT.lift1, p); carry = lift > 0;
    } else {                                                // 沿最佳路線運送 → 放下
      const q = pathAtDist(bestMeta, bestMeta.length * ss(AT.go0, AT.go1, p));
      x = q.x; z = q.z; yaw = Math.atan2(-q.tz, q.tx);
      lift = 1 - ss(AT.go1, AT.lower1, p); carry = true;
    }
    const A = anim.agv;
    A.g.position.set(x, 0, z); A.g.rotation.y = yaw; A.lift.position.y = 0.06 * lift;
    /* 箱組：頂起後與 AGV 同姿態；以箱心為軸旋轉 */
    const R = anim.rig;
    if (carry) {
      const th = p <= AT.go0 ? 0 : yaw, c = Math.cos(th), s2 = Math.sin(th);
      R.position.set(x - (BIN_POS.x * c + BIN_POS.z * s2), 0.06 * lift, z - (-BIN_POS.x * s2 + BIN_POS.z * c));
      R.rotation.y = th;
    } else { R.position.set(0, 0, 0); R.rotation.y = 0; }

    /* 候選路線：依序畫出 → 被擋的與較長的逐一淡出 → 最佳路線發亮，抵達後淡出 */
    for (let i = 0; i < anim.routes.length; i++) {
      const o = anim.routes[i];
      const f = clamp01((p - (AT.appear0 + i * AT.appearStep)) / AT.appearDur);
      let op = 1;
      const fw = AT.fade[i];
      if (fw) op = 1 - ss(fw[0], fw[1], p);
      else op = 1 - ss(AT.go1, AT.lower1, p);
      const show = f > 0 && op > 0.01;
      o.tube.visible = show; o.sprite.visible = show && f > 0.6;
      if (!show) continue;
      o.tube.geometry.setDrawRange(0, Math.floor(f * ROUTE_TUBE_SEG) * ROUTE_RADIAL * 6);
      const glow = i === 0 ? ss(AT.glow0, AT.glow1, p) : 0;
      /* 可行路線閃亮：亮光沿路線移動，整體亮度輕微起伏；最佳路線發亮時更亮 */
      const shimmer = o.r.blocked ? 0 : 0.12 * Math.sin(p * 2600 + i * 2);
      if (o.mat.map) o.mat.map.offset.x = -(p - AT.appear0) * 70;
      o.mat.opacity = Math.min(1, (0.85 + shimmer + (i === 0 ? 0.1 * ss(AT.glow0, AT.glow1, p) : 0)) * op);
      if (!o.r.blocked) o.mat.color.setRGB(0.23 + (0.18 - 0.23) * glow, 0.63 + (0.66 - 0.63) * glow, 1 + (0.35 - 1) * glow);
      o.tube.scale.set(1, 0.3, 1 + 0);
      o.sprite.material.opacity = op;
      o.sprite.material.color.setRGB(1 - 0.25 * glow, 1, 1 - 0.25 * glow);
    }
  }

  /* ---------- 動態：全部只取決於 p ---------- */
  function update(p) {
    p = clamp01(p);
    const travel = travelAt(p);
    const markPitch = CYCLE / anim.marks.length;
    anim.marks.forEach((m, i) => {
      const d = (i * markPitch + travel) % CYCLE;
      m.position.x = BELT_X0 + d;
      m.visible = d > 0.05 && d < CYCLE - 0.05;
    });
    let flash = 0;
    for (let i = 0; i < SLOTS; i++) {
      const s = anim.slots[i], { x, id } = slotAt(i, p);
      if (s.id !== id) {
        s.id = id;
        const kind = chipKind(id);
        s.kind = kind;
        s.variants.ok.visible = kind === 'ok';
        s.variants.crack.visible = kind === 'crack';
        s.variants.chip.visible = kind === 'chip';
        s.sprite.material = labelMat(kind === 'ok' ? 'ok' : 'bad', id);
      }
      /* 瑕疵品被夾爪夾起後，改由箱內晶片物件接手（同一位置、同一姿態） */
      const picked = (s.kind !== 'ok' && x - PICK_X >= T.grasp) || (s.kind === 'ok' && id >= N_PACK0 && x - PACK_X >= T2.grasp);
      s.slot.visible = !picked;
      if (picked) continue;
      /* 進出帶尾的兩端縮放淡入淡出，避免循環瞬移被看見 */
      const edge = smooth(clamp01(Math.min(x - BELT_X0, BELT_X0 + CYCLE - x) / 0.5));
      s.slot.position.set(x, CHIP_Y, 0);
      s.slot.scale.setScalar(Math.max(0.001, edge));
      /* 過了相機才有檢測結果 */
      const dx = x - CAM_X;
      const res = smooth(clamp01(dx / 0.7));
      s.sprite.visible = res > 0.01;
      s.sprite.scale.set(0.44 * res, 0.55 * res, 1);
      s.frame.visible = s.kind !== 'ok' && res > 0.01;
      s.frame.scale.setScalar(0.85 + 0.15 * res);
      flash = Math.max(flash, 1 - clamp01(Math.abs(dx) / 0.4));
    }
    M.beam.opacity = 0.08 + 0.32 * flash;
    M.ring.emissiveIntensity = 0.9 + 0.7 * flash;

    /* 手臂：找出正在取放的那顆瑕疵品（間距保證同時最多一顆），否則回待命點 */
    let tip = { pos: HOME, grip: 0 };
    for (const df of DEFECTS) {
      const d = chipX(df.n, p) - PICK_X;
      if (d > T.start && d < T.home) { tip = tipAt(d, df.k); break; }
    }
    const A = anim.arm, ik = solveArm(ARM, tip.pos);
    A.yawG.rotation.y = ik.yaw;
    A.shoulder.rotation.x = ik.th1;
    A.elbow.rotation.x = ik.th2;
    A.wrist.rotation.x = -(ik.th1 + ik.th2);   // 抵消前兩節的傾角，夾爪始終朝下
    A.gripYaw.rotation.y = -ik.yaw;            // 抵消底座迴轉，夾爪與帶向對齊
    for (const f of A.fingers) f.position.x = f.userData.sign * (0.37 - 0.06 * tip.grip);

    updateAgv(p);
    updatePack(p);
    updateActors(p);

    /* 箱內晶片：夾起後跟著夾爪走，放下後留在箱中 */
    for (let k = 0; k < BIN_CAP; k++) {
      const o = anim.bin[k], df = DEFECTS[k];
      if (!df) { o.holder.visible = false; continue; }
      const d = chipX(df.n, p) - PICK_X;
      const on = d >= T.grasp;
      o.holder.visible = on;
      if (!on) continue;
      if (o.kind !== df.kind) { o.kind = df.kind; o.v.crack.visible = df.kind === 'crack'; o.v.chip.visible = df.kind === 'chip'; }
      const bin = binSlot(k);
      const pos = tipAt(Math.min(d, T.down), k).pos;
      const u = ss(T.closed, T.down, d);
      o.holder.position.set(pos[0], pos[1], pos[2]);
      o.holder.rotation.y = bin.yaw * u;
      o.holder.scale.setScalar(1 + (BIN_SCALE - 1) * u);
    }
  }
  update(0);

  /* 鏡頭取景點：desktop／mobile 各一組；後續各幕在此加入 */
  function shots(mobile) {
    const tgtWide = [1.2, 0.9, 0];
    return {
      /* 開場俯視：整個產線（進料端到分析站、控制台）一次看完；開場時畫布只露出下半段，取景由 updateHero 補償 */
      wide: {
        pos: mobile ? [4.0, 60, 15.0] : [3.2, 23.0, 19.4],
        tgt: mobile ? [4.0, 0, 2.5] : [3.2, 0, 3.4]
      },
      pad: {
        pos: mobile ? [12.6, 8.4, 17.0] : [7.2, 5.0, 14.6],
        tgt: mobile ? [12.6, 1.4, 4.6] : [12.4, 2.6, 4.6]
      },
      console: {
        pos: mobile ? [8.0, 4.8, 17.7] : [8.4, 5.4, 18.2],
        tgt: mobile ? [8.0, 1.1, 5.8] : [8.4, 1.0, 5.9]
      },
      monitor: {
        pos: mobile ? [6.4, 2.1, 13.5] : [6.9, 1.9, 11.2],
        tgt: mobile ? [6.4, 1.62, 5.5] : [6.9, 1.6, 5.5]
      },
      monitor2: {
        pos: mobile ? [6.4, 2.0, 13.0] : [6.8, 1.85, 10.5],
        tgt: mobile ? [6.4, 1.62, 5.5] : [6.8, 1.6, 5.5]
      },
      party: {
        pos: mobile ? [6.4, 3.1, 18.8] : [6.4, 2.4, 13.8],
        tgt: mobile ? [6.4, 1.3, 6.8] : [6.4, 1.2, 6.7]
      },
      route: {
        pos: mobile ? [-6.3, 94.6, 77.0] : [8.6, 14.6, 12.6],
        tgt: mobile ? [2.8, 0, -0.15] : [10.0, 0, 0.7]
      },
      pick: {
        pos: mobile ? [PICK_X + 7.35, 4.33, 3.9] : [PICK_X - 2.9, 4.7, 7.6],
        tgt: mobile ? [PICK_X + 0.9, 0.8, -1.05] : [PICK_X + 0.7, 0.9, -0.8]
      },
      detect: {
        pos: mobile ? [CAM_X - 7.4, 2.9, 3.0] : [CAM_X + 1.9, 1.9, 3.7],   // 手機拉遠取景，完整呈現檢測相機與輸送帶
        tgt: mobile ? [CAM_X + 1.6, 0.8, -0.1] : [CAM_X + 0.0, 0.8, 0]
      }
    };
  }

  function dispose() {
    group.traverse(o => { if (o.isMesh && o.geometry) o.geometry.dispose(); });
    geos.forEach(g => g.dispose()); geos.length = 0;
    texs.forEach(t => t.dispose()); mats.forEach(m => m.dispose());
    if (feedRT) feedRT.dispose();
    Object.values(M).forEach(m => m.dispose());
  }

  /* 除錯用：目前每個槽位的狀態（預覽工具與測試使用） */
  const inspect = () => anim.slots.map(s => ({
    id: s.id, kind: s.kind, x: +s.slot.position.x.toFixed(3), slotVisible: s.slot.visible,
    variant: Object.keys(s.variants).filter(k => s.variants[k].visible).join('+'),
    labelIsOk: s.sprite.material === labelMats.ok, spriteVisible: s.sprite.visible, frameVisible: s.frame.visible
  }));

  return { group, bounds, materials: M, update, shots, inspect, renderFeed, dispose, detail: low ? 'low' : 'high' };
}
