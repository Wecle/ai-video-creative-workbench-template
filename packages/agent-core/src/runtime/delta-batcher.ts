export type DeltaBatcherOptions = {
  minIntervalMs?: number;
  minChars?: number;
  now?: () => number;
  onFlush: (text: string) => void;
};

export interface DeltaBatcher {
  append(text: string): void;
  flush(): void;
}

const MAX_DELTA_SIZE = 4096;

export function createDeltaBatcher(options: DeltaBatcherOptions): DeltaBatcher {
  const {
    minIntervalMs = 50,
    minChars = 64,
    now = () => Date.now(),
    onFlush,
  } = options;

  let buffer = "";
  let lastFlushTime = now();

  function flushBuffer() {
    if (buffer.length === 0) return;
    const textToSend = buffer;
    buffer = "";
    lastFlushTime = now();

    // Ensure chunks do not exceed MAX_DELTA_SIZE (4KB)
    for (let i = 0; i < textToSend.length; i += MAX_DELTA_SIZE) {
      onFlush(textToSend.slice(i, i + MAX_DELTA_SIZE));
    }
  }

  return {
    append(text: string) {
      if (!text) return;
      buffer += text;
      const currentTime = now();
      if (
        buffer.length >= minChars ||
        currentTime - lastFlushTime >= minIntervalMs
      ) {
        flushBuffer();
      }
    },
    flush() {
      flushBuffer();
    },
  };
}
