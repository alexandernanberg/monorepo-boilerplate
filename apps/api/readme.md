# API

## Auth

- Rate limits
- Passwordless email login
- Renew sessions automatically

## Linting

Linting and formatting run on [oxlint and oxfmt](https://oxc.rs) via
`oxlint-config-alexandernanberg`. Note that `eslint-plugin-drizzle`'s
`enforce-delete-with-where` / `enforce-update-with-where` rules have no oxlint
equivalent, so `.delete()` and `.update()` calls are no longer checked for a
`.where(...)` clause — always double check those by hand.

## TODO

- [ ] Passkeys
- [ ] Change email?
