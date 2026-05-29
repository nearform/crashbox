// crashbox spike 07 driver — runs the snapshot-serialization benchmark page in Chrome via CDP
// and prints window.__results. Dependency-free (Node 24 global fetch + WebSocket).
//
// Serves with COOP/COEP headers so crossOriginIsolated === true and
// performance.measureUserAgentSpecificMemory() is available.
//
//   node 07-driver.mjs

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 9912;
const CDP_PORT = 9223;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { ".html": "text/html", ".mjs": "text/javascript" };

const startServer = () =>
  new Promise((resolve) => {
    const srv = createServer(async (req, res) => {
      try {
        const body = await readFile(
          join(HERE, decodeURIComponent(req.url.split("?")[0])),
        );
        res.writeHead(200, {
          "content-type": MIME[extname(req.url)] ?? "application/octet-stream",
          // enable crossOriginIsolated for measureUserAgentSpecificMemory:
          "cross-origin-opener-policy": "same-origin",
          "cross-origin-embedder-policy": "require-corp",
        });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end("not found");
      }
    });
    srv.listen(PORT, () => resolve(srv));
  });

const connectCDP = async (wsUrl) => {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let nextId = 1;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) =>
    (
      await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      })
    ).result?.value;
  return { send, evaluate, close: () => ws.close() };
};

const findPageTarget = async () => {
  for (let i = 0; i < 50; i++) {
    try {
      const targets = await (
        await fetch(`http://localhost:${CDP_PORT}/json`)
      ).json();
      const page = targets.find(
        (t) => t.type === "page" && t.webSocketDebuggerUrl,
      );
      if (page) return page;
    } catch {
      /* not up */
    }
    await sleep(100);
  }
  throw new Error("no page target");
};

const srv = await startServer();
const url = `http://localhost:${PORT}/07-snapshot-serialization.html`;
const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=/tmp/cb-spike07-profile`,
    "--no-first-run",
    "--no-default-browser-check",
    url,
  ],
  { stdio: "ignore" },
);

try {
  const page = await findPageTarget();
  const cdp = await connectCDP(page.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url });

  let results;
  for (let i = 0; i < 120; i++) {
    results = await cdp.evaluate("window.__results").catch(() => undefined);
    if (results) break;
    await sleep(150);
  }
  console.log(JSON.stringify(results ?? { error: "no results" }, null, 2));
  cdp.close();
} finally {
  chrome.kill();
  srv.close();
}
