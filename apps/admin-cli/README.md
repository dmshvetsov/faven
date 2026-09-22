# Faven admin CLI

`faven` is the command-line tool for Faven administrators.

## Solana configuration

Commands that access Solana use the default Solana CLI configuration at
`~/.config/solana/cli/config.yml`. Configure its RPC endpoint and keypair with
the Solana CLI, then verify them before running a command:

    $ solana config get

    $ solana config set -k <path to keypair json file>

    $ solana config set -u <rpc url>

## RFQ server configuration

`faven series finalize` sends each on-chain finalization signature to the RFQ
server. Set these variables in the shell where you run the command:

```sh
export RFQ_SERVER_URL="https://devent-api.faven.markets"
export RFQ_SERVER_ADMIN_AUTH_TOKEN="your-admin-token"
```

## Settling series

`faven series settle` discovers settlement-ready Series directly on-chain. It
selects one Market and expiry group, simulates safe SellerVault batches before
asking for confirmation, and keeps a local checkpoint for unfinished runs.

## Install locally

From the repository root, build the CLI and install it into your user-owned
`~/.local/bin` directory:

```sh
pnpm --dir apps/admin-cli run build
npm install --global --prefix "$HOME/.local" "$PWD/apps/admin-cli"
```

Ensure `~/.local/bin` is in your shell `PATH`:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

Add that line to your shell profile if it is not already there. To update after
changing the CLI, run the two install commands again.

To remove it later:

```sh
npm uninstall --global --prefix "$HOME/.local" admin-cli
```
