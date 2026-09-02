# 06: Reconcile broadcasts missing durable lifecycle records

**What to build:** Recover the durable underwrite lifecycle when the signed transaction reaches Solana but a D1 status update fails and the queue message is acknowledged.

**Blocked by:** 04: Make RFQ broadcasts terminal and auditable.

**Status:** ready-for-agent

- [ ] Identify and persist enough safe broadcast-attempt data to find an unrecorded transaction by its Solana signature.
- [ ] Reconcile its Solana receipt into the durable underwrite and audit record without broadcasting the signed transaction again.
- [ ] Add dashboard-visible operational reporting and recovery tests for the reconciliation path.
