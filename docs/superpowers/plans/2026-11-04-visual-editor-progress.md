# Execution ledger — visual editor

Completed 2026-11-05 on branch codex/visual-editor.

- Design approved in chat; UI review/improvements authorized. User confirmed the existing Android updater works on phone.
- Used ProseMirror directly with an explicit schema and loss-aware Markdown codec. CodeMirror remains available as source mode.
- Task 1 complete: model, commands, codec, source mapping, protected unknown fragments, safe HTML tables and regression tests.
- Task 2 complete: visual/source adapter, per-note shared undo, clipboard, search, images, comments, dictation and incoming source updates. Opening a note alone preserves original source bytes. Existing version/rescue mechanisms retained.
- Task 3 complete: active format controls, paragraph selector, pinned Insert menu with accordion and explicit next item, inner newline and paragraph-after-block actions. Enter starts an ordinary unformatted paragraph and preserves empty tasks.
- Task 4 complete: independent whole-change review; confirmed findings fixed with regressions, including pipe characters inside table cells. Documentation and welcome notes updated.

## Verification

- Full Node suite: 253 passed, 0 failed.
- Playwright browser suite passed: visual formatting, Enter, tasks, accordions, read-only behavior, unchanged source, modes, per-note/shared history, clipboard, search, dictation, incoming updates, composition guards and responsive themes at 360/390/430/1100 px.
- Build passed; Android asset packaging and standalone browser packaging passed.
- Real application browser check passed: save/reopen, image upload, comments, shortcuts, touch menu focus and light/dark layouts.
- git diff --check passed before local commit.

## Delivery and limits

- Reviewed changes committed locally; no merge, push, tag or new release. Package version remains 0.17.2 until a subsequent release is authorized.
- Real Android IME and native installation of the redesigned editor have not been tested. Browser composition guards are covered, but a phone check remains necessary.
- Unrelated .claude/worktrees remains untouched.
