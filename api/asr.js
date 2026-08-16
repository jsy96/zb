// POST /api/asr  { audio: base64(WAV), filename? }  →  { ok, text }
// 实时录音的服务器识别模式：前端每十几秒送一小段 WAV，这里转发给 ASR 服务；
// 收到超过 60 秒的音频会自动分段识别再拼接（上限 30 分钟）
"use strict";
const { resolveConfig, readJsonBody, sendJson, callAsrAuto } = require("./_shared");

module.exports.maxDuration = 60;

module.exports = async (req, res) => {
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "只支持 POST" });
  try {
    const body = await readJsonBody(req);
    const cfg = resolveConfig(body.config);
    if (!cfg.apiKey) {
      return sendJson(res, 400, { ok: false, error: "未配置 API Key：请在「设置」里填写，或在部署环境配置变量 API_KEY" });
    }
    if (!body.audio) return sendJson(res, 400, { ok: false, error: "audio 为空" });
    const wav = Buffer.from(String(body.audio), "base64");
    if (wav.length < 1000) return sendJson(res, 400, { ok: false, error: "音频太短" });
    const text = await callAsrAuto(cfg, wav, body.filename);
    return sendJson(res, 200, { ok: true, text });
  } catch (e) {
    return sendJson(res, e.status || 500, { ok: false, error: e.message || String(e) });
  }
};
