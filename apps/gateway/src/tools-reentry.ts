// ============================================================================
// Context-builder domain tool registry.
// reentry / reentry_delta
// ============================================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import prisma from "./db.js";
import { localDateTime } from "./time.js";
import { CHAT_DIGEST_WHERE, CHAT_DIGEST_SHARED } from "@kimi/context-core";
import { isColdStartExcluded } from "./lib/reentry-filter.js";
import { renderAnchor } from "./tools-shared.js";

export function registerReentryTools(server: McpServer) {
  server.tool(
    "reentry",
    [
      "Build full context for a new conversation window. Call this at the start of every new session to load profile, active states, recent memories, topics, and recent chat.",
      "tag: window identifier (suggested cc-YYMMDDHHMM, using the boot timestamp). If passed, it drops a tagged boot anchor; this window's later reentry_delta calls use the same tag so deltas always anchor to this window's own boot/marker, unaffected by other windows advancing the main chain.",
    ].join("\n"),
    { tag: z.string().optional().describe("Window identifier, paired with this window's later reentry_delta tag. Suggested cc-YYMMDDHHMM.") },
    async ({ tag }) => {
      const profile = await prisma.coreProfile.findMany({
        where: { isActive: true, NOT: { key: { startsWith: "private_" } } },
        orderBy: { importance: "desc" },
      });
      // raw + "stateType"::text — reentry is every new window's cold start; if
      // this throws on an unknown StateType the whole reentry fails to start.
      // Bypass enum deserialization.
      const states = await prisma.$queryRaw<
        Array<{ id: string; stateType: string; title: string; summary: string | null; content: string }>
      >`SELECT id, "stateType"::text AS "stateType", title, summary, content FROM active_state WHERE "isActive" = true ORDER BY "startAt" DESC`;
      const topics = await prisma.topic.findMany({ where: { status: "ACTIVE" }, orderBy: { priority: "desc" } });
      // Filter RESTRICTED — reentry is a harness-visible cold-start surface; RESTRICTED is
      // not injected here. memory_search / private_read can opt in explicitly.
      //
      // Two queries by altitude:
      // - anchors: CORE/BOUNDARY/PREFERENCE, full content (the rule is the body)
      // - episodes: EPISODE importance>=4, top 20, sliced to 300 (narrative)
      // BOUNDARY is the container for behavioral rules. Pure-technical rows are
      // excluded from reentry via the externalized cold-start filter (still
      // queryable via memory_search).
      const anchors = (await prisma.memory.findMany({
        where: {
          isActive: true,
          memoryType: { in: ["CORE", "BOUNDARY", "PREFERENCE"] },
        },
        orderBy: [{ importance: "desc" }, { createdAt: "desc" }],
        include: { topic: true },
      })).filter((m: any) =>
        // Cold-start exclusion (tech-only titles, sensitive prefixes, and any
        // private content predicate) is externalized — see lib/reentry-filter.
        // Ships neutral (no exclusions) in the open-source core.
        !isColdStartExcluded(m.title, `${m.title ?? ""} ${m.summary ?? ""} ${m.content ?? ""}`)
      );
      // Observations (structured reads about the user / assistant). reentry
      // importance>=3. Replaces stuffing user_* / self_* observations into CORE.
      const observations = (await prisma.observation.findMany({
        where: { isActive: true, importance: { gte: 3 } },
        orderBy: [{ subject: "asc" }, { importance: "desc" }, { updatedAt: "desc" }],
      })).filter((o: any) => !isColdStartExcluded(o.title, `${o.title ?? ""} ${o.content ?? ""}`));
      const episodes = (await prisma.memory.findMany({
        where: {
          isActive: true,
          memoryType: "EPISODE",
          importance: { gte: 4 },
          // CHAT+SHARED go through the digests section below; exclude here to avoid duplication.
          NOT: { ...CHAT_DIGEST_SHARED },
        },
        orderBy: [{ importance: "desc" }, { createdAt: "desc" }],
        take: 20,
        include: { topic: true },
      })).filter((m: any) => !isColdStartExcluded(m.title, `${m.title ?? ""} ${m.summary ?? ""} ${m.content ?? ""}`));
      const recentEvents = await prisma.event.findMany({
        where: { NOT: { source: { in: ["reentry", "reentry_delta"] } } },
        orderBy: { createdAt: "desc" },
        take: 10,
      });
      // Dialogue digests (sanitized) instead of raw CHAT — raw may contain
      // sensitive content that a cold session reentry should not expose. The
      // digest layer is produced sanitized; the cold-start content filter is a
      // second layer on top (externalized, ships neutral).
      const digests = (await prisma.memory.findMany({
        where: { isActive: true, ...CHAT_DIGEST_WHERE },
        orderBy: { createdAt: "desc" },
        take: 15,
      })).filter((d: any) => !isColdStartExcluded(d.title, `${d.title ?? ""} ${d.summary ?? ""} ${d.content ?? ""}`)).slice(0, 10);

      let ctx = "# Re-entry Context\n\n## Core Profile\n\n";
      ctx += profile.length
        ? profile.map((e) => `**${e.title}** (${e.key}, importance: ${e.importance})\n${e.content}`).join("\n\n")
        : "No profile data.\n";

      ctx += "\n\n## Active States\n\n";
      // state content dumped in full blows up reentry token count; read only
      // summary, with a null fallback slice(300)+'...' + a warn nudging backfill.
      // Fetch the full body on-demand via state_get(id).
      ctx += states.length
        ? states
            .map((s) => {
              if (s.summary) return `- [${s.stateType}] ${s.title} (id: ${s.id}): ${s.summary}`;
              console.warn(`[reentry] state "${s.title}" (${s.id}) missing summary, using slice fallback — please backfill via state_set`);
              return `- [${s.stateType}] ${s.title} (id: ${s.id}): ${s.content.slice(0, 300)}${s.content.length > 300 ? "..." : ""}`;
            })
            .join("\n")
        : "No active states.\n";

      ctx += "\n\n## Active Topics\n\n";
      ctx += topics.length
        ? topics.map((t) => `- [${t.domain}] **${t.name}** (${t.slug}): ${t.summary || ""}`).join("\n")
        : "No active topics.\n";

      ctx += "\n\n## Anchors & Rules (CORE / BOUNDARY / PREFERENCE)\n\n";
      ctx += anchors.length
        ? anchors
            .map(
              (m) => `**${m.title}** [${m.memoryType}, importance: ${m.importance}]\n${renderAnchor(m)}`,
            )
            .join("\n\n---\n\n")
        : "No anchors.\n";

      ctx += "\n\n## Observations (structured reads about the user / assistant)\n\n";
      ctx += observations.length
        ? observations
            .map(
              (o) => `**[${o.subject}] ${o.title}** (${o.key}, importance: ${o.importance})\n${o.content}`,
            )
            .join("\n\n---\n\n")
        : "No observations.\n";

      ctx += "\n\n## Recent Episodes (importance>=4)\n\n";
      ctx += episodes.length
        ? episodes
            .map(
              (m) =>
                `**${m.title}** [${m.memoryType}, importance: ${m.importance}]\n${m.summary || m.content.slice(0, 300)}`,
            )
            .join("\n\n---\n\n")
        : "No recent episodes.\n";

      ctx += "\n\n## Recent dialogue digests (sanitized · past memory, not the current conversation)\n";
      const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      ctx += digests.length
        ? digests.map((d) => {
            // Anchor on the conversation's event time (digestTimeEnd), not the row
            // write time — the 7-day backfill writes old sessions today, so createdAt
            // would mislabel a days-old digest as "today" and re-introduce the exact
            // "old conversation reads as current" failure this label exists to prevent.
            const eventTime = d.digestTimeEnd ?? d.createdAt;
            const isRecent = eventTime >= oneWeekAgo;
            const body = isRecent
              ? (d.summary || d.content).slice(0, 300)
              : (d.summary || d.content.slice(0, 100));
            const ageDays = Math.floor((Date.now() - eventTime.getTime()) / 86_400_000);
            const ageLabel = ageDays <= 0 ? "today" : `${ageDays}d ago`;
            return `- [${ageLabel}] ${d.title}: ${body}`;
          }).join("\n")
        : "- (none — the digest layer produces these automatically)";

      ctx += "\n\n## Recent Events\n\n";
      ctx += recentEvents.length
        ? recentEvents.map((e) => `- [${e.eventType}] ${e.value || ""} (${localDateTime(e.createdAt)})`).join("\n")
        : "No recent events.\n";

      // Boot marker — gives reentry_delta a "this window's start" anchor (placed
      // after the query, not included in this output). value=tag: a same-tag
      // delta first-call anchors here, not the global latest boot (which could
      // be another window).
      await prisma.event.create({ data: { eventType: "SYSTEM", source: "reentry", value: tag } });

      return { content: [{ type: "text", text: ctx }] };
    },
  );

  server.tool(
    "reentry_delta",
    [
      "Incremental reentry: pull context new/updated since the last delta call (or this window's reentry boot).",
      "In a long conversation the reentry snapshot goes stale (frozen at boot); this tool fills the delta, each row tagged [NEW]/[UPD].",
      "Default (no args) = advancing watermark: anchor at the last reentry_delta marker; else the most recent reentry boot; else a 6h fallback. A no-arg call drops a new marker advancing the chain, so calling twice the second sees only what's truly new.",
      "override: since(ISO) or sinceMinutes — a one-shot look-back that does not advance the marker chain.",
      "tag: multi-window isolation, each with its own marker chain, default main. If reentry passed the same tag at boot, this chain's first call anchors at this window's own boot — true isolation; otherwise the first call falls back to the global latest boot.",
      "Sections mirror reentry (States/Anchors/Episodes/Observations/Digests/Topics/Profile/Events), RESTRICTED filtered as usual. Empty sections are hidden.",
    ].join("\n"),
    {
      since: z.string().optional().describe("ISO lower bound. One-shot override, does not advance the marker chain."),
      sinceMinutes: z.number().optional().describe("Look back N minutes. One-shot override, does not advance the marker chain."),
      tag: z.string().optional().describe("Marker chain identifier, multi-window isolation. Default main."),
    },
    async ({ since: sinceISO, sinceMinutes, tag }) => {
      const chainTag = tag ?? "main";
      const explicit = !!(sinceISO || sinceMinutes);
      let since: Date;
      let anchorSrc: string;
      if (sinceISO) {
        since = new Date(sinceISO);
        anchorSrc = `explicit since ${sinceISO}`;
      } else if (sinceMinutes) {
        since = new Date(Date.now() - sinceMinutes * 60_000);
        anchorSrc = `last ${sinceMinutes}min`;
      } else {
        const lastDelta = await prisma.event.findFirst({
          where: { eventType: "SYSTEM", source: "reentry_delta", value: chainTag },
          orderBy: { createdAt: "desc" },
        });
        if (lastDelta) {
          since = lastDelta.createdAt;
          anchorSrc = `last reentry_delta (${localDateTime(lastDelta.createdAt)})`;
        } else {
          // First look for a same-tag boot anchor (dropped by reentry with a
          // tag); else fall back to the global latest boot. The global fallback
          // can let memories written after this window's boot fall through a
          // gap if another window's boot/marker is newer; a tagged boot chain
          // does not have that gap.
          let lastReentry = await prisma.event.findFirst({
            where: { eventType: "SYSTEM", source: "reentry", value: chainTag },
            orderBy: { createdAt: "desc" },
          });
          let bootSrc = `this window's reentry boot [tag=${chainTag}]`;
          if (!lastReentry) {
            lastReentry = await prisma.event.findFirst({
              where: { eventType: "SYSTEM", source: "reentry" },
              orderBy: { createdAt: "desc" },
            });
            bootSrc = "most recent reentry boot (global, no same-tag boot)";
          }
          if (lastReentry) {
            since = lastReentry.createdAt;
            anchorSrc = `${bootSrc} (${localDateTime(lastReentry.createdAt)})`;
          } else {
            since = new Date(Date.now() - 360 * 60_000);
            anchorSrc = "fallback 6h (no marker)";
          }
        }
      }

      const recent = { OR: [{ createdAt: { gte: since } }, { updatedAt: { gte: since } }] };
      const mark = (createdAt: Date) => (createdAt >= since ? "NEW" : "UPD");

      // States (raw + ::text — same as reentry, guards against unknown enum throw)
      const states = await prisma.$queryRaw<
        Array<{ id: string; stateType: string; title: string; summary: string | null; content: string; createdAt: Date }>
      >`SELECT id, "stateType"::text AS "stateType", title, summary, content, "createdAt"
        FROM active_state
        WHERE "isActive" = true
          AND ("createdAt" >= ${since} OR "updatedAt" >= ${since} OR "startAt" >= ${since})
        ORDER BY "startAt" DESC`;

      // delta shares the reentry main function's cold-start exclusion
      // (externalized, ships neutral).
      const anchors = (await prisma.memory.findMany({
        where: { isActive: true, memoryType: { in: ["CORE", "BOUNDARY", "PREFERENCE"] }, ...recent },
        orderBy: [{ importance: "desc" }, { createdAt: "desc" }],
      })).filter((m: any) => !isColdStartExcluded(m.title, `${m.title ?? ""} ${m.summary ?? ""} ${m.content ?? ""}`));

      const observations = (await prisma.observation.findMany({
        where: { isActive: true, importance: { gte: 3 }, ...recent },
        orderBy: [{ subject: "asc" }, { importance: "desc" }, { updatedAt: "desc" }],
      })).filter((o: any) => !isColdStartExcluded(o.title, `${o.title ?? ""} ${o.content ?? ""}`));

      const episodes = (await prisma.memory.findMany({
        where: {
          isActive: true,
          memoryType: "EPISODE",
          importance: { gte: 4 },
          NOT: { ...CHAT_DIGEST_SHARED },
          ...recent,
        },
        orderBy: { createdAt: "desc" },
        take: 30,
      })).filter((m: any) => !isColdStartExcluded(m.title, `${m.title ?? ""} ${m.summary ?? ""} ${m.content ?? ""}`));

      const digests = (await prisma.memory.findMany({
        where: { isActive: true, ...CHAT_DIGEST_WHERE, ...recent },
        orderBy: { createdAt: "desc" },
        take: 30,
      })).filter((m: any) => !isColdStartExcluded(m.title, `${m.title ?? ""} ${m.summary ?? ""} ${m.content ?? ""}`));

      const topics = await prisma.topic.findMany({ where: { status: "ACTIVE", ...recent }, orderBy: { priority: "desc" } });
      const profile = await prisma.coreProfile.findMany({
        where: { isActive: true, NOT: { key: { startsWith: "private_" } }, ...recent },
        orderBy: { importance: "desc" },
      });
      const events = await prisma.event.findMany({
        where: {
          createdAt: { gte: since },
          eventType: { not: "APP_OPEN" },
          NOT: { source: { in: ["reentry", "reentry_delta"] } },
        },
        orderBy: { createdAt: "desc" },
        take: 40,
      });

      let ctx = `# Re-entry Delta\n\nSince ${localDateTime(since)} (anchor: ${anchorSrc}, tag=${chainTag})\n`;
      let any = false;

      if (states.length) {
        any = true;
        ctx += "\n## Active States Δ\n\n";
        ctx += states
          .map((s) => `- [${mark(s.createdAt)}][${s.stateType}] ${s.title} (id: ${s.id}): ${s.summary || s.content.slice(0, 300)}`)
          .join("\n");
      }
      if (anchors.length) {
        any = true;
        ctx += "\n\n## Anchors Δ (CORE / BOUNDARY / PREFERENCE)\n\n";
        ctx += anchors
          .map((m: any) => `**[${mark(m.createdAt)}] ${m.title}** [${m.memoryType}, importance: ${m.importance}]\n${renderAnchor(m)}`)
          .join("\n\n---\n\n");
      }
      if (observations.length) {
        any = true;
        ctx += "\n\n## Observations Δ\n\n";
        ctx += observations
          .map((o) => `**[${mark(o.createdAt)}][${o.subject}] ${o.title}** (${o.key}, importance: ${o.importance})\n${o.content}`)
          .join("\n\n---\n\n");
      }
      if (episodes.length) {
        any = true;
        ctx += "\n\n## Episodes Δ (importance>=4)\n\n";
        ctx += episodes
          .map((m) => `**[${mark(m.createdAt)}] ${m.title}** [importance: ${m.importance}]\n${m.summary || m.content.slice(0, 300)}`)
          .join("\n\n---\n\n");
      }
      if (digests.length) {
        any = true;
        ctx += "\n\n## Dialogue digests Δ (sanitized)\n\n";
        ctx += digests.map((d) => `- [${mark(d.createdAt)}] ${d.title}: ${(d.summary || d.content).slice(0, 300)}`).join("\n");
      }
      if (topics.length) {
        any = true;
        ctx += "\n\n## Topics Δ\n\n";
        ctx += topics.map((t) => `- [${mark(t.createdAt)}][${t.domain}] **${t.name}** (${t.slug}): ${t.summary || ""}`).join("\n");
      }
      if (profile.length) {
        any = true;
        ctx += "\n\n## Profile Δ\n\n";
        ctx += profile.map((e) => `**[${mark(e.createdAt)}] ${e.title}** (${e.key}, importance: ${e.importance})\n${e.content}`).join("\n\n");
      }
      if (events.length) {
        any = true;
        ctx += "\n\n## Events Δ\n\n";
        ctx += events.map((e) => `- [${e.eventType}] ${e.value || ""} (${localDateTime(e.createdAt)})`).join("\n");
      }

      if (!any) ctx += `\nNothing new since ${localDateTime(since)}.`;

      // Advance the marker chain — only on a default (no explicit override) call.
      if (!explicit) {
        await prisma.event.create({ data: { eventType: "SYSTEM", source: "reentry_delta", value: chainTag } });
        ctx += `\n\n_marker advanced (tag=${chainTag})_`;
      }

      return { content: [{ type: "text", text: ctx }] };
    },
  );
}
