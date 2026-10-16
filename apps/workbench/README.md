# Workbench

The Next.js app exports static assets. The Core Node HTTP server serves those assets and owns all API requests, persistence, model calls, cancellation, and validation. Run `npm run build:web` from the repository root to export and bundle the app into the installable Core package.

The browser obtains a per-process server token from the same-origin bootstrap endpoint. It keeps that token in memory and attaches it to every other API request, including artifact downloads. Restarting the server requires reconnecting. The SDK transport sends only the latest user message; the server loads authoritative history.

An accepted operation continues when its browser tab closes. Use **Stop** to explicitly cancel the server operation. Restoring a session loads saved native UI messages and tool evidence without replaying tools. A completed execution and a passed delivery check are separate states.

The three desktop panes become keyboard-accessible panel tabs below 901 pixels. The saved light/dark preference uses local storage, while the selected session uses session storage. With storage disabled, both controls remain usable within the current page.

Expand **Input files** in the Sessions pane to import a scientific text input. The server supplies the accepted extensions and size limit. Imports receive a unique, immutable project path and SHA-256. **Copy path** copies that reference; **Use for task** inserts the path into the draft, switches to Task mode, and adds an explicit input binding without submitting a turn. One project has one active operation, so imports wait for execution or validation to finish.

**Task inputs** accepts project-relative files or directories independently of the prompt. Explicit bindings override project defaults and remain visible for task turns until removed. With no bindings selected, the browser omits the override and the server uses project defaults. The server freezes the selected file set at task acceptance; adding an unrelated upload later does not enlarge that run's baseline. Chat omits task bindings and creates no task run. Enabled Python and native tools can still have host side effects in Chat; Capabilities reports each Python script's allowed modes.

Select an output filename to preview bounded CSV/TSV, JSON, Markdown, text, PNG or JPEG content. Text is escaped, Markdown raw HTML is displayed as text, and raster images use authenticated blob downloads. Unsupported active content remains available only as a saved file. Truncation is explicit; the original download remains available.

**Capabilities** shows the configured model, tool descriptions and native input schemas, skill descriptions, Python script modes, actual MCP connection status, and the file access policy. It provides no configuration editor and displays no project environment values. Run evidence separates the original delivery verdict from later rechecks, records observed file changes, and exposes input selection, frozen input hashes, versions and SKILL.md fingerprints with actual loaded flags. Historical runs without these records retain an explicit unavailable state.
