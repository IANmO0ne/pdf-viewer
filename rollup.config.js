import { cpSync, copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import deckyPlugin from "@decky/rollup";

function copyPdfjsAssets() {
  return {
    name: "copy-pdfjs-assets",
    writeBundle() {
      // Keep the release zip self-contained and reviewable: these files are copied
      // from the pinned pdfjs-dist package during build, not downloaded at runtime.
      const source = resolve("node_modules/pdfjs-dist/legacy/build/pdf.worker.min.js");
      const target = resolve("dist/pdf.worker.min.js");
      const standardFontsSource = resolve("node_modules/pdfjs-dist/standard_fonts");
      const standardFontsTarget = resolve("dist/standard_fonts");
      const cMapsSource = resolve("node_modules/pdfjs-dist/cmaps");
      const cMapsTarget = resolve("dist/cmaps");

      if (!existsSync(source)) {
        throw new Error(`Missing PDF.js worker at ${source}`);
      }
      if (!existsSync(standardFontsSource)) {
        throw new Error(`Missing PDF.js standard fonts at ${standardFontsSource}`);
      }
      if (!existsSync(cMapsSource)) {
        throw new Error(`Missing PDF.js CMaps at ${cMapsSource}`);
      }

      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
      rmSync(standardFontsTarget, { recursive: true, force: true });
      rmSync(cMapsTarget, { recursive: true, force: true });
      cpSync(standardFontsSource, standardFontsTarget, { recursive: true });
      cpSync(cMapsSource, cMapsTarget, { recursive: true });
    }
  };
}

export default deckyPlugin({
  plugins: [copyPdfjsAssets()]
});
