# 04: Make RFQ broadcasts terminal and auditable

**What to build:** A queued RFQ underwrite is processed one at a time: simulated, sent once, confirmed, and recorded for the seller dashboard. Any failure becomes a durable terminal failure without retrying the signed transaction.

**Blocked by:** 03: Select and queue the signed winning underwrite.

**Status:** ready-for-agent

- [ ] Queue processing waits for Solana `confirmed` commitment before acknowledgement and persists the resulting receipt and underwrite state.
- [ ] Simulation, send, and confirmation failures each create one failed audit entry and are acknowledged without transient or blockhash-validity retries.
