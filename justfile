test: anchor-test

lint: anchor-lint

format: anchor-format

anchor-test:
    cd anchor && cargo test

anchor-lint:
    cd anchor && cargo clippy -- -D warnings

anchor-format:
    cd anchor && cargo fmt

