# Ideas / Backlog

Unvalidated ideas, not commitments. Worked-on ideas get moved into issues or PRs.

## 1. Recency-aware recall ("recently relevant stuff first")

**Goal:** at session start, surface the most *recently* relevant memories, not just lexically relevant ones.

**Blocker:** recall results currently carry only `context` + `evidence_id` — no timestamps. The server ranks by RRF (semantic + keyword), which has no recency component. The hook can't sort what it can't see.

**Paths (in order of effort):**
- **Server-side:** add `recorded_at` / `valid_from` to `recall_memory` hits (or a `recency_boost` score) and optionally a `sort=recency` mode. Cleanest, fixes it for every client.
- **Client-side (this hook):** `trace_memory` / portal API (`/ui/api/*`) per evidence_id to fetch timestamps — N+1 calls at session start, only worth it for the top few hits.

**Rejected:** `known_at = last git commit` — `known_at` is "knowledge as of T" (before-semantics), so anchoring there *shrinks* recall to pre-commit knowledge and drops everything learned since the last commit. Confirmed via source (`recallservice/recall.go`) and live probes (50 → 12 results).

## 2. Summarizer pass over the memory corpus

**Goal:** replace raw deduped snippets with a digest — "here's the state of this project, sorted by what changed recently."

**Shape:** at session start, recall top-N per query → fetch each evidence's timestamp (see idea 1) → send corpus + timestamps to an LLM → inject a short structured digest instead of / alongside raw snippets.

**Open questions:**
- Where does the timestamp come from until idea 1 lands server-side? (portal API, `trace_memory`, or a server change)
- Cost/latency budget — session_start currently must never hang (timeoutMs); an LLM pass adds seconds.
- Keep raw snippets as fallback when the summarizer fails or times out.
- Char budget (`maxContextChars`) applies to digest size, not snippet count.

## 3. Anything else that surfaces

Add freely.
