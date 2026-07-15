# `/update apply` Alias Design

## Goal

Accept the exact text command `/update apply` as an alias for `/upgrade apply`.
The alias gives users a familiar spelling without creating a second upgrade
command surface.

## Scope

- Add the exact mapping `/update apply` → `/upgrade apply` to the existing
  `commandAliases` map.
- Keep `/upgrade` as the sole canonical command and handler.
- Leave `/update`, `/update status`, `/update check`, and `/update rollback`
  unsupported.
- Document the exact alias in the English and Chinese command references.

## Behavior and Safety

Alias normalization happens before command parsing. After normalization, the
existing `/upgrade` flow performs all authorization and execution:

- owner/admin access policy;
- private-chat-only enforcement;
- the immediate “upgrade started” acknowledgement;
- controlled release validation, activation, and restart.

No new handler, permission rule, callback path, or upgrade implementation is
introduced.

## Tests

Add integration coverage proving that:

1. an authorized user in a private chat can invoke `/update apply` and reaches
   the existing upgrade service;
2. `/update check` remains unhandled, locking the alias to the requested exact
   command;
3. the canonical `/upgrade apply` behavior remains covered by its existing
   tests.

Run the focused command test first, then the repository's complete local CI
before completion.
