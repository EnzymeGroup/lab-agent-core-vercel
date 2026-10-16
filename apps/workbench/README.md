# Workbench

The Next.js app exports static assets. The Core Node HTTP server serves those assets and owns all API requests, persistence, model calls, cancellation, and validation. Run `npm run build:web` from the repository root to export and bundle the app into the installable Core package.

The browser obtains a short-lived per-server token from the same-origin bootstrap endpoint. It keeps that token in memory and attaches it to every other API request, including artifact downloads. Restarting the server requires reconnecting. The SDK transport sends only the latest user message; the server loads authoritative history.

An accepted operation continues when its browser tab closes. Use **Stop** to explicitly cancel the server operation. Restoring a session loads saved native UI messages and tool evidence without replaying tools. A completed execution and a passed delivery check are separate states.

The three desktop panes become keyboard-accessible panel tabs below 901 pixels. The saved light/dark preference uses local storage, while the selected session uses session storage. With storage disabled, both controls remain usable within the current page.
