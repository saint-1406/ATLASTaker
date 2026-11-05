# Welcome to ATLAS

This is ATLAS for Android: notes and a reading library in one app. Everything you write saves itself.

## Where the notes live

- Notes and documents are kept in the app on this phone. Uninstalling the app deletes them.
- So make a copy now and then: the magnifier at the top → “Download all notes”. You get a .zip of .md files, and the phone asks where to save it.
- To bring notes back from files: magnifier → “Import .md”.
- If there has been no copy for more than a week, ATLAS reminds you.

## The library

- The books button at the top opens the library. It takes PDF, EPUB, FB2, DOCX, Markdown, TXT and HTML.
- Even simpler: open a file in any app and choose “Open with” or “Share” → ATLAS.
- A book opens where you stopped. A− and A+ change the text size, ☰ shows the contents, Back returns to the shelf.
- Select a passage and tap “To a note”: it becomes a quote in that book’s note.

## How it works

- Text is saved half a second after the last letter. There is no Save button: the bottom bar shows it is all there.
- Choose a heading from the paragraph selector; sections appear in the contents.
- The button at the top left is the notes list, ＋ makes a new note, the magnifier searches the notes and runs every command.
- Settings (the sliders button): theme, the Atlas look, text size and language, Russian included.

## Writing and formatting

Use the paragraph selector for headings and the buttons for bold, italic, underline and strike. Buttons show the active format; spaces keep it active. Enter always starts a plain paragraph. Shift+Enter makes a line inside the current block. To continue a list intentionally, choose Insert → Next list item.

Insert → Accordion creates a collapsible section. Edit its title, press Enter for its content, and use Paragraph after block to continue outside. Markdown source is a separate mode in the note menu or Settings → Writing.

## Tasks and comments

- [ ] Put the cursor on this line, tap the magnifier and choose “Comment on the line”
      💬 26.10.2026 18:00 · the comment lands right under the task, with the date and time
- [x] Build my own notepad

## Code

Choose Insert → Code block or press Ctrl+E. Shift+Enter adds a code line; Enter starts a plain paragraph after the block. Language highlighting and the /# syntax are available in source mode:

```python
def outline(note: str) -> list[str]:
    """The note's headings, in order."""
    return [line.lstrip("# ") for line in note.splitlines() if line.startswith("#")]
```
