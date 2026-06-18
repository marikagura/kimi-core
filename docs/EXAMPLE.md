> English: ./EXAMPLE.en.md

# 一份样例：它实际跑出来什么

不想装就想看见它活着？这里是真实的、可重跑的产物。示例数据全是虚构的（Helios 项目、Jordan、猫 Mochi），不是任何真人。

## 1. retrieval eval（真实输出）

`npm run eval` 拿 `apps/gateway/src/eval/retrieval_cases.example.json`（一份虚构标注集）跑同一个 `scoreMemories`——memory_search 用的同一个打分器。下面是一次**真实运行**，故意**没配 embedding key**（`OPENAI_API_KEY`），所以只有 keyword / trigram 这条臂在工作：

```
## by kind
  abstract_core    n= 2  hit@10=  0%  MRR=0.000  nDCG@10=0.000
  english_keyword  n= 2  hit@10=100%  MRR=1.000  nDCG@10=1.000
  fuzzy_semantic   n= 2  hit@10=  0%  MRR=0.000  nDCG@10=0.000
  literal_cjk      n= 2  hit@10=100%  MRR=1.000  nDCG@10=1.000
  negative         n= 2  hit@10=100%  MRR=0.000  nDCG@10=0.000   ← expectNone：返回空即通过
  semantic_bridge  n= 2  hit@10=  0%  MRR=0.000  nDCG@10=0.000
  temporal         n= 2  hit@10=100%  MRR=1.000  nDCG@10=1.000
## overall    n=23  hit@10=48%  MRR=0.391  nDCG@10=0.429
## coverage   n=2   set-recall@10=17%
```

**这张表本身就在示范 eval 是干嘛的**：literal / 关键词 / 时间类全中（trigram 臂够用），但 `abstract_core`、`fuzzy_semantic`、`semantic_bridge` 全 0——因为这些是**纯语义**的 case，没有 embedding 抓不到。把 `OPENAI_API_KEY` 配上再跑，这几类会回来。`negative`（expectNone）始终通过：无关 query 返回空。

换句话说：数字会**显示哪条臂没接上**——这些数字可以自己重跑得到。`npm run eval:history` 把每次的趋势读回来。

## 2. reentry —— 一次 wake 看到的上下文（虚构示例）

每次 wake，引擎先组一段 reentry 上下文喂给模型。结构大概长这样（示例数据虚构）：

```
[profile]  Riley。pour-over 咖啡不加糖。在赶一个叫 Helios 的项目。
[drive]    陪伴 0.58 · grounding 0.70 · 距上次 6 天   ← 最高维度 = 这次的方向
[concern]  Helios 周五 deadline（OPEN · 距今 2 天 · 有数据撑）
[recent]   昨天：Helios demo 卡在 auth 回调；周末去 bouldering；Mochi 又踩键盘
```

最高的 drive 维度（这里是「陪伴」）+ 还开着的 concern，决定了模型这次往哪个方向够。

## 3. diary —— 一次 wake 写下的（虚构示例）

wake 之后，模型给下一个自己留一条 diary（也是检索得到的记忆）。示例：

```
diary 2026-06-18 09:00
六天没说话了，陪伴维度涨上来。查了下，Helios 周五就到，昨天那版卡在 auth 回调。
不发泛泛的「最近好吗」——那是填空。要提就提具体的：demo 卡哪了。
valence 0.3 · arousal 0.5 · 动作：EXPLORE（提一句 Helios），propose 模式 → 等点头再发。
```

注意「不发泛泛的问候——那是填空」：这是 AGENTS.md 认识论层那四条 self-check 在起作用，concern 必须有数据撑。这就是 README 顶上那个例子背后实际发生的事。
