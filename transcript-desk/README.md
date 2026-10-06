# 口述听写稿校对台

为口述历史 / 采访录音做**听写稿协同校对**的独立工具：音频按时间码分段、多位校对员
各自独立校对、版本三方合并，**冲突段落必须人工确认后才能定稿落库**。

零第三方依赖：Python 3.10+ 标准库（SQLite + ThreadingHTTPServer）+ 原生 HTML/CSS/JS。
数据默认全部落在 `./data/`（可用 `TRANSCRIPT_DESK_HOME` 覆盖），不连任何外网服务。

---

## 30 秒跑起来

```bash
cd transcript-desk

# 方式一：空白启动，自己在界面里建项目
bash scripts/run.sh                 # http://127.0.0.1:4100

# 方式二：一键生成演示项目（含合成音频、8 段草稿、两位校对员与 3 处冲突）
bash scripts/demo.sh
```

端到端自检（自动起隔离实例，跑 56 项 HTTP 断言，跑完即停）：

```bash
python3 scripts/e2e.py
```

## 工作流

```
上传音频 ──► 导入草稿（SRT / [时间码] 行 / 纯文本）
          │   自动分段、时间码对齐，可逐条微调或在播放位置拆分
          ▼
多位校对员各自独立提交（每人每段保留一个版本，更新有审计）
          │   全文一致 ──► 自动合并
          │   出现分歧 ──► 标记冲突，不进终稿
          ▼
合并台逐条处理冲突：采用某人版本 / 人工综合裁定（两种都算「人工确认」）
          ▼
定稿闸门：① 每段至少一版校对  ② 所有冲突段均已人工确认
          │   任一不满足 → 拒绝落库（409，给出具体段落号）
          ▼
定稿锁定 + 导出 SRT / 时间码 TXT（可重新打开继续校对，全程审计留痕）
```

## 关键设计

| 需求 | 实现 |
| --- | --- |
| 音频分段 | 草稿三种格式自动识别；时间码单调/不重叠校验；段时间码可编辑、可在播放位置 ✂ 拆分；已有校对的段禁止拆分（防止版本失配） |
| 时间码对齐 | 全链路毫秒整数；播放器进度条标注分段切点；点时间码跳转播放该段；0.6–1.5× 变速 |
| 多人校对 | 轻量身份（登记姓名，token 存 localStorage）；`(segment, user)` 唯一，再提交=更新，审计区分 `proof.submit/update`；4 秒轮询 + 5 秒心跳显示在线头像；他人版本与原稿字符级 diff（LCS，中文按字） |
| 版本合并 | 一致→`auto`；分歧→冲突且终稿留空；冲突确认后若又有新版本，状态变「待复核」（裁定仍保留，不阻塞定稿）；双方改回一致自动复位，过程在审计日志可查 |
| 冲突人工确认后落库 | 服务端事务闸门 `finalize`：缺校对 → `missing_proofs`；未确认冲突 → `unresolved_conflicts`；通过才写 `status=finalized`，此后所有校对/结构写操作 400 锁定；终稿统一取 `merges` 记录 |
| 大文件 | multipart 单遍流式解析（文件直接落盘，普通字段入内存），按 Content-Length 限量读取；音频接口支持 `Range`（206/Content-Range），可拖动 |
| 留痕 | `audit_logs`：登记、导入、上传、每次提交、冲突确认、定稿、重开，全部记录操作人与时间 |

## HTTP API 摘要

```
POST   /api/users                      登记校对员 → {id,name,token}
POST   /api/users/login                按姓名取回身份
GET    /api/projects                   项目列表（含校对进度计数）
POST   /api/projects                   建项目            (Bearer)
POST   /api/projects/demo              生成演示项目
GET    /api/projects/:pid              项目详情
POST   /api/projects/:pid/audio        multipart 上传音频  (Bearer)
POST   /api/projects/:pid/segments/import   草稿导入       (Bearer)
GET    /api/projects/:pid/segments     分段 + 全部版本 + 合并态
POST   /api/projects/:pid/segments/:sid/proofs    提交/更新我的校对 (Bearer)
POST   /api/projects/:pid/segments/:sid/timecodes 调时间码 (Bearer)
POST   /api/projects/:pid/segments/:sid/split      播放处拆分 (Bearer)
GET    /api/projects/:pid/merge        合并台视图（含统计）
POST   /api/projects/:pid/segments/:sid/resolve   冲突人工确认 (Bearer)
POST   /api/projects/:pid/finalize     定稿闸门 + 落库    (Bearer)
POST   /api/projects/:pid/reopen       重新打开           (Bearer)
GET    /api/projects/:pid/export?format=srt|txt      定稿后导出
GET    /api/projects/:pid/audit        审计日志
GET    /api/projects/:pid/audio/:file 音频流（支持 Range）
POST   /api/projects/:pid/heartbeat    在线状态
```

## 目录

```
transcript-desk/
├── server/
│   ├── db.py          # SQLite schema（users/projects/segments/versions/merges/audit/presence）
│   ├── service.py     # 业务规则与事务：合并状态机、定稿闸门、审计
│   ├── app.py         # HTTP 路由 / JSON API / Range 音频流 / 静态托管
│   ├── util.py        # 时间码、SRT 解析导出、字符级 diff、WAV 探测、流式 multipart
│   └── seed.py        # 演示数据（stdlib wave 合成 102 秒音频）
├── web/               # 单页校对台（index.html / app.js / style.css，无构建步骤）
├── scripts/run.sh · demo.sh · e2e.py
└── data/              # desk.db (SQLite WAL) + uploads/  （运行时生成）
```

## 说明与取舍

- 身份模型刻意从简：本地协作台以姓名区分校对员，token 仅用于标识提交人，
  不是密码学认证；如需公网部署，应前置反向代理并加真正的账号体系。
- 读接口不设权限（局域网内互信），写接口必须带校对员 token。
- 非 WAV 音频的时长由浏览器 `loadedmetadata` 回填；WAV 服务端直接解析时长。
- 冲突**永不会被静默合并**：即使只有一个人校对（自动），两人不一致时终稿字段保持为空，
  直到有人在合并台点击「确认此段定稿」。
