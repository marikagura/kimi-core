> English: ./SELF-AUDIT.en.md

# 自审 harness

这个仓库本身就携带了构建它所用的*方法*：一套对抗式、multi-agent 的安全 + 去标识化（de-identification）审计，你可以在部署或公开之前，针对自己的 fork 跑一遍。它是一组被指令做对抗式审计的 agent，**每一项发现在计入之前都要经过行为层面的验证。**

## 为什么要行为验证，而非静态推断

静态推断系统性地既*过度声张*又*漏报*。在本仓库自己的审计过程中，静态扫描产生了误报（一个“默认凭证”实际上是运行时经由 dotenv 加载的；一个 RLS 缺口其实早已封堵），同时漏掉了只有对运行中的产物执行 `grep` 才能抓到的残留。规则是：**任何发现在针对活物——一个请求、一次查询、一个文件——复现出来之前，都不算真。**反驳（refutation）这一步才是整件事的要点；它能干掉那些单次扫描会直接交付的“看似成立但实则错误”的发现。

## 已经接好的两层

- `npm run scrub` —— 机械式去标识化闸门。形状层（shape-layer）的正则放在仓库里（`scripts/scrub-scan.sh`）；你真正的私密词放在被 gitignore 的 `.scrub-secrets.local` 里，因此扫描器本身永远不会成为泄露源。它在 CI 中运行，也作为 pre-push hook 运行（`git config core.hooksPath scripts/hooks`）。**范围：scrub 只扫已 tracked 文件的内容**——git history 和 commit metadata（作者名 / 邮箱）不在它的范围内，由下面那套 agent 审计覆盖（本仓 commit 作者用的是化名身份，刻意为之）。
- 本文档 —— 扫描器无法替代的人/agent 层：被改写过的或语义层面的残留，以及真正的漏洞。

## 运行审计（任意 multi-agent runner）

把一组 agent（例如 Claude Code）指向你的 fork，用类似下面的 prompt：

> 以对抗者的身份审计这个仓库。并行地，每个面（surface）一个 agent：
> (1) 凭证与 secrets —— working tree **以及** git history；
> (2) 每一条 HTTP / MCP 路由和工具上的鉴权；
> (3) DB 暴露 —— RLS、anon 访问、连接字符串、TLS；
> (4) injection / SSRF / 不安全的反序列化（unsafe deserialization）；
> (5) 实际处于请求路径上的依赖 CVE；
> (6) 去标识化残留 —— 名字、私密词、语义泄露。
> 对每一个 high/critical 级别的发现，派生一个独立的怀疑者（skeptic），它通过针对活的 service / DB / file 复现该发现来尝试**反驳**它。任何无法复现的都丢弃。只报告已确认的发现，外加每一项是如何被验证的。

然后修复、重新部署、再跑一遍。把“0 项确认”当成你挣来的结果，而不是你假定的结果。
