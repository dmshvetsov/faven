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

/** Derives an associated token account for an owner, mint, and token program. */
export async function deriveAssociatedTokenAddress(input: {
  readonly owner: Address;
  readonly mint: Address;
  readonly tokenProgram?: Address;
}): Promise<Address> {
  const [associatedTokenAddress] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    seeds: [
      getAddressEncoder().encode(input.owner),
      getAddressEncoder().encode(
        input.tokenProgram ?? LEGACY_TOKEN_PROGRAM_ADDRESS
      ),
      getAddressEncoder().encode(input.mint),
    ],
  });
  return associatedTokenAddress;
}
