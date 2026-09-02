# 05: Remove the legacy RFQ path and prove the replacement

**What to build:** The RFQ server has only the canonical Durable Object flow, with no legacy premium-free template or buyer positions behavior, and has automated coverage for the seller and maker contracts.

**Blocked by:** 01: Persist a valid RFQ at fan-out; 02: Generate and accept v0 buyer quotes; 03: Select and queue the signed winning underwrite; 04: Make RFQ broadcasts terminal and auditable.

**Status:** complete

- [x] Obsolete RFQ flow and contract behavior are removed without changing the dashboard's durable underwrite records.
- [x] Focused RFQ-server tests cover the replacement lifecycle, then formatting, linting, and the complete test suite pass.
