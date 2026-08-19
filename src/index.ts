import { net, protocol } from "electron";
import { stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".ogg": "audio/ogg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export interface RendererProtocolOptions {
  /** Custom scheme to register, e.g. "app". Defaults to "app". */
  scheme?: string;
  /** Host segment of the served origin, e.g. "bundle". Defaults to "bundle". */
  host?: string;
  /** Directory on disk that holds the built renderer bundle. */
  directory: string;
  /** File served for requests that don't resolve to a file on disk (SPA routing). Defaults to "index.html". */
  fallback?: string;
  /** Content-Security-Policy header value applied to every response. */
  contentSecurityPolicy?: string;
}

export interface RendererProtocol {
  readonly scheme: string;
  readonly host: string;
  readonly url: string;
  readonly customScheme: Electron.CustomScheme;
  /** Attach the handler, on the default session unless one is given. */
  register(session?: Electron.Session): void;
  /** Detach the handler. Pass the session it was registered on. */
  unregister(session?: Electron.Session): void;
}

export type RendererPathResult =
  | { ok: true; file: string; requested: string }
  | { ok: false; status: 400 | 403 };

function validProtocolPart(value: string, label: string): string {
  if (!/^[a-z][a-z0-9+.-]*$/i.test(value)) {
    throw new TypeError(`Invalid renderer protocol ${label}: ${value}`);
  }
  return value.toLowerCase();
}

/**
 * Resolves a request pathname to a file inside `directory`, rejecting any
 * path that would escape it (encoded traversal, encoded separators, null
 * bytes, or literal backslashes).
 */
export function resolveRendererPath(
  directory: string,
  encodedPathname: string,
  fallback = "index.html",
): RendererPathResult {
  if (/%(?:2f|5c)/i.test(encodedPathname)) return { ok: false, status: 400 };

  let requested: string;
  try {
    requested = decodeURIComponent(encodedPathname).replace(/^\/+/, "") || fallback;
  } catch {
    return { ok: false, status: 400 };
  }

  if (requested.includes("\0") || requested.includes("\\")) {
    return { ok: false, status: 400 };
  }

  const base = resolve(directory);
  const file = resolve(base, requested);
  const rel = relative(base, file);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return { ok: false, status: 403 };
  }

  return { ok: true, file, requested };
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

function withSecurityHeaders(
  headers: Headers,
  file: string,
  contentSecurityPolicy: string,
): Headers {
  headers.set("content-security-policy", contentSecurityPolicy);
  headers.set(
    "content-type",
    MIME_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
  );
  headers.set("x-content-type-options", "nosniff");
  return headers;
}

/**
 * Registers a hardened `protocol.handle` origin that serves a built Electron
 * renderer bundle from disk: confined to `directory`, GET/HEAD only, a
 * locked-down Content-Security-Policy by default, and an SPA fallback for
 * routes that don't map to a file.
 *
 * Bodies are streamed by Chromium's own `file:` loader through `net.fetch`, so
 * byte ranges, `Content-Length` and `Last-Modified` come from the platform
 * instead of being reimplemented here.
 */
export function createRendererProtocol(options: RendererProtocolOptions): RendererProtocol {
  const scheme = validProtocolPart(options.scheme ?? "app", "scheme");
  const host = validProtocolPart(options.host ?? "bundle", "host");
  const directory = resolve(options.directory);
  const fallback = options.fallback ?? "index.html";
  const contentSecurityPolicy =
    options.contentSecurityPolicy ??
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
  const fallbackResult = resolveRendererPath(directory, `/${fallback}`, fallback);
  if (!fallbackResult.ok)
    throw new TypeError("Renderer protocol fallback must stay inside directory");
  const fallbackFile = fallbackResult.file;

  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.protocol !== `${scheme}:` || url.hostname !== host || url.username || url.password) {
      return new Response("Forbidden", { status: 403 });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { allow: "GET, HEAD" },
      });
    }

    const result = resolveRendererPath(directory, url.pathname, fallback);
    if (!result.ok)
      return new Response(result.status === 400 ? "Bad request" : "Forbidden", result);

    let file = result.file;
    if (!(await isFile(file))) {
      if (extname(result.requested)) return new Response("Not found", { status: 404 });
      file = fallbackFile;
      if (!(await isFile(file))) return new Response("Not found", { status: 404 });
    }

    // Request headers are forwarded so Range requests reach the file loader.
    // The session is irrelevant for `file:` URLs (no cookies, cache or proxy),
    // so the default session's net.fetch is used regardless of where this
    // protocol was registered.
    let response: Response;
    try {
      response = await net.fetch(pathToFileURL(file).href, { headers: request.headers });
    } catch {
      return new Response("Not found", { status: 404 });
    }

    const headers = withSecurityHeaders(new Headers(response.headers), file, contentSecurityPolicy);
    if (request.method === "HEAD") {
      await response.body?.cancel();
      return new Response(null, { status: response.status, headers });
    }
    return new Response(response.body, { status: response.status, headers });
  };

  return {
    scheme,
    host,
    url: `${scheme}://${host}/`,
    customScheme: {
      scheme,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        // Chromium only caches compiled JS for custom schemes when codeCache
        // and standard are both set, which is most of this scheme's startup
        // cost on a large renderer bundle.
        codeCache: true,
      },
    },
    register: (session) => (session?.protocol ?? protocol).handle(scheme, handler),
    unregister: (session) => (session?.protocol ?? protocol).unhandle(scheme),
  };
}
