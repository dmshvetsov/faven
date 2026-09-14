import {
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
} from "@solana/kit";

export const LEGACY_TOKEN_PROGRAM_ADDRESS = address(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);
const ASSOCIATED_TOKEN_PROGRAM_ADDRESS = address(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
);

/** Derives the legacy SPL Token associated account for an owner and mint. */
export async function deriveAssociatedTokenAddress(input: {
  readonly owner: Address;
  readonly mint: Address;
}): Promise<Address> {
  const [associatedTokenAddress] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    seeds: [
      getAddressEncoder().encode(input.owner),
      getAddressEncoder().encode(LEGACY_TOKEN_PROGRAM_ADDRESS),
      getAddressEncoder().encode(input.mint),
    ],
  });
  return associatedTokenAddress;
}
