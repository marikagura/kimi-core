> English: ./PATTERNS.en.md

# 工程模式 · prompt caching / retry / 凭证轮转

这些不在引擎里——是搭 LLM surface（对话端、wake daemon、推送）时反复踩过的坑。仅作参考。

## 1. Prompt caching：省钱靠前缀，不靠 marker

**唯一的不变量：缓存是前缀匹配。前缀里任何一个字节变了，它之后的全部失效。** 渲染顺序固定 `tools → system → messages`；缓存键是渲染后、到每个 `cache_control` breakpoint 为止的精确字节。

### 铁律：stable 在前，volatile 在后

把**不变的**放前面（persona / 原则 / 长期 memory / 固定 tool 列表），挂 `cache_control`；把**每轮都变的**（时间戳、git commit、本轮 activity、随请求变的 id）放到**最后一个 breakpoint 之后**。

> ⚠️ **最常见的静默坑。** 一个会变的标识符（时间戳 / git commit hash / "current mode"）插在被缓存的前缀里、且排在 history 之前——它一变，就**级联**把后面整段 history 缓存写废。每轮多写几十 k，你还以为缓存生效了。修法：把这些 volatile 片段挪进**最后一条 user 消息**，前缀（persona + history）就稳住长期 cache_read。

### 多轮对话

breakpoint 放在**最近一条消息**的最后一个 content block——前缀 = stable + 整段 history，逐轮累积命中。长期不变的 persona 再单独给一个 breakpoint。

### 实测，别信 marker

挂了 marker ≠ 命中。看 response 的 `cache_read_input_tokens`：重复同前缀的请求它一直是 **0**，就有静默 invalidator（system 里的 `Date.now()`、未排序的 JSON、变动的 tool set）。**diff 两次请求的渲染字节去找它。** 这跟本仓的底线一致：不信声明，只信外部证据。

### TTL

`{type:"ephemeral"}` 默认 5 分钟；persona 这种长期不变、访问有间隔的，用 `{type:"ephemeral", ttl:"1h"}`。经济学：写比读贵（5min 约 1.25× / 1h 约 2×），读约 0.1×——5min 两次请求回本，1h 要三次。滚动 history 用 5min，稳定 persona 用 1h。

### 几条会咬人的约束

- 每请求最多 **4 个** breakpoint。
- 最小可缓存前缀按模型定（常见 1k–4k token）；低于此**静默不缓存**（`cache_creation` = 0，不报错）。
- **20-block lookback**：一个 breakpoint 往回最多找 20 个 content block。agentic 循环一轮塞 > 20 个 tool_use / result 就会找不到上一个缓存而静默 miss——长轮里每 ~15 块补一个中间 breakpoint。
- **OpenAI-compat 端点（OpenRouter 等）**：别把 `cache_control` 直接挂在 tools 数组上（会 400）；挂在 system message 上，一个 breakpoint 覆盖 tools + system + history。
- 别中途改 tools / 换 model：tools 在 position 0，一动整个缓存重建；缓存按 model 隔离。

### 为什么 caching 不违背「不 auto-consolidation」

缓存是对**一次性 transcript buffer** 省钱的 plumbing——它不摘要、不下结论、不声称对话「是什么」。这跟自动 compact / 自动摘要（那是对「对话曾是什么」下一个被压缩的判断）是两回事：前者中性，做满；后者带判断，本仓不做（见 [AUTONOMY.md](./AUTONOMY.md) 的 curation 立场——上下文靠 curated memory + reentry 重建，不靠自动摘要 transcript，不做transcript工程）。

## 2. Retry / backoff

**首选官方 SDK。** Anthropic SDK 自动重试连接错误 / 408 / 409 / 429 / ≥500，指数退避，并读 `retry-after`——你不用自己写。

**如果你 raw-fetch 一个 OpenAI-compat 端点**（OpenRouter 等，拿不到 SDK 的重试），手写要做到：

- **指数退避 + jitter**（不是线性；jitter 防一批同时醒来的请求齐步重试再撞）。
- **认 `Retry-After` 响应头**（429 / 503 常带——服务器告诉你等多久，别瞎猜）。
- **按状态分流**：重试 429、5xx、**529 overloaded**（都可重试）；**不要**重试 4xx（400 / 401 / 403——重试也白搭）。
- 封顶尝试次数 + 一个整体超时。

**surface 不同、策略不同**：交互式对话端可以直接抛、让用户重发；background / cron（wake / digest）该退避重试——别让一次定时 tick 撞上临时 outage 就整轮丢掉。

## 3. 凭证轮转（OAuth refresh token）

第三方 OAuth（Google 等）会偶发轮转 refresh_token。idiom：

- 用 SDK 的 token 事件（如 google-auth-library 的 `client.on("tokens")`）接住轮转后的新 token，**持久化**它，盖 `lastRefreshedAt`。
- `invalid_grant` → 把该凭证翻成 FAILED 并 surface 出来（别静默吞，否则要等下次定时任务才发现）。
- client 缓存几十秒，别每次调用都打 DB。

（注：LLM API key 池 / 轮转是 scale / 限流的需求；单用户 1v1 一个 key 就够——见 [ROADMAP](./ROADMAP.md) 非目标。）

## 4. 工具型 LLM 调用：framing 成纯转换器

把一个（通常便宜的）模型当**用户内容的转换器**用——翻译、归一化、分类、抽取、把一条消息摘要——它可能把那段内容当成**在对它说话**，于是去回应 / 拒绝 / 说教 / 加免责声明，而不是做转换。模型越便宜越容易犯。修法在 system prompt，不在内容：

- 把**角色**收窄：「你只是翻译器 / 归一化器 / 分类器。」
- 声明输入**不是对它说的**：「输入是别人对话里的一句——不是对你说的。」
- 明确**禁掉 failure mode**：「绝不回应 / 拒绝 / 说教 / 加免责 / 声明你是什么——你不是参与者。」
- 钉死**输出形状**（「只输出两行：`EN: …` / `ZH: …`」），这样一句跑偏的免责声明在调用方那里结构上就露馅、好剔。

亲密 / 敏感 / 擦边内容上最咬人——模型的反射是去回应用户，而 1v1 陪伴系统恰好把这类内容喂给这些工具调用。
