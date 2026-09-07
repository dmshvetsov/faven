# Faven admin CLI

`faven` is the command-line tool for Faven administrators.

## Solana configuration

Commands that access Solana use the default Solana CLI configuration at
`~/.config/solana/cli/config.yaml`. Configure its RPC endpoint and keypair with
the Solana CLI, then verify them before running a command:

    $ solana config get

    $ solana config set -k <path to keypair json file>

    $ solana config set -u <rpc url>

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
