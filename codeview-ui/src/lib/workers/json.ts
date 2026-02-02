// Web Worker for parsing large JSON files off main thread

import { Result } from 'better-result';

self.onmessage = (event: MessageEvent<{ type: string; text?: string }>) => {
  const { type, text } = event.data;

  if (type === 'parse' && text) {
    const start = performance.now();
    const result = Result.try(() => JSON.parse(text));
    const elapsed = performance.now() - start;

    if (result.isOk()) {
      self.postMessage({
        type: 'success',
        data: result.value,
        timing: Math.round(elapsed)
      });
    } else {
      const err = result.error;
      self.postMessage({
        type: 'error',
        error: err instanceof Error ? err.message : 'Failed to parse JSON'
      });
    }
  }
};
