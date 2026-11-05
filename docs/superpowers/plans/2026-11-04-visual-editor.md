# Visual Editor Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for inline implementation, with a fresh whole-change review at the end.

**Goal:** Replace marker editing with a visual document editor and accessible mobile UI while retaining Markdown storage.
**Architecture:** ProseMirror document/schema + loss-aware Markdown codec; an adapter provides existing Markdown-based save/selection events while the visible editor operates on nodes/marks. CodeMirror remains the explicit source mode.
**Tech Stack:** JavaScript, ProseMirror, existing Marked parser and CodeMirror, node:test, Playwright browser verification.
**Spec:** ../specs/2026-11-04-visual-editor-design.md (approved in chat; UI improvements also authorized).

## Global Constraints

- Enter starts an ordinary paragraph with no active marks, including lists, quotes, headings and code. Shift+Enter is an intentional inner newline.
- No raw marker insertion from formatting buttons in visual mode. Space preserves active marks.
- Keep Markdown storage, sync, backups, comments, images, versions and updater. Opening alone never rewrites a note.
- Reuse current checkout on codex/visual-editor; do not touch .claude/worktrees. Do not publish without subsequent authorization.

## Review Focus

- Round trips preserve unknown Markdown, escaped text, whitespace, tables and nested accordions.
- Source/visual cursor mapping and switching notes do not replace the wrong text or lose undo.
- Enter preserves existing text and empty tasks, and IME composition does not double-submit.
- Copy/translate use visible text; unsafe HTML/URLs never become executable nodes.
- Mobile insert controls stay discoverable with old toolbar preferences and do not steal selection.

## Task 1: Model, codec and edit commands

Files: src/rich/schema.js, src/rich/markdown.js, src/rich/commands.js, tests/richMarkdown.test.js, tests/richCommands.test.js; package files.
Interfaces: parseMarkdown(source) -> {doc, mapping}; serializeMarkdown(doc) -> {text, toSource, toDocument}; normalParagraph(state, dispatch), nextItem(state, dispatch).
- [x] Write and run failing semantic round-trip and Enter tests.
- [x] Install ProseMirror dependencies; implement schema, safe token conversion, opaque source nodes and mapping serializer.
- [x] Verify marks/paragraphs, lists/tasks, code, images/links, tables, comments and nested details; unknown fragments survive; Enter and explicit next-item behavior.

## Task 2: Editor adapter and source mode

Files: src/rich/editor.js, src/noteEditor.js, src/editor.js, src/accordionView.js, src/app.js.
- [x] Implement real ProseMirror view with node views for assets/details/tasks, IME-safe input, clipboard, search and undo.
- [x] Provide Markdown snapshot/event facade for save/sync and cursor mapping; retain per-note model/history snapshots. Route existing helpers to rich commands when active.
- [x] Explicit visual/source mode, safe original preservation and first-save history; copy/translate plain selected text, comments/dictation/outline restored.
- [x] Browser checks for switching notes/modes, selection, save/reload, incoming sync edits, images, comments and source preservation.

## Task 3: Toolbar and UI

Files: src/formatBar.js, src/styles.css, src/i18n.js, src/app.js, tests/browser verification.
- [x] Replace default row with paragraph selector, active mark controls and pinned Insert menu. Migrate preferences without hiding Insert.
- [x] Always-visible accordion entry and next-item/newline/paragraph-after-block actions; keyboard/touch accessibility.
- [x] Verify 360/390/430 px and desktop, light/dark themes, read-only/keyboard, no overflow or focus loss.

## Task 4: Verification and delivery

- [x] Run full tests/build/Android asset packaging; meaningful browser regressions of complete app.
- [x] Independent review; fix significant findings and retest affected paths.
- [x] Update docs, record limitations, commit reviewed changes. Report local result; no new release without authorization.
