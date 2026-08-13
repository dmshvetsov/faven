# Sign In With Sui (SIWSui) Standard

## Purpose

SIWSui proves control of a Sui wallet without creating a transaction. Faven exchanges that proof for a short-lived opaque bearer token.

The same flow works for browser users, agents, and programmatic clients.

## Requirements

- Authentication uses Sui `PersonalMessage` signing only.
- The message must never request a transaction, transfer, or permission.
- The server creates every challenge and controls its contents, expiry, and one-time use.
- The verified signer must exactly match the challenge address.
- A session proves identity only; ownership checks decide what that identity may access.

## Challenge message

```text
{domain} wants you to sign in with your Sui account:
{address}

Sign in to Faven. This request will not create a transaction or move assets.

URI: {uri}
Version: 1
Chain ID: {chainId}
Nonce: {challengeId}
Issued At: {issuedAt}
Expiration Time: {expirationTime}
```

| Field | Rule |
|---|---|
| `domain`, `uri` | Configured Faven web origin, never supplied by the client. |
| `address` | Canonical Sui address the signer must prove control of. |
| `chainId` | Configured network: `sui:mainnet`, `sui:testnet`, `sui:devnet`, or `sui:localnet`. |
| `challengeId` / `nonce` | One server-generated, 256-bit random value. It identifies the challenge row and prevents replay. |
| `issuedAt`, `expirationTime` | RFC 3339 timestamps. Challenges expire after five minutes. |

The message is UTF-8 and signed as a Sui `PersonalMessage`. `notBefore`, `resources`, and `requestId` are intentionally omitted.

The server validates and normalizes every address before use. Canonical addresses are lowercase, have one `0x` prefix, and are left-padded to 64 hexadecimal characters.

## API

All authentication responses use `Cache-Control: no-store`.

### Create a challenge

`POST /api/auth/challenges`

Request:

```json
{
  "address": "0xabc..."
}
```

Response:

```json
{
  "challengeId": "base64url-encoded-256-bit-value",
  "message": "faven.example wants you to sign in with your Sui account:\n0x0000...0abc\n\nSign in to Faven. This request will not create a transaction or move assets.\n\nURI: https://faven.example\nVersion: 1\nChain ID: sui:testnet\nNonce: base64url-encoded-256-bit-value\nIssued At: 2026-08-01T12:00:00Z\nExpiration Time: 2026-08-01T12:05:00Z",
  "expiresAt": "2026-08-01T12:05:00Z"
}
```

### Verify and create a session

`POST /api/auth/verify`

Request:

```json
{
  "challengeId": "base64url-encoded-256-bit-value",
  "signature": "base64-serialized-sui-signature",
  "sessionDuration": "long"
}
```

`sessionDuration` is required:

- `short`: 15 minutes.
- `long`: 24 hours.

Any authenticated client may request either duration.

Response:

```json
{
  "accessToken": "base64url-encoded-256-bit-value",
  "tokenType": "Bearer",
  "subject": "0x0000...0abc",
  "chainId": "sui:testnet",
  "expiresAt": "2026-08-02T12:00:00Z"
}
```

Clients send the token only to protected endpoints:

```http
Authorization: Bearer {accessToken}
```

### Logout

`POST /api/auth/logout`

The endpoint requires the current bearer token and deletes only its session.

## Server verification and storage

Before issuing a token, the server must:

1. Load the challenge by `challengeId`.
2. Confirm it is unexpired and unused.
3. Verify the stored message as a Sui `PersonalMessage` with the supplied signature.
4. Require the verified signer to match the stored canonical address.
5. Atomically mark the challenge as used.
6. Create the session only after that atomic update succeeds.

An invalid signature does not consume a challenge. A consumed challenge remains until expiry so a replay can return `challenge_used`. Expired challenges and sessions are deleted lazily during normal authentication requests.

The server accepts locally verifiable Sui signature schemes: Ed25519, Secp256k1, Secp256r1, multisig, and passkeys. zkLogin is out of scope because it needs network-assisted verification.

Access tokens are 256-bit random opaque values. The server stores only each token's SHA-256 hash, canonical wallet address, configured network, creation time, and expiry. One wallet may hold multiple concurrent sessions. Logout deletes the current row; session listing and global logout are out of scope.

No refresh tokens, custom scopes, application-level rate limits, or persistent audit records are part of version one.

## Browser and CORS behavior

The MVP uses bearer tokens only; it does not set authentication cookies or use CSRF tokens.

- After wallet connection, the browser must immediately complete SIWSui sign-in.
- If signing is rejected or fails, the app disconnects the wallet.
- The browser stores its long-lived MVP token in `sessionStorage` and clears it on logout, any `401` response, or wallet disconnection.
- On reload, a restored wallet may reuse only a matching, unexpired stored session; otherwise it signs in again.
- Logging out revokes the token, clears local state, and disconnects the wallet. If revocation cannot be confirmed, the app still clears local state and disconnects.
- Switching wallets keep previously authenticated wallet authenticated.

The server allows CORS requests from one exact configured web origin per environment and permits the `Authorization` header. It never uses `*` or reflects arbitrary origins. Non-browser agents are unaffected by CORS.

If the web-origin or authentication-domain configuration is missing or invalid, the authentication endpoints fail closed with `503`.

## Server authorization policy

For protected data and actions, the server derives the acting wallet from the verified session. It does not trust client-supplied owner addresses and should not contain endpoints that accepts client client-supplied addresses as a proof authentication or authorization to resources. Ownership mismatches return `404` with a resource-specific error code, in such cases the API does not reveal that another wallet's resource exists.

## Errors

Errors are defined in a shared TypeScript module and return machine-readable codes.

| HTTP status | Code | Meaning |
|---|---|---|
| `400` | `invalid_request` | Missing, malformed, or unsupported input. |
| `401` | `invalid_signature` | The signature does not verify for the stored message and address. |
| `401` | `challenge_expired` | The challenge is past expiry. |
| `401` | `challenge_used` | The challenge was already consumed. |
| `401` | `token_invalid` | The token is absent, invalid, expired, or revoked. |
| `404` | resource-specific, such as `vault_not_found` | The requested resource is missing or is not owned by the authenticated wallet. |
| `503` | `auth_configuration_unavailable` | Required authentication configuration is unavailable. |

## Agent and programmatic use

Agents use the same endpoints as browsers:

1. Create a challenge for the agent's Sui address.
2. Sign the returned UTF-8 message as a Sui `PersonalMessage`.
3. Verify the challenge and request `short` duration for security reasons.
4. Send the returned token in `Authorization: Bearer …` to protected endpoints.

Server API does not introduce API keys or a separate agent identity model in this version.

### Minimal TypeScript example

```ts
type PersonalMessageSigner = {
  toSuiAddress(): string;
  signPersonalMessage(message: Uint8Array): Promise<{ signature: string }>;
};

async function signIn(apiUrl: string, signer: PersonalMessageSigner) {
  const challengeResponse = await fetch(`${apiUrl}/api/auth/challenges`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: signer.toSuiAddress() }),
  });
  const challenge = await challengeResponse.json();

  const { signature } = await signer.signPersonalMessage(
    new TextEncoder().encode(challenge.message),
  );
  const verifyResponse = await fetch(`${apiUrl}/api/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      challengeId: challenge.challengeId,
      signature,
      sessionDuration: "short",
    }),
  });
  const { accessToken } = await verifyResponse.json();
  return accessToken;
}
```

The agent must obtain `signer` from its secure Sui wallet signer and never expose its private key.
