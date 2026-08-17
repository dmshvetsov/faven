# Anchor Options (Financial Derivatives) Program

## Project guide

- `src/libs.rs` program entrypoint, instructions specific code goes to `src/instructions/*`
- `src/state.rs` account structs and PDA seeds
- `src/instructions/*.rs` instruction handlers, keep instructions modular — one Rust file per instruction
- `src/events.rs` for emitted events 
- `src/errors.rs` for error handling
- `src/*.rs` for specific utility modules, e.g. `math.rs`
- `tests/*.rs` place for tests

Write integration tests that simulate real-world flows, not just unit tests.

## Testing best practices to follow

Full test coverage is mandatory.

Go beyond happy paths: Don’t just test the expected “success” cases — intentionally break things.

Handle edge cases: Think about missing accounts, incorrect bumps, wrong signers, and invalid inputs.

Shuffle accounts: Instruction accounts may come in different orders, so simulate that to catch unexpected behavior.

Fail gracefully: Verify that your program errors out cleanly when constraints are violated.

Rust Unit Tests
— Great for testing pure logic functions (e.g. math utilities, validation helpers) without needing a Solana runtime.
— Fast and lightweight — ideal for TDD (Test Driven Development).

Anchor Integration Tests (with Local Validator)
— Use anchor test, which spins up a local Solana test validator.
— Best for simulating real-world flows: account initialization, PDAs, CPIs, closing accounts, etc.
— Lets you write tests in TypeScript/JavaScript (or Rust) that mimic actual client interactions.

Rust Runtime / Local Validator Tests
— Write tests in Rust that interact directly with solana-program-test.
— Gives finer control compared to anchor test, but requires more boilerplate.
— Useful if you want to stay purely in Rust (no TS) while still hitting program logic.

Fuzz Tests
— Randomize inputs to your program (e.g., wrong accounts, invalid bumps, extreme values).
— Helps catch unexpected corner cases that normal unit/integration tests may miss.
— Tools like cargo-fuzz , Turbine can integrate into your workflow.
