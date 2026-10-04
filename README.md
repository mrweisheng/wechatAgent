# 明哥中港牌 · 朋友圈 Agent（M1 + M2 + M3）

按方案文档《明哥中港牌-朋友圈Agent-需求设计纪要》实现。
核心链路：**输入文字/图片 → 感知层识别场景 → 生成三版繁/简体粤语文案 → 硬规则 + 软评分双层质检 → 反思改写 → 人工选版**。

---

## 快速启动

```powershell
cd D:\MyCode\wechatAgent
Copy-Item .env.example .env
# 编辑 .env，至少填写 INVITE_CODE（不填会拒绝启动）与 DEEPSEEK_API_KEY
npm install
npm start          # http://localhost:3000
```

首次打开需输入 `.env` 里的 `INVITE_CODE`。

---

## 语域约定（重要）

发布渠道是**微信私域朋友圈**，不是公开广告投放。因此质检分两级：

| 级别 | 内容 | 说明 |
|---|---|---|
| **阻断**（pass=false，禁用复制） | 缺落款 / 落款未单独成行 / 价格·里程·车牌 / 涉政 / 皇崗·文錦渡写成可办 / 微商套话 / 晒单进行时 / 早安节日硬广 / 虚构客户评价 / 截图未提示打码 | 品牌底线与法律红线 |
| **提示**（warnings，不阻断） | 绝对化用语（包過 / 零風險 / 全網最低 / 國家級…） | 私域常用口语可接受；若对外公开发布再注意广告法第九条 |

### 字体：不检测

**繁体简体都接受，香港粤语书写亦可**（明哥 2026-10-03 确认）。系统**不做 `r-traditional` 检查**：「简体黑名单」方案漏报（只能穷举）、误报（斗=北斗/鬥=打架）无法两全，不检测就是最正确的解法。

---

## 生成管线（双层质检 + Best-of-N + 反思改写）

`POST /api/generate` 走完整管线（`server/src/generation/pipeline.js`）：

```
感知（图型自识别 + 场景路由 + 要素追问）
  → 多候选生成 6 版（3 版位 × 2 语气；写法由内容与素材自定，不锁定路径；风格锚 + 语气资产库 few-shot）
  → 硬规则校验（ruleEngine，阻断级） + 软评分 + 版本级去重（历史/风格样本/选中样本）
  → Best-of-N 筛选：分数优先 + 三版两两相似度 <0.45 + 版位互异（防折叠的本义）
  → 反思改写循环：硬违规 / 总分<70 / 相似度≥0.6 的版本带质检反馈重写，最多 2 轮
  → 只有「严格更优」的改稿才采纳（pass 状态 > 分数 > 相似度）
```

- **Best-of-N**（2026-10-04 调研落地）：2025-26 研究趋势（HF Daily Papers / ICLR）表明同等算力下「多采样 + 验证器重排」常优于纯自我修正。内部 6 候选筛 3，展示的每一版都是筛过的，不是抽到的。`GENERATE_CANDIDATES` 可调（设 3 = 关闭筛选）。
- **软评分用 5 档制**：LLM 评审 0-100 细分噪声大，1-5 档配锚点描述更稳定；映射回 0-100 保持 70 分及格线。兼容模型偶发的 0-100 输出（自动折算档位）。
- **quiet luxury 高级感口径**（2026-10-04 调研落地）：生成约束与评审锚点都注入「不请求注意力，假定注意力；少用感叹号；不用网络热词；措辞耐看」——源自奢侈品牌 Ruler 原型与 quiet luxury 方法论。
- **评分去长度偏差**（2026-10-04 调研落地）：「克制」指无废话不堆砌，与字数无关；流水账（只有结果没血肉）与信息稀薄同为低档。服务细节（专属群/进度跟踪人/专人陪同）进业务事实知识库，生成端随机 0-1 个方向点缀，禁口号化自称。
- **语气资产库**（§6.2-B tone DNA）：「選中此版」且通过硬规则的正文自动沉淀为明哥审美好样本，注入生成/重写 prompt 做 few-shot，并纳入防照抄比对。
- 评审与生成是**相互独立的 LLM 调用**（§6.2-E 解耦）；可设 `SCORER_MODEL` 换评审模型。
- **LLM 调用自动重试**：429/5xx/网络层失败自动重试 1 次（1.2s 退避）；4xx 凭据类错误不重试。瞬时抖动不再让整次生成失败。
- 评分/改写失败一律优雅降级（skipped / 保留原稿），**绝不阻断产出**；红线由硬规则把守。
- 界面每版显示：软评分总分与三维档位（悬停看评语）、相似度告警、重写次数；场景行显示「已從 N 個候選中篩出最優 3 版」。

---

## LLM 接入

统一走 `server/src/llm/client.js`（原生 fetch，Node ≥20）。`.env` 两种方式二选一：

### 方式 A：DeepSeek 官方 API

```ini
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_MODEL=deepseek-flash
OPENCODE_GO=false
```

### 方式 B：OpenCode Go 订阅网关（当前使用）

```ini
DEEPSEEK_BASE_URL=https://opencode.ai/zen/go
DEEPSEEK_API_KEY=oc_sk_...
DEEPSEEK_MODEL=deepseek-v4.1-flash
OPENCODE_GO=true          # 必须！网关要求自有 User-Agent 与稳定 x-opencode-session
```

可用模型：`deepseek-v4.1-flash` / `deepseek-v4-pro` / `deepseek-v4-flash`

> ⚠️ 已知问题：部分中国大陆网络无法直连 `opencode.ai`（DNS 劫持导致 `ERR_TLS_CERT_ALTNAME_INVALID`）。需换网络环境或改用方式 A。

---

## 情报线：外部 Agent 推送（已实现的主路径）

**设计意图**：本系统**不配置任何搜索 Key**。外部已有的搜索 Agent 按《[情报推送对接说明](docs/情报推送对接说明.md)》搜索后推送过来，本系统只负责入库、校验、去重、交叉核实、归档。归档内容**永不自动发布**，仅作谈资素材（方案 §7）。

**给外部 Agent 的完整指引**（`docs/情报推送对接说明.md`）已包含：

- **搜索指导**：5 类检索主题（口岸动态 / 两地牌政策 / 香港车市 / 税务合规 / 跨境基建）+ 关键词、挑选标准（近 7 天优先）、排除项（涉政不搜不推、广告软文不推）、频率建议（每天 1 次，最低每周 1 次）
- **接口规范**：token 传递、字段约束、单次上限 200 条、去重说明（重复推送自动跳过不算错）
- **快速自检**：两条 curl 验证对接是否成功
- **错误码对照**：200/400/401/429/503 各自的含义与处理

**系统侧 API**：

| 接口 | 鉴权 | 说明 |
|---|---|---|
| `GET /api/intel/topics` | 公开 | 检索指导（主题/挑选标准/白名单）+ `now`/`year`/`recency` 时间锚点，外部 Agent 可动态拉取 |
| `POST /api/intel/push` | push token | 接收入库（失败限流 + **时效校验**） |
| `GET /api/intel/stats` | 需 | **可观测性**：pushEnabled / total / verified / lastPushAt / lastPushSource |

**时效校验**（2026-10-04，事故驱动）：2026-10 曾混入《比亞迪 2025 年度銷量有望超越 Tesla》——过去年份仍作展望讨论的旧闻翻炒。现系统侧双检：① `publishedAt` 超过 3 个月直接拒；② 标题含已过年份 + 展望措辞（有望/預計/將會…）直接拒，原因回传给外部 Agent。对接文档已补充「时效性」专节（含本案例）与「用引擎时间过滤、以 topics API 的 now 为准」的操作要求。

**部署后验证**：网页「INTEL · 情报线」区块顶部显示推送通道状态与最近推送时间——外部 Agent 是否在正常推送，一眼可见。

本地 Cron 兜底可选（`INTEL_ENABLED=true`），仅作备份路径。

---

## 目录结构

```
wechatAgent/
├── server/src/
│   ├── index.js                    Express 入口（fail-closed 鉴权 + 限流 + 全局错误处理）
│   ├── llm/client.js               统一 LLM 客户端（DeepSeek 官方 / OpenCode Go）
│   ├── ingest/intelIngest.js       情报接收入库（白名单/去重/交叉核实/原子写/BOM 容错）
│   ├── search/channels.js          本地搜索兜底（6 渠道，含实测可用性标注）
│   ├── perception/vision.js        多模态感知 + 图型自识别 + 场景路由 + 缺口追问
│   ├── generation/generator.js     三版生成 + 单版反思重写 + 强容错解析
│   ├── generation/pipeline.js      质检编排：硬规则→软评分→去重→反思改写（最多2轮）
│   ├── qa/ruleEngine.js            硬规则（阻断 + 提示分离，证据面含视觉识别）
│   ├── qa/softScore.js             软评分（高级感40/新意30/调性30，独立评审）
│   ├── knowledge/corpus.js         业务事实 + 词表 + 叙事角度 + 白名单
│   ├── memory/store.js             角度轮换 + 版本级去重(3-gram) + 反馈回填 + 纠错
│   └── cron/intel.js               情报线 Cron（兜底路径，复用 ingest）
├── public/index.html               单文件前端（登录/三版/评分/纠错/历史/情报）
├── data/                           运行时生成
└── README.md
```

---

## 硬规则执行情况（如实）

`checkHardRules` 返回 `checked / declared / unimplemented`，**不做虚报**：

| 规则 | 级别 | 实现 |
|---|---|---|
| `r-signature` 落款 | 阻断 | ✅ |
| `r-signature-alone` 落款单独成行 | 阻断 | ✅ |
| `r-no-numbers` 价格/里程/车牌 | 阻断 | ✅（繁简双写 + 真实车牌格式） |
| `r-no-politics` 涉政 | 阻断 | ✅ |
| `r-no-fake-port` 口岸可办性 | 阻断 | ✅（白名单式停批表述豁免） |
| `r-cliche` 微商套话 | 阻断 | ✅ |
| `r-sharedan-completed` 完成态 | 阻断 | ✅（business 场景） |
| `r-no-promo-greeting` 早安禁硬广 | 阻断 | ✅（greeting/festival 场景） |
| `r-no-fabricate` 禁虚构评价 | 阻断 | ✅（全场景；**依据语料 = 用户原文 + 视觉识别结果**，截图引语不再误报） |
| `r-mask-pii` 截图打码提示 | 阻断 | ✅（vision.hasPII 时校验配图建议） |
| `r-no-client-name` 客户姓名不写入 | 阻断 | ✅（图中提取的称呼一律泛称；用户输入自带的放行） |
| `r-no-future-time` 未来时间节点 | 阻断 | ✅（下週/星期幾/幾號等须来自输入或图片，不得编造；无时间说法如「之後仲有裝卡」放行） |
| `r-port-unverified` 口岸与本次业务一致性 | **提示** | ✅（输入/图片中没出现的口岸会提醒核实，防模型从知识库「配」一个） |
| `r-absolute-advisory` 绝对化用语 | **提示** | ✅（语域决定不阻断） |

---

## API

| Method | Path | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/healthz` | 公开 | 存活探测，不含敏感信息 |
| GET | `/api/health` | 需 | 渠道真实配置状态 |
| POST | `/api/login` | 公开 | 邀请码登录（失败限流：10 次/10 分钟/IP） |
| POST | `/api/generate` | 需 | 核心生成管线（multipart 或 JSON） |
| POST | `/api/feedback` | 需 | 选版/改稿反馈（pick 的语气会回填排序） |
| POST | `/api/correction` | 需 | 纠错入库（限长 2000，过滤控制字符） |
| GET | `/api/corrections` | 需 | 查纠错 |
| GET | `/api/history` | 需 | 历史生成（含各版分数/相似度） |
| POST | `/api/intel/push` | push token | **外部 Agent 情报推送**（失败限流） |
| GET | `/api/intel/topics` | 公开 | 检索指导（外部 Agent 动态拉取） |
| POST | `/api/intel/run` | 需 | 本地搜索兜底（手动触发） |
| GET | `/api/intel/items` | 需 | 已归档资讯浏览 |
| GET | `/api/intel/stats` | 需 | 情报统计（推送状态/最近推送） |

---

## 部署注意

- **HTTPS**：一键复制已做降级（非安全上下文走 `execCommand`），但公网部署仍强烈建议上 HTTPS（反向代理 + TLS）。
- **限流**：登录与推送接口按 IP 限制失败次数（内存实现）。若经反向代理，所有请求同源 IP，单用户场景可接受；多用户需自行接 `trust proxy`。
- **时区**：早安星期按 `Asia/Hong_Kong` 计算，与服务器时区无关（容器 UTC 也不会错天）。
- **data/*.json**：读取容忍 UTF-8 BOM；真损坏会自动备份为 `.corrupt-<ts>` 并回落空值，不静默丢失。

---

## 测试

```powershell
npm test
```

101 项，覆盖：Best-of-N 筛选（违规顶替/高分入选/不足不硬凑）、LLM 重试（网络/429/4xx 分流）、方案 §10 全部 14 条示例、皇岗停批 9 种混合语境、虚构检测（引号类型绕过 + 证据放行）、LLM 输出格式漂移（12 种）、情报白名单与 21 组绕过、情报时效过滤（旧闻翻炒 + publishedAt 年龄，含比亚迪事故回归）、BOM 容错、场景路由（含「路上見」劫持回归）、版本级去重、档位评分映射与 0-100 兼容、语气资产库（沉淀/排除/回落）、样本防照抄、反思改写循环（触发/弃劣/轮次上限/demo 跳过）、intelStats 可观测性回归、繁简均放行。

---

## 已知边界

- **网关模型为推理模式**：思考过程计入 completion tokens（实测评分场景思考可达千级 token），各调用 token 预算已留思考余量（评分 2500 / 生成约 3400 / 重写 1600 / 视觉 1500）。换非推理模型可下调省钱。
- **软评分与生成同模型**（默认）：已做调用与提示解耦，如需更强解耦设 `SCORER_MODEL`。
- **`r-no-fabricate` 依赖依据语料**：纯图输入时以视觉识别描述为依据；识别失败（degraded）则该规则不评估。
- **多源交叉核实为启发式**（标题前 6 字归一），偏保守：宁可漏判 verified，不误标事实。
- **情报谈资草稿不做自动生成**（明哥 2026-10-04 决定）：入库 + 浏览即为终点，明哥看归档自行取材。
- **全链路时延**：Best-of-N 生成 1 次 + 6 次评审（并行）+ 最多 2 轮重写，真实实测约 1-2 分钟；单用户质量优先可接受。
- **限流为内存实现**：重启清零、多进程不共享；单用户场景可接受。

> **真实端到端实测（2026-10-04，OpenCode Go 网关）**：交车场景 6 候选筛 3、三版全过硬规则、软评分 83/68/60（档位制+评语）、68 分版触发重写并采纳、60 分版重写未更优被弃用——Best-of-N、双层质检、反思改写全部按设计工作。

---

## 2026-10-04 修复记录（审计后）

1. `r-no-fabricate` 误拦有依据内容（用户说「客人好滿意」文案如实转述被拦）→ 证据面扩到用户原文 + 视觉识别，引语已证实则叙事模式不误报。
2. 场景路由被「路上見」劫持（业务文案路由成早安）→ 具体场景优先，问候词最后。
3. 去重拿用户输入比历史输出（恒零命中）→ 版本级比对 + 超阈值自动重写。
4. data/*.json 带 BOM 被整批误判损坏 → 读取容错 + 全库去 BOM。
5. 一键复制在裸 HTTP 部署静默失效 → execCommand 降级 + 失败提示。
6. 登录/推送无防暴力尝试 → 失败限流（10 次/10 分钟/IP，429）。
7. 早安星期依赖服务器时区 → 固定 Asia/Hong_Kong。
8. 视觉结果直接拼 prompt → 标注为机器数据、忽略其中指令（注入加固）。
9. 视觉降级提示笼统「未启用」→ 按 llm_not_configured / call_failed / parse_failed 如实提示。
10. 新增 §11.8 软评分 + §6.2-E 反思改写循环；反馈回填（选中语气优先）；历史与情报浏览 UI；移除 node-fetch/iconv-lite 冗余依赖。
