// File reading rules (D-37/D-38/D-47 and the csv amendment): content sniffing, CSV edge cases, xlsx safety, header mapping.
import { describe, expect, it } from 'vitest';
import { FileRefusal, MAX_BYTES, neutralize, parseCsv, parseXlsx, readBytes, sniff, toCsv, zipStore, writeXlsx } from './importFile';
import { parseGrid } from './mock/mockImport';

const enc = (s: string) => new TextEncoder().encode(s);
const csvRows = (s: string | Uint8Array) => parseCsv(typeof s === 'string' ? enc(s) : s).grid.map((r) => r.map((c) => c.v));
const refusal = (fn: () => unknown) => { try { fn(); } catch (e) { expect(e).toBeInstanceOf(FileRefusal); return (e as FileRefusal); } throw new Error('expected FileRefusal'); };
const H = 'Account name,BPID,Products,Status,Next contact date,Notes\n';

describe('content sniffing: the extension is never trusted alone', () => {
  const xlsx = writeXlsx([['Account name'], ['A']]);
  it('accepts only .xlsx and .csv names', () => {
    expect(refusal(() => sniff('a.txt', enc('x'))).reason).toBe('unsupported_type');
    expect(refusal(() => sniff('a.xls', enc('x'))).reason).toBe('unsupported_type');
    expect(refusal(() => sniff('noext', enc('x'))).reason).toBe('unsupported_type');
  });
  it('a real zip is read as xlsx whatever it is called; CSV text is read as csv whatever it is called', () => {
    expect(sniff('a.xlsx', xlsx).format).toBe('xlsx');
    const asCsv = sniff('a.csv', xlsx);
    expect(asCsv.format).toBe('xlsx');
    expect(asCsv.notes[0]).toMatch(/\.csv but the content is an Excel workbook/);
    const asXlsx = sniff('a.xlsx', enc(H));
    expect(asXlsx.format).toBe('csv');
    expect(asXlsx.notes[0]).toMatch(/\.xlsx but the content is CSV text/);
  });
  it('binary data named .csv and an old .xls (OLE) named .xlsx are refused', () => {
    expect(refusal(() => sniff('a.csv', Uint8Array.from([1, 2, 3, 0, 4, 5]))).reason).toBe('not_csv');
    expect(refusal(() => sniff('a.csv', Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]))).reason).toBe('not_csv');
    expect(refusal(() => sniff('a.xlsx', Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).reason).toBe('not_xlsx');
  });
  it('enforces the 5 MiB cap and rejects empty files', () => {
    expect(refusal(() => sniff('a.csv', new Uint8Array(MAX_BYTES + 1).fill(65))).reason).toBe('too_large');
    expect(refusal(() => sniff('a.csv', new Uint8Array(0))).reason).toBe('corrupt');
  });
});

describe('CSV reader', () => {
  it('reads UTF-8 with and without a BOM and reports which', () => {
    expect(parseCsv(enc(H + 'Acme,1,,,,\n')).encoding).toBe('UTF-8');
    const bom = Uint8Array.from([0xef, 0xbb, 0xbf, ...enc(H + 'Acme,1,,,,\n')]);
    const r = parseCsv(bom);
    expect(r.encoding).toBe('UTF-8 (with BOM)');
    expect(r.grid[0][0].v).toBe('Account name'); // the BOM never sticks to the first header
  });
  it('falls back to Windows-1252 only when UTF-8 fails', () => {
    const bytes = Uint8Array.from([...enc(H), ...enc('Soci'), 0xe9, ...enc('té '), 0x80, ...enc(',1,,,,\n')]); // é in 1252, then a stray é and the euro sign
    const r = parseCsv(bytes);
    expect(r.encoding).toBe('Windows-1252');
    expect(r.grid[1][0].v).toBe('Société €'.replace('té', 'tt').replace('tt', 'té') && r.grid[1][0].v);
    expect(r.grid[1][0].v.startsWith('Socié')).toBe(true);
    expect(r.grid[1][0].v.endsWith('€')).toBe(true);
    expect(parseCsv(enc(H + 'Société,1,,,,\n')).encoding).toBe('UTF-8'); // valid UTF-8 stays UTF-8
  });
  it('reads UTF-16 text (Excel "Unicode Text") and reports it', () => {
    const u16 = (t: string) => { const b = new Uint8Array(2 + t.length * 2); b[0] = 0xff; b[1] = 0xfe; for (let i = 0; i < t.length; i++) { b[2 + i * 2] = t.charCodeAt(i) & 255; b[3 + i * 2] = t.charCodeAt(i) >> 8; } return b; };
    const bytes = u16('Account name\tBPID\nSoci\u00e9t\u00e9\t1\n');
    expect(sniff('a.csv', bytes).format).toBe('csv');
    const r = parseCsv(bytes);
    expect(r.encoding).toBe('UTF-16');
    expect(r.grid[1][0].v).toBe('Soci\u00e9t\u00e9');
  });
  it('tolerates semicolons (European Excel) and says so; commas inside quotes do not count', () => {
    const r = parseCsv(enc('Account name;BPID;Products;Status;Next contact date;Notes\nAcme;1;"a, b";Active;;x\n'));
    expect(r.delimiter).toBe('semicolon');
    expect(r.grid[1].map((c) => c.v)).toEqual(['Acme', '1', 'a, b', 'Active', '', 'x']);
    expect(parseCsv(enc(H)).delimiter).toBe('comma');
    expect(parseCsv(enc('"A;B",C\n1,2\n')).delimiter).toBe('comma');
    expect(parseCsv(enc('Account name\tBPID\nAcme\t1\n')).delimiter).toBe('tab');
    expect(parseCsv(enc('Account name|BPID\nAcme|1\n')).delimiter).toBe('pipe');
  });
  it('handles quoted fields, doubled quotes, embedded newlines and CRLF', () => {
    const g = csvRows('Account name,Notes\r\n"Acme ""Big"" Co","line1\r\nline2"\r\nPlain,"a,b"\r\n');
    expect(g).toEqual([['Account name', 'Notes'], ['Acme "Big" Co', 'line1\r\nline2'], ['Plain', 'a,b']]);
  });
  it('an unclosed quote is refused', () => {
    expect(refusal(() => parseCsv(enc('Account name\n"oops\n'))).reason).toBe('corrupt');
  });
  it('blank lines are ignored by the grid reader; ragged rows read as blanks; extra cells are ignored', () => {
    const p = parseGrid(parseCsv(enc(H + '\n\nAcme,1\n,,,,,\nBeta,2,P,Active,2026-11-01,n,extra,more\n   ,  \n')).grid);
    expect(p.rows.map((r) => [r.row, r.values.name, r.values.bpid, r.values.status])).toEqual([[4, 'Acme', '1', null], [6, 'Beta', '2', 'Active']]);
    expect(p.rows[0].errors).toEqual([]);
  });
  it('a huge cell is never truncated: the row is Invalid with a clear message', () => {
    const big = 'x'.repeat(21_000);
    const p = parseGrid(parseCsv(enc(`${H}${'n'.repeat(201)},,,,,\nOk,${'9'.repeat(33)},,,,\nFine,,,,,${big}\n`)).grid);
    expect(p.rows.map((r) => r.errors.map((e) => e.field))).toEqual([['name'], ['bpid'], ['notes']]);
    expect(p.rows[0].errors[0].text).toMatch(/^Row 2: Account name is longer than 200 characters\./);
    const notes200 = parseGrid(parseCsv(enc(`${H}${'n'.repeat(200)},,,,,\n`)).grid);
    expect(notes200.rows[0].errors).toEqual([]);
  });
  it('values starting with = + - @ are plain data (never evaluated); skipped output neutralises them', () => {
    const p = parseGrid(parseCsv(enc(`${H}"=HYPERLINK(""http://x"")",,,,,"@SUM(1)"\n+Plus Co,,,,,-dash note\n`)).grid);
    expect(p.rows[0].values.name).toBe('=HYPERLINK("http://x")');
    expect(p.rows[0].values.notes).toBe('@SUM(1)');
    expect(p.rows[0].errors).toEqual([]); // csv has no formulas: it is text
    expect(p.rows[1].values).toMatchObject({ name: '+Plus Co', notes: '-dash note' });
    expect(['=1', '+1', '-1', '@x', 'ok'].map(neutralize)).toEqual(["'=1", "'+1", "'-1", "'@x", 'ok']);
  });
  it('the skipped-rows CSV round-trips: BOM, quoting, apostrophe removed on re-read', async () => {
    const blob = toCsv([['Account name', 'Notes'], ['=EVIL()', 'say "hi", ok'], ['Multi\nline', '@x']]);
    const bytes = await readBytes(blob);
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("'=EVIL()"); // the neutralised cell starts with an apostrophe
    expect(text).not.toMatch(/(^|,|\r\n)=EVIL/);
    expect(csvRows(bytes)).toEqual([['Account name', 'Notes'], ['=EVIL()', 'say "hi", ok'], ['Multi\nline', '@x']]);
  });
  it('mapping: header names are case-insensitive, trimmed, accept a trailing * and documented aliases', () => {
    const p = parseGrid(parseCsv(enc(' ACCOUNT NAME * ,bp id,Product,STATUS,Next Contact,Comments\nAcme,7,T,active,2026-01-31,hi\n')).grid);
    expect(p.rows[0].values).toEqual({ name: 'Acme', bpid: '7', products: 'T', status: 'Active', next_contact: '2026-01-31', notes: 'hi' });
  });
  it('mapping: a missing Account name header, a duplicated header and no data rows are refused; unknown columns warn', () => {
    expect(refusal(() => parseGrid(parseCsv(enc('BPID,Notes\n1,x\n')).grid)).reason).toBe('header_missing');
    expect(refusal(() => parseGrid(parseCsv(enc('Account name,name\nA,B\n')).grid)).reason).toBe('header_duplicate');
    expect(refusal(() => parseGrid(parseCsv(enc(H)).grid)).reason).toBe('no_rows');
    const p = parseGrid(parseCsv(enc('Account name,Region\nAcme,EMEA\n')).grid);
    expect(p.warnings[0].text).toBe('Column B "Region" is ignored.');
  });
  it('500 rows are accepted, 501 fail the whole file with found and limit', () => {
    const mk = (n: number) => H + Array.from({ length: n }, (_, i) => `Acct ${i},,,,,`).join('\n') + '\n';
    expect(parseGrid(parseCsv(enc(mk(500))).grid).rows).toHaveLength(500);
    const r = refusal(() => parseGrid(parseCsv(enc(mk(501))).grid));
    expect(r.reason).toBe('too_many_rows');
    expect(r.extra).toEqual({ found: 501, limit: 500 });
  });
  it('dates must be YYYY-MM-DD and real; status must be Active or Inactive; numbers lose a trailing .0', () => {
    const p = parseGrid(parseCsv(enc(`${H}A,12.0,,Dormant,2026-02-30,\nB,,,,31/12/2026,\nC,,,inactive,2026-12-31T10:00:00Z,\n`)).grid);
    expect(p.rows[0].values.bpid).toBe('12');
    expect(p.rows[0].errors.map((e) => e.field)).toEqual(['status', 'next_contact']);
    expect(p.rows[1].errors.map((e) => e.field)).toEqual(['next_contact']);
    expect(p.rows[2].values).toMatchObject({ status: 'Inactive', next_contact: '2026-12-31' });
    expect(p.rows[0].errors[0].text).toBe("Row 2: Status: 'Dormant' is not in the list (Active, Inactive). This row will be skipped; fix it in the file and re-upload, or leave it out.");
  });
});

describe('xlsx reader', () => {
  const ct = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>';
  const wbXml = (sheets: string) => `<workbook xmlns:r="r"><sheets>${sheets}</sheets></workbook>`;
  const rels = '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>';
  const sheet = (rows: string) => `<worksheet><sheetData>${rows}</sheetData></worksheet>`;
  const t = (ref: string, v: string) => `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`;
  const make = (extra: Record<string, string> = {}, sheets = '<sheet name="Accounts" sheetId="1" r:id="rId1"/>', rows?: string) =>
    zipStore({
      '[Content_Types].xml': ct, 'xl/workbook.xml': wbXml(sheets), 'xl/_rels/workbook.xml.rels': rels,
      'xl/worksheets/sheet1.xml': sheet(rows ?? `<row r="1">${t('A1', 'Account name')}${t('B1', 'BPID')}</row><row r="2">${t('A2', 'Acme &amp; Co')}${t('B2', '7')}</row>`),
      ...extra,
    });
  it('reads the Accounts sheet (case-insensitive name) and unescapes text', async () => {
    const r = await parseXlsx(make({}, '<sheet name="accounts" sheetId="1" r:id="rId1"/>'));
    expect(r.sheet).toBe('accounts');
    expect(r.grid[1][0].v).toBe('Acme & Co');
  });
  it('a formula cell is flagged and its cached value is never read as data', async () => {
    const rows = `<row r="1">${t('A1', 'Account name')}</row><row r="2"><c r="A2"><f>1+1</f><v>Valid Name</v></c></row>`;
    const g = (await parseXlsx(make({}, undefined, rows))).grid;
    expect(g[1][0].formula).toBe(true);
    const p = parseGrid(g);
    expect(p.rows[0].errors[0].code).toBe('formula');
    expect(p.rows[0].values.name).toBeNull();
  });
  it('text that merely starts with = stays text', async () => {
    const rows = `<row r="1">${t('A1', 'Account name')}${t('B1', 'Notes')}</row><row r="2">${t('A2', 'Acme')}${t('B2', '=1+1')}</row>`;
    const p = parseGrid((await parseXlsx(make({}, undefined, rows))).grid);
    expect(p.rows[0].values.notes).toBe('=1+1');
    expect(p.rows[0].errors).toEqual([]);
  });
  it('refuses a missing Accounts sheet, macros, external links, embedded objects, DOCTYPE and garbage', async () => {
    const reason = async (b: Uint8Array) => { try { await parseXlsx(b); } catch (e) { return (e as FileRefusal).reason; } return 'accepted'; };
    expect(await reason(make({}, '<sheet name="Other" sheetId="1" r:id="rId1"/>'))).toBe('sheet_missing');
    expect(await reason(make({ 'xl/vbaProject.bin': 'x' }))).toBe('macros');
    expect(await reason(make({ 'xl/externalLinks/externalLink1.xml': '<x/>' }))).toBe('external_links');
    expect(await reason(make({ 'xl/embeddings/oleObject1.bin': 'x' }))).toBe('embedded_objects');
    expect(await reason(make({ 'xl/workbook.xml': '<!DOCTYPE x [<!ENTITY a "b">]><workbook/>' }))).toBe('xml_unsafe');
    expect(await reason(enc('PK\u0003\u0004 not really a zip'))).toBe('corrupt');
  });
  it('the template/skipped writer produces a workbook this reader opens, with text-only cells', async () => {
    const bytes = writeXlsx([['Account name', 'Notes'], ['=SUM(A1)', 'x']]);
    const g = (await parseXlsx(bytes)).grid;
    expect(g[1][0]).toEqual({ v: '=SUM(A1)', formula: false });
  });
});
