import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  handler: undefined as ((request: Request) => Promise<Response>) | undefined,
  protocol: {
    handle: vi.fn((_scheme: string, handler: (request: Request) => Promise<Response>) => {
      electron.handler = handler;
    }),
    unhandle: vi.fn(),
  },
  // Stands in for Chromium's `file:` loader: streams the file back with the
  // headers the real loader supplies, including a 206 for range requests.
  net: {
    fetch: vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const { readFile: read } = await import("node:fs/promises");
      const { fileURLToPath: toPath } = await import("node:url");
      const data = await read(toPath(url));
      const range = new Headers(init?.headers).get("range");
      if (range) {
        const partial = data.subarray(0, 4);
        return new Response(partial, {
          status: 206,
          headers: {
            "content-length": String(partial.byteLength),
            "content-range": `bytes 0-3/${data.byteLength}`,
            "content-type": "application/x-chromium-guess",
          },
        });
      }
      return new Response(data, {
        headers: {
          "content-length": String(data.byteLength),
          "content-type": "application/x-chromium-guess",
        },
      });
    }),
  },
}));

vi.mock("electron", () => ({ net: electron.net, protocol: electron.protocol }));

import { createRendererProtocol, resolveRendererPath } from "../src/index.js";

describe("renderer protocol", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "electron-renderer-protocol-"));
    await mkdir(join(directory, "assets"));
    await writeFile(join(directory, "index.html"), "<h1>app</h1>");
    await writeFile(join(directory, "assets", "app.js"), "console.log('app')");
    electron.handler = undefined;
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("confines decoded paths to the renderer directory", () => {
    expect(resolveRendererPath(directory, "/assets/app.js")).toMatchObject({
      ok: true,
      requested: "assets/app.js",
    });
    expect(resolveRendererPath(directory, "/%2e%2e/secret.txt")).toEqual({
      ok: false,
      status: 403,
    });
    expect(resolveRendererPath(directory, "/assets%2fsecret.txt")).toEqual({
      ok: false,
      status: 400,
    });
    expect(resolveRendererPath(directory, "/bad%zz")).toEqual({ ok: false, status: 400 });
  });

  it("serves assets, falls back for SPA routes, and never falls back for missing files", async () => {
    const renderer = createRendererProtocol({ directory });
    renderer.register();
    const handle = electron.handler!;

    const asset = await handle(new Request("app://bundle/assets/app.js"));
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("text/javascript");
    expect(asset.headers.get("x-content-type-options")).toBe("nosniff");
    expect(asset.headers.get("content-security-policy")).toContain("default-src 'self'");

    const route = await handle(new Request("app://bundle/settings/profile"));
    expect(route.status).toBe(200);
    expect(await route.text()).toContain("<h1>app</h1>");

    const missing = await handle(new Request("app://bundle/assets/missing.js"));
    expect(missing.status).toBe(404);
  });

  it("never reads a file the request could not resolve to", async () => {
    const renderer = createRendererProtocol({ directory });
    renderer.register();
    const handle = electron.handler!;

    await handle(new Request("app://bundle/%2e%2e/secret.txt"));
    await handle(new Request("app://bundle/assets/missing.js"));
    await handle(new Request("app://bundle/index.html", { method: "POST" }));
    expect(electron.net.fetch).not.toHaveBeenCalled();
  });

  it("serves a directory request from the fallback rather than the directory itself", async () => {
    const renderer = createRendererProtocol({ directory });
    renderer.register();
    const handle = electron.handler!;

    const response = await handle(new Request("app://bundle/assets"));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<h1>app</h1>");
  });

  it("keeps the platform's response but decides the content type itself", async () => {
    const renderer = createRendererProtocol({ directory });
    renderer.register();
    const handle = electron.handler!;

    const response = await handle(new Request("app://bundle/assets/app.js"));
    const source = await readFile(join(directory, "assets", "app.js"));
    // Content-Length comes from Chromium; the content type does not, so a
    // sniffed guess can never override the table in this package.
    expect(response.headers.get("content-length")).toBe(String(source.byteLength));
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  });

  it("forwards range requests and passes the partial response through", async () => {
    const renderer = createRendererProtocol({ directory });
    renderer.register();
    const handle = electron.handler!;

    const response = await handle(
      new Request("app://bundle/assets/app.js", { headers: { range: "bytes=0-3" } }),
    );
    expect(electron.net.fetch.mock.calls[0]?.[0]).toBe(
      pathToFileURL(join(directory, "assets", "app.js")).href,
    );
    expect(new Headers(electron.net.fetch.mock.calls[0]?.[1]?.headers).get("range")).toBe(
      "bytes=0-3",
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 0-3/18");
    expect(await response.text()).toBe("cons");
  });

  it("requires the exact app origin and read-only methods", async () => {
    const renderer = createRendererProtocol({ directory });
    renderer.register();
    const handle = electron.handler!;

    expect((await handle(new Request("app://other/index.html"))).status).toBe(403);
    expect((await handle(new Request("app://bundle/index.html", { method: "POST" }))).status).toBe(
      405,
    );

    const head = await handle(new Request("app://bundle/index.html", { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    // HEAD is only useful if it still reports the size of the body it omits.
    expect(head.headers.get("content-length")).toBe("12");
  });

  it("validates scheme, host, and fallback shape", () => {
    expect(() => createRendererProtocol({ directory, scheme: "not a scheme" })).toThrow(TypeError);
    expect(() => createRendererProtocol({ directory, host: "not a host" })).toThrow(TypeError);
    expect(() => createRendererProtocol({ directory, fallback: "../outside.html" })).toThrow(
      TypeError,
    );
  });

  it("applies a custom Content-Security-Policy", async () => {
    const renderer = createRendererProtocol({
      directory,
      contentSecurityPolicy: "default-src 'none'",
    });
    renderer.register();
    const handle = electron.handler!;

    const response = await handle(new Request("app://bundle/index.html"));
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'");
  });

  it("exposes the scheme, host, url, and privileged custom scheme", () => {
    const renderer = createRendererProtocol({ directory, scheme: "app", host: "bundle" });
    expect(renderer.scheme).toBe("app");
    expect(renderer.host).toBe("bundle");
    expect(renderer.url).toBe("app://bundle/");
    expect(renderer.customScheme).toEqual({
      scheme: "app",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        codeCache: true,
      },
    });
  });

  it("registers on a given session instead of the default one", async () => {
    const partition = {
      protocol: {
        handle: vi.fn(),
        unhandle: vi.fn(),
      },
    } as unknown as Electron.Session;

    const renderer = createRendererProtocol({ directory });
    renderer.register(partition);
    renderer.unregister(partition);

    expect(partition.protocol.handle).toHaveBeenCalledWith("app", expect.any(Function));
    expect(partition.protocol.unhandle).toHaveBeenCalledWith("app");
    expect(electron.protocol.handle).not.toHaveBeenCalled();
    expect(electron.protocol.unhandle).not.toHaveBeenCalled();
  });

  it("unregisters through the underlying protocol module", () => {
    const renderer = createRendererProtocol({ directory });
    renderer.register();
    renderer.unregister();
    expect(electron.protocol.unhandle).toHaveBeenCalledWith("app");
  });
});
