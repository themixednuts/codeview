// Web Worker for parsing large JSON files off main thread

self.onmessage = (event: MessageEvent<{ type: string; text?: string }>) => {
  const { type, text } = event.data;

  if (type === 'parse' && text) {
    try {
      const start = performance.now();
      const parsed = JSON.parse(text);
      const elapsed = performance.now() - start;

      self.postMessage({
        type: 'success',
        data: parsed,
        timing: Math.round(elapsed)
      });
    } catch (error) {
      self.postMessage({
        type: 'error',
        error: error instanceof Error ? error.message : 'Failed to parse JSON'
      });
    }
  }
};
