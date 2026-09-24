test: anchor-test

lint: anchor-lint apps-lint

format: anchor-format apps-format

anchor-dev *args:
    cd anchor && source .surfpoolenv && surfpool start --db .surfpool/faven-local-development.sqlite --surfnet-id local-development --watch {{args}}

anchor-dev-setup:
    cd anchor && surfpool run setup_markets --env localnet --unsupervised

anchor-test:
    cd anchor && cargo test

anchor-lint:
    cd anchor && cargo clippy -- -D warnings

anchor-format:
    cd anchor && cargo fmt

apps-format:
    pnpm -F rfq run format
    pnpm -F admin-cli run format
    pnpm -F sdk run format
    pnpm -F web run format

apps-lint:
    pnpm -F rfq run lint
    pnpm -F admin-cli run lint
    pnpm -F sdk run lint
    pnpm -F web run lint

rfq-dev *args:
    pnpm -F rfq run dev {{args}}

web-dev *args:
    pnpm -F web run dev {{args}}

rfq-test:
    pnpm -F rfq run test

rfq-deploy-staging: rfq-test
    pnpm -F rfq exec wrangler d1 migrations apply DB --remote --env staging-devnet
    pnpm -F rfq exec wrangler deploy --env staging-devnet

db-migrate-local:
    pnpm -F rfq run db:migrate:local

install-admin-cli:
    pnpm --dir apps/admin-cli run build && npm install --global --prefix "$HOME/.local" "$PWD/apps/admin-cli"

[parallel]
dev: anchor-dev rfq-dev
