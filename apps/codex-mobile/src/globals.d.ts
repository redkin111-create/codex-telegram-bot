/// <reference types="vite/client" />

export {};


declare global {
  interface Window {
    CodexMarkdown: { render(root: HTMLElement, source: string): void };
    CodexPhotos: {
      prepare(file: File): Promise<{ name: string; mimeType: string; data: string; preview: string }>;
      max: number;
      maxBytes: number;
    };
  }
}
