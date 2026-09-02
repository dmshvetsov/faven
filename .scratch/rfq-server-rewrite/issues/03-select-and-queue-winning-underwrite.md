# 03: Select and queue the signed winning underwrite

**What to build:** At RFQ close, the seller privately receives the highest valid quote or the no-buyers result. The seller can submit the selected unexpired transaction, signed unchanged by both parties, and receive an idempotent queued result after durable queue admission.

**Blocked by:** 01: Persist a valid RFQ at fan-out; 02: Generate and accept v0 buyer quotes.

**Status:** ready-for-agent

- [ ] The RFQ selects the highest premium, preserves first-arrival tie-breaking, and never delivers a quote after cancellation or seller disconnect.
- [ ] Seller submission validates the exact selected v0 message, canonical terms, account layout, required signatures, and simulation; matching repeats return the original queued result while changed bytes fail.
- [ ] The queued underwrite and audit record are durable before the queue is admitted, with a migration only if existing durable fields are insufficient.
