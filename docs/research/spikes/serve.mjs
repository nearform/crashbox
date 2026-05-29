// crashbox spike LAN server — serve the spike pages to a phone on the same Wi-Fi.
// Dependency-free. Binds 0.0.0.0 and prints the LAN URLs to open on the iPhone.
//
//   cd docs/research/spikes && node serve.mjs        # default port 8080
//   PORT=9000 node serve.mjs
//
// COOP/COEP headers are set so performance.measureUserAgentSpecificMemory() works (spike 07).

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
const MIME = {
  ".html": "text/html",
  ".mjs": "text/javascript",
  ".js": "text/javascript",
};

const lanIPs = () =>
  Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);

createServer(async (req, res) => {
  const rel = decodeURIComponent(req.url.split("?")[0]);
  try {
    const body = await readFile(
      join(HERE, rel === "/" ? "/index-list.html" : rel),
    );
    res.writeHead(200, {
      "content-type": MIME[extname(rel)] ?? "application/octet-stream",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp",
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found: " + rel);
  }
}).listen(PORT, "0.0.0.0", () => {
  const ips = lanIPs();
  console.log(`\ncrashbox spikes served on port ${PORT}`);
  console.log(`Open one of these on the iPhone (same Wi-Fi):\n`);
  for (const ip of ips) {
    console.log(
      `  http://${ip}:${PORT}/01-localstorage-durability.html   (spike 1: durability)`,
    );
    console.log(
      `  http://${ip}:${PORT}/02-ios-discard-vs-crash.html       (spike 2: discard vs crash)`,
    );
    console.log(
      `  http://${ip}:${PORT}/07-snapshot-serialization.html     (spike 7: serialization)`,
    );
    console.log("");
  }
  if (!ips.length) console.log("  (no LAN IPv4 found — check Wi-Fi)");
  console.log("Ctrl-C to stop.\n");
});
