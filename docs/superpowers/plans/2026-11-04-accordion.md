# Accordion 0.17.2 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task.

**Goal:** Ship insertable, editable, persistent accordions in ATLAS 0.17.2, retaining Android updates.
**Architecture:** A strict line-based details parser feeds CodeMirror decorations and safe exports. Open state is stored in Markdown; no additional dependency or storage.
**Tech Stack:** JavaScript, CodeMirror 6, node:test, existing Android/GitHub Actions release pipeline.
**Spec:** ../specs/2026-11-04-accordion-design.md (approved in chat).

## Global Constraints

- Standalone insertable blocks, not heading folding. Russian and English UI.
- Preserve Markdown, text, undo, nested blocks, and code examples; never execute raw HTML.
- Reuse current checkout on a feature branch. User authorized implementation and release 0.17.2.

## Review Focus

- Nested and incomplete blocks must not hide unrelated text.
- Fence and indented code examples remain literal.
- Title input preserves focus; toggling works with touch and keyboard.
- Read-only viewing does not persist text changes.
- Printing includes collapsed bodies; exporting HTML never enables arbitrary attributes.

## Task 1: Block model and insertion

Files: src/accordion.js, tests/accordion.test.js.
Interfaces: accordionBlocks(text) returns positions and decoded plain titles; insertAccordion(state, title) returns an undoable transaction; toggleAccordion(state, block) changes only the opening tag.
- [x] Write failing tests for empty insertion, wrapping selection, undo, nested bounds, malformed blocks, fences and escaping.
- [x] Run node --test tests/accordion.test.js, verify failure, implement and rerun.

## Task 2: Editor and exports

Files: src/accordionView.js, src/editor.js, src/formatBar.js, src/app.js, src/i18n.js, src/styles.css, src/exporters.js, tests/exporters.test.js.
- [x] Add failing export tests for nested details, text, script escaping, and print expansion.
- [x] Implement accessible header controls with editable title; hide closed content using block decorations. Read-only toggles use transient state.
- [x] Add insertion to palette, menu, and configurable format bar. Extend safe HTML/text export and print expansion.
- [x] Verify targeted tests and actual editor in wide/narrow browser layouts, including title focus and undo.

## Task 3: Release

Дополнение перед выпуском: src/editingRules.js + tests/editingRules.test.js задают выход из скрытого зачёркивания по пробелу/Enter и сохранение пустого чекбокса по Enter. Интеграция в editor.js, livePreview.js, format.js. Ошибки сначала воспроизведены в настоящем createEditor в Chrome; затем добавлены тесты и проверены исправления.

Files: package.json, package-lock.json, README.md, approved spec.
- [x] Bump to 0.17.2, document accordion and retain updater integration.
- [x] Run full suite, build, Android asset packaging; review diff with fresh reviewer.
- [ ] Commit, fast-forward main, push main and v0.17.2; wait for builds and verify published APK, MSI, ZIP and hashes.
- [ ] Report actual verification and any publishing blocker; never claim phone installation was tested.

Verification before release: 230/230 node tests passed; node build.mjs; scripts/android-assets.mjs; browser tests of editor controls, nested/read-only accordions, insertion through palette and save/reload; editing boundary reproductions corrected; independent review completed.

