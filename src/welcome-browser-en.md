# Welcome to ATLAS

This is the browser version of the notepad: one file, nothing to install. Everything you write saves itself.

## Where the notes live

- Your notes are kept in this browser. If you clear its data (history, cookies and site data), the notes go with it.
- So make a copy now and then: Ctrl+K → “Download all notes”. You get a .zip with the .md files.
- To bring notes back from files: Ctrl+K → “Import .md”.
- If there has been no copy for more than a week, ATLAS reminds you itself.

## How it works

- Text is saved half a second after the last keystroke. There is no Save button: the bottom right corner shows that everything is in place.
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

Paste code from the clipboard and ATLAS wraps it in a block and guesses the language. Guessed wrong? Ctrl+Z.

## Shortcuts

| Keys | What it does |
| --- | --- |
| Ctrl+K | palette: notes and commands |
| Ctrl+N | new note |
| Ctrl+, | settings, language and backup copy |
| Ctrl+. | focus mode |
| /# or Ctrl+E | code block (/# inside one leaves it) |
| Ctrl+Shift+M | comment on the line |
| Ctrl+F | find in the note |
| Ctrl+Shift+L | light / dark theme |
