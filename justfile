test: anchor-test

lint: anchor-lint apps-lint

format: anchor-format apps-format

anchor-dev:
    cd anchor && surfpool start --db .surfpool/faven.sqlite --watch

anchor-dev-setup:
    cd anchor && surfpool run market --env localnet --unsupervised

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

apps-lint:
    pnpm -F rfq run lint
    pnpm -F admin-cli run lint
    pnpm -F sdk run lint

rfq-dev:
    pnpm -F rfq run dev

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
