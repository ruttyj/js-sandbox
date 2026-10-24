# Docs

Documentation for GE Tracker. The main [README](../README.md) covers running and deploying the
app.

## Images

`images/` holds the screenshots the README shows. They are all of the dev user's **Oathplate**
scope, a calculator for the profit on making Oathplate armour.

### `images/workbench.png`

The Scopes tab's workbench: the Data panel, the editor with the caret on a variable (its
occurrences marked and the occurrence bar at the bottom), and the sidebar with the UI section
docked above Values.

![The Scopes tab: Data panel, code editor and sidebar](images/workbench.png)

### `images/ui-panel.png`

The scope's UI panel docked full width above the editor: a form, stat tiles and tables built by
the scope's code.

![The Oathplate scope's UI panel](images/ui-panel.png)

### `images/code-editor.png`

The scope's code in the editor, with the caret on `shaleCost`: its occurrences are marked and
the occurrence bar shows its value and steps through them.

![The Oathplate scope's code in the editor](images/code-editor.png)

### `images/ai-chat.png`

The AI chat drawer after it changed the scope, with the Data panel collapsed.

![The AI chat drawer after changing the Oathplate scope](images/ai-chat.png)

To retake them, start the app in dev mode with `DEV_LOGIN=true`, sign in at
`http://localhost:3000/auth/dev`, open the Oathplate scope on the Scopes tab, and capture at a
1600×900 window. That's wide enough for the Data panel, editor and sidebar to sit side by side;
narrower windows stack the Data panel above the editor.
