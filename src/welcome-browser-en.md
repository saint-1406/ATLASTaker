# Welcome to ATLAS

This is the browser version of the notepad: one file, nothing to install. Everything you write saves itself.

## Where the notes live

- Your notes are kept in this browser. If you clear its data (history, cookies and site data), the notes go with it.
- So make a copy now and then: Ctrl+K → “Download all notes”. You get a .zip with the .md files.
- To bring notes back from files: Ctrl+K → “Import .md”.
- If there has been no copy for more than a week, ATLAS reminds you itself.

## How it works

- Text is saved half a second after the last keystroke. There is no Save button: the bottom right corner shows that everything is in place.
- Choose a heading from the paragraph selector; sections appear in the contents.
- Screenshots go straight into a note: Win+Shift+S, then Ctrl+V. You can also drag a picture into the text. Click it to see it full screen.
- Ctrl+K opens the palette: search across your notes and every command. Ctrl+, opens the settings, the language among them.
- In the mood for atmosphere? Switch to the Atlas look: the note becomes a relief map and its headings become peaks.

## Writing and formatting

Use the paragraph selector for headings and the buttons for bold, italic, underline and strike. Buttons show the active format; spaces keep it active. In bulleted and numbered lists, Enter after a filled item adds the next one. On an empty item it exits the list or moves up one level. In other blocks, Enter starts a plain paragraph. Shift+Enter adds a line inside the current block.

Insert → Accordion creates a collapsible section. Edit its title, press Enter for its content, and use Paragraph after block to continue outside. Markdown source is a separate mode in the note menu or Settings → Writing.

## Tasks and comments

- [ ] Select this line, right-click and choose “Add comment”
      💬 26.10.2026 18:00 · the comment lands right under the task, with the date and time
- [x] Build my own notepad

## Code

Choose Insert → Code block or press Ctrl+E. Shift+Enter adds a code line; Enter starts a plain paragraph after the block. Language highlighting and the /# syntax are available in source mode:

```python
def outline(note: str) -> list[str]:
    """The note's headings, in order."""
    return [line.lstrip("# ") for line in note.splitlines() if line.startswith("#")]
```

Ordinary paste keeps the text type. Choose a code block before pasting code. Source mode retains language highlighting and smart code paste.

## Shortcuts

| Keys | What it does |
| --- | --- |
| Ctrl+K | palette: notes and commands |
| Ctrl+N | new note |
| Ctrl+, | settings, language and backup copy |
| Ctrl+. | focus mode |
| Ctrl+E | code block |
| Ctrl+Shift+M | comment on the line |
| Ctrl+F | find in the note |
| Ctrl+Shift+L | light / dark theme |
