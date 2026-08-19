# electron-renderer-protocol

A hardened custom protocol for serving a built Electron renderer bundle, in place of `loadFile()` or a raw `file://` load.

- **Confined to one directory.** Every request is resolved and checked against the bundle directory: encoded traversal (`%2e%2e`), encoded separators (`%2f`, `%5c`), null bytes, and literal backslashes are all rejected before touching the filesystem.
- **Locked-down by default.** Ships a strict `Content-Security-Policy` (`default-src 'self'`, no `object-src`, no `frame-ancestors`) and `X-Content-Type-Options: nosniff` on every response. Only `GET`/`HEAD` are accepted; anything else is `405`.
- **SPA-aware.** Falls back to `index.html` (configurable) for routes that don't map to a file, without ever falling back for a request that has a file extension and is genuinely missing.
- **Streamed by the platform.** Bodies are served by Chromium's own `file:` loader through `net.fetch`, so `Content-Length`, `Last-Modified`, and byte ranges work for media and large assets without ever buffering a whole file into the main process.
- **Origin-strict.** Rejects requests whose scheme, host, or userinfo don't match exactly, so nothing else can be reached through the registered origin.

## Why not `file://` or `loadFile()`?

Loading a packaged renderer from `file://` gives it a `null` origin and disables important browser security boundaries (fetch/XHR from `file://`, some CSP directives, `SharedWorker`, etc.), and `loadFile()` offers no traversal protection if any part of the path is ever derived from user input. Serving from a real origin over a registered custom scheme (as documented in [Electron's process model guide](https://www.electronjs.org/docs/latest/tutorial/process-model)) keeps the renderer under a proper origin while this package handles the parts that are easy to get wrong: path confinement, MIME types, and default security headers.

## Install

```sh
pnpm add electron-renderer-protocol
```

`electron` is a peer dependency; this package targets Electron 25 and later, the release that introduced `protocol.handle`.

## Usage

Registering a custom scheme is a two-step Electron API: the scheme's privileges must be declared with `protocol.registerSchemesAsPrivileged` **before** the app is ready, and the request handler is attached with `protocol.handle` **after**.

```ts
import { app, BrowserWindow, protocol } from "electron";
import { join } from "node:path";
import { createRendererProtocol } from "electron-renderer-protocol";

const renderer = createRendererProtocol({
  scheme: "app",
  host: "bundle",
  directory: join(__dirname, "../renderer"),
});

// Before app.whenReady()
protocol.registerSchemesAsPrivileged([renderer.customScheme]);

app.whenReady().then(async () => {
  renderer.register();

  const window = new BrowserWindow({ webPreferences: { preload: join(__dirname, "preload.cjs") } });
  await window.loadURL(renderer.url); // "app://bundle/"
});

app.on("before-quit", () => renderer.unregister());
```

## API

### `createRendererProtocol(options)`

| Option                  | Type     | Default        | Description                                                       |
| ----------------------- | -------- | -------------- | ----------------------------------------------------------------- |
| `directory`             | `string` | —              | Directory on disk holding the built renderer bundle. Required.    |
| `scheme`                | `string` | `"app"`        | Custom scheme to register. Must be a valid URI scheme.            |
| `host`                  | `string` | `"bundle"`     | Host segment of the served origin. Must be a valid host token.    |
| `fallback`              | `string` | `"index.html"` | File served for requests that don't resolve to a file on disk.    |
| `contentSecurityPolicy` | `string` | see below      | `Content-Security-Policy` header value applied to every response. |

Default CSP:

```
default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'
```

Returns a `RendererProtocol`:

- `scheme`, `host`, `url` — the registered origin, e.g. `"app://bundle/"`.
- `customScheme` — pass to `protocol.registerSchemesAsPrivileged` before the app is ready. It declares the scheme as standard, secure, fetchable, CORS-enabled, and code-cached, so Chromium keeps compiled JavaScript for the bundle across launches.
- `register()` — attach the handler via `protocol.handle`. Call after `app.whenReady()`.
- `unregister()` — detach the handler via `protocol.unhandle`. Call on shutdown.

### `resolveRendererPath(directory, encodedPathname, fallback?)`

The path-confinement logic used internally by `createRendererProtocol`, exported for direct testing or reuse. Returns `{ ok: true, file, requested }` or `{ ok: false, status: 400 | 403 }`.

## License

MIT
