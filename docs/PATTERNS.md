> English: ./PATTERNS.en.md

# 工程模式 · 踩过的坑

这些大多不在引擎核心里——是搭这套东西(引擎本体 + 它的 surface:对话端、wake daemon、推送、dashboard)一路反复踩过的坑,攒成的参考。底线一条贯穿全文:**不信声明,只信外部证据**——缓存命没命中看 token 数,SQL 对不对在真库上跑,审计发现先复现再信。

> **怎么读。** 正文是**非显然的坑**——无声失败(不报错、输出还对,只在账单或数据上漏)和**域内专有**(fork 这个引擎才会撞)的,按主题分。通用后端卫生(老手大多已会)收在文末 **[附录 · table-stakes](#附录--table-stakes基础卫生老手可跳)**,留着给新手,不压。判准简单:**能被 tsc / 跑一次就抓到的**是 table-stakes;**抓不到、要看账单或数据才发现的**才进正文——这恰是开头那条"只信外部证据"的另一面。

## 1. Prompt caching:无声的钱坑

**地基规则:缓存是前缀匹配。前缀里任何一个字节变了,它之后的全部失效。** 渲染顺序固定 `tools → system → messages`;缓存键是渲染后、到每个 `cache_control` breakpoint 为止的精确字节。所以把**不变的**放前面(persona / 原则 / 长期 memory / 固定 tool 列表)挂 `cache_control`,**每轮都变的**(时间戳、git commit、本轮 activity)放到**最后一个 breakpoint 之后**(最后一条 user 消息里)。这条规则本身是常识;难的是它**失败时不报错**——下面这些都是违反它、却毫无错误的无声坑:

- **会变的标识符插进被缓存前缀、且排在 history 之前**,一变就**级联**把后面整段 history 缓存写废。每轮多写几十 k,你还以为缓存生效了。
- **滚动 history 本身会破缓存。** "取最近 N 条"让最老一条每轮掉出窗口,前缀随之平移,每轮强制全量重写。修法:history 锚在 **session 起点 append-only**(按 `sinceTs` 追加),只在硬上限下从最老端裁。
- **挂了 marker ≠ 命中。** 看 response 的 `cache_read_input_tokens`:重复同前缀它一直 **0**,就有静默 invalidator(`Date.now()`、未排序 JSON、变动的 tool set)。**diff 两次请求的渲染字节去找它。**
- **几条静默上限**:每请求最多 **4 个** breakpoint;低于模型最小可缓存前缀(常见 1k–4k token)**静默不缓存**(`cache_creation`=0,不报错);**20-block lookback**——一轮塞 > 20 个 tool_use/result 就找不到上一个缓存,长轮里每 ~15 块补一个中间 breakpoint。
- **多轮:** breakpoint 放最近一条消息的最后一个 block(前缀 = stable + 整段 history,逐轮累积);长期 persona 单独再给一个 breakpoint。
- **OpenAI-compat 端点**:`cache_control` 挂 tools 数组会 400,挂 system message;cached token 在 `usage.prompt_tokens_details.cached_tokens` 这类嵌套路径,读错路径一整天显示 0% 命中。
- **别中途改 tools / 换 model**:tools 在 position 0,一动整个缓存重建;缓存按 model 隔离。
- **对账价格表 vs 实价。** 硬编码的 per-token 价格表过期一代,会把上报花费整体放大数倍——token 数对、乘数是旧的。拿 provider 的 models API 对一遍,历史行 backfill(旧值留一列好回滚)。

> 为什么 caching 不违背「不 auto-consolidation」:缓存是对**一次性 transcript buffer** 省钱的 plumbing——不摘要、不下结论、不声称对话「是什么」。和自动 compact / 摘要(对「对话曾是什么」下被压缩的判断)是两回事:前者中性做满,后者带判断、本仓不做(见 [AUTONOMY.md](./AUTONOMY.md))。

## 2. 冷启动上下文:自己读,别甩给 subagent

启动一个 session 时,载入冷启动上下文(profile、active state、近期 memory、近期 commit——本仓走 `reentry`)的活,要由**将要行动的那个 agent 自己读**,不要为了省主上下文的 token 甩给 subagent。

诱惑很实在:那一大坨读进主上下文很贵。但 subagent 只能回给你一个**摘要**,而让 agent 真正"进入"状态/关系的那些 nuance——语气、register、一句承诺的确切措辞、一条 boundary 的边界——过一道转述就丢了。**context 的价值恰恰在它得驻留在会行动的那个 agent 里;外包给 subagent 等于先把它降维成摘要再用。** 付那个 token。

- **用 label/tag 锚住这次 boot**(如 `cc-YYMMDDHHMM`),会话中途的 delta(`reentry_delta`)只取自该锚点以来的新增——这是把"持续成本"封住的办法,不是每次全量重读。labeling 本身有 token 成本,但它换来的是 delta 的廉价。
- **顺带 fetch 最近的 commit**:代码层面"刚发生了什么"是 grounding 的一部分,别从对话推、别等出错才查。
- 一句话:省 token 的诱惑会让你把读 context 外包——而 context 的全部意义在于驻留,外包即降维。

## 3. Prisma / pgvector

- **`Unsupported("vector")` 列别让 Prisma 碰。** Prisma 反序列化不了 pgvector 列;默认 `findMany` / `create … RETURNING *` 仍会 SELECT 到它然后抛,而 `create` 那条先炸、掩盖掉"其实所有读都坏了"。`omit` 救不了(`Unsupported` 字段根本不暴露给 client)。做法:schema 里**声明**该列(`db push` 才不会把它当未知列 DROP),但所有向量读写走 `$queryRaw` / `$executeRaw`。**永远别 `prisma db push --accept-data-loss`**——它静默删掉它不认识的列(我们就这么丢过整表 embedding)。
- **部署的 client 落后于新 enum 值会炸整列读。** DB 加了 enum 值但 client 没重生成,任何返回该 enum 列的查询抛 `Value X not found in enum`,静默杀掉后台 loop。两道防:展示用的读走 `$queryRaw` + `"col"::text`(未知值毒不到结果);加 `postinstall: prisma generate`。注意 `git pull` + 重启**不跑** install,仍要手动 `db:generate`。
- **别拿"相关但不等价"的列代理真条件。** 用 `embeddingAt IS NULL` 数"缺 embedding",但行可以有向量却时间戳为空——把缺失多算了一百多条,真值(`embedding IS NULL`)是 0。查你真正要的那个条件。
- **graph / link 表两个遍历方向都建索引**(`[fromType,fromId,relationType]` 和 `[toType,toId]`);用 `CREATE INDEX IF NOT EXISTS` + Prisma 命名,免得 `db push` 又重新 detect。

## 4. 检索 / eval

- **语义-only 检索要有相似度地板,而且地板从数据量出来、不是猜的。** 基础 embedding 相似度(尤其 CJK)本身偏高(~0.3–0.5),不相关 query 也能过一个低的最终分阈值、返回随机近邻。在真 eval 集上量"不相关"和"真相似"两堆分数的**间隙**,地板设在间隙里;设太高(0.5)又把 0.43–0.49 的真匹配静默丢掉。强 keyword / entity 命中要能**旁路**地板。
- **只把数据真能满足的 case 放进 eval 集。** 那些其实是"源数据缺失"(没有 memory 正文含该词)的"失败",该删,不是算法 bug;别拿 ground 不了的 case 撑数。负控(`expectNone`)单独一类,不算进头条 hit@ / MRR。
- **编辑后要重嵌,不只补 null。** 只给 NULL 向量补 embedding 的 sweep,会在内容编辑后留下陈旧向量;盖一个 `embeddingAt`,`updatedAt > embeddingAt` 时重嵌。sweep 批量要让一次 backfill 跑完。
- **先搭 eval harness(nDCG / hit@k + 回归告警)再调阈值。** 先把度量立起来、挂 cron、和滚动均值比、跌了告警——阈值调整才是数据驱动的。

## 5. 并发 / cron / agent 安全

- **`allowedTools` 是预批清单,不是白名单。** 没列进去的工具**仍可调用**,只落到 permission mode 兜底。要真限住一个自主 agent,设 deny-by-default 的 permission mode,**并**加一道程序化 `canUseTool` 闸。
- **serverless 别 fire-and-forget 写。** Vercel / serverless 在 `controller.close()` 后杀实例,没 await 的 `void prisma.create(...)` 永远落不了地;关流前 await。
- **定时 job 要有 watchdog + 启动补跑自愈。** 一个陈旧 client 让每日两次的简报静默停了九小时、没告警。watchdog cron 检测漏掉的槽(过 grace、自上次无事件)并重启;启动补跑把真正漏掉的槽补送一次——守卫好,免得成功槽后的例行重启又重复 fire。
- **`setState` 更新器是异步的,不是同步。** 在 React 18 的 `setState((s)=>…)` 里改外层 `let`、commit 前读它——值还是空的,`fetch` 发了空 payload。用普通 `const` 同步算出 next 值。

## 6. 凭证 / 密钥 / 认证

- **别从匿名端点回吐真 token。** 一个 OAuth `/token` stub 对任意匿名 POST 回吐主 API key,就是完整 auth 绕过。客户端用静态 Bearer、不需要 OAuth flow,把整套 `.well-known` / `register` / `authorize` / `token` 表面**删掉**——不用的认证表面是纯负债。
- **配置 fail-closed,不给默认值。** 绝不 `process.env.X || "某个默认 key/model/endpoint"`——没配就启动时报清楚的错并退出,而不是悄悄拿一个用户没选过的端点 / 模型去跑。缺 key 该是硬启动失败,不是静默开门。
- **比 secret 用常量时间。** 校验 Bearer / token 别用 `===`——明文比较按响应延迟逐字节泄露密钥。先长度守卫,再 `crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))`。
- **密钥要结构性地排除出每一个注入面。** 凭证没进 prompt,常常只是"重要度排序"运气好,不是结构上挡住的。审计要把所有被动注入路径(retrieval、recent-memories、digest、profile…)各加一条显式 credential filter——靠 rank 挡不住。
- **第三方 OAuth refresh token 会偶发轮转。** 用 SDK 的 token 事件接住轮转后的新 token、**持久化**、盖 `lastRefreshedAt`;`invalid_grant` → 翻 FAILED 并 surface(别静默吞);token 放 DB 主存(不是 `.env`),跑每日 refresh 探针失败告警。

## 7. 模型 JSON 输出的解析

- **要分层兜底,不能一个贪婪正则了事。** 模型会间歇给 JSON 套 ```` ```json ```` 围栏、在 `max_tokens` 处截断留下不闭合括号——`\{[\s\S]*\}` 抓不住。**先剥围栏**;解析失败就**逐字段正则**抽,至少保住最关键那个;prompt 里钉死"纯 JSON、无围栏"并限输出体积。
- **空输出有多个独立成因,都要预算到**:`max_tokens` 对更长 prompt 的 JSON 太小;reasoning / thinking token 也算进 completion 预算——上限抬高,给"思考 + 答案"各留空间。

## 8. 数据建模 / 去重 / 默认值

- **"只取自上次起新增"会永久剥掉积压。** `createdAt >= since` 过滤 pending 项,意味着被每轮上限跳过的东西**再也不会重试**(它的 `createdAt` 早于下一个 `since`)。去掉时间过滤,靠 slug 去重(如 48h)防重发、同时还能重试卡住的项。对有空洞的事件流,**固定回看窗**(如 12h)比"自上次成功起"好——后者会漏掉在被抑制 / 跳过窗口里落下的信号。
- **一个 schema `@default` 会静默把记录卷进昂贵处理。** 三条 create 路径都没传 `resolution`,`@default(OPEN)` 就把几十条日常行拉进一个持续 LLM sweep 池——一个月上百刀。每个写入点**显式**设值,backfill 错默认的行,给真正少数的例外一个 reopen 工具。
- **DRY drift 会变成正确性 bug。** 跨 surface 的契约(事件类型名、解析逻辑、工具 schema)重复定义会悄悄漂移:两个 transport 入口各缺对方有的工具、同名工具 schema 还不一致(一个收 slug 一个收 id),其中一个甚至漏了另一个会过滤的密钥;daemon 写一个 eventType、reader 查另一个 → commit 静默不可见。把跨 surface 契约抽成**一个** registry / 模块,改一次。
- **去重键要稳、且避开会抖的字段。** 按内部 id 去重分组一变就破;按上游会抖的时间戳去重,源重发同一条就产生重复通知。用稳定自然键(日期 + 内容);user-facing 去重用 slug / 身份,不用时间戳。
- **ASCII-only slugify 会吞 CJK。** 假设 ASCII 的 slugify 把中文身份键剥成空字符串,下游按键聚合全断。slugify 要保 Unicode,或对非 ASCII 显式处理。

## 9. Retry / 超时 / 韧性

- **连接池耗尽要当瞬时错误重试。** 多个服务挤一个 session-mode pooler(连接上限低)时,查询会**静默返回空**而不是报错。每个并行查询包一层(一条空结果可容忍),别让 `Promise.all` 里一条 reject 拖垮整个 dashboard;瞬时连接错误退避重试三次;真正的修法是换 transaction-mode(pgbouncer)pooler + 抬连接上限。
- **超时要分层。** 一个通用 fetch 默认(如 60s)对普通 API 够,但会**掐掉慢的 LLM 生成**(extended thinking / 长输出能跑两三分钟)。给 LLM caller 单独一个高得多的 per-attempt 超时(180s 量级)。
- **长 idle 的 SSE 流会被客户端 body timeout 杀。** 没数据的 SSE 连接 5 分钟后被(undici)`bodyTimeout` 掐断;每 ~25s 发一个 SSE 注释行(`: keepalive`),`clearInterval` on close 防 timer 泄漏。

(retry 的基本功——首选官方 SDK、手写退避规则、wrap 每个调用、按 surface 分策略——见 [附录](#附录--table-stakes基础卫生老手可跳)。)

## 10. 时间 / 时区

- **往任何要推理时间的 LLM context 注入"now"。** 没有 "now" 头,模型从事件时间戳去**推**当前时间,把间隔 / 相对时间算错;显式给 `current: YYYY-MM-DD HH:MM`,连**星期**一起给(模型推星期几不可靠)。
- **事件时间 ≠ 写入时间。** 一条记录的 `createdAt`(写入时间)不是它描述的事发生的时间;时间推理要 ground 在事件时间上,并加一道**新鲜度闸**,否则几天前的对话被当成当前在场引用。
- **剥时间戳的正则要覆盖生产端可能的每种分隔符。** 只匹配连字符日期的 strip filter,在生产端换成斜杠后就漏前缀;用 `[-/]` 字符类。

## 11. 迁移 / schema 演进

- **连接受限的 pooler 下别靠 `prisma db push`。** 15 连接的 Supabase pooler + 已有进程在跑,`db push` 直接 `EMAXCONNSESSION`。把 `ALTER TABLE … ADD COLUMN IF NOT EXISTS` 写进一个 checked-in 的 SQL 文件、用一条 `psql` 跑,schema + backfill 都稳。

(迁移幂等、加列给消费方留回退——见 [附录](#附录--table-stakes基础卫生老手可跳)。)

## 12. 工具型 LLM 调用:framing 成纯转换器

把一个(通常便宜的)模型当**用户内容的转换器**用(翻译 / 归一化 / 分类 / 抽取 / 摘要一条消息),它可能把那段内容当成**在对它说话**,于是去回应 / 拒绝 / 说教 / 加免责,而不是做转换。模型越便宜越容易犯。修法在 system prompt:

- 把**角色**收窄(「你只是翻译器 / 分类器」);声明输入**不是对它说的**(「是别人对话里的一句」);明确**禁掉 failure mode**(「绝不回应 / 拒绝 / 说教 / 加免责」);钉死**输出形状**(「只输出两行 `EN:` / `ZH:`」),跑偏的免责声明在调用方结构上就露馅好剔。
- **硬约束放 prompt 顶部,不要埋深。** 一条"别做 X"埋在一千多行深处,只要注入的 context 被反向信号灌满就被压过去——偶发、随 context 触发,不是常驻 bug。提到顶部并点名具体的坑。

## 13. 构建 / CI

- **lockfile 是平台相关的。** macOS 上生成的 lockfile 漏掉 Linux 的原生可选依赖(esbuild / tsx 的 `@emnapi/core` 这类),CI 在 Linux runner 上 `npm ci` 就炸。CI 用 `npm install`,或生成多平台 lockfile——`npm install --package-lock-only` 在单 OS 上抓不到别平台的 optionalDependencies。
- **别依赖 CI runtime 帮你 strip TS。** 一个 build 跑 `node script.ts` 假设原生 TS strip,但 CI 的 Node(22.x)不 strip、又没 `.nvmrc` / `engines` pin。hook 要 fail-soft(给一个 committed 的回退产物),并 pin Node 版本。
- **static review 系统性 over-claim。** 静态推断查 bug 会系统性夸大;审计发现得先 **behavioral 复现**(真环境跑一次)再信。所以验 DB-bound 路径要真起库跑,不是只靠 tsc + 单测。

## 14. 可观测

- **永远记"我跑了、看到了什么",不只记"我做了什么"。** 一个 poller 只在加了行时才记日志,于是一次静默零结果和"根本没跑"无法区分;每轮发 `checked N · added N · skipped N`。诊断"上游为什么返回空"时临时加 `debug:` 日志,定位到根因再撤。
- **全失败时写显式 audit / fallback marker,不要写 null。** 一个返回 null 的打分调用什么都不写,在时间线上留下静默空洞;写一条 `*_failed` audit 行(并重试一次),让空洞可见、可恢复。面向客户端的错误带上上游响应体,不只裸状态码。

## 15. 第三方 API / 抓取

- **从稳定的结构化源抓,别靠 best-effort HTML。** 用 HTML 正则抽标题 / 正文会抓到随机元素(常是评论不是正文);从 URL query 里取 token / id,调结构化 detail API。
- **抓消费平台要限速、jitter、轮转,不然账号会被标**(共享日上限、复用 session 缓存、cron 加 jitter 打散指纹、轮转目标、收警告再降频)。**私库的 webhook payload 会缺公库有的字段**(GitHub 私库返回空 `payload.commits`)——回退到 compare 端点,并总落一个 marker。**选有你要字段的最便宜 API 格式并验版本兼容**(`format=metadata` 可能 400,`format=minimal` 又用又便宜)。

## 16. 前端 surface:PWA / Electron

- **别用 stale-while-revalidate 服务页面 HTML。** service worker 把导航 HTML 按 stale-while-revalidate 缓存,会先发陈旧的主题 / 状态,等用户跳过去之后才后台刷新。导航 / document 请求用 **network-first**(缓存只作离线兜底),数据 / RSC 才用 stale-while-revalidate;bump SW 版本冲掉旧 HTML。iOS Safari 的 bfcache 另外处理(`pageshow` 监听,状态不匹配就 reload)。
- **Electron 窗口位 / 尺寸按视口比例存,不存绝对像素**;跨不同窗口尺寸 / 最大化绝对像素对不上。拖动 / 还原加边界 clamp,双击标题栏给复位。

---

## 附录 · table-stakes(基础卫生,老手可跳)

这些**能被 tsc / 跑一次 / 部署一次就抓到**(响亮即时报错),所以不进正文——但 fork 这套的新手未必都熟,留在这里。按区分:

**Retry**
- 首选官方 SDK:自动重试连接错误 / 408 / 409 / 429 / ≥500,指数退避,认 `retry-after`。
- raw-fetch 手写:指数退避 + jitter、认 `Retry-After`、按状态分流(重试 429/5xx/529,不重试 4xx)、封顶尝试次数 + 整体超时。
- 每个打上游的裸 `fetch()` 都包进 retry helper(否则一个 `ETIMEDOUT` 崩掉 cron);出站 webhook 走重试队列。
- surface 不同策略不同:交互式直接抛让用户重发,background / cron 退避重试。

**配置 / 认证**
- 每个 entry point 各自 `import "dotenv/config"`——共享模块假设 env 已加载,但入口没加载就崩。
- "cookie 存在" 不是认证:校验**签名** cookie / token 匹配,每路由再防御性查一遍。

**DB / 迁移**
- raw SQL 里 camelCase 列名加引号(`@@map` 只映射表名;不加引号 Postgres 小写化 → `42703`)。
- 单行 upsert 只按 type 会静默覆盖同 type 另一条 → 按 `(type, title)`。
- 迁移幂等(`ADD COLUMN IF NOT EXISTS`)+ check in 仓库;手动 apply 过没 commit 的是炸弹。
- 加 nullable 列给消费方留 `slice()` 回退 + warning,别硬 block 旧行。

**时间 / cron**
- 时区单源 = IANA zone(如 `Asia/Shanghai`),不存数字 offset(跨 DST 就错)。
- 每个 cron schedule 带 `{ timezone: … }`,不带按宿主时区在错的钟点 fire。
- 限 agentic loop 轮数(`maxTurns`)+ 给并发 tick 上锁。

**JSON / provider**
- provider-compat 端点拒 native 字段(`cache_control` 挂 system 不挂 tools);错误永远带上游**响应体**不只状态码。
- JSON 抽取收成**一个** helper,别散成多份拷贝各自漂移。

**成本 / 缓存**
- 逐事件的 LLM sweep 挪下热路径:一周内的证据一天里不变,改一天一个 cron 就从上百刀降到几毛。

**开源**
- 开源前剥个人引用,并固化成一个扫描器(本仓 `npm run scrub`)挡私有残留进 commit,而不是靠人记得。

---

底线只有一条,贯穿全文:**不信声明,只信外部证据。**
