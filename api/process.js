// POST /api/process  { transcript, config? }  →  { ok, products }
// 把整场直播的转写文稿交给 LLM，按商品切分并生成口语版 / 书面语版
"use strict";
const { resolveConfig, readJsonBody, sendJson, extractProducts } = require("./_shared");

// 长文稿要多段调用 LLM，放宽函数超时（Vercel Hobby 最高 60s）
module.exports.maxDuration = 60;

module.exports = async (req, res) => {
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "只支持 POST" });
  try {
    const body = await readJsonBody(req);
    const cfg = resolveConfig(body.config);
    const transcript = String(body.transcript || "").trim();
    if (!transcript) return sendJson(res, 400, { ok: false, error: "transcript 为空" });
    if (!cfg.apiKey) {
      return sendJson(res, 400, {
        ok: false,
        error: "未配置 API Key：请在页面右上角「设置」里填写，或在部署环境配置变量 API_KEY",
      });
    }
    const products = await extractProducts(cfg, transcript);
    return sendJson(res, 200, { ok: true, products });
  } catch (e) {
    return sendJson(res, e.status || 500, { ok: false, error: e.message || String(e) });
  }
};
