import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { createUnderwriteTables } from '../src/database/schema';
import { UnderwriteRepository, type QueuedUnderwrite } from '../src/database/underwrite-repository';

const underwrite: QueuedUnderwrite = {
  signedTransactionHash: 'a'.repeat(64),
  instructionIndex: 0,
  rfqId: '0193c3c5-1967-7000-8000-000000000000',
  sellerAddress: 'seller-address',
  buyerAddress: 'buyer-address',
  marketAddress: 'market-address',
  seriesAddress: 'series-address',
  ticker: 'BTC-USDC-WBTC-01JAN25-60000-C',
  isPut: false,
  expiryMs: 1_735_689_600_000,
  strike: '6000000000000',
  quantity: '1000000000000000000',
  premium: '25000000',
  baseCoinMint: 'base-mint',
  quoteCoinMint: 'quote-mint',
  feeRecipient: 'fee-recipient',
  operationalFeeBps: 50,
  transactionSignature: 'transaction-signature',
  createdAtMs: 1_735_600_000_000,
};

describe('underwrite repository', () => {
  beforeEach(async () => {
    await createUnderwriteTables(env.DB);
    await env.DB.exec('DELETE FROM underwrite_audit; DELETE FROM underwrites; DELETE FROM option_series;');
  });

  it('records an identical queued transaction only once with one audit entry', async () => {
    const repository = new UnderwriteRepository(env.DB);

    await expect(repository.createQueued(underwrite)).resolves.toEqual({ created: true });
    await expect(repository.createQueued(underwrite)).resolves.toEqual({ created: false });

    await expect(repository.get(underwrite.signedTransactionHash, 0)).resolves.toMatchObject({
      status: 'queued',
      ticker: 'BTC-USDC-WBTC-01JAN25-60000-C',
      sellerAddress: 'seller-address',
    });
    await expect(repository.auditFor(underwrite.signedTransactionHash, 0)).resolves.toEqual([
      { createdAtMs: 1_735_600_000_000, status: 'queued' },
    ]);
  });

  it('persists lifecycle receipts and creates the immutable series after confirmation', async () => {
    const repository = new UnderwriteRepository(env.DB);
    await repository.createQueued(underwrite);

    await repository.markSubmitted(underwrite.signedTransactionHash, 0, 1_735_600_001_000);
    await repository.markConfirmed(underwrite.signedTransactionHash, 0, 1_735_600_002_000);

    await expect(repository.get(underwrite.signedTransactionHash, 0)).resolves.toMatchObject({
      status: 'confirmed',
      submittedAtMs: 1_735_600_001_000,
      confirmedAtMs: 1_735_600_002_000,
    });
    await expect(repository.auditFor(underwrite.signedTransactionHash, 0)).resolves.toEqual([
      { createdAtMs: 1_735_600_000_000, status: 'queued' },
      { createdAtMs: 1_735_600_001_000, status: 'submitted' },
      { createdAtMs: 1_735_600_002_000, status: 'confirmed' },
    ]);
    await expect(repository.getSeries('series-address')).resolves.toEqual({
      seriesAddress: 'series-address',
      marketAddress: 'market-address',
      ticker: 'BTC-USDC-WBTC-01JAN25-60000-C',
      isPut: false,
      expiryMs: 1_735_689_600_000,
      strike: '6000000000000',
      baseCoinMint: 'base-mint',
      quoteCoinMint: 'quote-mint',
      confirmedAtMs: 1_735_600_002_000,
    });
  });
});
