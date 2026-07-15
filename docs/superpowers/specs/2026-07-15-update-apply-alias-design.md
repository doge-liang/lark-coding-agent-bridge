# Command Alias Cleanup Design

## Goal

Make two focused command-alias changes:

1. accept the exact text command `/update apply` as an alias for
   `/upgrade apply`;
2. standardize the Chinese new-session label on `新会话` and remove the old
   `新对话` alias.

These changes keep one canonical handler for each command while removing a
duplicate user-facing label.

## Scope

- Add the exact mapping `/update apply` → `/upgrade apply` to the existing
  `commandAliases` map.
- Keep `/upgrade` as the sole canonical command and handler.
- Leave `/update`, `/update status`, `/update check`, and `/update rollback`
  unsupported.
- Keep `新会话` → `/new` in `commandAliases` and remove `新对话` → `/new`.
- Remove `新对话` from the help/menu card and leave one `新会话` entry.
- Document both final alias choices in the English and Chinese command
  references.

## Behavior and Safety

Alias normalization happens before command parsing. After normalization, the
existing `/upgrade` flow performs all authorization and execution:

- owner/admin access policy;
- private-chat-only enforcement;
- the immediate “upgrade started” acknowledgement;
- controlled release validation, activation, and restart.

The `新会话` alias continues to route through the existing `/new` handler. The
removed `新对话` text is no longer consumed as a bridge command. No new
handler, permission rule, callback path, or upgrade implementation is
introduced.

## Tests

Add integration coverage proving that:

1. an authorized user in a private chat can invoke `/update apply` and reaches
   the existing upgrade service;
2. `/update check` remains unhandled, locking the alias to the requested exact
   command;
3. `新会话` still clears the session through `/new`;
4. `新对话` is no longer handled as a command;
5. the canonical `/upgrade apply` and `/new` behavior remains covered by its
   existing tests.

Run the focused command test first, then the repository's complete local CI
before completion.
