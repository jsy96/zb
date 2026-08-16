// POST /api/test  { config? }  →  { ok, reply }
// 设置页「测试连接」用：走一遍后端 → LLM 的完整链路
"use strict";
const { resolveConfig, readJsonBody, sendJson, postChat } = require("./_shared");

module.exports.maxDuration = 30;

module.exports = async (req, res) => {
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "只支持 POST" });
  try {
    const body = await readJsonBody(req);
    const cfg = resolveConfig(body.config);
    if (!cfg.apiKey) return sendJson(res, 400, { ok: false, error: "未配置 API Key" });
    const data = await postChat(cfg, {
      model: cfg.llmModel,
      max_tokens: 8,
      messages: [{ role: "user", content: "只回复两个字：正常" }],
    });
    const reply = data.choices && data.choices[0] && data.choices[0].message;
    return sendJson(res, 200, { ok: true, reply: String((reply && reply.content) || "").slice(0, 30) });
  } catch (e) {
    return sendJson(res, e.status || 500, { ok: false, error: e.message || String(e) });
  }
};
