export function buildUtf8Prefix(text: string): Uint32Array {
  const prefix = new Uint32Array(text.length + 1);
  let bytes = 0;
  let index = 0;
  while (index < text.length) {
    const first = text.charCodeAt(index);
    prefix[index] = bytes;
    if (first >= 0xd800 && first <= 0xdbff && index + 1 < text.length) {
      const second = text.charCodeAt(index + 1);
      if (second >= 0xdc00 && second <= 0xdfff) {
        prefix[index + 1] = bytes;
        bytes += 4;
        prefix[index + 2] = bytes;
        index += 2;
        continue;
      }
    }
    bytes += first <= 0x7f ? 1 : first <= 0x7ff ? 2 : 3;
    prefix[index + 1] = bytes;
    index += 1;
  }
  return prefix;
}

export function utf8BytesBetween(prefix: Uint32Array, start: number, end: number): number {
  const safeStart = Math.max(0, Math.min(prefix.length - 1, start));
  const safeEnd = Math.max(safeStart, Math.min(prefix.length - 1, end));
  return (prefix[safeEnd] ?? 0) - (prefix[safeStart] ?? 0);
}

export function buildLineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

export function splitSourceLines(text: string): string[] {
  return text.split(/\r?\n/);
}
