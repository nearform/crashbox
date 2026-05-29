// crashbox spike 01 driver — dependency-free CDP harness (Node 24: global fetch + WebSocket).
//
// Serves this directory over HTTP, launches Chrome with remote debugging, runs the
// localStorage/IndexedDB write loop, samples the live counter OUT OF PROCESS (so it survives
// the renderer death), kills the renderer, reloads, and reports tail-write loss per store.
//
// Usage:
//   node 01-driver.mjs                    # crash mode: Page.crash (deterministic renderer kill)
//   node 01-driver.mjs --mode oom         # induce a real allocation-driven renderer OOM
//   node 01-driver.mjs --runs 5           # repeat N times
//
// Caveat: Page.crash is an abrupt renderer termination — a good desktop proxy for "process
// died without graceful unload", but the authoritative OOM test is iOS Safari (manual). The
// page's "induce OOM" button exercises a real allocation-driven kill if you want that path.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 9911;
const CDP_PORT = 9222;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const RUNS = Number(process.argv[process.argv.indexOf("--runs") + 1]) || 1;
const MODE = process.argv.includes("--mode")
  ? process.argv[process.argv.indexOf("--mode") + 1]
  : "crash";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- tiny static server ----
const MIME = {
  ".html": "text/html",
  ".mjs": "text/javascript",
  ".js": "text/javascript",
};
const startServer = () =>
  new Promise((resolve) => {
    const srv = createServer(async (req, res) => {
      try {
        const path = join(HERE, decodeURIComponent(req.url.split("?")[0]));
        const body = await readFile(path);
        res.writeHead(200, {
          "content-type": MIME[extname(path)] ?? "application/octet-stream",
        });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end("not found");
      }
    });
    srv.listen(PORT, () => resolve(srv));
  });

// ---- minimal CDP client over a single page target's WebSocket ----
const connectCDP = async (wsUrl) => {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error
        ? reject(new Error(JSON.stringify(msg.error)))
        : resolve(msg.result);
    } else if (msg.method) {
      (listeners.get(msg.method) ?? []).forEach((fn) => fn(msg.params));
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const on = (method, fn) =>
    listeners.set(method, [...(listeners.get(method) ?? []), fn]);
  const evaluate = async (expression) =>
    (
      await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      })
    ).result?.value;
  return { send, on, evaluate, close: () => ws.close() };
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
      /* chrome not up yet */
    }
    await sleep(100);
  }
  throw new Error("no page target");
};

const runOnce = async (cdp, base, runIdx) => {
  const url = `${base}/01-localstorage-durability.html`;
  let crashed = false;
  cdp.on("Inspector.targetCrashed", () => {
    crashed = true;
  });

  let reference = 0; // the last n we KNOW the loop reached, observed out-of-process

  if (MODE === "oom") {
    // Real allocation-driven renderer OOM. Poll __n until the renderer dies
    // (evaluate starts throwing / targetCrashed fires); last good read is the reference.
    await cdp.send("Page.navigate", { url: `${url}?auto=oom` });
    const started = Date.now();
    while (Date.now() - started < 30000 && !crashed) {
      const n = await cdp.evaluate("window.__n").catch(() => undefined);
      if (typeof n === "number") reference = Math.max(reference, n);
      else if (reference > 0) break; // evaluate failing after we'd seen progress => renderer gone
      await sleep(40);
    }
  } else {
    // Deterministic kill: spin the loop briefly, take a PRECISE final sample, then crash
    // immediately so the reference is as close as possible to the true crash-point n.
    await cdp.send("Page.navigate", { url: `${url}?auto=loop` });
    await sleep(2000);
    reference = (await cdp.evaluate("window.__n").catch(() => 0)) || 0;
    cdp.send("Page.crash").catch(() => {}); // never returns normally
  }

  for (let i = 0; i < 60 && !crashed; i++) await sleep(50);

  // Reload (no auto) and read what survived.
  await sleep(300);
  await cdp.send("Page.navigate", { url });
  let recovered;
  for (let i = 0; i < 40; i++) {
    recovered = await cdp.evaluate("window.__recovered").catch(() => undefined);
    if (recovered) break;
    await sleep(100);
  }

  // loss = reference - survived. <=0 means the store retained everything up to (or past)
  // our reference sample (no tail loss). >0 means writes were lost at the tail.
  const lsSurv = recovered?.localStorage_n ?? null;
  const idbSurv = recovered?.indexedDB_n ?? null;
  return {
    run: runIdx + 1,
    mode: MODE,
    crashed,
    reference_n: reference,
    localStorage_survived: lsSurv,
    indexedDB_survived: idbSurv,
    localStorage_tail_loss:
      lsSurv === null ? null : Math.max(0, reference - lsSurv),
    indexedDB_tail_loss:
      idbSurv === null ? null : Math.max(0, reference - idbSurv),
    localStorage_minus_indexedDB:
      lsSurv !== null && idbSurv !== null ? lsSurv - idbSurv : null,
  };
};

// ---- main ----
const srv = await startServer();
const base = `http://localhost:${PORT}`;
const profile = `/tmp/cb-spike01-profile`;
const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    `${base}/01-localstorage-durability.html`,
  ],
  { stdio: "ignore" },
);

try {
  const page = await findPageTarget();
  const cdp = await connectCDP(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Inspector.enable");

  const results = [];
  for (let i = 0; i < RUNS; i++) results.push(await runOnce(cdp, base, i));

  const version = await (
    await fetch(`http://localhost:${CDP_PORT}/json/version`)
  ).json();
  console.log(
    JSON.stringify(
      {
        browser: version.Browser,
        userAgent: version["User-Agent"],
        runs: results,
      },
      null,
      2,
    ),
  );
  cdp.close();
} finally {
  chrome.kill();
  srv.close();
}
