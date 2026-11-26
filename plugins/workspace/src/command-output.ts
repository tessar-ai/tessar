const MAX_OUTPUT_LINES = 2_000;
const LINE_FEED = 0x0a;
const UTF8_PREFIX_MASK = 0xc0;
const UTF8_CONTINUATION_PREFIX = 0x80;

type OutputStream = "stdout" | "stderr";
type OutputChunk = { stream: OutputStream; data: Buffer };

function completeLines(data: Buffer, partialHead: boolean): Buffer {
  if (!partialHead) return data;
  const newline = data.indexOf(LINE_FEED);
  return data.subarray(newline === -1 ? data.length : newline + 1);
}

function decodeTail(data: Buffer, partialHead: boolean): string {
  let start = 0;
  if (partialHead) {
    while (start < data.length && (data[start]! & UTF8_PREFIX_MASK) === UTF8_CONTINUATION_PREFIX) start++;
  }
  return data.toString("utf8", start);
}

export class CommandOutput {
  #chunks: (OutputChunk | undefined)[] = [];
  #head = 0;
  #bytes = 0;
  #truncated = false;
  #partialHead = { stdout: false, stderr: false };

  constructor(private readonly maxBytes: number) {}

  add(stream: OutputStream, data: Buffer): void {
    if (!data.length) return;
    this.#chunks.push({ stream, data });
    this.#bytes += data.length;
    this.#drop(this.#bytes - this.maxBytes);
  }

  finish(): { stdout: string; stderr: string; truncated: boolean } {
    const seen = { stdout: false, stderr: false };
    let lines = 0;
    let bytes = 0;
    // Read backwards so a final line without a newline still counts.
    tail: for (let index = this.#chunks.length - 1; index >= this.#head; index--) {
      const { stream, data } = this.#chunks[index]!;
      for (let offset = data.length - 1; offset >= 0; offset--) {
        if (!seen[stream] || data[offset] === LINE_FEED) {
          seen[stream] = true;
          if (++lines > MAX_OUTPUT_LINES) break tail;
        }
        bytes++;
      }
    }
    this.#drop(this.#bytes - bytes);

    const chunks: Record<OutputStream, Buffer[]> = { stdout: [], stderr: [] };
    for (let index = this.#head; index < this.#chunks.length; index++) {
      const { stream, data } = this.#chunks[index]!;
      chunks[stream].push(data);
    }
    const stdout = Buffer.concat(chunks.stdout);
    const stderr = Buffer.concat(chunks.stderr);
    const stdoutLines = completeLines(stdout, this.#partialHead.stdout);
    const stderrLines = completeLines(stderr, this.#partialHead.stderr);
    if (stdoutLines.length || stderrLines.length) {
      return { stdout: stdoutLines.toString(), stderr: stderrLines.toString(), truncated: this.#truncated };
    }
    return {
      stdout: decodeTail(stdout, this.#partialHead.stdout),
      stderr: decodeTail(stderr, this.#partialHead.stderr),
      truncated: this.#truncated,
    };
  }

  #drop(bytes: number): void {
    if (bytes <= 0) return;
    this.#bytes -= bytes;
    this.#truncated = true;
    while (bytes > 0) {
      const chunk = this.#chunks[this.#head]!;
      const count = Math.min(bytes, chunk.data.length);
      this.#partialHead[chunk.stream] = chunk.data[count - 1] !== LINE_FEED;
      if (count === chunk.data.length) this.#chunks[this.#head++] = undefined;
      else chunk.data = chunk.data.subarray(count);
      bytes -= count;
    }
    if (this.#head * 2 >= this.#chunks.length) {
      this.#chunks = this.#chunks.slice(this.#head);
      this.#head = 0;
    }
  }
}
