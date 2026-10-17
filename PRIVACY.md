# Privacy and data handling

CSV does not implement an upload service, analytics client, or extension-specific telemetry collection. Normal editable views parse, search, sort, and edit files through the VS Code document and the extension's bundled code. No account or external processing service is required by CSV.

## Where processing happens

Normal editable CSV views receive the file's decoded text from VS Code. The extension parses that text with the bundled Papa Parse library, sends table content to its VS Code webview, and applies edits through VS Code's document APIs. Saving in these views uses VS Code's normal file-saving behavior and the selected file encoding.

The read-only large-file preview supports host-local UTF-8 files and reads bounded blocks directly from the saved file. It does not write the saved file.

For a normal local workspace, these operations run on your computer. In Remote SSH, WSL, Dev Containers, or another remote workspace, the extension host and files can be on that remote environment. File contents travel through your existing VS Code connection to display and edit them in the webview. “No external processing service” does not mean that a remote workspace's data stays on your local computer.

The font picker uses the bundled `font-list` package to enumerate fonts available to the extension host through operating-system helpers. It does not use an online font service.

## Actions that share information outside the table

- **Clipboard:** Copying writes the selected contents to the system clipboard; pasting reads clipboard contents supplied by the editor. Other applications, clipboard managers, and operating-system clipboard synchronization may have access to that clipboard.
- **Links:** Ctrl/Cmd+click on a recognized link asks VS Code to open its URL using your configured browser or application. Supported schemes include HTTP, HTTPS, FTP, and email links. The destination receives the URL, including any information in its path or query, according to that application's behavior. CSV does not fetch a link merely to render its text. You can disable link interaction with `csv.clickableLinks`.
- **Support:** If you attach a file, screenshot, or log to a GitHub issue, you are sharing it with that issue's audience. CSV does not submit these materials automatically.

VS Code's Marketplace connections, updates, Settings Sync, remote services, other extensions, and the browser or application used for links have their own data-handling behavior. They are separate from CSV's runtime processing.

## Logs and stored state

The extension writes diagnostic messages to the extension host's console. Routine messages include file paths/URIs, row counts, and the row/column coordinates of an edit; routine edit messages omit the cell value. Errors can still contain document or operation details, and a failed external-link operation can log its URL. Treat extension host logs as potentially containing sensitive information, especially before sharing them for support. The log location and retention are controlled by VS Code and may be in a remote environment.

CSV's code does not send those logs or cell contents to a telemetry endpoint. This statement does not describe or override VS Code's own telemetry, logging, crash reporting, or another extension's behavior. Consult your editor's privacy policy and settings for those services.

CSV stores per-file view preferences in VS Code workspace state on the extension host, keyed by the file URI: header mode, serial-index visibility, separator overrides, hidden leading rows, manual column widths, frozen rows/columns, and column filters. Filter conditions include any text you enter and may contain sensitive CSV values; Clear all filters removes the saved conditions for that file. Its webview state remembers scroll/selection positions, column widths, row heights, and zoom. View preferences and saved state can themselves contain sensitive data and metadata; they are not intended as full-document backups. VS Code independently manages the document, undo history, unsaved-file backups, autosave, and any platform synchronization you enable.

## Scope of these statements

These statements describe this repository's extension and webview implementation. The main data paths are in [`src/CsvEditorProvider.ts`](src/CsvEditorProvider.ts), [`media/main.js`](media/main.js), [`src/commands.ts`](src/commands.ts), and [`src/extension.ts`](src/extension.ts); runtime dependencies are declared in [`package.json`](package.json). They are not a promise about every VS Code component, remote host, dependency version, or installed extension. Review the version you use and your environment's policies when deciding whether it fits your data requirements.
