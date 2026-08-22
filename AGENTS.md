# Agent Instructions

Aim to build a strong projects that grounded in real user needs. Show deep product thinking, strive to smooth, continuous, and free of interruptions and flaws UX. Have a clear path for this product to being market-ready, not just technically possible.

## Domain Language

Read and use shared `./DOMAIN-LANGUAGE.md` in conversations and code.

## Code Style

- avoid writing files larger then 500-1000 lines, if possible split the logically 
- typescript specific
  - avoid using `as <SomeType>` and `any` if this weakens type-safety

### Solana Programs

If you work on Solana programs then follow `./anchor/README.md` instructions on how to write solana programs in this repo.

### Frontend

Always prefer to use Shadcn components if they exists in Shadcn library of component, install missing component instead writing your own component like so `corepack pnpm dlx shadcn@latest add tabs table`. Do not make copies of shadcn components yourself always install. Only write your own components if Shadcn library missing it. Use Radix-UI with Shadcn.

## Git rules

- commits format `<name of the monorepo package>: <explain what changes are in the commit>`
- commit logically coherent changes per monorepo package and per app, do not include changes from two or more packages/apps into single commit
- do not combine multiple task into single git commit, strive to break large changes in coherent logically related git commits

## Package Manager

Always prefix `pnpm` commands with `corepack` to use project specific pnpm defined in root package.json packageManager:

```bash
corepack pnpm --version
corepack pnpm --dir apps/rfq-server test
corepack pnpm --dir apps/rfq-server check
```
If existing pnpm commands cannot be run due to pnpm specific error then stop whatever you are doing and report to human you can't proceed due to issues with pnpm. You must not try to fix pnpm issues yourself.

## Development environment

If you need to install tools, update version of existing tools to complete task please stop and ask human for help.

## Quality Checks and Tests

If following commands exists run them periodically to test and check quality of the code:
- `corepack pnpm test`
- `corepack pnpm check`

## API

Follow RESTFull design practices in designing API. Avoid RPC style if possible.
