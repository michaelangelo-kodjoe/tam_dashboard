// File reading for the MOCK adapter's import: content sniffing, CSV reader/writer, a small xlsx
// reader/writer. Mirrors what the backend reader enforces (docs/04_API_CONTRACT.md §10, D-38/D-47,
// csv amendment) so DEV mock mode behaves like the real server. Never evaluates anything: every
// cell is data. Lives in src/data; components never import it.
import type { ImportFormat } from '../types';

export const MAX_BYTES = 5 * 1024 * 1024;
export const MAX_ROWS = 500;
export const SCAN_LIMIT = 10_000;
export const COLUMNS = ['Account name', 'BPID', 'Products', 'Status', 'Next contact date', 'Notes'] as const;
export type Cell = { v: string; formula?: boolean };
export type Grid = Cell[][];

export class FileRefusal extends Error {
  constructor(public reason: string, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

export async function readBytes(file: Blob): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') return new Uint8Array(await file.arrayBuffer());
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(new Uint8Array(r.result as ArrayBuffer));
    r.onerror = () => rej(r.error);
    r.readAsArrayBuffer(file);
  });
}

// ---- sniffing ----------------------------------------------------------------------------------
export interface Sniffed { format: ImportFormat; notes: string[] }

/** Content decides; the extension only has to be .xlsx or .csv (anything else is refused outright). */
export function sniff(name: string, bytes: Uint8Array): Sniffed {
  const ext = /\.([^.\\/]+)$/.exec(name.trim())?.[1]?.toLowerCase() ?? '';
  if (ext !== 'xlsx' && ext !== 'csv') throw new FileRefusal('unsupported_type', 'Only .xlsx and .csv files can be imported.');
  if (bytes.length > MAX_BYTES) throw new FileRefusal('too_large', 'This file is larger than 5 MB. Split it and import it in parts.');
  if (bytes.length === 0) throw new FileRefusal('corrupt', 'This file is empty.');
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4;
  if (zip) return { format: 'xlsx', notes: ext === 'csv' ? ['The file name ends in .csv but the content is an Excel workbook. It was read as .xlsx.'] : [] };
  const ole = bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
  if (ole) throw new FileRefusal('not_xlsx', 'This is an old Excel (.xls) or encrypted file. Save it as .xlsx or .csv and try again.');
  const utf16 = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff); // Excel's "Unicode Text"
  const head = bytes.subarray(0, Math.min(bytes.length, 8192));
  if (!utf16) {
    for (const b of head) if (b === 0 || b < 9 || (b > 13 && b < 32)) throw new FileRefusal('not_csv', 'This file is not a spreadsheet or CSV text file.');
  }
  return { format: 'csv', notes: ext === 'xlsx' ? ['The file name ends in .xlsx but the content is CSV text. It was read as .csv.'] : [] };
}

// ---- CSV ---------------------------------------------------------------------------------------
export interface CsvRead { grid: Grid; encoding: 'UTF-8' | 'UTF-8 (with BOM)' | 'UTF-16' | 'Windows-1252'; delimiter: 'comma' | 'semicolon' | 'tab' | 'pipe' }
const DELIM = { comma: ',', semicolon: ';', tab: '\t', pipe: '|' } as const;

export function decodeCsv(bytes: Uint8Array): { text: string; encoding: CsvRead['encoding'] } {
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'UTF-16' };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'UTF-16' };
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return { text: bom ? text.slice(1) : text, encoding: bom ? 'UTF-8 (with BOM)' : 'UTF-8' };
  } catch {
    // Windows-1252 only when the bytes are not valid UTF-8
    let s = '';
    for (const b of bytes) s += b >= 0x80 && b <= 0x9f ? (W1252[b - 0x80] ?? '�') : String.fromCharCode(b);
    return { text: s, encoding: 'Windows-1252' };
  }
}
const W1252 = '€�‚ƒ„…†‡ˆ‰Š‹Œ�Ž��‘’“”•–—˜™š›œ�žŸ'.split('');

/** The first record (outside quotes) decides: the most frequent of , ; tab | wins; a tie or none means comma. */
export function detectDelimiter(text: string): CsvRead['delimiter'] {
  let q = false;
  const n = { comma: 0, semicolon: 0, tab: 0, pipe: 0 };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') q = !q;
    else if (!q && (ch === '\n' || ch === '\r')) break;
    else if (!q && ch === ',') n.comma++;
    else if (!q && ch === ';') n.semicolon++;
    else if (!q && ch === '\t') n.tab++;
    else if (!q && ch === '|') n.pipe++;
  }
  let best: CsvRead['delimiter'] = 'comma';
  for (const k of ['semicolon', 'tab', 'pipe'] as const) if (n[k] > n[best]) best = k;
  return best;
}

export function parseCsv(bytes: Uint8Array): CsvRead {
  const { text, encoding } = decodeCsv(bytes);
  const delimiter = detectDelimiter(text);
  const sep = DELIM[delimiter];
  const grid: Grid = [];
  let row: Cell[] = [];
  let cur = '';
  let q = false;
  let wasQuoted = false;
  const endCell = () => { row.push({ v: unapostrophe(cur, wasQuoted) }); cur = ''; wasQuoted = false; };
  const endRow = () => { endCell(); grid.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch;
    } else if (ch === '"' && cur === '') { q = true; wasQuoted = true; }
    else if (ch === sep) endCell();
    else if (ch === '\r') { if (text[i + 1] === '\n') i++; endRow(); }
    else if (ch === '\n') endRow();
    else cur += ch;
    if (grid.length > SCAN_LIMIT) break;
  }
  if (q) throw new FileRefusal('corrupt', 'This CSV has an unclosed quote.');
  if (cur !== '' || row.length > 0) endRow();
  return { grid, encoding, delimiter };
}
/** The skipped-rows CSV prefixes = + - @ with an apostrophe; reading it back removes that apostrophe. */
function unapostrophe(v: string, _quoted: boolean): string {
  return /^'[=+\-@\t\r]/.test(v) ? v.slice(1) : v;
}

/** CSV output: UTF-8 with BOM (Excel-friendly); = + - @ at the start of a cell get a leading apostrophe. */
export function neutralize(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}
export function toCsv(rows: string[][], delimiter = ','): Blob {
  // UTF-8 with BOM, comma separated, like the backend's skipped file
  const esc = (v: string) => (/[",;\r\n]/.test(v) || v !== v.trim() ? `"${v.replace(/"/g, '""')}"` : v);
  const body = rows.map((r) => r.map((c) => esc(neutralize(c))).join(delimiter)).join('\r\n') + '\r\n';
  return new Blob(['﻿', body], { type: 'text/csv;charset=utf-8' });
}

// ---- xlsx (minimal) -----------------------------------------------------------------------------
const te = new TextEncoder();
const td = new TextDecoder();
const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

interface ZipEntry { name: string; method: number; csize: number; usize: number; offset: number; flags: number }

function zipEntries(b: Uint8Array): ZipEntry[] {
  let e = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65_557); i--) if (u32(b, i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new FileRefusal('corrupt', 'This workbook is damaged or is not a real .xlsx file.');
  const n = u16(b, e + 10);
  if (n > 200) throw new FileRefusal('zip_unsafe', 'This workbook has too many internal parts.');
  const out: ZipEntry[] = [];
  let p = u32(b, e + 16);
  for (let i = 0; i < n; i++) {
    if (u32(b, p) !== 0x02014b50) throw new FileRefusal('corrupt', 'This workbook is damaged or is not a real .xlsx file.');
    const nl = u16(b, p + 28), el = u16(b, p + 30), cl = u16(b, p + 32);
    const name = td.decode(b.subarray(p + 46, p + 46 + nl));
    out.push({ name, method: u16(b, p + 10), csize: u32(b, p + 20), usize: u32(b, p + 24), offset: u32(b, p + 42), flags: u16(b, p + 8) });
    p += 46 + nl + el + cl;
  }
  return out;
}

async function entryText(b: Uint8Array, z: ZipEntry): Promise<string> {
  const nl = u16(b, z.offset + 26), el = u16(b, z.offset + 28);
  const data = b.subarray(z.offset + 30 + nl + el, z.offset + 30 + nl + el + z.csize);
  if (z.method === 0) return td.decode(data);
  if (z.method !== 8) throw new FileRefusal('corrupt', 'This workbook uses an unsupported compression.');
  const DS = (globalThis as unknown as { DecompressionStream?: new (f: string) => TransformStream }).DecompressionStream;
  if (!DS) throw new FileRefusal('corrupt', 'This browser cannot read compressed workbooks.');
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DS('deflate-raw'));
  return new Response(stream).text();
}

const attr = (tag: string, a: string) => new RegExp(`${a}="([^"]*)"`).exec(tag)?.[1];
const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(+d)).replace(/&amp;/g, '&');
const colIndex = (ref: string) => [...ref.replace(/\d+/g, '')].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

export interface XlsxRead { sheet: string; grid: Grid }

export async function parseXlsx(bytes: Uint8Array): Promise<XlsxRead> {
  const entries = zipEntries(bytes);
  const names = new Set(entries.map((e) => e.name));
  if (entries.some((e) => /vbaProject\.bin$/i.test(e.name))) throw new FileRefusal('macros', 'This workbook contains macros. Save it as a plain .xlsx and try again.');
  if (entries.some((e) => /^xl\/externalLinks\//i.test(e.name))) throw new FileRefusal('external_links', 'This workbook links to other files. Remove the links and try again.');
  if (entries.some((e) => /^xl\/(embeddings|activeX)\//i.test(e.name) || /\.bin$/i.test(e.name))) throw new FileRefusal('embedded_objects', 'This workbook contains embedded objects. Remove them and try again.');
  if (entries.some((e) => (e.flags & 1) !== 0)) throw new FileRefusal('encrypted', 'This workbook is encrypted. Remove the password and try again.');
  if (entries.some((e) => e.usize > 20 * 1024 * 1024 || (e.csize > 0 && e.usize / e.csize > 100))) throw new FileRefusal('zip_unsafe', 'This workbook cannot be read safely.');
  if (!names.has('xl/workbook.xml')) throw new FileRefusal('corrupt', 'This is not a real .xlsx workbook.');
  const get = async (n: string) => { const z = entries.find((e) => e.name === n); return z ? entryText(bytes, z) : null; };
  const wb = (await get('xl/workbook.xml'))!;
  if (/<!DOCTYPE|<!ENTITY/i.test(wb)) throw new FileRefusal('xml_unsafe', 'This workbook cannot be read safely.');
  const rels = (await get('xl/_rels/workbook.xml.rels')) ?? '';
  const sheets = [...wb.matchAll(/<sheet\b[^>]*>/g)].map((m) => ({ name: unxml(attr(m[0], 'name') ?? ''), rid: attr(m[0], 'r:id') ?? '' }));
  const hit = sheets.find((s) => s.name.trim().toLowerCase() === 'accounts');
  if (!hit) throw new FileRefusal('sheet_missing', `No sheet named "Accounts" was found. Sheets in this file: ${sheets.map((s) => s.name).join(', ') || 'none'}.`, { sheets: sheets.map((s) => s.name) });
  const rel = [...rels.matchAll(/<Relationship\b[^>]*>/g)].find((m) => attr(m[0], 'Id') === hit.rid);
  const target = (attr(rel?.[0] ?? '', 'Target') ?? '').replace(/^\/?(xl\/)?/, 'xl/');
  const xml = await get(target);
  if (xml == null) throw new FileRefusal('corrupt', 'This is not a real .xlsx workbook.');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new FileRefusal('xml_unsafe', 'This workbook cannot be read safely.');
  const sstXml = (await get('xl/sharedStrings.xml')) ?? '';
  const sst = [...sstXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => unxml([...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
  const stylesXml = (await get('xl/styles.xml')) ?? '';
  const customDate = new Set([...stylesXml.matchAll(/<numFmt\b[^>]*>/g)].filter((m) => /[ymd]/i.test((attr(m[0], 'formatCode') ?? '').replace(/"[^"]*"|\[[^\]]*\]/g, ''))).map((m) => attr(m[0], 'numFmtId')));
  const xfBlock = /<cellXfs\b[\s\S]*?<\/cellXfs>/.exec(stylesXml)?.[0] ?? '';
  const dateXf = [...xfBlock.matchAll(/<xf\b[^>]*>/g)].map((m) => { const id = attr(m[0], 'numFmtId') ?? '0'; return (+id >= 14 && +id <= 22) || (+id >= 45 && +id <= 47) || customDate.has(id); });

  const grid: Grid = [];
  for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const r = +(attr(rm[1], 'r') ?? grid.length + 1) - 1;
    if (r >= SCAN_LIMIT) break;
    const cells: Cell[] = [];
    for (const cm of (rm[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const c = colIndex(attr(cm[1], 'r') ?? 'A1');
      const t = attr(cm[1], 't');
      const body = cm[2] ?? '';
      const f = /<f\b/.test(body);
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let val = '';
      if (t === 's') val = sst[+(v ?? -1)] ?? '';
      else if (t === 'inlineStr') val = unxml([...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));
      else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
      else if (v !== undefined) {
        val = unxml(v);
        if (t === undefined || t === 'n') {
          const s = +(attr(cm[1], 's') ?? 0);
          if (dateXf[s] && /^-?\d+(\.\d+)?$/.test(val)) val = new Date(Date.UTC(1899, 11, 30) + Math.floor(+val) * 86_400_000).toISOString().slice(0, 10);
        }
      }
      while (cells.length < c) cells.push({ v: '' });
      cells[c] = { v: val, formula: f };
    }
    while (grid.length < r) grid.push([]);
    grid[r] = cells;
  }
  return { sheet: hit.name, grid };
}

// ---- xlsx writer (template and skipped rows in mock mode) ------------------------------------------
function crc32(b: Uint8Array): number {
  let c, crc = 0xffffffff;
  for (let i = 0; i < b.length; i++) {
    c = (crc ^ b[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Stored (uncompressed) zip; used by the writer and by tests to build crafted files. */
export function zipStore(files: Record<string, string | Uint8Array>): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let off = 0;
  const w16 = (n: number) => [n & 255, (n >> 8) & 255];
  const w32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
  for (const [name, content] of Object.entries(files)) {
    const nm = te.encode(name);
    const data = typeof content === 'string' ? te.encode(content) : content;
    const crc = crc32(data);
    const local = Uint8Array.from([...w32(0x04034b50), ...w16(20), ...w16(0), ...w16(0), ...w16(0), ...w16(0), ...w32(crc), ...w32(data.length), ...w32(data.length), ...w16(nm.length), ...w16(0), ...nm]);
    central.push(Uint8Array.from([...w32(0x02014b50), ...w16(20), ...w16(20), ...w16(0), ...w16(0), ...w16(0), ...w16(0), ...w32(crc), ...w32(data.length), ...w32(data.length), ...w16(nm.length), ...w16(0), ...w16(0), ...w16(0), ...w16(0), ...w32(0), ...w32(off), ...nm]));
    parts.push(local, data);
    off += local.length + data.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = Uint8Array.from([...w32(0x06054b50), ...w16(0), ...w16(0), ...w16(central.length), ...w16(central.length), ...w32(cdSize), ...w32(off), ...w16(0)]);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of all) { out.set(p, o); o += p.length; }
  return out;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** One `Accounts` sheet of text cells (inline strings, never formulas). */
export function writeXlsx(rows: string[][]): Uint8Array {
  const colName = (i: number) => String.fromCharCode(65 + i);
  const sheet = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows
    .map((r, ri) => `<row r="${ri + 1}">${r.map((c, ci) => (c === '' ? '' : `<c r="${colName(ci)}${ri + 1}" t="inlineStr"><is><t xml:space="preserve">${esc(c)}</t></is></c>`)).join('')}</row>`)
    .join('')}</sheetData></worksheet>`;
  return zipStore({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Accounts" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': sheet,
  });
}

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export function xlsxBlob(rows: string[][]): Blob {
  return new Blob([writeXlsx(rows) as BlobPart], { type: XLSX_TYPE });
}

// ---- header mapping -----------------------------------------------------------------------------
const ALIASES: Record<string, (typeof COLUMNS)[number]> = {
  'account name': 'Account name', account: 'Account name', name: 'Account name', 'client name': 'Account name', client: 'Account name',
  bpid: 'BPID', 'bp id': 'BPID',
  products: 'Products', product: 'Products',
  status: 'Status',
  'next contact date': 'Next contact date', 'next contact': 'Next contact date', 'next client touch': 'Next contact date', 'next touch': 'Next contact date',
  notes: 'Notes', note: 'Notes', comments: 'Notes',
};
export const HEADER_ALIASES = ALIASES;
export function headerKey(h: string): string {
  return h.normalize('NFC').replace(/\s+/g, ' ').trim().replace(/\*$/, '').trim().toLowerCase();
}
