import { describe, it, expect } from "vitest";
import { clusterCandidates } from "./consolidate.js";

// Pure-function coverage for pass 3 (connected-component clustering + the cosine
// it rides on). triage / dirtyTopics are DB-backed and live in the integration
// suite; the clustering + ordering here is deterministic and testable in isolation.
type PoolRow = { id: string; title: string; importance: number; emb: number[] };
const row = (id: string, title: string, importance: number, emb: number[]): PoolRow => ({
  id,
  title,
  importance,
  emb,
});

describe("clusterCandidates", () => {
  it("groups vectors above the edge threshold and orders members by importance", () => {
    // Three near-parallel vectors (cos ≈ 1, well above the 0.60 edge) form one
    // component; the fourth is orthogonal (cos ≈ 0) and stays out.
    const pool = [
      row("1", "alpha", 5, [1, 0, 0]),
      row("2", "beta", 4, [0.99, 0.01, 0]),
      row("3", "gamma", 3, [0.98, 0.02, 0]),
      row("4", "delta", 5, [0, 1, 0]),
    ];
    const out = clusterCandidates(pool);
    expect(out).toHaveLength(1); // only alpha/beta/gamma reach the >=3 minimum
    expect(out[0]).toContain("cluster 1 (3)");
    // members are importance-sorted: alpha(5) | beta(4) | gamma(3)
    expect(out[0]).toBe("cluster 1 (3): alpha | beta | gamma");
    expect(out[0]).not.toContain("delta");
  });

  it("returns nothing when no component reaches the minimum size", () => {
    const pool = [row("1", "x", 3, [1, 0, 0]), row("2", "y", 3, [0, 1, 0])];
    expect(clusterCandidates(pool)).toEqual([]);
  });

  it("caps a cluster's shown members at the maximum", () => {
    // Ten parallel vectors → one component of 10; only the top 8 by importance show.
    const pool = Array.from({ length: 10 }, (_, i) =>
      row(String(i), `m${i}`, i, [1, i * 1e-6, 0]),
    );
    const out = clusterCandidates(pool);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("cluster 1 (8)"); // 10 members, capped at 8
    expect(out[0]).toContain("m9"); // highest importance kept
    expect(out[0]).not.toContain("m0"); // lowest two dropped by the cap
  });
});
