# 直播话术整理台 · 实时版

给直播主播用的实时整理工具（网页版）：**边直播边录音，话术实时转成文字，AI 实时按商品切分**，每个商品生成两份介绍材料——

- **口语版**：保留主播原话风格，只去掉口癖和闲聊
- **书面语版**：整理成通顺规范的详情页 / 宣传文案

界面分三块：**上面**是实时转写区（边说边出字）；**下面左边**是商品列表；**下面右边**是选中商品的整理结果（口语 / 书面语两个版本，可直接编辑）。点「导出全部 MD」把所有商品打包成一个 Markdown 下载。

前后端分离，**所有配置固定在 `env.local` 文件里，网页上没有任何设置项**。

## 怎么启动

双击 `start.bat`（或命令行 `node server.js`），浏览器会自动打开。

> 实时版需要后端接口，不能直接双击 `index.html` 使用。默认端口 8642，被占用时自动换相邻端口。改完 `env.local` 要重启服务才生效。

## 配置：env.local

复制 `env.example` 为 `env.local`（`cp env.example env.local` 或手动复制），填入 Key 即可：

| 变量 | 说明 | 默认 |
|------|------|------|
| `zhipu_apikey` | 智谱 Key（[open.bigmodel.cn](https://open.bigmodel.cn)），`glm-4.5-flash` 整理免费 | — |
| `siliconflow_apikey` | 硅基流动 Key（[siliconflow.cn](https://siliconflow.cn)），转写 `SenseVoiceSmall` 免费 | — |
| `auto_delay` | 文稿稳定几秒后自动整理 | 8 |
| `auto_interval` | 录音中每隔几秒整理一次（0 = 关） | 30 |

**Key 的三种填法：**

| 填法 | 整理（LLM） | 服务器识别转写 | 费用 |
|------|------------|---------------|------|
| 两家都填（推荐） | 智谱 `glm-4.5-flash` | 硅基流动 `SenseVoiceSmall` | **全免费** |
| 只填智谱 | 智谱 | 智谱 `glm-asr` | LLM 免费，转写按量计费 |
| 只填硅基流动 | 硅基流动 `GLM-4-9B` | 硅基流动 `SenseVoiceSmall` | 全免费（小模型整理效果略弱） |

页面顶栏的小圆点表示服务器配置状态（悬停可看详情）；识别引擎（浏览器 / 服务器）在下拉框里切换，仅记住本机偏好。

## 实时工作流

1. 选识别引擎，点「🎤 开始录音」，转写文字实时出现在上方
2. AI 自动整理：录音中每隔 `auto_interval` 秒、文稿稳定 `auto_delay` 秒后自动触发（也可点「⚡ 立即整理」）
3. 左侧点商品查看 / 编辑；「⬇ 导出全部 MD」下载一个 Markdown 文件
4. 手改过的商品内容不会被自动整理覆盖

想先看效果：「填入演示文稿」→ 等几秒（或点「立即整理」）。

## 部署到 Vercel

项目根目录的静态文件 + `api/` 目录开箱即用，零配置（`env.local` 等本地文件已被 `.vercelignore` 排除，不会上传）。三步：

```bash
npm i -g vercel
vercel              # ① 首次：登录、建项目（起个名，如 zb）
node push-env.js    # ② 把 env.local 的变量导入 Vercel（--dry 可先预览）
vercel --prod       # ③ 正式发布
```

`push-env.js` 会把 `env.local` 里的变量原样导入 Vercel 的 production / preview / development 三个环境——**后端认识这些小写名字**（`zhipu_apikey` / `siliconflow_apikey` / `auto_delay` / `auto_interval`），导入即生效，不需要改名。已存在的变量会自动跳过（想改值：`vercel env rm 名称 环境` 删掉后重跑）。

不想用脚本，也可以在 Vercel 后台 **Settings → Environment Variables** 手动配。两套名字都认：

| 简单名（推荐，和 env.local 一致） | 规范名（等效） | 说明 |
|------|------|------|
| `zhipu_apikey` | `API_KEY` | 整理用的智谱 Key |
| `siliconflow_apikey` | `ASR_API_KEY` | 转写用的硅基流动 Key |
| — | `ASR_BASE_URL` | 转写接口（配了硅基流动 Key 会自动填 `https://api.siliconflow.cn/v1`，可不填） |
| — | `ASR_MODEL` | 转写模型（同上，自动 `FunAudioLLM/SenseVoiceSmall`） |
| — | `API_BASE` / `LLM_MODEL` | 整理接口 / 模型（默认智谱 `glm-4.5-flash`，可不填） |
| `auto_delay` | `AUTO_DELAY` | 文稿稳定几秒后自动整理（默认 8） |
| `auto_interval` | `AUTO_INTERVAL` | 录音中每隔几秒整理一次（默认 30） |

两家 Key 的分工规则与本地一致：**都配 = 整理走智谱 + 转写走硅基流动（全免费组合）**；只配智谱 = 全走智谱（转写按量计费）；只配硅基流动 = 全走硅基流动（免费，整理模型稍弱）。

## 已知限制

- 「浏览器识别」需要 Chrome / Edge 且联网（国内 Chrome 基本连不上识别服务，建议 Edge，或用服务器识别）
- 服务器识别每 15 秒回传一段，延迟略高于浏览器识别；若一次送来超过 60 秒的音频，`/api/asr` 会**自动按 ≤55 秒分段识别再拼接**（本地最多 30 分钟；Vercel 上限约 110 秒，受函数 60 秒执行时间约束）
- Vercel 免费版单次函数执行最长 60 秒：超长直播（几万字文稿）自动整理可能超时，可清掉旧文稿再继续，或用本地 `server.js`（无此限制）
- 请保持页面打开；转写文稿和商品列表自动存在本机浏览器，刷新不丢

## 文件结构

```
index.html        页面（实时转写 + 商品列表 + 详情，无设置页）
style.css         样式（纸面编辑风）
app.js            前端逻辑（录音 / 转写 / 自动整理 / 导出）
api/_shared.js    后端共享库（LLM 提示词、上游调用、合并逻辑）
api/config.js     GET  /api/config  服务器配置探测（只回掩码 Key）
api/process.js    POST /api/process 文稿 → 按商品切分整理
api/asr.js        POST /api/asr     WAV 音频段 → 文字
api/test.js       POST /api/test    连接测试
env.example       配置模板（Key 留空，复制为 env.local 后填写）
env.local         本地配置（Key + 参数，不随部署上传）
push-env.js       把 env.local 一键导入 Vercel 环境变量（--dry 预览）
server.js         本地开发服务器（静态 + API 路由，与 Vercel 同一套代码）
start.bat         一键启动
1git.bat          提交并推送到 Gitee
```
