import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import deckyPlugin from "@decky/rollup";

function copyPdfWorker() {
  return {
    name: "copy-pdfjs-worker",
    writeBundle() {
      const source = resolve("node_modules/pdfjs-dist/legacy/build/pdf.worker.min.js");
      const target = resolve("dist/pdf.worker.min.js");

      if (!existsSync(source)) {
        throw new Error(`Missing PDF.js worker at ${source}`);
      }

      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
    }
  };
}

export default deckyPlugin({
  plugins: [copyPdfWorker()]
});
