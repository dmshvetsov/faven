# 01: Persist a valid RFQ at fan-out

**What to build:** A seller can create a UUIDv7 RFQ with validated market terms. The server fetches and stores the current blockhash and series state, fans the request out once, recovers its deadline after restarts, cancels it when its seller disconnects, and retains terminal tombstones for two weeks.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [x] Creation validates the RFQ against the configured Market and stores canonical terms, blockhash, last valid block height, and series state before fan-out.
- [x] Fan-out starts the fixed aggregation window; cancellation, alarms, restart recovery, and two-week terminal cleanup preserve the specified lifecycle.
