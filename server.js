// 本地开发服务器：静态页面 + /api/* 接口（与 Vercel 部署时同一套 api/ 代码）
// 用法：node server.js   （可用环境变量 PORT 指定起始端口）
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const START_PORT = Number(process.env.PORT) || 8642;

/* ---------- 加载本地密钥文件 env.local / .env.local / .env ----------
   只是本地开发 convenience；Vercel 部署时用平台的环境变量，不读文件 */
function loadEnvFile() {
  const names = ["env.local", ".env.local", ".env"];
  for (const n of names) {
    let content;
    try { content = fs.readFileSync(path.join(ROOT, n), "utf8"); } catch (_) { continue; }
    const map = new Map();
    for (let line of content.split(/\r?\n/)) {
      line = line.trim();
      if (!line || line.startsWith("#")) continue;
      const i = line.indexOf("=");
      if (i < 0) continue;
      map.set(line.slice(0, i).trim().toLowerCase().replace(/[\s-]+/g, "_"), line.slice(i + 1).trim());
    }
    const get = (...keys) => { for (const k of keys) { const v = map.get(k); if (v) return v; } return ""; };
    const zhipu = get("zhipu_apikey", "zhipu_key", "zhipu_api_key", "api_key", "apikey");
    const sf = get("siliconflow_apikey", "siliconflow_key", "siliconflow_api_key", "guiji_apikey");
    const ad = get("auto_delay", "autodelay");
    const ai = get("auto_interval", "autointerval");
    if (ad) process.env.AUTO_DELAY = ad;
    if (ai) process.env.AUTO_INTERVAL = ai;
    const mask = (k) => (k ? k.slice(0, 6) + "…" + k.slice(-4) : "(空)");
    if (zhipu && sf) {
      // 两家都配了：整理走智谱（glm-4.5-flash 免费），转写走硅基流动（SenseVoiceSmall 免费），全免费组合
      process.env.API_KEY = zhipu;
      process.env.ASR_API_KEY = sf;
      process.env.ASR_BASE_URL = "https://api.siliconflow.cn/v1";
      process.env.ASR_MODEL = "FunAudioLLM/SenseVoiceSmall";
      process.env._ENV_SOURCE = "env.local";
      console.log("已加载 " + n + "：整理用智谱 " + mask(zhipu) + "，转写用硅基流动 " + mask(sf) + "（全免费组合）");
    } else if (zhipu && !process.env.API_KEY) {
      process.env.API_KEY = zhipu;
      process.env._ENV_SOURCE = "env.local";
      console.log("已加载 " + n + "：智谱 Key " + mask(zhipu) + "（注意 glm-asr 转写按量计费）");
    } else if (sf && !process.env.API_KEY) {
      process.env.API_KEY = sf;
      process.env.API_BASE = "https://api.siliconflow.cn/v1";
      process.env.LLM_MODEL = "THUDM/GLM-4-9B-0414";
      process.env.ASR_MODEL = "FunAudioLLM/SenseVoiceSmall";
      process.env._ENV_SOURCE = "env.local";
      console.log("已加载 " + n + "：使用硅基流动 Key " + mask(sf) + "（全免费模型）");
    } else {
      console.log("已加载 " + n + "，但没认出可用的 Key（支持：zhipu_apikey / siliconflow_apikey）");
    }
    return;
  }
}
loadEnvFile();

// 与 Vercel Serverless Function 相同的 (req, res) 处理器，直接复用
const routes = {
  "/api/process": require("./api/process"),
  "/api/asr": require("./api/asr"),
  "/api/test": require("./api/test"),
  "/api/config": require("./api/config"),
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);

  if (routes[urlPath]) {
    routes[urlPath](req, res);
    return;
  }

  let file = urlPath === "/" ? "/index.html" : urlPath;
  file = path.normalize(path.join(ROOT, file));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end("Not Found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
    res.end(data);
  });
});

// 端口被占（比如旧实例还开着）就自动往后找空闲端口
let port = START_PORT;
function listen() {
  server.once("error", (e) => {
    if (e.code === "EADDRINUSE" && port < START_PORT + 10) {
      port++;
      listen();
    } else {
      console.error("启动失败：" + e.message);
      process.exit(1);
    }
  });
  server.listen(port, () => {
    const url = "http://localhost:" + port;
    console.log("直播话术整理台（实时版）已启动：" + url);
    if (port !== START_PORT) {
      console.log("（默认端口 " + START_PORT + " 被占用，多半是旧实例还开着，已自动改用 " + port + "）");
    }
    // Windows 下自动打开浏览器，失败不影响使用
    if (process.platform === "win32") {
      require("child_process").exec('start "" "' + url + '"').on("error", () => {});
    }
  });
}
listen();
