/* ============ 直播话术整理台 · 实时版 ============
   上：实时转写（浏览器识别 / 服务器识别）
   下左：商品列表（多选导出）  下右：商品详情（口语版 / 书面语版）
   后端接口：/api/process（LLM 切分整理）、/api/asr（服务器识别）、/api/test */
"use strict";

// 版本号（格式 v主.次.YYMMDD-当日序号），界面顶栏由它自动填充
const APP_VERSION = "v1.0.260816-2";

/* ---------- 小工具 ---------- */

const $ = (id) => document.getElementById(id);

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

function ts() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return "" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes());
}

let uidSeq = 0;
const uid = () => Date.now().toString(36) + "-" + (++uidSeq).toString(36);

function toast(msg, type = "") {
  const el = document.createElement("div");
  el.className = "toast " + type;
  el.textContent = msg;
  $("toasts").appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "opacity .4s";
    setTimeout(() => el.remove(), 450);
  }, 3600);
}

async function copyText(text, tip) {
  if (!text || !text.trim()) { toast("没有可复制的内容", "err"); return; }
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  toast(tip || "已复制到剪贴板", "ok");
}

// 出错要让人看见，不然就是「点了没反应」
window.addEventListener("error", (e) => {
  toast("脚本出错：" + (e.message || "未知错误"), "err");
  console.error(e.error || e.message);
});
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  toast("请求异常：" + ((r && r.message) || r || "未知"), "err");
});

function downloadFile(name, content, mime) {
  const blob = new Blob([content], { type: mime + ";charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

const normKey = (s) => String(s).toLowerCase().replace(/[\s·、，,。.；;：:！!？?（）()【】\[\]「」-]/g, "");

/* ---------- 配置：全部来自服务器（env.local / 环境变量），浏览器里没有设置项 ---------- */

let serverCfg = null; // 启动时通过 /api/config 获取：Key、模型、自动整理参数

function autoDelaySec() {
  return Math.max(2, (serverCfg && serverCfg.autoDelay) || 8);
}
function autoIntervalSec() {
  return serverCfg && serverCfg.autoInterval != null ? serverCfg.autoInterval : 30;
}

function refreshKeyStatus() {
  const dot = $("keyStatus");
  const has = !!(serverCfg && serverCfg.hasKey);
  dot.className = "key-dot " + (has ? "on" : "off");
  dot.title = has
    ? "服务器已配置：" + serverCfg.provider + " · " + serverCfg.llmModel + "（Key " + serverCfg.keyMasked + "，" + serverCfg.source + "）。要修改：编辑项目目录 env.local 后重启服务"
    : "服务器未配置 API Key：在项目目录 env.local 里填 zhipu_apikey 或 siliconflow_apikey，保存后重启服务";
}

/* ---------- 后端 API ---------- */

async function apiPost(path, body) {
  let res;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error("连不上后端服务：" + (e.message || e));
  }
  let j = null;
  try { j = await res.json(); } catch (_) { /* 非 JSON 响应 */ }
  if (!res.ok || !j || j.ok === false) {
    throw new Error((j && j.error) || "请求失败（HTTP " + res.status + "）");
  }
  return j;
}

/* ---------- 状态 ---------- */

let products = [];            // {id,key,name,price,highlights[],spoken,written,edited*,fresh}
let selectedId = null;        // 当前查看的商品
let detailTab = "spoken";
let dirty = false;            // 文稿有新内容没整理
let orgRunning = false, orgPending = false, lastAutoErrAt = 0;
let engineChoice = "";        // 访客自己选过的识别引擎（存本机，仅记住偏好）

function persist() {
  clearTimeout(persist._t);
  persist._t = setTimeout(() => {
    try {
      localStorage.setItem("ltc2-state", JSON.stringify({
        v: 2,
        transcript: $("transcript").value,
        products,
        selectedId,
        detailTab,
      }));
    } catch (_) { /* 存储满了就算了 */ }
  }, 500);
}

function restore() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem("ltc2-state") || "null"); } catch (_) {}
  if (!s || s.v !== 2) return;
  $("transcript").value = s.transcript || "";
  products = Array.isArray(s.products) ? s.products : [];
  selectedId = products.some((p) => p.id === s.selectedId) ? s.selectedId : null;
  detailTab = s.detailTab === "written" ? "written" : "spoken";
  dirty = !!(s.transcript || "").trim();
}

/* ---------- 实时录音：浏览器识别（Web Speech API） ---------- */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let mic = { active: false, engine: "", startAt: 0, timer: null, rec: null };

function micSetStatus(t) { $("micStatus").textContent = t || ""; }

function appendTranscriptLine(text, elapsedSec) {
  const ta = $("transcript");
  const stamp = "[" + fmtTime(elapsedSec != null ? elapsedSec : (Date.now() - mic.startAt) / 1000) + "] ";
  ta.value = (ta.value ? ta.value.replace(/\s+$/, "") + "\n" : "") + stamp + String(text).replace(/\s+/g, " ").trim();
  transcriptChanged();
}

function startMic() {
  if (mic.active) return;
  const engine = $("engineSel").value === "server" ? "server" : "sr";
  mic.active = true;
  mic.engine = engine;
  mic.startAt = Date.now();
  micSetStatus("正在启动…");
  $("micStart").classList.add("hidden");
  $("micStop").classList.remove("hidden");
  $("recBadge").classList.remove("hidden");
  $("engineSel").disabled = true;
  $("micTimer").textContent = "00:00";
  mic.timer = setInterval(() => { $("micTimer").textContent = fmtTime((Date.now() - mic.startAt) / 1000); }, 1000);
  if (engine === "sr") startSr();
  else startServerCapture();
}

function stopMic() {
  if (!mic.active) return;
  mic.active = false;
  clearInterval(mic.timer);
  if (mic.rec) { try { mic.rec.stop(); } catch (_) {} mic.rec = null; }
  if (cap.proc) { try { cap.proc.disconnect(); } catch (_) {} cap.proc = null; }
  if (cap.srcNode) { try { cap.srcNode.disconnect(); } catch (_) {} cap.srcNode = null; }
  if (cap.ac) { try { cap.ac.close(); } catch (_) {} cap.ac = null; }
  if (cap.stream) { cap.stream.getTracks().forEach((t) => t.stop()); cap.stream = null; }
  $("micStart").classList.remove("hidden");
  $("micStop").classList.add("hidden");
  $("recBadge").classList.add("hidden");
  $("engineSel").disabled = false;
  $("micInterim").textContent = "";
  micSetStatus("已停止，内容已并入文稿");
  if (cap.buffered > 1600) flushWav();          // 服务器模式：不足一段的尾巴也送出去
  scheduleAuto(0);                               // 停止后立即整理一次
}

/* --- 引擎一：浏览器自带识别 --- */

function startSr() {
  if (!SR) { toast("当前浏览器不支持语音识别，请换 Chrome / Edge，或改用「服务器识别」", "err"); stopMic(); return; }
  micSetStatus("收音中…（浏览器识别，若首次使用需允许麦克风权限）");
  const rec = new SR();
  mic.rec = rec;
  rec.lang = "zh-CN";
  rec.continuous = true;
  rec.interimResults = true;
  rec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) {
        const t = r[0].transcript.trim();
        if (t) appendTranscriptLine(t);
      } else {
        interim += r[0].transcript;
      }
    }
    $("micInterim").textContent = interim ? "… " + interim : "";
  };
  rec.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      toast("麦克风权限被拒绝，请在浏览器地址栏允许麦克风", "err");
      stopMic();
    }
  };
  rec.onend = () => {
    // Chrome 会周期性自动停，录音还在就自动续上
    if (mic.active && mic.engine === "sr") { try { rec.start(); } catch (_) {} }
  };
  try { rec.start(); } catch (_) {}
}

/* --- 引擎二：录 PCM → 每 15 秒编 WAV → /api/asr --- */

const SRV_CHUNK_SEC = 15;
let cap = { ac: null, stream: null, proc: null, srcNode: null, chunks: [], buffered: 0, chunkStart: 0, queue: Promise.resolve() };

function encodeWav(f32, sampleRate) {
  const n = f32.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVE");
  w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const x = Math.max(-1, Math.min(1, f32[i]));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return buf;
}

function resampleTo16k(f32, rate) {
  if (rate === 16000 || !rate) return f32;
  const ratio = rate / 16000;
  const outLen = Math.floor(f32.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio, i0 = Math.floor(pos), fr = pos - i0;
    out[i] = f32[i0] * (1 - fr) + (f32[i0 + 1] || 0) * fr;
  }
  return out;
}

function bufToBase64(buf) {
  const u8 = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

async function startServerCapture() {
  micSetStatus("正在请求麦克风…");
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast("这个浏览器环境拿不到麦克风（常见于软件内嵌的预览页）。请用 Chrome / Edge 打开 http://localhost:8642 再试", "err");
    stopMic();
    return;
  }
  if (!(serverCfg && serverCfg.hasKey) &&
      !confirm("服务器还没配置 API Key（env.local），服务器识别会失败。继续吗？")) {
    stopMic();
    return;
  }
  try {
    cap = { ...cap, chunks: [], buffered: 0, chunkStart: (Date.now() - mic.startAt) / 1000 };
    cap.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    let ac;
    try { ac = new AudioContext({ sampleRate: 16000 }); } catch (_) { ac = new AudioContext(); }
    cap.ac = ac;
    cap.srcNode = ac.createMediaStreamSource(cap.stream);
    cap.proc = ac.createScriptProcessor(4096, 1, 1);
    cap.proc.onaudioprocess = (e) => {
      if (!mic.active) return;
      const d = e.inputBuffer.getChannelData(0);
      cap.chunks.push(new Float32Array(d));
      cap.buffered += d.length;
      if (cap.buffered >= SRV_CHUNK_SEC * ac.sampleRate) flushWav();
    };
    cap.srcNode.connect(cap.proc);
    cap.proc.connect(ac.destination);
    micSetStatus("收音中…（服务器识别，每 " + SRV_CHUNK_SEC + " 秒回传一段）");
  } catch (e) {
    toast(e && e.name === "NotAllowedError" ? "麦克风权限被拒绝" : "录音启动失败：" + (e.message || e), "err");
    stopMic();
  }
}

function flushWav() {
  if (!cap.chunks.length) return;
  const rate = cap.ac ? cap.ac.sampleRate : 16000;
  const all = new Float32Array(cap.buffered);
  let off = 0;
  for (const c of cap.chunks) { all.set(c, off); off += c.length; }
  const stampSec = cap.chunkStart;
  cap.chunks = [];
  cap.buffered = 0;
  cap.chunkStart = (Date.now() - mic.startAt) / 1000;
  const pcm = resampleTo16k(all, rate);
  if (pcm.length < 1600) return; // 不足 0.1 秒不送
  const b64 = bufToBase64(encodeWav(pcm, 16000));
  micSetStatus("识别中…（" + fmtTime(stampSec) + " 处）");
  // 顺序执行，避免多段并发
  cap.queue = cap.queue.then(async () => {
    try {
      const j = await apiPost("/api/asr", { audio: b64, filename: "chunk.wav" });
      if (j.text) appendTranscriptLine(j.text, stampSec);
    } catch (e) {
      toast("语音识别失败：" + e.message, "err");
    } finally {
      if (mic.active) micSetStatus("收音中…（服务器识别）");
    }
  });
}

/* ---------- AI 实时整理 ---------- */

function transcriptChanged() {
  updateCharCount();
  dirty = true;
  persist();
  scheduleAuto();
}

function scheduleAuto(delayOverride) {
  clearTimeout(scheduleAuto._t);
  const delay = delayOverride != null ? delayOverride : autoDelaySec() * 1000;
  scheduleAuto._t = setTimeout(() => organize("auto"), delay);
}

// 录音中定期整理（自动整理始终开启，间隔在 env.local 的 auto_interval 调）
setInterval(() => {
  if (mic.active && dirty && autoIntervalSec() > 0 && !orgRunning) {
    organize("auto");
  }
}, 5000);

async function organize(source) {
  if (orgRunning) { orgPending = true; return; }
  const text = $("transcript").value.trim();
  if (!text) return;
  orgRunning = true;
  const snapLen = text.length;
  $("btnOrganize").disabled = true;
  $("orgStatus").innerHTML = '<span class="spin"></span>AI 整理中…';
  try {
    const j = await apiPost("/api/process", { transcript: text });
    const incoming = Array.isArray(j.products) ? j.products : [];
    if (!incoming.length) {
      if (source === "manual") toast("没有识别出商品：文稿里要有具体的商品讲解内容", "err");
    } else {
      const added = mergeProducts(incoming);
      renderProducts();
      if (selectedId) renderDetail();
      else if (products.length) selectProduct(products[0].id);
      const verb = source === "auto" ? "自动整理" : "整理";
      toast(verb + "完成：" + incoming.length + " 个商品" + (added ? "，新增 " + added : ""), "ok");
      dirty = $("transcript").value.trim().length !== snapLen; // 整理期间又有新内容
      if (dirty) scheduleAuto();
      $("orgStatus").textContent = "✓ " + incoming.length + " 个商品";
      setTimeout(() => { if (!orgRunning) $("orgStatus").textContent = ""; }, 2500);
    }
  } catch (e) {
    if (source === "manual" || Date.now() - lastAutoErrAt > 30000) {
      toast("整理失败：" + e.message, "err");
      lastAutoErrAt = Date.now();
    }
    $("orgStatus").textContent = "";
  } finally {
    orgRunning = false;
    $("btnOrganize").disabled = false;
    if (orgPending) { orgPending = false; organize("auto"); }
  }
}

// 服务端返回的是全量商品列表；与本地合并时保留用户手改过的内容
function mergeProducts(incoming) {
  let added = 0;
  const used = new Set();
  for (const sp of incoming) {
    const k = normKey(sp.productName);
    if (!k) continue;
    let found = null;
    // 先精确匹配，再子串模糊匹配
    for (const p of products) {
      if (used.has(p.id)) continue;
      if (normKey(p.name) === k) { found = p; break; }
    }
    if (!found) {
      for (const p of products) {
        if (used.has(p.id)) continue;
        const pk = normKey(p.name);
        if (pk.length >= 2 && k.length >= 2 && (pk.includes(k) || k.includes(pk))) { found = p; break; }
      }
    }
    if (found) {
      used.add(found.id);
      if (!found.editedMeta) {
        if (!found.price && sp.price) found.price = sp.price;
        for (const h of sp.highlights || []) {
          if (found.highlights.length >= 6) break;
          if (!found.highlights.some((x) => normKey(x) === normKey(h))) found.highlights.push(h);
        }
      }
      if (!found.editedSpoken && sp.spokenText) found.spoken = sp.spokenText;
      if (!found.editedWritten && sp.writtenText) found.written = sp.writtenText;
      found.fresh = true;
    } else {
      const id = uid();
      products.push({
        id, key: k,
        name: sp.productName || "未命名商品",
        price: sp.price || "",
        highlights: (sp.highlights || []).slice(0, 6),
        spoken: sp.spokenText || "",
        written: sp.writtenText || "",
        editedSpoken: false, editedWritten: false, editedMeta: false,
        fresh: true,
      });
      added++;
    }
  }
  persist();
  return added;
}

/* ---------- 商品列表 ---------- */

function updateCharCount() {
  $("charCount").textContent = $("transcript").value.length + " 字";
}

function renderProducts() {
  const box = $("products");
  const scrollTop = box.scrollTop;
  box.innerHTML = "";
  $("productsEmpty").classList.toggle("show", !products.length);
  products.forEach((p, i) => box.appendChild(buildRow(p, i)));
  box.scrollTop = scrollTop;
  $("exportAll").disabled = !products.length;
  $("copyAll").disabled = !products.length;
}

function buildRow(p, i) {
  const row = document.createElement("div");
  row.className = "prod-item" + (p.id === selectedId ? " active" : "");
  row.setAttribute("role", "listitem");

  const idx = document.createElement("span");
  idx.className = "p-idx";
  idx.textContent = String(i + 1).padStart(2, "0");

  const nm = document.createElement("span");
  nm.className = "p-nm";
  nm.textContent = p.name || "未命名商品";
  nm.title = nm.textContent;

  if (p.fresh) {
    const b = document.createElement("span");
    b.className = "badge-new";
    b.textContent = "新";
    row.append(idx, nm, b);
  } else {
    row.append(idx, nm);
  }

  if (p.price) {
    const pr = document.createElement("span");
    pr.className = "p-price";
    pr.textContent = p.price;
    row.appendChild(pr);
  }

  const del = document.createElement("button");
  del.className = "p-del";
  del.type = "button";
  del.title = "删除这个商品";
  del.textContent = "✕";
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!confirm("删除「" + (p.name || "未命名商品") + "」？")) return;
    products = products.filter((x) => x.id !== p.id);
    if (selectedId === p.id) { selectedId = null; renderDetail(); }
    renderProducts();
    persist();
  });
  row.appendChild(del);

  row.addEventListener("click", () => selectProduct(p.id));
  return row;
}

function selectProduct(id) {
  selectedId = id;
  const p = products.find((x) => x.id === id);
  if (p) p.fresh = false; // 看过了就摘掉「新」标
  document.querySelectorAll(".prod-item").forEach((el, i) => {
    el.classList.toggle("active", products[i] && products[i].id === id);
  });
  renderDetail();
  persist();
}

/* ---------- 商品详情 ---------- */

function renderDetail() {
  const p = products.find((x) => x.id === selectedId);
  $("detail").classList.toggle("hidden", !p);
  $("detailEmpty").style.display = p ? "none" : "flex";
  if (!p) return;

  const i = products.indexOf(p);
  $("dIdx").textContent = String(i + 1).padStart(2, "0");
  $("dName").value = p.name || "";
  $("dPrice").value = p.price || "";
  $("dNew").classList.toggle("hidden", !p.fresh);
  $("dSpoken").value = p.spoken || "";
  $("dWritten").value = p.written || "";
  switchTab(detailTab, true);

  const hl = $("dHl");
  hl.innerHTML = "";
  p.highlights.forEach((h, hi) => {
    const chip = document.createElement("span");
    chip.className = "hl-chip";
    chip.contentEditable = "true";
    chip.spellcheck = false;
    chip.textContent = h;
    chip.title = "回车确认；清空即删除";
    chip.addEventListener("blur", () => {
      const v = chip.textContent.trim();
      if (v) p.highlights[hi] = v;
      else { p.highlights.splice(hi, 1); renderDetail(); }
      p.editedMeta = true;
      persist();
    });
    hl.appendChild(chip);
  });
  const addHl = document.createElement("button");
  addHl.className = "hl-add";
  addHl.type = "button";
  addHl.textContent = "＋ 卖点";
  addHl.addEventListener("click", () => {
    p.highlights.push("新卖点");
    p.editedMeta = true;
    renderDetail();
    const chips = $("dHl").querySelectorAll(".hl-chip");
    const last = chips[chips.length - 1];
    if (last) { last.focus(); document.getSelection().selectAllChildren(last); }
  });
  hl.appendChild(addHl);
}

function switchTab(v, silent) {
  detailTab = v;
  document.querySelectorAll(".d-tab").forEach((b) => b.classList.toggle("active", b.dataset.v === v));
  $("dSpoken").classList.toggle("hidden", v !== "spoken");
  $("dWritten").classList.toggle("hidden", v !== "written");
  if (!silent) persist();
}

/* ---------- 导出 ---------- */

function productMarkdown(p, idx) {
  const hl = (p.highlights || []).filter(Boolean);
  let s = "## " + (idx + 1) + ". " + (p.name || "未命名商品") + "\n";
  if (p.price) s += "- 价格：" + p.price + "\n";
  if (hl.length) s += "- 卖点：" + hl.join("；") + "\n";
  s += "\n### 口语版（原话整理）\n\n" + (p.spoken || "（无）") + "\n";
  s += "\n### 书面语版（详情页文案）\n\n" + (p.written || "（无）") + "\n";
  return s;
}

function listMarkdown(list) {
  let s = "# 直播商品介绍材料\n\n> 整理时间：" + new Date().toLocaleString("zh-CN") +
    " ｜ 共 " + list.length + " 个商品\n\n";
  s += list.map(productMarkdown).join("\n---\n\n");
  return s;
}

/* ---------- 演示文稿 ---------- */

const DEMO = `[00:12] 哈喽哈喽宝宝们晚上好呀，欢迎来到咱们直播间，今天给大家带来了三个压箱底的好东西，先别急着划走，马上上福利。
[00:31] 先说今天第一个宝贝，就是这个大容量的空气炸锅，5.5 升的哦，一家人吃妥妥够用。它是触屏的，上面有八个菜单，薯条、鸡翅、烤红薯一键就搞定，真不用你盯着火候。
[01:02] 你像平时上班累了一天回家，把鸡翅往里面一丢，撒点料，200 度 18 分钟，出来那个皮是焦的、里面是嫩的，绝了。
[01:25] 而且它是那种不沾内胆，洗的时候拿抹布一擦就干净，懒人福音真的是。今天直播间价格也给到很低，原价三百多的，今天 199 直接拿走，还送一套烤纸和食谱，库存不多了啊宝宝们。
[02:10] 好，接下来第二个，家里有小朋友的一定要看，这个儿童保温杯，316 的内胆，6 个小时保温没问题，中午装的水下午喝还是温的。
[02:35] 它的吸管是食品级的，咬嘴可以换，杯子有 200 和 300 毫升两个规格。关键它不漏水！放书包里倒过来晃都不漏，妈妈们懂这个含金量吧。
[02:58] 平时一直卖 69 的，今天直播间 49.9，拍下再送一个备用咬嘴，颜色有粉色、蓝色、绿色，男宝女宝都有合适的。
[03:40] 最后一个，爱吃夜宵的宝宝看过来，这个柳州螺蛳粉三袋装。它是正宗的酸笋，汤底是熬出来的，不是香精冲泡的那个味儿。
[04:02] 里面料很足，腐竹、花生、酸豆角都有，米粉是干粉，煮八分钟就软了，QQ 弹弹的。能吃辣的加它自带的辣椒油，不能吃辣的少放，汤都很鲜。
[04:30] 一袋算下来才 10 块钱，三袋 29.9 包邮，囤货合适，今天拍三组还送一双筷子哈哈。
[04:55] 好了宝宝们，今天三个宝贝都过完了：空气炸锅 199、保温杯 49.9、螺蛳粉 29.9 三袋。看中哪个直接拍，我们秒发货，售后放心，不合适无理由退。`;

/* ---------- 初始化 ---------- */

function init() {
  $("brandVer").textContent = APP_VERSION;
  try { engineChoice = localStorage.getItem("ltc2-engine") || ""; } catch (_) {}
  restore();
  updateCharCount();

  // 获取服务器端配置（env.local / 环境变量）：Key、模型、自动整理参数都在那里
  (async () => {
    try {
      const r = await fetch("/api/config");
      const j = await r.json();
      if (j && j.ok) serverCfg = j;
    } catch (_) { /* 探测失败：按默认参数跑，识别/整理请求会给出错误提示 */ }
    refreshKeyStatus();
    // 访客没自己选过引擎时：服务器配了免费的硅基流动转写 → 默认服务器识别
    if (!engineChoice && serverCfg && serverCfg.hasKey && serverCfg.asrModel &&
        /siliconflow/.test(serverCfg.asrBaseUrl || serverCfg.baseUrl)) {
      $("engineSel").value = "server";
    }
  })();

  // 识别引擎：不支持 Web Speech API 的浏览器强制服务器模式
  const eng = $("engineSel");
  if (!SR) {
    eng.value = "server";
    eng.querySelector('option[value="sr"]').disabled = true;
    eng.querySelector('option[value="sr"]').textContent = "浏览器识别（当前浏览器不支持）";
  } else if (engineChoice === "server" || engineChoice === "sr") {
    eng.value = engineChoice;
  } else {
    eng.value = "sr";
  }

  // 录音
  $("micStart").addEventListener("click", startMic);
  $("micStop").addEventListener("click", stopMic);
  eng.addEventListener("change", () => {
    engineChoice = eng.value;
    try { localStorage.setItem("ltc2-engine", engineChoice); } catch (_) {}
  });

  // 文稿
  $("transcript").addEventListener("input", transcriptChanged);
  $("btnClear").addEventListener("click", () => {
    if ($("transcript").value && confirm("清空转写文稿？（商品列表会保留）")) {
      $("transcript").value = "";
      transcriptChanged();
    }
  });
  $("loadDemo").addEventListener("click", () => {
    $("transcript").value = DEMO;
    transcriptChanged();
    toast("演示文稿已填入，稍等几秒会自动整理（或点「立即整理」）", "ok");
  });

  // 整理与导出
  $("btnOrganize").addEventListener("click", () => organize("manual"));
  $("exportAll").addEventListener("click", () => {
    if (!products.length) return;
    downloadFile("直播商品材料-" + ts() + ".md", listMarkdown(products), "text/markdown");
  });
  $("copyAll").addEventListener("click", () => copyText(listMarkdown(products), "已复制全部材料"));

  // 详情编辑
  $("dName").addEventListener("input", () => {
    const p = products.find((x) => x.id === selectedId);
    if (!p) return;
    p.name = $("dName").value.trim();
    p.editedMeta = true;
    const row = document.querySelector(".prod-item.active .p-nm");
    if (row) row.textContent = p.name || "未命名商品";
    persist();
  });
  $("dPrice").addEventListener("input", () => {
    const p = products.find((x) => x.id === selectedId);
    if (!p) return;
    p.price = $("dPrice").value.trim();
    p.editedMeta = true;
    persist();
  });
  ["dSpoken", "dWritten"].forEach((id) => {
    $(id).addEventListener("input", () => {
      const p = products.find((x) => x.id === selectedId);
      if (!p) return;
      if (id === "dSpoken") { p.spoken = $(id).value; p.editedSpoken = true; }
      else { p.written = $(id).value; p.editedWritten = true; }
      persist();
    });
  });
  document.querySelectorAll(".d-tab").forEach((b) =>
    b.addEventListener("click", () => switchTab(b.dataset.v)));
  $("dCopy").addEventListener("click", () => {
    const p = products.find((x) => x.id === selectedId);
    if (p) copyText(productMarkdown(p, products.indexOf(p)), "已复制「" + (p.name || "未命名") + "」");
  });
  $("dDel").addEventListener("click", () => {
    const p = products.find((x) => x.id === selectedId);
    if (!p) return;
    if (!confirm("删除「" + (p.name || "未命名商品") + "」？")) return;
    products = products.filter((x) => x.id !== p.id);
    selectedId = null;
    renderDetail();
    renderProducts();
    persist();
  });

  // 恢复上次内容
  renderProducts();
  renderDetail();

  // 有内容时提醒别误关
  window.addEventListener("beforeunload", (e) => {
    if ($("transcript").value.trim() || products.length) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
}

init();
