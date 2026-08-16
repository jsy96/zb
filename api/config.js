// GET /api/config → 前端启动时探测服务器端配置（只回掩码 Key，不回完整 Key）
"use strict";
const { resolveConfig, sendJson } = require("./_shared");

module.exports = async (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendJson(res, 405, { ok: false, error: "只支持 GET" });
  }
  const cfg = resolveConfig({}); // 只看服务端环境变量（本地由 server.js 从 env.local 载入）
  const base = cfg.baseUrl || "";
  const provider = /bigmodel/.test(base) ? "智谱"
    : /siliconflow/.test(base) ? "硅基流动"
    : /googleapis/.test(base) ? "Google Gemini"
    : /dashscope/.test(base) ? "阿里百炼"
    : (base.replace(/^https?:\/\//, "").split("/")[0] || "未知");
  const num = (v, d) => {
    if (v === undefined || v === null || v === "") return d;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : d;
  };
  const delay = process.env.AUTO_DELAY || process.env.auto_delay;
  const interval = process.env.AUTO_INTERVAL || process.env.auto_interval;
  return sendJson(res, 200, {
    ok: true,
    hasKey: !!cfg.apiKey,
    keyMasked: cfg.apiKey ? cfg.apiKey.slice(0, 6) + "…" + cfg.apiKey.slice(-4) : "",
    provider,
    baseUrl: base,
    llmModel: cfg.llmModel,
    asrModel: cfg.asrModel,
    asrBaseUrl: cfg.asrBaseUrl || base,
    source: process.env._ENV_SOURCE || "服务器环境变量",
    autoDelay: Math.min(120, num(delay, 8)),
    autoInterval: Math.min(600, num(interval, 30)),
  });
};
