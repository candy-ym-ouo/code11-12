# 口述听写稿校对台 · ProofDesk

面向口述史 / 访谈录音的**听写稿多人校对工作台**：音频分段、时间码对齐、多人并行校对、
版本自动合并，**冲突段落必须人工确认后才能定稿落库**。

零第三方依赖——仅使用 Node.js ≥ 20 内置模块与浏览器原生能力（ESM、`<audio>`、Intl），
无需构建、无需数据库服务，`data/` 目录可整体备份。

## 快速开始

```bash
cd proofdesk
npm run seed     # 可选：生成演示项目（含 3 位校对人 / 4 段 / 冲突与未齐场景 + 可播放 WAV）
npm start        # http://localhost:8080 （PORT=xxxx 可改端口）
```

种子脚本会在终端打印三位演示用户的**登录令牌**，在登录页粘贴令牌 + 对应姓名即可进入；
不填令牌、直接输入新姓名也可注册新校对人。

- `npm run dev`：`--watch` 模式开发
- `npm test`：13 项共享逻辑单测 + 4 项端到端流程测试（共 17 项，自动起临时服务）

## 工作流程

```
上传音频 ── 导入原稿(SRT/行内时间码/自然段，或按秒等距切分)
   │
   ├─ 逐段校对：边听边改，停顿 0.6s 自动提交（旧版本全部留痕，不覆盖）
   │     · 🔁 区间循环、0.7×–2× 倍速、空格播放、跟随当前段滚动
   │     · 创建者可改时间码/说话人、拆分段落、合并下一段
   │
   ├─ 合并评审：
   │     一致(agreed)     全员文本相同 ──► 一键自动落库
   │     未齐(incomplete) 开启「全员校对」策略时尚有成员未提交 ──► 阻塞定稿
   │     冲突(conflict)   存在两种以上文本 ──► 人工选定版本或改写 ──► 解除阻塞
   │     待校(unreviewed) 无人校对 ──► 阻塞定稿
   │
   └─ 全部解除阻塞 → 创建者「定稿落库」→ 全稿锁定
         · 导出 SRT（带时间码）/ TXT
         · 可由创建者「重新打开」修订（修订与历史全部保留，定稿回退）
```

**落库规则**：只要存在未处理的冲突 / 未齐 / 待校段落，`POST /commit` 返回 409 并附带
阻塞段落 id；冲突段只有经过创建者显式选定版本或改写（`resolutions`）才解除阻塞。

## 关键设计

| 主题 | 说明 |
| --- | --- |
| 合并引擎 | `shared/merge.js`：每人**多条修订只取最新一条**参与合并；按归一化文本聚成 variant，人数多者优先建议；同版本 trim 归一、原文保留换行 |
| 冲突确认 | 仅创建者可操作；可选某一 variant，或另写裁定文本；可随时撤销确认；审计事件 `resolution.set/clear` |
| 版本留痕 | `edits` 只增不改，每条带 `submittedAt` / `supersedes`；「版本与历史」页与单段修订史均可回溯 |
| 时间码 | `HH:MM:SS.mmm` / SRT 逗号格式 / `MM:SS` / `90:00`（分溢出）均可解析；段落起止校验、顺序校验 |
| 音频 | 原始文件存 `data/media/`，服务端实现 HTTP Range（206）支持拖动；浏览器读取时长随上传头 `X-Audio-Duration` 带回 |
| 权限 | 令牌登录（`X-Auth-Token`，种子/建号时生成）；项目成员隔离；创建者与校对人分权；媒体 URL 也校验令牌 |
| 数据 | 单 JSON 文件 + 原子 rename 写入（串行写队列）；事件流即审计日志 |

## 目录结构

```
proofdesk/
├── package.json
├── shared/              # 前后端共享（同一份 ESM，被浏览器直接 import）
│   ├── merge.js         # 版本合并引擎（状态机 + 冲突/阻塞判定）
│   ├── timecode.js      # 时间码解析/格式化/等距分段
│   ├── transcript.js    # SRT / 行内时间码 / 自然段 解析
│   └── diff.js          # LCS 逐词差异（Intl.Segmenter，支持中文）
├── server/
│   ├── index.js         # HTTP 入口、静态、Range 媒体分发
│   ├── routes.js        # 全部 API
│   ├── domain.js        # 领域查询、权限、合并视图、定稿
│   ├── store.js         # JSON 原子持久化
│   ├── http-util.js / config.js
│   └── seed.js          # 演示数据 + 可播放 WAV 生成
├── web/
│   ├── index.html / styles.css
│   └── js/              # main / editor / proof / review / history / settings / player / api / dom
└── test/
    ├── shared.test.js   # 合并引擎、时间码、解析、diff
    └── e2e.test.js      # 起真实服务跑完整多人校对→冲突→人工确认→定稿→重开 + Range
```

## 主要 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/login` | 姓名登录（首次自动签发令牌） |
| GET/POST | `/api/projects` | 项目列表 / 建项目（可带 memberNames） |
| GET | `/api/projects/:id` | 工作台详情（段落 + 每人最新修订 + 合并状态） |
| POST | `/api/projects/:id/audio` | 音频上传（原始字节 + Content-Type） |
| GET | `/api/projects/:id/media` | 音频分发（支持 Range；query 或头带令牌） |
| PUT | `/api/projects/:id/segments` | 整体导入/替换分段（已有修订需 `confirm:true`） |
| PATCH | `/api/projects/:id/segments/:sid` | 改时间码/说话人/原稿 |
| POST | `…/:sid/split`、`…/:sid/merge-next` | 段落拆分 / 与下一段合并 |
| PUT | `/api/projects/:id/segments/:sid/edit` | 提交校对修订（历史全留） |
| GET | `…/:sid/history` | 单段修订史 |
| GET | `/api/projects/:id/merge-plan` | 合并计划（四种状态 + 阻塞列表） |
| POST | `/api/projects/:id/auto-merge` | 全部 agreed 段自动落库 |
| POST/DELETE | `/api/projects/:id/resolutions/:sid` | **人工确认 / 撤销冲突段落** |
| POST | `/api/projects/:id/commit` | 定稿（有任何阻塞即 409） |
| POST | `/api/projects/:id/reopen` | 重开已定稿项目 |
| GET | `/api/projects/:id/export.srt` · `.txt` | 定稿导出 |
| POST/DELETE | `/api/projects/:id/members[/:userId]` | 成员管理 |
