/* =====================================================================
 * Room Capture for 3DGS (AnySplat) — ルームモード撮影ガイド
 * ---------------------------------------------------------------------
 * 設計方針:
 *   ・「たくさん撮る」より「良い 48〜60 枚を能動的に集める」
 *   ・核: ①自動シャッター(視差バンド) ②カバレッジ・ドーム ③ブレ/パン検知
 *   ・DeviceMotion/DeviceOrientation(加速度・ジャイロ・方位)で判定
 *   ・撮影後に端末内で「セーフティネット選別」(ブレ除去+視点均等化)
 *   ・全て静的(GitHub Pages)で動作。画像は端末外に出ない。
 * ===================================================================== */
'use strict';

/* ------------------------- チューニング定数 ------------------------- */
const CFG = {
  TARGET_TOTAL: 60,      // 目標採用枚数(上限)
  MIN_TOTAL:    48,      // これ以上で「十分」
  SECTORS:      16,      // 方位カバレッジの分割数
  MIN_PER_SECTOR: 2,     // 各方位で最低欲しい枚数
  CAP_W: 1600,           // 保存フレームの最大幅(横持ち想定, 高さは比率維持)
  JPEG_Q: 0.85,
  SMALL_W: 96, SMALL_H: 54, // 動き・ブレ判定用の縮小サイズ
  MOTION_BAND: 1.15,     // 前回採用からの累積動き量がこれを超えたら撮る(視差バンド)
  MIN_INTERVAL_MS: 350,  // 連写しすぎ防止
  BLUR_REL: 0.55,        // シャープネスが直近中央値のこの倍未満なら「ブレ」で見送り
  FAST_ROT_DPS: 75,      // これ以上の角速度は「速すぎ(ブレ)」警告
  STILL_ACC: 0.25,       // 線形加速度がこれ未満が続くと「歩いて視点を変えて」
};

/* ------------------------- 画面遷移 ------------------------- */
const screens = {
  start:   document.getElementById('screen-start'),
  capture: document.getElementById('screen-capture'),
  review:  document.getElementById('screen-review'),
};
function show(name){
  for (const k in screens) screens[k].classList.toggle('active', k === name);
}

/* ------------------------- 状態 ------------------------- */
const S = {
  stream: null,
  running: false,
  captured: [],          // { blob, small:Float32Array(gray 0..1), sharp, heading, t }
  lastSmall: null,       // 直近フレームの縮小グレー
  lastKeySmall: null,    // 最後に採用したフレームの縮小グレー
  accMotion: 0,          // 前回採用からの累積動き量
  lastCapTime: 0,
  sharpHist: [],         // 直近のシャープネス履歴(相対閾値用)
  sectorCount: new Int32Array(CFG.SECTORS),
  heading: 0,            // 方位(deg, 0-360)
  headingOK: false,
  yaw: 0,                // フォールバック用のジャイロ積分ヨー
  rotDps: 0,             // 角速度の大きさ(deg/s)
  linAcc: 0,             // 線形加速度の大きさ
  lastMotionTs: 0,
  coach: '',
};

/* ------------------------- DOM ------------------------- */
const video   = document.getElementById('video');
const covCanvas = document.getElementById('coverage');
const covCtx  = covCanvas.getContext('2d');
const chipCount = document.getElementById('chip-count');
const chipCov = document.getElementById('chip-coverage');
const coachEl = document.getElementById('coach');
const flashEl = document.getElementById('shutter-flash');
const rotateHint = document.getElementById('rotate-hint');

/* 作業用オフスクリーン canvas */
const capCanvas = document.createElement('canvas');
const capCtx = capCanvas.getContext('2d', { willReadFrequently: false });
const smallCanvas = document.createElement('canvas');
smallCanvas.width = CFG.SMALL_W; smallCanvas.height = CFG.SMALL_H;
const smallCtx = smallCanvas.getContext('2d', { willReadFrequently: true });

/* ===================================================================
 *  権限 & カメラ
 * =================================================================== */
async function requestSensorPermission(){
  try {
    if (typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function') {
      await DeviceMotionEvent.requestPermission();
    }
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      await DeviceOrientationEvent.requestPermission();
    }
  } catch (e) { /* 拒否されても撮影は続行(カバレッジは映像動きで代替) */ }
}

async function startCamera(){
  const constraints = {
    audio: false,
    video: { facingMode: { ideal: 'environment' },
             width: { ideal: 1920 }, height: { ideal: 1080 } },
  };
  S.stream = await navigator.mediaDevices.getUserMedia(constraints);
  video.srcObject = S.stream;
  await video.play();
}

/* ===================================================================
 *  センサー
 * =================================================================== */
function onOrientation(ev){
  let h = null;
  if (typeof ev.webkitCompassHeading === 'number') h = ev.webkitCompassHeading;      // iOS
  else if (ev.absolute && typeof ev.alpha === 'number') h = 360 - ev.alpha;           // Android absolute
  if (h != null && !Number.isNaN(h)) { S.heading = ((h % 360) + 360) % 360; S.headingOK = true; }
}
function onMotion(ev){
  const now = performance.now();
  const dt = S.lastMotionTs ? (now - S.lastMotionTs) / 1000 : 0;
  S.lastMotionTs = now;
  const rr = ev.rotationRate || {};
  const ax = Math.abs(rr.alpha||0), ay = Math.abs(rr.beta||0), az = Math.abs(rr.gamma||0);
  S.rotDps = Math.hypot(ax, ay, az);
  // 方位が取れない端末はジャイロ(z=alpha)を積分してヨーを代用
  if (!S.headingOK && dt > 0 && dt < 0.5) {
    S.yaw = (S.yaw + (rr.alpha||0) * dt);
    S.heading = ((S.yaw % 360) + 360) % 360;
  }
  const a = ev.acceleration || {};   // 重力除去済み(端末が対応していれば)
  S.linAcc = Math.hypot(a.x||0, a.y||0, a.z||0);
}

/* ===================================================================
 *  画像処理: 縮小グレー / シャープネス / 動き量
 * =================================================================== */
function grabSmallGray(){
  smallCtx.drawImage(video, 0, 0, CFG.SMALL_W, CFG.SMALL_H);
  const d = smallCtx.getImageData(0, 0, CFG.SMALL_W, CFG.SMALL_H).data;
  const g = new Float32Array(CFG.SMALL_W * CFG.SMALL_H);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    g[j] = (0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2]) / 255;
  }
  return g;
}
// ラプラシアン分散(大きいほどシャープ)
function sharpness(g){
  const W = CFG.SMALL_W, H = CFG.SMALL_H;
  let mean = 0, n = 0;
  const lap = new Float32Array(W*H);
  for (let y = 1; y < H-1; y++) for (let x = 1; x < W-1; x++){
    const i = y*W+x;
    const v = 4*g[i] - g[i-1] - g[i+1] - g[i-W] - g[i+W];
    lap[i] = v; mean += v; n++;
  }
  mean /= n; let varr = 0;
  for (let y = 1; y < H-1; y++) for (let x = 1; x < W-1; x++){
    const d = lap[y*W+x] - mean; varr += d*d;
  }
  return varr / n;
}
// 2枚の縮小グレーの平均絶対差(動き量の近似)
function madGray(a, b){
  let s = 0; const n = a.length;
  for (let i = 0; i < n; i++) s += Math.abs(a[i] - b[i]);
  return s / n;
}

/* ===================================================================
 *  フレーム採用(自動シャッター)
 * =================================================================== */
function captureFrame(small, sharp){
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return;
  const scale = Math.min(1, CFG.CAP_W / vw);
  capCanvas.width = Math.round(vw * scale);
  capCanvas.height = Math.round(vh * scale);
  capCtx.drawImage(video, 0, 0, capCanvas.width, capCanvas.height);
  capCanvas.toBlob((blob) => {
    if (!blob) return;
    S.captured.push({ blob, small, sharp, heading: S.heading, t: Date.now() });
    const sec = sectorOf(S.heading);
    S.sectorCount[sec]++;
    updateHud();
  }, 'image/jpeg', CFG.JPEG_Q);

  // シャッター演出
  flashEl.classList.add('on');
  setTimeout(() => flashEl.classList.remove('on'), 90);
}

function sectorOf(headingDeg){
  return Math.floor((((headingDeg % 360) + 360) % 360) / (360 / CFG.SECTORS)) % CFG.SECTORS;
}

/* ===================================================================
 *  メインループ
 * =================================================================== */
function loop(){
  if (!S.running) return;
  requestAnimationFrame(loop);
  if (video.readyState < 2) return;

  // 縦持ち検出(映像が縦長)
  rotateHint.classList.toggle('hidden', video.videoWidth >= video.videoHeight);

  const g = grabSmallGray();
  const sharp = sharpness(g);

  // シャープネス履歴(直近30)で相対閾値
  S.sharpHist.push(sharp);
  if (S.sharpHist.length > 30) S.sharpHist.shift();
  const med = median(S.sharpHist);

  // 前フレームからの動きを累積
  if (S.lastSmall) S.accMotion += madGray(S.lastSmall, g);
  S.lastSmall = g;

  const now = performance.now();
  const tooFast = S.rotDps > CFG.FAST_ROT_DPS;
  const blurry = med > 0 && sharp < CFG.BLUR_REL * med;
  const enoughParallax = S.accMotion >= CFG.MOTION_BAND;
  const intervalOK = (now - S.lastCapTime) > CFG.MIN_INTERVAL_MS;

  // ---- 自動シャッター判定 ----
  if (enoughParallax && intervalOK && !tooFast && !blurry &&
      S.captured.length < CFG.TARGET_TOTAL) {
    captureFrame(g, sharp);
    S.lastKeySmall = g;
    S.accMotion = 0;
    S.lastCapTime = now;
  }

  // ---- コーチング表示 ----
  let msg = 'ゆっくり動かしてください', cls = '';
  if (tooFast) { msg = '⚠️ ゆっくり(速すぎ)'; cls = 'warn'; }
  else if (blurry) { msg = '⚠️ ブレています / 止めて'; cls = 'warn'; }
  else if (!enoughParallax && S.rotDps < 8 && S.linAcc < CFG.STILL_ACC) {
    msg = '🚶 歩いて視点を変えて'; cls = '';
  } else if (coverageDone() && S.captured.length >= CFG.MIN_TOTAL) {
    msg = '✅ 十分です。終了できます'; cls = 'good';
  } else {
    const gap = nextGapDir();
    msg = gap == null ? '📸 いい調子、続けて' : `🧭 ${gap} の方向を埋めて`;
  }
  if (msg !== S.coach) { coachEl.textContent = msg; coachEl.className = 'coach ' + cls; S.coach = msg; }

  drawCoverage();
}

function updateHud(){
  chipCount.textContent = `${S.captured.length} / ${CFG.MIN_TOTAL}`;
  chipCov.textContent = `方向 ${filledSectors()}/${CFG.SECTORS}`;
}
function filledSectors(){
  let c = 0; for (let i = 0; i < CFG.SECTORS; i++) if (S.sectorCount[i] >= CFG.MIN_PER_SECTOR) c++;
  return c;
}
function coverageDone(){ return filledSectors() === CFG.SECTORS; }

// 現在の向きから見て、最も近い未充足セクターの方角ラベル
function nextGapDir(){
  let best = -1, bestDist = 1e9;
  for (let i = 0; i < CFG.SECTORS; i++){
    if (S.sectorCount[i] >= CFG.MIN_PER_SECTOR) continue;
    const center = (i + 0.5) * (360 / CFG.SECTORS);
    let d = Math.abs(((center - S.heading + 540) % 360) - 180); // 角度差
    if (d < bestDist) { bestDist = d; best = i; }
  }
  if (best < 0) return null;
  const center = (best + 0.5) * (360 / CFG.SECTORS);
  let rel = ((center - S.heading + 540) % 360) - 180;
  if (Math.abs(rel) < 22) return 'そのまま前';
  return rel > 0 ? '右' : '左';
}

/* ------------------------- カバレッジ・ドーム描画 ------------------------- */
function drawCoverage(){
  const w = covCanvas.width, h = covCanvas.height;
  const cx = w/2, cy = h/2, rOut = w*0.46, rIn = w*0.30;
  covCtx.clearRect(0,0,w,h);
  const seg = (Math.PI*2)/CFG.SECTORS;
  for (let i = 0; i < CFG.SECTORS; i++){
    // 画面上は「上=現在の向き」になるよう heading を基準に回す
    const a0 = -Math.PI/2 + (i*360/CFG.SECTORS - S.heading) * Math.PI/180 - seg/2;
    const a1 = a0 + seg*0.86;
    const cnt = S.sectorCount[i];
    const ratio = Math.min(1, cnt / CFG.MIN_PER_SECTOR);
    covCtx.beginPath();
    covCtx.arc(cx, cy, rOut, a0, a1);
    covCtx.arc(cx, cy, rIn, a1, a0, true);
    covCtx.closePath();
    if (ratio >= 1) covCtx.fillStyle = 'rgba(55,214,122,.95)';
    else if (ratio > 0) covCtx.fillStyle = 'rgba(76,194,255,.85)';
    else covCtx.fillStyle = 'rgba(255,255,255,.14)';
    covCtx.fill();
  }
  // 中央: 現在向きマーカー(上向き三角)
  covCtx.fillStyle = 'rgba(255,255,255,.9)';
  covCtx.beginPath();
  covCtx.moveTo(cx, cy - rIn + 4);
  covCtx.lineTo(cx - 7, cy - rIn + 18);
  covCtx.lineTo(cx + 7, cy - rIn + 18);
  covCtx.closePath(); covCtx.fill();
  covCtx.fillStyle = 'rgba(255,255,255,.85)';
  covCtx.font = 'bold 13px system-ui'; covCtx.textAlign = 'center'; covCtx.textBaseline = 'middle';
  covCtx.fillText(`${filledSectors()}/${CFG.SECTORS}`, cx, cy);
}

/* ===================================================================
 *  セーフティネット選別(端末内): ブレ除去 + 視点均等化
 * =================================================================== */
function curate(frames){
  if (frames.length === 0) return [];
  // 1) ブレ除去(中央値の 0.5 倍未満を捨てる)
  const sorted = frames.map(f => f.sharp).slice().sort((a,b)=>a-b);
  const med = sorted[sorted.length >> 1] || 0;
  let kept = frames.filter(f => f.sharp >= 0.5 * med);
  if (kept.length === 0) kept = frames.slice();

  // 2) 視点(動き量)均等化で TARGET 以下に間引く
  if (kept.length > CFG.TARGET_TOTAL) {
    const cum = [0];
    for (let i = 1; i < kept.length; i++)
      cum.push(cum[i-1] + madGray(kept[i-1].small, kept[i].small));
    const total = cum[cum.length-1] || 1;
    const pick = new Set();
    for (let k = 0; k < CFG.TARGET_TOTAL; k++){
      const target = total * k / (CFG.TARGET_TOTAL - 1);
      pick.add(lowerBound(cum, target));
    }
    kept = [...pick].sort((a,b)=>a-b).map(i => kept[i]);
  }
  return kept;
}

/* ===================================================================
 *  終了 → レビュー → zip
 * =================================================================== */
async function finishCapture(){
  S.running = false;
  stopStream();
  show('review');
  const summary = document.getElementById('review-summary');
  const thumbs = document.getElementById('thumbs');
  const btnDl = document.getElementById('btn-download');
  thumbs.innerHTML = ''; btnDl.disabled = true;

  summary.textContent = `撮影 ${S.captured.length} 枚 → 端末内で選別中…`;
  await new Promise(r => setTimeout(r, 30)); // UI更新を挟む

  const kept = curate(S.captured);
  summary.textContent = `撮影 ${S.captured.length} 枚 → 選別後 ${kept.length} 枚(ブレ除去＋視点均等化済み)`;

  // サムネイル
  for (const f of kept.slice(0, 60)){
    const img = document.createElement('img');
    img.src = URL.createObjectURL(f.blob);
    thumbs.appendChild(img);
  }

  // zip 準備
  const files = [];
  const meta = { app: 'room-capture-3dgs', created: new Date().toISOString(),
                 count: kept.length, sectors: CFG.SECTORS, frames: [] };
  for (let i = 0; i < kept.length; i++){
    const name = `frame_${String(i+1).padStart(4,'0')}.jpg`;
    const buf = new Uint8Array(await kept[i].blob.arrayBuffer());
    files.push({ name, data: buf });
    meta.frames.push({ file: name, heading: Math.round(kept[i].heading),
                       sharpness: +kept[i].sharp.toFixed(4), t: kept[i].t });
  }
  files.push({ name: 'capture_meta.json',
               data: new TextEncoder().encode(JSON.stringify(meta, null, 2)) });

  const zipBlob = buildZip(files);
  const url = URL.createObjectURL(zipBlob);
  btnDl.disabled = false;
  btnDl.onclick = () => {
    const a = document.createElement('a');
    a.href = url;
    a.download = `room_capture_${kept.length}.zip`;
    document.body.appendChild(a); a.click(); a.remove();
  };
}

/* ===================================================================
 *  最小 ZIP ビルダー(無圧縮 store。JPEGは既圧縮なので十分)
 * =================================================================== */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++){ let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0; }
  return t;
})();
function crc32(u8){
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function buildZip(files){
  const enc = new TextEncoder();
  const chunks = [];      // 出力チャンク
  const central = [];     // セントラルディレクトリ用
  let offset = 0;
  const push = (u8) => { chunks.push(u8); offset += u8.length; };
  const u16 = (v) => new Uint8Array([v & 255, (v>>>8) & 255]);
  const u32 = (v) => new Uint8Array([v & 255, (v>>>8)&255, (v>>>16)&255, (v>>>24)&255]);

  for (const f of files){
    const nameBytes = enc.encode(f.name);
    const crc = crc32(f.data);
    const size = f.data.length;
    const localOffset = offset;
    // local file header
    push(u32(0x04034b50));
    push(u16(20)); push(u16(0)); push(u16(0)); // version, flags, method(0=store)
    push(u16(0)); push(u16(0));                // time, date
    push(u32(crc)); push(u32(size)); push(u32(size));
    push(u16(nameBytes.length)); push(u16(0));
    push(nameBytes);
    push(f.data);
    // central directory record (後で結合)
    const cd = [];
    const cpush = (u8) => cd.push(u8);
    cpush(u32(0x02014b50));
    cpush(u16(20)); cpush(u16(20)); cpush(u16(0)); cpush(u16(0));
    cpush(u16(0)); cpush(u16(0));
    cpush(u32(crc)); cpush(u32(size)); cpush(u32(size));
    cpush(u16(nameBytes.length)); cpush(u16(0)); cpush(u16(0));
    cpush(u16(0)); cpush(u16(0)); cpush(u32(0));
    cpush(u32(localOffset));
    cpush(nameBytes);
    central.push(concat(cd));
  }
  const cdStart = offset;
  for (const c of central) push(c);
  const cdSize = offset - cdStart;
  // end of central directory
  push(u32(0x06054b50));
  push(u16(0)); push(u16(0));
  push(u16(files.length)); push(u16(files.length));
  push(u32(cdSize)); push(u32(cdStart)); push(u16(0));

  return new Blob(chunks, { type: 'application/zip' });
}
function concat(arrs){
  let len = 0; for (const a of arrs) len += a.length;
  const out = new Uint8Array(len); let o = 0;
  for (const a of arrs){ out.set(a, o); o += a.length; }
  return out;
}

/* ------------------------- ユーティリティ ------------------------- */
function median(arr){
  if (!arr.length) return 0;
  const s = arr.slice().sort((a,b)=>a-b);
  return s[s.length >> 1];
}
function lowerBound(sortedArr, target){
  let lo = 0, hi = sortedArr.length - 1;
  while (lo < hi){ const mid = (lo+hi) >> 1; if (sortedArr[mid] < target) lo = mid+1; else hi = mid; }
  return lo;
}
function stopStream(){
  if (S.stream){ S.stream.getTracks().forEach(t => t.stop()); S.stream = null; }
}

/* ------------------------- 起動フロー ------------------------- */
async function beginSession(){
  const errEl = document.getElementById('start-error');
  errEl.textContent = '';
  try {
    await requestSensorPermission();
    await startCamera();
  } catch (e) {
    errEl.textContent = 'カメラ/センサーを起動できませんでした: ' + (e && e.message || e) +
      '\nHTTPS で開き、カメラの許可を確認してください。';
    return;
  }
  window.addEventListener('deviceorientation', onOrientation, true);
  if (window.DeviceOrientationEvent) window.addEventListener('deviceorientationabsolute', onOrientation, true);
  window.addEventListener('devicemotion', onMotion, true);

  // 横向きロックを試行(対応端末のみ)
  try { if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape'); } catch(e){}

  // 状態リセット
  S.captured = []; S.lastSmall = null; S.lastKeySmall = null; S.accMotion = 0;
  S.lastCapTime = 0; S.sharpHist = []; S.sectorCount = new Int32Array(CFG.SECTORS);
  S.yaw = 0; S.coach = '';
  updateHud();

  show('capture');
  S.running = true;
  requestAnimationFrame(loop);
}

document.getElementById('btn-start').addEventListener('click', beginSession);
document.getElementById('btn-finish').addEventListener('click', finishCapture);
document.getElementById('btn-restart').addEventListener('click', () => location.reload());

// 開始画面を表示
show('start');
