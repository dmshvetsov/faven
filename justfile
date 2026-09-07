test: anchor-test

lint: anchor-lint apps-lint

format: anchor-format apps-format

anchor-test:
    cd anchor && cargo test

anchor-lint:
    cd anchor && cargo clippy -- -D warnings

anchor-format:
    cd anchor && cargo fmt

apps-format:
    pnpm -F rfq run format
    pnpm -F admin-cli run format

apps-lint:
    pnpm -F rfq run lint
    pnpm -F admin-cli run lint

rfq-test:
    pnpm -F rfq run test

db-migrate-local:
    pnpm -F rfq run db:migrate:local

install-admin-cli:
    pnpm --dir apps/admin-cli run build && npm install --global --prefix "$HOME/.local" "$PWD/apps/admin-cli"

