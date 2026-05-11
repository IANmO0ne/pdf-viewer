declare module "pdfjs-dist/legacy/build/pdf.js" {
  export const GlobalWorkerOptions: {
    workerSrc: string;
  };

  export function getDocument(source: unknown): {
    promise: Promise<unknown>;
    destroy?: () => Promise<void>;
  };

  export const version: string;
}
