# Changelog

## 0.2.1

- Use an English command description in the slash menu and command palette.
- Compare actual published file contents when checking an existing npm release,
  avoiding false failures from platform-specific tar/gzip encoding.

## 0.2.0

Initial public release of the OpenCode adapter for Plannotator TUI.

- `/annotate [file]` and `/annotate-last` for replies or local Markdown/text documents.
- Same-terminal handoff and confirmed feedback to the captured session.
- Paginated completed-reply lookup and isolated document snapshots.
- Original document path and snapshot hash included in feedback.
- Recovery drafts on failure and preservation of archived annotations.
- Fourteen behavior tests and real terminal/API smoke coverage.
