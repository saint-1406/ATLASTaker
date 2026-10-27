# Welcome to ATLAS

This is your notepad: quick, quiet and uncluttered. Everything you write saves itself.

## How it works

- Text is saved half a second after the last keystroke. There is no Save button: the bottom right corner shows that everything is already on disk.
- Notes are plain .md files that any app can open. Before every update and once a day ATLAS puts a copy of them in the backups folder, and edits that did not make it to disk are offered back at the next start.
- A line that starts with “# ” becomes a section. A table of contents appears on the right, with the section under the cursor highlighted.
- Screenshots go straight into a note: Win+Shift+S, then Ctrl+V. You can also drag a picture into the text. Click it to see it full screen.
- Ctrl+K opens the palette: search across your notes and every command. Ctrl+, opens the settings, the language among them.
- In the mood for atmosphere? Switch to the Atlas look: the note becomes a relief map and its headings become peaks.

## Tasks and comments

- [ ] Select this line, right-click and choose “Add comment”
      💬 26.10.2026 18:00 · the comment lands right under the task, with the date and time
- [x] Build my own notepad

## Code

For a code block, type /# at the start of a line (or press Ctrl+E): the block opens with the cursor inside. Another /# leaves the block. Add a language after the three backticks and highlighting turns on by itself:

```python
def outline(note: str) -> list[str]:
    """The note's headings, in order."""
    return [line.lstrip("# ") for line in note.splitlines() if line.startswith("#")]
```

```javascript
const sections = note.split('\n').filter((line) => line.startsWith('#'));
console.log(`Sections: ${sections.length}`);
```

Paste code from the clipboard and ATLAS wraps it in a block and guesses the language. Guessed wrong? Ctrl+Z.

## Shortcuts

| Keys | What it does |
| --- | --- |
| Ctrl+K | palette: notes and commands |
| Ctrl+Shift+P | commands only |
| Ctrl+N | new note |
| Ctrl+, | settings: language, look, theme, accent |
| Ctrl+. | focus mode |
| /# or Ctrl+E | code block (/# inside one leaves it) |
| Ctrl+Shift+M | comment on the line |
| Ctrl+F | find in the note |
| Ctrl+B | hide the notes list |
| Ctrl+Shift+L | light / dark theme |
| Ctrl + plus / minus | text size |
| Ctrl+click | open a link |
| Ctrl+M | atlas of notes (in the Atlas look) |
