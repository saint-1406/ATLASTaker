# Welcome to ATLAS

This is your notepad: quick, quiet and uncluttered. Everything you write saves itself.

## How it works

- Text is saved half a second after the last keystroke. There is no Save button: the bottom right corner shows that everything is already on disk.
- Notes are plain .md files that any app can open. Before every update and once a day ATLAS puts a copy of them in the backups folder, and edits that did not make it to disk are offered back at the next start.
- Choose a heading from the paragraph selector; sections appear in the contents.
- Screenshots go straight into a note: Win+Shift+S, then Ctrl+V. You can also drag a picture into the text. Click it to see it full screen.
- Ctrl+K opens the palette: search across your notes and every command. Ctrl+, opens the settings, the language among them.
- In the mood for atmosphere? Switch to the Atlas look: the note becomes a relief map and its headings become peaks.

## Writing and formatting

Use the paragraph selector for headings and the buttons for bold, italic, underline and strike. Buttons show the active format; spaces keep it active. Enter always starts a plain paragraph. Shift+Enter makes a line inside the current block. To continue a list intentionally, choose Insert → Next list item.

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

```javascript
const sections = note.split('\n').filter((line) => line.startsWith('#'));
console.log(`Sections: ${sections.length}`);
```

Ordinary paste keeps the text type. Choose a code block before pasting code. Source mode retains language highlighting and smart code paste.

## Shortcuts

| Keys | What it does |
| --- | --- |
| Ctrl+K | palette: notes and commands |
| Ctrl+Shift+P | commands only |
| Ctrl+N | new note |
| Ctrl+, | settings: language, look, theme, accent |
| Ctrl+. | focus mode |
| Ctrl+E | code block |
| Ctrl+Shift+M | comment on the line |
| Ctrl+F | find in the note |
| Ctrl+Shift+B | hide the notes list |
| Ctrl+Shift+L | light / dark theme |
| Ctrl + plus / minus | text size |
| Ctrl+click | open a link |
| Ctrl+M | atlas of notes (in the Atlas look) |
