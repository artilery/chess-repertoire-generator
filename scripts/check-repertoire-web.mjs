import { readdir, readFile, stat } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { runInNewContext } from "node:vm";
const root = resolve(process.argv[2] ?? "dist-repertoire");
const files = [];
async function walk(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = resolve(path, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Published artifacts must not contain symlinks");
    if (entry.isDirectory()) await walk(file);
    else files.push(file);
  }
}
await walk(root);
let bytes = 0;
for (const file of files) {
  const name = relative(root, file).replaceAll("\\", "/");
  if (
    !/^(?:index\.html|LICENSE\.txt|NOTICE\.txt|\.nojekyll|assets\/[\w.-]+\.(?:js|css))$/.test(name)
  )
    throw new Error(`Unexpected published file: ${name}`);
  bytes += (await stat(file)).size;
  if (
    file.endsWith(".js") &&
    /__TAURI_INTERNALS__|tauri:\/\/|127\.0\.0\.1|get_opening_knowledge_position_keys|onnxruntime|game-speed-evidence/.test(
      await readFile(file, "utf8"),
    )
  )
    throw new Error(`Desktop runtime detected in ${name}`);
}
if (bytes > 6 * 1024 * 1024)
  throw new Error("Standalone build exceeded its 6 MiB uncompressed budget");
const html = await readFile(resolve(root, "index.html"), "utf8");
const base = "/chess-repertoire-generator/";
for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const asset = match[1];
  if (!asset.startsWith(base + "assets/"))
    throw new Error(`Asset does not use the deployment base: ${asset}`);
  await stat(resolve(root, asset.slice(base.length)));
}
if (!files.some((file) => /generator\.worker-.*\.js$/.test(file)))
  throw new Error("Generation worker was not bundled");
console.log(
  `Standalone artifact verified: ${files.length} files, ${(bytes / 1024 / 1024).toFixed(2)} MiB uncompressed. No desktop runtime or unrelated assets.`,
);

// Exercise the actual compiled worker without a DOM or desktop runtime. This is
// CLI verification, not a live Chrome/Edge session.
const workerFile = files.find((file) => /generator\.worker-.*\.js$/.test(file));
let reply;
const scope = {
  postMessage: (message) => {
    reply = message;
  },
};
runInNewContext(
  await readFile(workerFile, "utf8"),
  { self: scope, TextEncoder, console },
  { timeout: 10_000 },
);
scope.onmessage({
  data: {
    id: 1,
    request: {
      kind: "generate",
      selection: { openingId: "italian-game", variationId: "giuoco-piano", side: "white" },
      coverage: "deep",
      name: "Production worker check",
      generatedAt: "2026-10-19T00:00:00Z",
    },
  },
});
if (
  reply?.error ||
  reply?.response?.kind !== "result" ||
  !reply.response.result.pgn.includes('[ZuluCoverage "deep"]') ||
  reply.response.result.games[0].nodes.length < 10
)
  throw new Error(`Compiled worker generation failed: ${reply?.error ?? "missing output"}`);
const pgn = reply.response.result.pgn;
scope.onmessage({ data: { id: 2, request: { kind: "import", pgn } } });
if (reply?.error || reply?.response?.result?.pgn !== pgn)
  throw new Error("Compiled worker PGN round trip failed");
console.log(
  "Compiled production worker: generation, inspection and PGN round trip passed without a DOM.",
);
