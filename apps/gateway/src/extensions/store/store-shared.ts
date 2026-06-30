// Pure helpers for the `store` extension. These mirror kimi-room's
// src/lib/stores/shared.ts EXACTLY so the engine-side store and the room-side
// adapters are behaviourally interchangeable and their export/import JSON is the
// same shape (Record<collection, row[]>). Kept self-contained (minimal local
// types, no cross-repo import) — the engine store is generic; it does not need
// room's specific entry types.
//
// Storage model: every collection is one uniform row { id, collection,
// createdAt, updatedAt, data }, where `data` is the entry minus its envelope
// (id/createdAt/updatedAt). One table (store_rows) holds all collections + blob,
// keyed by `collection`.

export type ISO = string;

export type StoreEntry = {
  id: string;
  createdAt: ISO;
  updatedAt: ISO;
  [k: string]: unknown;
};

export type BlobEntry = {
  id: string;
  kind: string;
  contentType: string;
  base64: string;
  createdAt: ISO;
};

export type Filter = {
  ids?: string[];
  tags?: string[];
  status?: string;
  activeOnly?: boolean;
  dateRange?: { from: ISO; to: ISO };
  limit?: number;
};

export type StoreRow = {
  id: string;
  collection: string;
  createdAt: ISO;
  updatedAt: ISO;
  data: Record<string, unknown>;
};

export const BLOB_COLLECTION = "blob";

export function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function nowISO(): ISO {
  return new Date().toISOString();
}

export function applyFilter<T extends StoreEntry>(rows: T[], filter?: Filter): T[] {
  if (!filter) return rows;
  let out = rows;
  // `filter` arrives as opaque z.unknown() cast to Filter — guard the array fields so
  // a malformed value (e.g. ids:"abc") narrows to "no match" instead of throwing a
  // TypeError on .includes(...) deep in the handler.
  if (Array.isArray(filter.ids)) out = out.filter((r) => filter.ids!.includes(r.id));
  if (Array.isArray(filter.tags)) {
    out = out.filter((r) => {
      const t = (r as { tags?: string[] }).tags;
      return Array.isArray(t) && filter.tags!.some((tag) => t.includes(tag));
    });
  }
  if (filter.status) {
    out = out.filter((r) => (r as { status?: string }).status === filter.status);
  }
  if (filter.activeOnly) {
    out = out.filter((r) => (r as { active?: boolean }).active !== false);
  }
  if (filter.dateRange) {
    out = out.filter((r) => {
      const d = (r as { date?: string }).date ?? r.createdAt;
      return d >= filter.dateRange!.from && d <= filter.dateRange!.to;
    });
  }
  if (filter.limit) out = out.slice(0, filter.limit);
  return out;
}

export function searchRows<T extends StoreEntry>(rows: T[], query: string): T[] {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  return rows.filter((r) => JSON.stringify(r).toLowerCase().includes(q));
}

export function mergeEntry(
  existing: StoreEntry | null,
  patch: Record<string, unknown> & { id?: string },
  now: ISO,
): StoreEntry {
  const id = patch.id ?? existing?.id ?? newId();
  return {
    ...(existing ?? {}),
    ...patch,
    id,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  } as StoreEntry;
}

export function entryToRow(collection: string, entry: StoreEntry): StoreRow {
  const { id, createdAt, updatedAt, ...rest } = entry;
  return { id, collection, createdAt, updatedAt, data: rest };
}

export function rowToEntry(row: StoreRow): StoreEntry {
  return {
    ...row.data,
    id: row.id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  } as StoreEntry;
}

export function blobToRow(blob: BlobEntry): StoreRow {
  const { id, createdAt, ...rest } = blob;
  return {
    id,
    collection: BLOB_COLLECTION,
    createdAt,
    updatedAt: createdAt,
    data: rest as Record<string, unknown>,
  };
}

export function rowToBlob(row: StoreRow): BlobEntry {
  return {
    id: row.id,
    createdAt: row.createdAt,
    ...(row.data as Omit<BlobEntry, "id" | "createdAt">),
  };
}

export function rowsToExport(rows: StoreRow[]): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const row of rows) {
    (out[row.collection] ??= []).push(
      row.collection === BLOB_COLLECTION ? rowToBlob(row) : rowToEntry(row),
    );
  }
  return out;
}

export function importToRows(payload: Record<string, unknown[]>): StoreRow[] {
  const rows: StoreRow[] = [];
  for (const [collection, arr] of Object.entries(payload)) {
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (!item || typeof item !== "object" || !("id" in item)) continue;
      rows.push(
        collection === BLOB_COLLECTION
          ? blobToRow(item as BlobEntry)
          : entryToRow(collection, item as StoreEntry),
      );
    }
  }
  return rows;
}
