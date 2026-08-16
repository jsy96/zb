// 后端共享工具（api/ 目录下 _ 前缀的文件不会被 Vercel 当成接口路由）
"use strict";

const DEFAULT_BASE = "https://open.bigmodel.cn/api/paas/v4";

/* ---------- 配置：请求里带的配置优先，其次环境变量 ---------- */

function resolveConfig(c) {
  c = c && typeof c === "object" ? c : {};
  const env = process.env;
  // 同时认两套名字：规范名（API_KEY / ASR_API_KEY…，Vercel 后台或显式配置用）
  // 和 env.local 的友好名（zhipu_apikey / siliconflow_apikey，vercel env upload env.local 直传用）
  const zhipu = String(env.ZHIPU_API_KEY || env.zhipu_apikey || "").trim();
  const sf = String(env.SILICONFLOW_API_KEY || env.siliconflow_apikey || "").trim();
  const apiKey = String(c.apiKey || env.API_KEY || zhipu || sf || "").trim();
  let baseUrl = String(c.baseUrl || env.API_BASE || "").trim().replace(/\/+$/, "");
  let llmModel = String(c.llmModel || env.LLM_MODEL || "").trim();
  let asrApiKey = String(c.asrApiKey || env.ASR_API_KEY || "").trim();
  let asrBaseUrl = String(c.asrBaseUrl || env.ASR_BASE_URL || "").trim();
  let asrModel = String(c.asrModel || env.ASR_MODEL || "").trim();

  if (zhipu && sf && !asrApiKey) {
    // 全免费组合：整理走智谱（glm-4.5-flash 免费），转写走硅基流动（SenseVoiceSmall 免费）
    asrApiKey = sf;
    asrBaseUrl = asrBaseUrl || "https://api.siliconflow.cn/v1";
    asrModel = asrModel || "FunAudioLLM/SenseVoiceSmall";
  } else if (!zhipu && sf && !env.API_KEY && !c.apiKey) {
    // 只配了硅基流动：整理、转写都走它（全免费）
    baseUrl = baseUrl || "https://api.siliconflow.cn/v1";
    llmModel = llmModel || "THUDM/GLM-4-9B-0414";
    asrApiKey = asrApiKey || sf;
    asrBaseUrl = asrBaseUrl || "https://api.siliconflow.cn/v1";
    asrModel = asrModel || "FunAudioLLM/SenseVoiceSmall";
  }

  return {
    apiKey,
    baseUrl: baseUrl || DEFAULT_BASE,
    llmModel: llmModel || "glm-4.5-flash",
    asrApiKey: asrApiKey || apiKey,
    asrBaseUrl,
    asrModel: asrModel || "glm-asr",
  };
}

/* ---------- 请求 / 响应 ---------- */

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    // Vercel 会把 JSON 请求体解析到 req.body；本地 server 走流式读取
    if (req.body && typeof req.body === "object") return resolve(req.body);
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (_) {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

/* ---------- 上游（OpenAI 兼容接口）调用 ---------- */

async function upstreamError(res) {
  let detail = "";
  try {
    const j = await res.json();
    detail = (j.error && (j.error.message || j.error.code)) || j.msg || j.message || JSON.stringify(j).slice(0, 200);
  } catch (_) { /* 忽略非 JSON 响应体 */ }
  const map = {
    401: "API Key 无效或未填写（401）",
    403: "没有权限，请检查 Key 和模型是否可用（403）",
    404: "接口地址或模型名不存在（404），请检查设置",
    429: "请求太频繁或额度不足（429）",
  };
  const err = new Error((map[res.status] || "接口返回 " + res.status) + (detail ? "：" + detail : ""));
  err.status = res.status;
  return err;
}

const SYS_PROMPT = `你是直播电商的资深运营助手。用户会提供一场直播的语音转写文稿：口语化、可能有错别字、重复、口癖和无关闲聊，段落前可能带有 [分:秒] 时间戳。

任务：整理出这场直播中介绍过的所有商品，为每个商品输出两种介绍材料。

规则：
1. 识别每个商品并去重：同一商品多次讲解合并为一个条目，按首次出场顺序排列；打招呼、抽奖、催单等与具体商品无关的内容丢弃。
2. productName：商品名称，用文中出现过的写法，可根据上下文修正明显错别字。
3. price：文中明确提到的价格或优惠（如「199」「49.9 买一送一」），没有则填空字符串。
4. highlights：2~5 条核心卖点短语，每条不超过 15 字。
5. spokenText（口语版）：保留主播的口语风格、称呼、语气和原话表达，只删掉口癖（嗯、那个、哈喽宝宝之类）、无意义重复和与商品无关的闲聊；禁止改写成书面语；段落前已有的 [分:秒] 时间戳要保留；同一商品不同时间的讲解用空行分段。
6. writtenText（书面语版）：整理成通顺、规范的书面商品介绍文案，可用小标题或分点，覆盖卖点、价格、适用人群、使用方式等文中出现过的信息；严禁编造原文没有的信息；适合直接用于商品详情页或宣传物料。
7. 只输出一个 JSON 数组，不要输出任何解释、前后缀或代码块标记。元素结构：
{"productName":"...","price":"...","highlights":["..."],"spokenText":"...","writtenText":"..."}`;

async function postChat(cfg, body) {
  const res = await fetch(cfg.baseUrl + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(170000),
  });
  if (!res.ok) {
    const err = await upstreamError(res);
    if (res.status === 400) err.badRequest = true;
    throw err;
  }
  return res.json();
}

async function chatExtract(cfg, userText) {
  const make = (opts) => ({
    model: cfg.llmModel,
    temperature: 0.2,
    messages: [
      { role: "system", content: SYS_PROMPT },
      { role: "user", content: "以下是转写文稿：\n\n" + userText },
    ],
    ...opts,
  });
  // 逐级降级：不同模型对 thinking / max_tokens 上限的兼容不同
  const candidates = [
    make({ max_tokens: 8192, thinking: { type: "disabled" } }),
    make({ max_tokens: 8192 }),
    make({ max_tokens: 4096 }),
    make({}),
  ];
  let data, lastErr;
  for (const body of candidates) {
    try { data = await postChat(cfg, body); break; }
    catch (e) {
      lastErr = e;
      if (!e.badRequest) throw e;
    }
  }
  if (!data) throw lastErr;
  const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
  return parseProductArray(msg.content || "");
}

function parseProductArray(raw) {
  if (!raw) throw new Error("模型没有返回内容");
  let s = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  const a = s.indexOf("["), b = s.lastIndexOf("]");
  if (a === -1 || b <= a) throw new Error("无法解析模型返回的 JSON，可以换个模型再试");
  const arr = JSON.parse(s.slice(a, b + 1));
  if (!Array.isArray(arr)) throw new Error("模型返回的不是数组");
  return arr
    .filter((p) => p && typeof p === "object" && (p.productName || p.name))
    .map((p) => ({
      productName: String(p.productName || p.name || "未命名商品"),
      price: String(p.price || ""),
      highlights: Array.isArray(p.highlights) ? p.highlights.map(String).filter(Boolean) : [],
      spokenText: String(p.spokenText || ""),
      writtenText: String(p.writtenText || ""),
    }));
}

/* ---------- 超长文稿：分段整理再合并 ---------- */

const EXTRACT_CHUNK = 12000;

function splitIntoPieces(text, maxLen) {
  const paras = text.split(/\n+/).flatMap((p) => (p.length > maxLen ? p.split(/(?<=[。！？!?])/) : [p])).filter(Boolean);
  const pieces = [];
  let cur = "";
  for (const p of paras) {
    if (cur && (cur + "\n" + p).length > maxLen) { pieces.push(cur); cur = p; }
    else cur = cur ? cur + "\n" + p : p;
  }
  if (cur) pieces.push(cur);
  return pieces;
}

const normKey = (s) => String(s).toLowerCase().replace(/[\s·、，,。.；;：:！!？?（）()【】\[\]「」-]/g, "");

function mergeProductLists(lists) {
  const map = new Map();
  for (const p of lists) {
    const key = normKey(p.productName);
    if (!key) continue;
    if (!map.has(key)) {
      map.set(key, { ...p, _spoken: [p.spokenText].filter(Boolean), _written: [p.writtenText].filter(Boolean) });
      continue;
    }
    const t = map.get(key);
    if (!t.price && p.price) t.price = p.price;
    for (const h of p.highlights) {
      if (!t.highlights.some((x) => normKey(x) === normKey(h))) t.highlights.push(h);
    }
    if (p.spokenText) t._spoken.push(p.spokenText);
    if (p.writtenText) t._written.push(p.writtenText);
  }
  // 去掉互为子串的重复段落（分段重叠导致的重复）
  const dedupe = (arr) => {
    const keep = arr.filter((s) => !arr.some((o) => o !== s && o.includes(s)));
    return [...new Set(keep)];
  };
  return [...map.values()].map((t) => ({
    productName: t.productName,
    price: t.price || "",
    highlights: t.highlights.slice(0, 6),
    spokenText: dedupe(t._spoken).join("\n\n"),
    writtenText: dedupe(t._written).join("\n\n"),
  }));
}

async function extractProducts(cfg, transcript) {
  const pieces = splitIntoPieces(transcript, EXTRACT_CHUNK);
  const results = [];
  for (const piece of pieces) {
    results.push(...(await chatExtract(cfg, piece)));
  }
  return mergeProductLists(results);
}

/* ---------- ASR：转发 WAV 到 /audio/transcriptions ---------- */

async function callAsr(cfg, wavBuffer, filename) {
  // asrBaseUrl 为空表示转写和聊天同一家；否则单独走转写服务
  const base = cfg.asrBaseUrl || cfg.baseUrl;
  const fd = new FormData();
  fd.append("file", new Blob([wavBuffer], { type: "audio/wav" }), filename || "chunk.wav");
  fd.append("model", cfg.asrModel);
  let res;
  try {
    res = await fetch(base + "/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: "Bearer " + cfg.asrApiKey },
      body: fd,
      signal: AbortSignal.timeout(90000),
    });
  } catch (e) {
    throw new Error("转写服务连接失败：" + (e.message || e));
  }
  if (!res.ok) throw await upstreamError(res);
  const j = await res.json().catch(() => ({}));
  return String(j.text || "").trim();
}

/* ---------- 超长音频：自动分段识别 ----------
   上游 ASR 普遍限制单条 ≤60 秒；/api/asr 收到更长的 WAV 时在这里
   自动切成 ≤55 秒的段、逐段识别、按顺序拼接文字 */

const ASR_SEG_SEC = 55;
// Vercel 单次函数最长 60s（两段识别约 50s），平台上限外再长就会超时；本地 server.js 无此限制
const ASR_MAX_TOTAL_SEC = process.env.VERCEL ? 110 : 1800;

// 解析 16-bit PCM WAV（单声道/立体声均可），失败返回 null
function parseWav16(buf) {
  if (buf.length < 44) return null;
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let off = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = tag(off);
    const size = v.getUint32(off + 4, true);
    if (id === "fmt ") {
      fmt = {
        format: v.getUint16(off + 8, true),
        channels: v.getUint16(off + 10, true),
        rate: v.getUint32(off + 12, true),
        bits: v.getUint16(off + 22, true),
      };
    } else if (id === "data") {
      dataOff = off + 8;
      dataLen = Math.min(size, buf.length - dataOff);
      break;
    }
    off += 8 + size + (size & 1); // chunk 按 2 字节对齐
  }
  if (!fmt || dataOff < 0 || fmt.format !== 1 || fmt.bits !== 16 || !fmt.rate || fmt.channels < 1) return null;
  return { rate: fmt.rate, channels: fmt.channels, samples: Math.floor(dataLen / 2 / fmt.channels), v, dataOff };
}

// 混成单声道 Float32
function wavToMono(w) {
  const out = new Float32Array(w.samples);
  for (let i = 0; i < w.samples; i++) {
    let s = 0;
    for (let ch = 0; ch < w.channels; ch++) {
      s += w.v.getInt16(w.dataOff + (i * w.channels + ch) * 2, true);
    }
    out[i] = s / w.channels / 32768;
  }
  return out;
}

// 线性重采样（识别服务对 16k 最友好）
function resample(f32, from, to) {
  if (from === to || !from || !to) return f32;
  const ratio = from / to;
  const n = Math.floor(f32.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * ratio, i0 = Math.floor(p), fr = p - i0;
    out[i] = f32[i0] * (1 - fr) + (f32[i0 + 1] !== undefined ? f32[i0 + 1] : f32[i0]) * fr;
  }
  return out;
}

// Float32 单声道 → 16k 16-bit WAV Buffer
function encodeWav16(f32, rate) {
  const pcm = resample(f32, rate, 16000);
  const out = Buffer.alloc(44 + pcm.length * 2);
  out.write("RIFF", 0); out.writeUInt32LE(36 + pcm.length * 2, 4); out.write("WAVE", 8);
  out.write("fmt ", 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(16000, 24); out.writeUInt32LE(32000, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write("data", 36); out.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i++) {
    const x = Math.max(-1, Math.min(1, pcm[i]));
    out.writeInt16LE(Math.round(x < 0 ? x * 0x8000 : x * 0x7fff), 44 + i * 2);
  }
  return out;
}

async function callAsrAuto(cfg, wavBuffer, filename) {
  const w = parseWav16(wavBuffer);
  const dur = w ? w.samples / w.rate : 0;
  // 不是标准 16-bit WAV、或时长在上游限制内：整条直传（保持原行为）
  if (!w || dur <= ASR_SEG_SEC) return callAsr(cfg, wavBuffer, filename);
  if (dur > ASR_MAX_TOTAL_SEC) {
    throw new Error("音频约 " + Math.round(dur / 60) + " 分钟，超过 " + ASR_MAX_TOTAL_SEC / 60 + " 分钟上限，请切短后再传");
  }
  const mono = wavToMono(w);
  const segSamples = Math.floor(ASR_SEG_SEC * w.rate);
  const nSeg = Math.ceil(mono.length / segSamples);
  const parts = [];
  for (let s = 0; s < mono.length; s += segSamples) {
    const seg = mono.subarray(s, Math.min(mono.length, s + segSamples));
    const text = await callAsr(cfg, encodeWav16(seg, w.rate), filename);
    if (text) parts.push(text);
  }
  console.log("[asr] 音频 " + dur.toFixed(1) + "s，自动分 " + nSeg + " 段识别完成");
  return parts.join("");
}

module.exports = {
  resolveConfig,
  readJsonBody,
  sendJson,
  upstreamError,
  postChat,
  chatExtract,
  extractProducts,
  callAsr,
  callAsrAuto,
};
