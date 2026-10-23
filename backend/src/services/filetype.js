// Content sniffing - never trust the extension or the client's MIME type alone.
import { open } from 'node:fs/promises';
import path from 'node:path';

const TEXT_EXT = new Set(['.txt', '.md', '.csv', '.text']);
const OFFICE_EXT = new Set(['.doc', '.docx', '.odt', '.rtf', '.ppt', '.pptx', '.odp', '.xls', '.xlsx', '.ods', '.html', '.htm']);

export const ACCEPTED_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.bmp', '.gif', ...TEXT_EXT, ...OFFICE_EXT];

/** @returns {Promise<{kind:'pdf'|'image'|'text'|'office', ext:string}|null>} */
export async function sniff(file, originalName) {
  const fh = await open(file, 'r');
  const buf = Buffer.alloc(4100);
  const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
  await fh.close();
  const b = buf.subarray(0, bytesRead);
  const ext = path.extname(originalName || '').toLowerCase();
  const startsWith = (...bytes) => bytes.every((v, i) => b[i] === v);

  // the PDF header may be preceded by a few junk bytes
  if (b.subarray(0, 1024).includes(Buffer.from('%PDF-'))) return { kind: 'pdf', ext: '.pdf' };
  if (startsWith(0x89, 0x50, 0x4e, 0x47)) return { kind: 'image', ext: '.png' };
  if (startsWith(0xff, 0xd8, 0xff)) return { kind: 'image', ext: '.jpg' };
  if (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return { kind: 'image', ext: '.webp' };
  if (b.subarray(0, 3).toString() === 'GIF') return { kind: 'image', ext: '.gif' };
  if (startsWith(0x49, 0x49, 0x2a, 0x00) || startsWith(0x4d, 0x4d, 0x00, 0x2a)) return { kind: 'image', ext: '.tif' };
  if (startsWith(0x42, 0x4d) && ext === '.bmp') return { kind: 'image', ext: '.bmp' };
  if (startsWith(0x50, 0x4b, 0x03, 0x04) && OFFICE_EXT.has(ext)) return { kind: 'office', ext };
  if (startsWith(0xd0, 0xcf, 0x11, 0xe0) && OFFICE_EXT.has(ext)) return { kind: 'office', ext };
  if (b.subarray(0, 5).toString() === '{\\rtf') return { kind: 'office', ext: '.rtf' };
  if ((ext === '.html' || ext === '.htm') && !b.includes(0)) return { kind: 'office', ext };
  if (TEXT_EXT.has(ext) && (!b.includes(0) || startsWith(0xff, 0xfe) || startsWith(0xfe, 0xff))) return { kind: 'text', ext };
  return null;
}
