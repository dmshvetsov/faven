# RFQ server broadcast queue

This document defines the broadcast queue for RFQ underwrite transactions.

## Requirements

RFQ underwrites MUST use one Cloudflare queue with one in-flight transaction.
`underwrites` and `underwrite_audit` are the durable lifecycle record.

Before returning `queued` to a seller, the server MUST persist the queued
underwrite and its audit event, then successfully admit the work to the queue.
The queued response MUST return `txSignature`, the Solana fee-payer signature;

For each queued transaction, the worker MUST:

1. Simulate it once.
2. Submit it once and persist `submitted` with an audit event.
3. Wait for `confirmed` commitment.
4. Persist `confirmed`, its audit event, and all resulting on-chain state from
   the receipt or emitted events.
5. Acknowledge the queue message only after that persistence succeeds.

On simulation, submission, or confirmation failure, the worker MUST persist
`failed` and its audit event, then acknowledge the message. It MUST NOT retry
the signed RFQ transaction, including transient or blockhash-validity retries.

Transactions that require sequential broadcast order MUST use the broadcast
queue. Other transactions MAY use it when that makes the server simpler.
