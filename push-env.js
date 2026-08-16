// 把 env.local 一键导入 Vercel 环境变量：node push-env.js
// 前提：已经 vercel link 过（跑过一次 vercel）；可先用 node push-env.js --dry 预览
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = __dirname;
const FILE = path.join(ROOT, "env.local");
const ENVS = ["production", "preview", "development"]; // 三个环境都配
const dry = process.argv.includes("--dry");

function parseEnv(text) {
  const out = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (k && v) out.push([k, v]);
  }
  return out;
}

const mask = (v) => (v ? v.slice(0, 6) + "…" + v.slice(-4) : "(空)");

if (!fs.existsSync(FILE)) {
  console.error("找不到 env.local");
  process.exit(1);
}
if (!dry && !fs.existsSync(path.join(ROOT, ".vercel", "project.json"))) {
  console.error("还没关联 Vercel 项目：请先运行 vercel （按提示建好项目）再导入");
  process.exit(1);
}

const vars = parseEnv(fs.readFileSync(FILE, "utf8"));
if (!vars.length) {
  console.error("env.local 里没有可导入的变量");
  process.exit(1);
}

console.log("env.local 解析出 " + vars.length + " 个变量：");
for (const [k, v] of vars) console.log("  " + k + " = " + (/key/i.test(k) ? mask(v) : v));

if (dry) {
  console.log("（--dry 预览模式，未执行导入。去掉 --dry 正式导入，写入环境：" + ENVS.join(" / ") + "）");
  process.exit(0);
}

let fail = 0;
for (const [k, v] of vars) {
  for (const env of ENVS) {
    const r = spawnSync("vercel", ["env", "add", k, env], { input: v + "\n", encoding: "utf8", shell: true });
    const err = (r.stderr || "") + (r.stdout || "");
    if (r.status === 0) {
      console.log("✓ " + k + " → " + env);
    } else if (/already exist|duplicate/i.test(err)) {
      console.log("· " + k + " → " + env + " 已存在（如需更新：vercel env rm " + k + " " + env + " 后重跑）");
    } else {
      fail++;
      console.error("✗ " + k + " → " + env + "：" + err.trim().split("\n").slice(-3).join(" / "));
    }
  }
}
console.log(fail ? "有 " + fail + " 项失败，请看上面的提示。" : "全部导入完成。记得执行 vercel --prod 让变量生效。");
process.exit(fail ? 1 : 0);
