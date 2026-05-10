import { createWriteStream } from "node:fs";
import { cp, mkdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import archiver from "archiver";

const slug = "decky-pdf-viewer";
const root = resolve(".");
const outDir = join(root, "out");
const stageDir = join(outDir, slug);
const zipPath = join(outDir, `${slug}.zip`);

async function ensureExists(path) {
  await stat(path);
}

async function copyIntoStage(source, target = source) {
  const from = join(root, source);
  const to = join(stageDir, target);
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to, { recursive: true });
}

await ensureExists(join(root, "dist", "index.js"));
await ensureExists(join(root, "dist", "pdf.worker.min.js"));

await rm(outDir, { recursive: true, force: true });
await mkdir(stageDir, { recursive: true });

await copyIntoStage("plugin.json");
await copyIntoStage("package.json");
await copyIntoStage("main.py");
await copyIntoStage("LICENSE");
await copyIntoStage("dist/index.js");
await copyIntoStage("dist/pdf.worker.min.js");

const output = createWriteStream(zipPath);
const archive = archiver("zip", { store: true });

const done = new Promise((resolveDone, rejectDone) => {
  output.on("close", resolveDone);
  archive.on("error", rejectDone);
});

archive.pipe(output);
archive.directory(stageDir, slug);
await archive.finalize();
await done;

console.log(`Created ${zipPath}`);
