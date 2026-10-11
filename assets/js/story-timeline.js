/* story-timeline.js — 首頁故事的捲動時間軸（純函式，無狀態）
 *
 * 維護說明
 *   · 所有輸出只取決於捲動進度 p（0..1）：同一個 p 永遠得到同一個結果，倒著捲也一致。
 *     不要在這裡加任何「累積狀態」（lerp 追蹤、計時器、亂數）。
 *   · 幕的長度只改 SEGMENTS；文案在 assets/data/story-data.js，不在這裡。
 *   · 有編號的幕（act）對應 story-data.js 的 acts[0..5]；transition 為無文字欄的滿版過場。
 */

/* 進度區間，需首尾相接並涵蓋 0..1 */
export const SEGMENTS = [
  { id: 'intro',      from: 0.00, to: 0.07 },
  { id: 'act',  act: 0, from: 0.07, to: 0.25 },   // 01 DETECT
  { id: 'transition', from: 0.25, to: 0.37 },   // SORT & PICK（滿版、無文字）
  { id: 'act',  act: 1, from: 0.37, to: 0.51 },   // 02 TRANSPORT
  { id: 'act',  act: 2, from: 0.51, to: 0.65 },   // 03 RCA
  { id: 'act',  act: 3, from: 0.65, to: 0.79 },   // 04 DECIDE
  { id: 'act',  act: 4, from: 0.79, to: 0.90 },   // 05 ACT & LEARN
  { id: 'act',  act: 5, from: 0.90, to: 1.00 }    // 06 CLOSED LOOP
];

export const ACT_COUNT = 6;
/* 文字欄進出場的緩動長度（進度單位） */
export const PANEL_RAMP = 0.02;

const clamp01 = x => Math.max(0, Math.min(1, x));
const smooth = x => x * x * (3 - 2 * x);

/* p → { index, id, act, local }；act 為 0..5，非幕時為 -1 */
export function stateAt(p) {
  p = clamp01(p);
  let i = SEGMENTS.length - 1;
  for (let k = 0; k < SEGMENTS.length; k++) {
    if (p < SEGMENTS[k].to) { i = k; break; }
  }
  const s = SEGMENTS[i];
  return {
    index: i,
    id: s.id,
    act: s.id === 'act' ? s.act : -1,
    local: clamp01((p - s.from) / (s.to - s.from))
  };
}

/* 導覽鈕跳幕時每一幕要落在幕內的哪個位置（0..1）。
   落在幕頭會碰到文字欄緩入與鏡頭仍在運鏡中的半成品畫面，所以各幕挑一個「畫面最能代表該幕」的時刻：
   01 鏡頭取景點（檢測相機入鏡）；02 候選路線與最佳路線都已浮出；03 對話框與證據面板都已出現；
   04 AI 對話框與數位孿生螢幕入鏡；06 工人與機器人同框慶祝。未列出的幕（05）落在幕頭稍後。 */
const JUMP_LOCAL = { 0: 0.5, 1: 0.37, 2: 0.7, 3: 0.69, 5: 0.66 };

/* 跳到第 act 幕時要捲到的進度 */
export function actStart(act) {
  const s = SEGMENTS.find(x => x.id === 'act' && x.act === act);
  if (!s) return 0;
  const u = JUMP_LOCAL[act];
  if (u != null) return s.from + (s.to - s.from) * u;
  return Math.min(s.to - 1e-4, s.from + 0.004);
}

/* 文字欄存在度 0..1：導覽幕之間為 1，與 intro／過場相鄰的邊緣以 PANEL_RAMP 緩入緩出 */
export function panelPresence(p) {
  p = clamp01(p);
  const st = stateAt(p);
  if (st.act < 0) return 0;
  const s = SEGMENTS[st.index];
  const prev = SEGMENTS[st.index - 1], next = SEGMENTS[st.index + 1];
  let v = 1;
  if (!prev || prev.id !== 'act') v = Math.min(v, clamp01((p - s.from) / PANEL_RAMP));
  if (!next || next.id !== 'act') v = Math.min(v, clamp01((s.to - p) / PANEL_RAMP));
  return smooth(v);
}

/* 滿版過場的邊框存在度 0..1：過場中為 1，與過場相鄰的幕在文字欄退場的緩動區間內同步淡入 */
export function bleedPresence(p) {
  p = clamp01(p);
  const st = stateAt(p);
  if (st.id === 'transition') return 1;
  if (st.act < 0) return 0;
  const s = SEGMENTS[st.index];
  const prev = SEGMENTS[st.index - 1], next = SEGMENTS[st.index + 1];
  let v = 0;
  if (prev && prev.id === 'transition') v = Math.max(v, 1 - clamp01((p - s.from) / PANEL_RAMP));
  if (next && next.id === 'transition') v = Math.max(v, 1 - clamp01((s.to - p) / PANEL_RAMP));
  return smooth(v);
}

/* 標題（intro）淡出程度 0..1：1 = 完全顯示 */
export function introPresence(p) {
  const end = SEGMENTS[0].to;
  return clamp01(1 - clamp01(p) / (end * 0.75));
}

/* 世界畫布由「標題下方的窗口」展開為整個舞台的進度 0..1 */
export function worldReveal(p) {
  return clamp01(clamp01(p) / SEGMENTS[0].to);
}

/* ---------- 鏡頭關鍵影格 ----------
   keys: [{ p, pos:[x,y,z], tgt:[x,y,z] }, ...]，p 遞增。
   cameraAt 用均勻 Catmull-Rom 樣條穿過所有關鍵影格。 */
function crom(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

export function cameraAt(keys, p) {
  p = clamp01(p);
  const n = keys.length;
  if (p <= keys[0].p) return { pos: keys[0].pos.slice(), tgt: keys[0].tgt.slice() };
  if (p >= keys[n - 1].p) return { pos: keys[n - 1].pos.slice(), tgt: keys[n - 1].tgt.slice() };
  let i = 0;
  while (i < n - 2 && p >= keys[i + 1].p) i++;
  const a = keys[Math.max(0, i - 1)], b = keys[i], c = keys[i + 1], d = keys[Math.min(n - 1, i + 2)];
  const t = (p - b.p) / (c.p - b.p);
  const pos = [0, 1, 2].map(k => crom(a.pos[k], b.pos[k], c.pos[k], d.pos[k], t));
  const tgt = [0, 1, 2].map(k => crom(a.tgt[k], b.tgt[k], c.tgt[k], d.tgt[k], t));
  return { pos, tgt };
}

/* 減少動態偏好：不內插，停在「最近一個已過的關鍵影格」 */
export function cameraHold(keys, p) {
  p = clamp01(p);
  let k = keys[0];
  for (let i = 0; i < keys.length; i++) if (keys[i].p <= p) k = keys[i];
  return { pos: k.pos.slice(), tgt: k.tgt.slice() };
}
