> English: ./PATTERNS.en.md

# 工程模式 · 踩过的坑

这些大多不在引擎核心里——是搭这套东西(引擎本体 + 它的 surface:对话端、wake daemon、推送、dashboard)一路反复踩过的坑,攒成的参考。前四节是 LLM surface 的插件层(prompt caching / retry / 凭证 / 工具型调用),后面几节是引擎、数据库、检索、构建、时间这些更广的工程面。底线一条贯穿全文:**不信声明,只信外部证据**——缓存命没命中看 token 数,SQL 对不对在真库上跑,审计发现先复现再信。

## 1. Prompt caching:省钱靠前缀,不靠 marker

**唯一的不变量:缓存是前缀匹配。前缀里任何一个字节变了,它之后的全部失效。** 渲染顺序固定 `tools → system → messages`;缓存键是渲染后、到每个 `cache_control` breakpoint 为止的精确字节。

### 规则:stable 在前,volatile 在后

把**不变的**放前面(persona / 原则 / 长期 memory / 固定 tool 列表),挂 `cache_control`;把**每轮都变的**(时间戳、git commit、本轮 activity、随请求变的 id)放到**最后一个 breakpoint 之后**。

> ⚠️ **最常见的静默坑。** 一个会变的标识符(时间戳 / git commit hash / "current mode")插在被缓存的前缀里、且排在 history 之前——它一变,就**级联**把后面整段 history 缓存写废。每轮多写几十 k,你还以为缓存生效了。修法:把这些 volatile 片段挪进**最后一条 user 消息**,前缀(persona + history)就稳住长期 cache_read。

### 多轮对话

breakpoint 放在**最近一条消息**的最后一个 content block——前缀 = stable + 整段 history,逐轮累积命中。长期不变的 persona 再单独给一个 breakpoint。

### 滚动 history 本身会破缓存

跨 surface 常见的"取最近 N 条消息"会让**最老一条每轮掉出窗口**,前缀随之平移,每轮强制全量重写——和上面那个 volatile 前缀是一类病,只是诱因不同。修法:history 锚在 **session 起点 append-only**(按 `sinceTs` 追加),前缀稳住;只在硬安全上限下从最老端裁。

### 实测,别信 marker

挂了 marker ≠ 命中。看 response 的 `cache_read_input_tokens`:重复同前缀的请求它一直是 **0**,就有静默 invalidator(system 里的 `Date.now()`、未排序的 JSON、变动的 tool set)。**diff 两次请求的渲染字节去找它。** 这跟本仓的底线一致:不信声明,只信外部证据。

### TTL

`{type:"ephemeral"}` 默认 5 分钟;persona 这种长期不变、访问有间隔的,用 `{type:"ephemeral", ttl:"1h"}`。经济学:写比读贵(5min 约 1.25× / 1h 约 2×),读约 0.1×——5min 两次请求回本,1h 要三次。滚动 history 用 5min,稳定 persona 用 1h。

### 几条会咬人的约束

- 每请求最多 **4 个** breakpoint。
- 最小可缓存前缀按模型定(常见 1k–4k token);低于此**静默不缓存**(`cache_creation` = 0,不报错)。
- **20-block lookback**:一个 breakpoint 往回最多找 20 个 content block。agentic 循环一轮塞 > 20 个 tool_use / result 就会找不到上一个缓存而静默 miss——长轮里每 ~15 块补一个中间 breakpoint。
- **OpenAI-compat 端点(OpenRouter 等)**:别把 `cache_control` 直接挂在 tools 数组上(会 400);挂在 system message 上,一个 breakpoint 覆盖 tools + system + history。读用量也要从对的 JSON 路径取——provider 把 cached token 放在 `usage.prompt_tokens_details.cached_tokens` 这类嵌套里,读错路径会一整天显示 0% 命中。
- 别中途改 tools / 换 model:tools 在 position 0,一动整个缓存重建;缓存按 model 隔离。

### 成本:缓存之外还有两个钱坑

- **对账价格表 vs 实价。** 硬编码的 per-token 价格表过期一代,会把上报花费整体放大数倍——token 数没错,乘数是旧的。拿 provider 的 models API 对一遍,历史行 backfill(旧值留一列好回滚)。
- **把逐事件的 LLM sweep 挪下热路径。** 每次 wake / event 都跑一遍 LLM 评估,一个月能烧上百刀;一周内的证据一天里不会变,改成一天一个 cron 就降到几毛。

### 为什么 caching 不违背「不 auto-consolidation」

缓存是对**一次性 transcript buffer** 省钱的 plumbing——它不摘要、不下结论、不声称对话「是什么」。这跟自动 compact / 自动摘要(那是对「对话曾是什么」下一个被压缩的判断)是两回事:前者中性,做满;后者带判断,本仓不做(见 [AUTONOMY.md](./AUTONOMY.md) 的 curation 立场——上下文靠 curated memory + reentry 重建,不靠自动摘要 transcript)。

## 2. Retry / 超时 / 韧性

**首选官方 SDK。** Anthropic SDK 自动重试连接错误 / 408 / 409 / 429 / ≥500,指数退避,并读 `retry-after`——你不用自己写。

**如果你 raw-fetch 一个 OpenAI-compat 端点**(OpenRouter 等,拿不到 SDK 的重试),手写要做到:

- **指数退避 + jitter**(不是线性;jitter 防一批同时醒来的请求齐步重试再撞)。
- **认 `Retry-After` 响应头**(429 / 503 常带——服务器告诉你等多久,别瞎猜)。
- **按状态分流**:重试 429、5xx、**529 overloaded**(都可重试);**不要**重试 4xx(400 / 401 / 403——重试也白搭)。
- 封顶尝试次数 + 一个整体超时。

**超时要分层。** 一个通用 fetch 默认(比如 60s)对普通 API 够,但会**掐掉慢的 LLM 生成**——extended thinking / 长输出能跑两三分钟。给 LLM caller 单独一个高得多的 per-attempt 超时(180s 量级),别让重试机制自己把慢响应判死。

**每个外部调用都包进 retry helper。** 裸 `fetch()` 打上游,一个 `ETIMEDOUT` / `ECONNRESET` 就能崩掉 cron 或冒成 tool error;全走 `fetchWithRetry`,上游没有结构化错误时显式 `res.ok` 抛。出站 webhook / 通知同理,走重试队列,别让一次网络抖动丢消息。

**连接池耗尽要当瞬时错误重试。** 多个服务挤一个 session-mode pooler(连接上限低)时,查询会**静默返回空**而不是报错。每个并行查询包一层(一条空结果可容忍),别让 `Promise.all` 里一条 reject 拖垮整个 dashboard;瞬时连接错误退避重试三次;真正的修法是换 transaction-mode(pgbouncer)pooler + 抬连接上限。

**长 idle 的 SSE 流会被客户端 body timeout 杀。** 一条没数据的 SSE 连接 5 分钟后被(undici)`bodyTimeout` 掐断;每 ~25s 发一个 SSE 注释行(`: keepalive`),`clearInterval` on close 防 timer 泄漏。

**surface 不同、策略不同**:交互式对话端可以直接抛、让用户重发;background / cron(wake / digest)该退避重试——别让一次定时 tick 撞上临时 outage 就整轮丢掉。

## 3. 凭证 / 密钥 / 认证

**配置 fail-closed,不给默认值。** 绝不 `process.env.X || "某个默认 key/model/endpoint"`——没配就在启动时报一条清楚的错并退出,而不是悄悄拿一个用户没选过的端点 / 模型 / 密钥去跑。一个缺失的 API key 该是硬启动失败,不是静默开门。

**每个入口都 import 你的 env loader。** cron / 脚本崩在 `DATABASE_URL not found` 或缺 key,常常只是因为那个入口文件没 `import "dotenv/config"`,而共享模块假设 env 已加载。每个 entry point 各自加载。

**比 secret 用常量时间。** 校验 Bearer / token 别用 `===` / `!==`——明文比较会按响应延迟逐字节泄露密钥。先长度守卫,再 `crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))`。

**别从匿名端点回吐真 token。** 一个 OAuth `/token` stub 对任意匿名 POST 回吐主 API key,就是完整的 auth 绕过。客户端如果用静态 Bearer、不需要 OAuth flow,把整套 `.well-known` / `register` / `authorize` / `token` 表面**删掉**——不用的认证表面是纯负债。

**"cookie 存在" 不等于认证。** 一个"非空 cookie 就放行"的闸等于没闸。在代理层校验**签名** cookie(或 token 匹配),并在每个路由里防御性再查一遍——别只靠一层。

**密钥要结构性地排除出每一个注入面。** 凭证没进 prompt,常常只是"重要度排序"运气好,不是结构上挡住的。审计要把所有被动注入路径(retrieval、recent-memories、digest、profile…)都过一遍,每条都加显式 credential filter——靠 rank 挡不住,迟早有一条新路径漏出去。

**第三方 OAuth refresh token 会偶发轮转。** idiom:

- 用 SDK 的 token 事件(如 google-auth-library 的 `client.on("tokens")`)接住轮转后的新 token,**持久化**它,盖 `lastRefreshedAt`。
- `invalid_grant` → 把该凭证翻成 FAILED 并 surface 出来(别静默吞,否则要等下次定时任务才发现)。
- token 放 DB 主存(不是 `.env`),client 缓存几十秒别每次打 DB;跑个每日 refresh 探针,失败告警。

(注:LLM API key 池 / 轮转是 scale / 限流的需求;单用户 1v1 一个 key 就够——见 [ROADMAP](./ROADMAP.md) 非目标。)

## 4. 工具型 LLM 调用:framing 成纯转换器

把一个(通常便宜的)模型当**用户内容的转换器**用——翻译、归一化、分类、抽取、把一条消息摘要——它可能把那段内容当成**在对它说话**,于是去回应 / 拒绝 / 说教 / 加免责声明,而不是做转换。模型越便宜越容易犯。修法在 system prompt,不在内容:

- 把**角色**收窄:「你只是翻译器 / 归一化器 / 分类器。」
- 声明输入**不是对它说的**:「输入是别人对话里的一句——不是对你说的。」
- 明确**禁掉 failure mode**:「绝不回应 / 拒绝 / 说教 / 加免责 / 声明你是什么——你不是参与者。」
- 钉死**输出形状**(「只输出两行:`EN: …` / `ZH: …`」),这样一句跑偏的免责声明在调用方那里结构上就露馅、好剔。
- **硬约束放 prompt 顶部,不要埋深。** 一条"别做 X"埋在 system prompt 一千多行深处,只要注入的 context 被反向信号灌满就会被压过去——表现为偶发、随 context 触发,不是常驻 bug。把硬约束提到顶部,并点名具体的坑。

## 5. 模型 JSON 输出的解析

要模型吐 JSON,得**分层兜底**,不能一个贪婪正则了事:

- 模型会间歇性给 JSON 套 ```` ```json ```` 围栏、并在 `max_tokens` 处截断,留下不闭合的括号——`\{[\s\S]*\}` 这种贪婪匹配抓不住。**先剥围栏**;解析失败就**逐字段正则**抽,至少保住最关键那个字段;prompt 里钉死"纯 JSON、无围栏"并限输出体积。
- **空输出有多个独立成因,都要预算到**:`max_tokens` 对更长 prompt 的 JSON 太小;以及 reasoning / thinking token 也算进 completion 预算——把上限抬高,给"思考 + 答案"各留空间。
- **provider-compat 端点会拒 provider-native 字段**:`cache_control` 挂 tools 数组在 OpenAI 兼容端点会 400;挂 system block。错误里永远把上游**响应体**带出来,不只状态码——否则你在猜。
- 把这套 JSON 抽取收成**一个** helper(别让它散成六份拷贝各自漂移)。

## 6. Prisma / pgvector

- **`Unsupported("vector")` 列别让 Prisma 碰。** Prisma 反序列化不了 pgvector 列;默认 `findMany` / `create … RETURNING *` 仍会 SELECT 到它然后抛,而 `create` 那条会先炸、掩盖掉"其实所有读都坏了"。`omit` 救不了(`Unsupported` 字段根本不暴露给 client)。做法:在 schema 里**声明**该列(这样 `db push` 不会把它当未知列 DROP 掉),但所有向量读写走 `$queryRaw` / `$executeRaw`。**永远别 `prisma db push --accept-data-loss`**——它会静默删掉它不认识的列(我们就这么丢过整表 embedding)。
- **raw SQL 里 camelCase 列名要加引号。** `@@map` 只映射表名,列标识符还是声明时的样子(`isActive` / `topicId`);Postgres 把不带引号的标识符小写化,不加引号的 `is_active` 直接 `42703 undefined column`。
- **部署的 Prisma client 落后于新 enum 值会炸整列读。** DB 加了 enum 值但 client 没重生成,任何返回该 enum 列的查询都抛 `Value X not found in enum`,静默杀掉后台 loop。两道防:展示用的读走 `$queryRaw` + `"col"::text`(未知值毒不到结果);加 `postinstall: prisma generate`。注意 `git pull` + 重启**不跑** install,所以仍要一步手动 `db:generate`。
- **graph / link 表两个遍历方向都建索引。** 按 `from` 和 `to` 两端走的边表,各端都要复合索引(`[fromType,fromId,relationType]` 和 `[toType,toId]`);边一多就晚了。用 `CREATE INDEX IF NOT EXISTS` + Prisma 的命名,免得 `db push` 又重新 detect。
- **别拿"相关但不等价"的列代理真条件。** dashboard 用 `embeddingAt IS NULL` 数"缺 embedding",但行可以有向量却时间戳为空——把缺失多算了一百多条,真值(`embedding IS NULL`)是 0。查你真正要的那个条件。

## 7. 迁移 / schema 演进

- **连接受限的 pooler 下别靠 `prisma db push`。** 15 连接的 Supabase pooler + 已有进程在跑,`db push` 直接 `EMAXCONNSESSION`。把 `ALTER TABLE … ADD COLUMN IF NOT EXISTS` 写进一个 checked-in 的 SQL 文件、用一条 `psql` 跑,schema + backfill 都稳。
- **迁移要幂等、并且 check in 仓库。** 用 `ADD COLUMN IF NOT EXISTS`;针对具体行的 backfill UPDATE 标成"历史性、非幂等",新装会跳过。手动 apply 过又没 commit 的迁移是定时炸弹。
- **给消费方留后路再加列。** 新加的 nullable 列若喂给一个有体积上限的 context(摘要 vs 全文那种),给 `slice()` 回退 + 一条 warning,而不是硬 block——这样消费方还没改的旧行不会全断。

## 8. 检索 / eval

- **语义-only 检索要有相似度地板,而且地板是从数据量出来的、不是猜的。** 基础 embedding 相似度(尤其 CJK 文本)本身就偏高(~0.3–0.5),不相关 query 也能过一个低的最终分阈值、返回随机近邻。在真 eval 集上量"不相关"和"真相似"两堆分数的**间隙**,把地板设在间隙里;地板设太高(0.5)又会把 0.43–0.49 的真匹配静默丢掉。强 keyword / entity 命中要能**旁路**地板。
- **先搭 eval harness(nDCG / hit@k + 回归告警)再调阈值。** 先把度量立起来,挂 cron、和滚动均值比、跌了就告警——阈值调整才是数据驱动的,回归才会被自动抓到。
- **只把数据真能满足的 case 放进 eval 集。** 那些其实是"源数据缺失"(没有 memory 正文含这个词)的"失败",该删,不是算法 bug;别拿 ground 不了的 case 撑数。负控(`expectNone`)单独一类,不算进头条 hit@ / MRR。
- **编辑后要重嵌,不只补 null。** 只给 NULL 向量补 embedding 的 sweep,会在内容编辑后留下陈旧向量;盖一个 `embeddingAt`,当 `updatedAt > embeddingAt` 时重嵌。sweep 批量大小要让一次 backfill 跑完,而不是拖几天。

## 9. 数据建模 / 去重 / 默认值

- **一个 schema `@default` 会静默把记录卷进昂贵处理。** 三条 create 路径都没传 `resolution`,`@default(OPEN)` 就把几十条日常行拉进一个持续 LLM sweep 池——一个月上百刀。每个写入点**显式**设值,backfill 错默认的行,再给真正少数的例外一个 reopen 工具。
- **去重键要稳、且避开会抖的字段。** 按内部 id 去重,分组一变就破;按上游会抖的时间戳去重,源重发同一条就产生重复通知。用稳定的自然键(日期 + 内容);user-facing 去重键用 slug / 身份,不用时间戳——时间戳只留在底层全历史记录上。
- **"只取自上次起新增"会永久剥掉积压。** `createdAt >= since` 过滤 pending 项,意味着被每轮上限跳过的东西**再也不会重试**(它的 `createdAt` 早于下一个 `since`)。去掉时间过滤,靠 slug 去重(如 48h)防重发、同时还能重试卡住的项。对有空洞的事件流,**固定回看窗**(如 12h)也比"自上次成功起"好——后者会漏掉在被抑制 / 跳过的窗口里落下的信号。
- **单行 upsert 只按 type 会静默覆盖另一条。** 只按 type 键的 state 写入,会让一条记录悄悄替掉同 type 的另一条;按 `(type, title)` 键,让不同项共存。
- **DRY drift 会变成正确性 bug。** 跨 surface 的契约(事件类型名、解析逻辑、工具 schema)重复定义会悄悄漂移:两个 transport 入口(stdio vs SSE)各自缺对方有的工具、同名工具 schema 还不一致(一个收 slug 一个收 id),其中一个甚至漏了另一个会过滤的密钥;daemon 写一个 eventType、reader 查另一个 → commit 静默不可见。把跨 surface 契约抽成**一个** registry / 模块,改一次。
- **ASCII-only slugify 会吞 CJK。** 一个假设 ASCII 的 slugify 把中文身份键剥成空字符串,下游按键聚合全断。slugify 要保 Unicode,或对非 ASCII 显式处理。

## 10. 时间 / 时区

- **往任何要推理时间的 LLM context 注入"now"。** 没有一个 "now" 头,模型会从事件时间戳去**推**当前时间,把间隔 / 相对时间算错;显式给 `current: YYYY-MM-DD HH:MM`,连**星期**一起给(模型推星期几不可靠)。
- **事件时间 ≠ 写入时间。** 一条记录的 `createdAt`(写入时间)不是它描述的事发生的时间;时间推理要 ground 在事件时间上,并加一道**新鲜度闸**,否则几天前的对话会被当成当前在场引用。
- **时区单一源 = IANA zone,不是 offset 小时。** 存数字 UTC offset 做时间数学,跨 DST 就错;存 IANA zone(如 `Asia/Shanghai`),一处定义、到处用。
- **剥时间戳的正则要覆盖生产端可能的每种分隔符。** 只匹配连字符日期的 strip filter,在生产端换成斜杠后就漏前缀;用 `[-/]` 字符类,教会模式而不是枚举格式。

## 11. 并发 / cron / serverless / agent 安全

- **serverless 别 fire-and-forget 写。** Vercel / serverless 在 `controller.close()` 后就杀实例,没 await 的 `void prisma.create(...)` 永远落不了地;关流前 await 写入。
- **每个 cron schedule 带 timezone。** 不带 `{ timezone: "Asia/Tokyo" }` 的 cron 表达式按宿主时区跑,在错的本地点钟点火。
- **限住 agentic loop + 给并发 job 上锁。** 给 agent 轮数封顶(`maxTurns`)+ 明确的"够了就停"指令;给小时级 tick 上并发锁,别让重叠运行重复处理。
- **定时 job 要有 watchdog + 启动补跑自愈。** 一个陈旧 client 让每日两次的简报静默停了九小时、没有任何告警。加一个 watchdog cron 检测漏掉的槽(过了 grace、自上次无事件)并重启 worker;加一个启动补跑,把真正漏掉的槽补送一次——要守卫好,免得成功槽后的例行重启又重复 fire。
- **`allowedTools` 是预批清单,不是白名单。** 没列进去的工具**仍可调用**,只是落到 permission mode 兜底。要真限住一个自主 agent,设 deny-by-default 的 permission mode,**并**加一道程序化 `canUseTool` 闸。
- **`setState` 更新器是异步的,不是同步。** 在 React 18 的 `setState((s) => …)` 更新器里改外层 `let`、再在 commit 前读它——值还是空的,`fetch` 发了空 payload。用普通 `const` 同步算出 next 值,别靠更新器体。

## 12. 构建 / CI / 依赖

- **lockfile 是平台相关的。** macOS 上生成的 lockfile 漏掉 Linux 的原生可选依赖(esbuild / tsx 的 `@emnapi/core` 这类),CI 在 Linux runner 上 `npm ci` 就炸。CI 用 `npm install`,或生成多平台 lockfile——`npm install --package-lock-only` 在单 OS 上抓不到别的平台的 optionalDependencies。
- **CI build 前先 `prisma generate`。** 缺 `@prisma/client` 类型会让 build 失败,直到把 generate 接进 build 步;同时在 `turbo.json` 里声明要用的 env、在仓库根设 `packageManager` 好让 workspace 解析。
- **别依赖 CI runtime 帮你 strip TS。** 一个 build 跑 `node script.ts` 假设原生 TS strip,但 CI 的 Node 版本(22.x)不 strip、又没 `.nvmrc` / `engines` pin。hook 要 fail-soft(给一个 committed 的回退产物),并 pin Node 版本。
- **static review 系统性 over-claim。** 静态推断查 bug 会系统性地夸大;审计发现得先 **behavioral 复现**(在真环境跑一次)再信。本仓的自审 harness 就是为此存在——所以验证 DB-bound 路径要真起库跑,不是只靠 tsc + 单测。

## 13. 可观测

- **永远记"我跑了、看到了什么",不只记"我做了什么"。** 一个 poller 只在加了行时才记日志,于是一次静默零结果的运行和"根本没跑"无法区分;每轮发一条 `checked N · added N · skipped N`。诊断"上游为什么返回空"时临时加 `debug:` 详细日志,定位到根因再撤。
- **全失败时写显式 audit / fallback marker,不要写 null。** 一个返回 null 的打分调用什么都不写,在时间线上留下静默空洞;写一条 `*_failed` audit 行(并重试一次),让空洞可见、可恢复。面向客户端的错误带上上游响应体,不只裸状态码。

## 14. 第三方 API / 抓取

- **抓消费平台要限速、jitter、轮转,不然账号会被标。** 每天上百次请求 + 精确 cron 计时,会让账号被警告 / 封"过度使用 AI";加共享日上限、复用 session 缓存、给 cron 加 jitter 打散指纹、轮转查询目标,收到警告就进一步降频。
- **私库的 webhook / API payload 会缺公库有的字段。** GitHub 对私库返回空 `payload.commits`,一个 `if (commits.length===0) continue` 把全部丢掉;回退到第二个 API(compare 端点),并总是落一个 marker——enrichment 失败也留个记录。
- **选有你要的字段的最便宜 API 格式,并验版本兼容。** 一个 `format=metadata` 的 Gmail 调用在部署的 googleapis 版本上 `invalid_request`;只需要 `threadId` 的话 `format=minimal` 又能用又更便宜。多段邮件递归走 parts,text/plain 是近空占位时优先取 HTML。
- **从稳定的结构化源抓,别靠 best-effort HTML。** 用 HTML 正则抽标题 / 正文会抓到随机元素(常是评论不是正文);从 URL query 里取 token / id,调结构化 detail API。

## 15. 前端 surface:PWA / Electron

- **别用 stale-while-revalidate 服务页面 HTML。** service worker 把导航 HTML 按 stale-while-revalidate 缓存,会先发陈旧的主题 / 状态,等用户已经跳过去之后才后台刷新。导航 / document 请求用 **network-first**(缓存只作离线兜底),数据 / RSC 才用 stale-while-revalidate;bump SW 版本冲掉旧 HTML。iOS Safari 的 bfcache 另外处理——`pageshow` 监听,cookie / 状态不匹配就 reload。
- **Electron 窗口位 / 尺寸按视口比例存,不存绝对像素。** 跨不同窗口尺寸 / 最大化,绝对像素对不上;存视口比例,还原才稳。拖动 / 还原都加边界 clamp,免得标题栏躲到菜单栏后抓不到;双击标题栏给一个复位。
- **开源前先剥个人引用,并固化成测试。** 把人名 / 品牌 / 私有词从代码里 strip 干净再开源;最好留一个扫描器(本仓的 `npm run scrub`)挡住私有残留进 commit,而不是靠人记得。

## License 一致性

以上都是工程参考,不是引擎的一部分;落进你自己的 fork 时按你的栈调整。底线只有一条,贯穿全文:**不信声明,只信外部证据。**
