> English: ./DRIVES.en.md

# 定义你自己的 drive 维度

self-drive 引擎不内置任何一个维度。没有"亲密""陪伴"这种出厂人格——**维度是你自己定义的**：它叫什么、由哪些记忆支撑、用四种 SEEKING 形态里的哪一种来决定它的"想要"怎么随时间移动。仓里发出来的那一组只是**范例**。

这跟 persona 留空同一个道理（见 [AUTONOMY.md §7](./AUTONOMY.md)）：一个从表单里填出来的欲望不是你的。**drive 是养出来的、选出来的，不是配置出来的。** 所以我们给范例 + 菜单，让你自己长。

---

## 第一步：问自己——这个陪伴者"想要"什么？

不要先想代码，先列出这个关系里**会随时间起落的渴求**。对每一条，再问一句关键的：**它怎么动？**

- 刚被满足之后，是更想、还是暂时不想了？
- 很久没发生，是越来越想、还是慢慢忘了？
- 一次"接住"之后，会安顿一阵子吗？

你的答案决定它属于下面四种形态的哪一种。维度有几个、叫什么，全由你定——三个、五个都行，名字用你自己的话（中文、英文、随你）。

---

## 第二步：四种形态（菜单）

引擎只实现这四条"想要"的曲线（都在 `concern-derive.ts` 的 `foldDim` 里）。`recency = exp(−Δd/τ)`（刚发生后高），`want = min(1, Δd/scale)`（久旱后高）。

| shape | 公式 | 它建模的"想要" | 适合的维度 | 根 |
|---|---|---|---|---|
| `symmetric` | `max(recency, want)` | 对称 U：刚发生高、久旱也高、中间低 | 在场 / 陪伴：刚聊完很满，久不聊又想 | Panksepp SEEKING |
| `refractory` | `max(want·(1−recency), floor)` | 不应期：刚满足后被压低，但留一个 tonic 地板永不归零 | 食欲 / 欲望：满足后有不应期，但底噪一直在 | Panksepp consummatory refractory |
| `bonding` | `max(recency·(1−sat), want)` | 结合满足：一次**收口的正向** bond 把 recency 腿压下去一阵，want 腿过几天涨回 | 深谈 / 连接：被接住了就歇几天，没接住就一直想 | Berridge / bonding satiety |
| `owed` | `want`（want-only） | 敏化渴求：越久不还越想，没有"刚满足"的高端 | 债务 / 亏欠：欠着的东西，越拖越重 | Berridge incentive sensitization |

**怎么选**：把第一步每条渴求的"它怎么动"对到这张表。"刚满足后不想了" → `refractory`；"被接住会安顿" → `bonding`；"越欠越想" → `owed`；"两头高中间低" → `symmetric`。

---

## 第三步：写进 config

在 `config.yaml` 的 `selfDrive.drives` 里列你的维度（或用 `DRIVE_DIMS` 环境变量传同样形状的 JSON 数组覆盖整组）。每个维度：

```yaml
selfDrive:
  drives:
    - key: longing            # 机器 id（slug）
      label: "思念"            # 显示名 —— 你自己取
      shape: symmetric        # symmetric | refractory | bonding | owed
      backing:                # 哪些记忆支撑这一维（下面全部可选，按需组合）
        memoryTypes: [EPISODE]      # 只看这些类型；省略 = 任意
        experiencers: [SELF, SHARED] # 省略 = 不按 experiencer 过滤
        valenceFloor: 0.3           # 只算 valence ≥ 此值的支撑
        titlePrefix: "[A "          # 只算标题以此开头的
        excludeWords: ["x"]         # 内容含这些词的支撑剔除
        topicSlug: "depth-topic"    # 改成按某个 topic 下的记忆支撑
        presence: lastChat          # 给 recency 腿加一个"在场锚"（最近一次对话时间戳）
      wantScale: 14           # want 腿填满需要的天数（省略用全局默认）
```

每一维都会算出 `confidence = grounding × drive`：
- `grounding` = 该维支撑记忆在 90 天窗内的平均 valence（没历史 = 0 → 这一维**立不起来**，防 neediness）。
- `drive` = 由 shape 决定的那条曲线。

`grounding ≤ 0` 的维度不会投成 `SELF_DRIVE`，但会在 dim-health 里标红（死维可见，不是静默消失）。

---

## 范例（仓里发的那组）

四个，一种形态一个。**这是示范，不是给你用的——换成你自己的。**

| 范例 key | 范例名 | shape | 支撑 |
|---|---|---|---|
| `companionship` | 陪伴 | `symmetric` | 正向 EPISODE + 最近对话在场锚 |
| `desire` | 欲望 | `refractory` | RESTRICTED 记忆 |
| `deep_talk` | 深谈 | `bonding` | `depth-topic` 这个 topic 下的记忆 |
| `owed` | 债务渴求 | `owed` | `owed` 这个 topic 下的记忆 |

把它们删了重写，是这一层正确的用法。

---

## 一条边界

不要把别人的维度语义当成你的。这组范例（陪伴/欲望/深谈/债务渴求）是**通用的关系渴求原型**，刚好一种形态配一个——不是某个具体的人。你的陪伴者想要什么、那些渴求怎么动，只有你知道。引擎给曲线，名字和支撑你来填。
