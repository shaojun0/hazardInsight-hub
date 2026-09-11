import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parseCsv } from '../rules/parser.js';
import { TEST_REQUIRED_FIELDS, type HazardTestDataset } from '../../shared/hazard-test.js';
import type { Grade } from '../../shared/types.js';

export const DEFAULT_TEST_NAME = '隐患抽样_抽样50条.csv';
export const MAX_TEST_ROWS = 500;
export const MAX_TEST_BYTES = 5 * 1024 * 1024;
export interface ParsedTestDataset { metadata: HazardTestDataset; records: Record<string, string>[] }

export function normalizeTestGrade(value: string): Grade | null {
  const match = /^([ABCD])\s*级?$/i.exec(value.normalize('NFKC').trim());
  return match ? match[1].toUpperCase() as Grade : null;
}

export function parseTestDataset(buffer: Buffer, fileName: string): ParsedTestDataset {
  if (!/\.csv$/i.test(fileName)) throw new Error('仅支持 CSV 文件，请将表格另存为 CSV 后上传。');
  if (buffer.length > MAX_TEST_BYTES) throw new Error('CSV 文件不能超过 5MB。');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { // 兼容中文 Excel 常见的 GB18030 / GBK CSV。
    try { text = new TextDecoder('gb18030', { fatal: true }).decode(buffer); }
    catch { throw new Error('无法识别文件编码，请使用 UTF-8 CSV。'); }
  }
  if (text.includes('\0')) throw new Error('文件不是有效的 CSV 文本，请另存为 UTF-8 CSV。');
  const [rawHeaders, ...data] = parseCsv(text.replace(/^\uFEFF/, ''), { strict: true });
  if (!rawHeaders) throw new Error('CSV 文件为空。');
  const headers = rawHeaders.map(h => h.trim().normalize('NFKC'));
  if (headers.some(h => !h) || new Set(headers).size !== headers.length) throw new Error('CSV 表头存在空列名或重复列名。');
  const missing = TEST_REQUIRED_FIELDS.filter(h => !headers.includes(h));
  if (missing.length) throw new Error(`缺少必要字段：${missing.join('、')}。请使用默认测试集的表头。`);
  if (!data.length) throw new Error('CSV 没有数据行。');
  if (data.length > MAX_TEST_ROWS) throw new Error(`单次最多支持 ${MAX_TEST_ROWS} 条数据。`);
  const gradeCounts = { A: 0, B: 0, C: 0, D: 0 };
  const warnings: string[] = [];
  let unlabeled = 0;
  const records = data.map((row, index) => {
    if (row.length !== headers.length) throw new Error(`第 ${index + 1} 条数据列数为 ${row.length}，表头为 ${headers.length} 列；请检查逗号和引号。`);
    const record = Object.fromEntries(headers.map((h, i) => [h, row[i]]));
    if (!record['隐患描述'].trim()) throw new Error(`第 ${index + 1} 条数据缺少隐患描述。`);
    if (record['隐患描述'].length > 20_000) throw new Error(`第 ${index + 1} 条隐患描述超过 20000 字符。`);
    const rawGrade = record['隐患级别'].trim();
    const grade = normalizeTestGrade(rawGrade);
    if (rawGrade && !grade) throw new Error(`第 ${index + 1} 条隐患级别“${rawGrade.slice(0, 40)}”无效，支持 A/B/C/D 或 A级/B级/C级/D级。`);
    if (grade) gradeCounts[grade] += 1;
    else unlabeled += 1;
    return record;
  });
  if (unlabeled) warnings.push(`${unlabeled} 条数据无标准答案，将执行判断但不计入准确率。`);
  if (!headers.includes('隐患分类')) warnings.push('未提供隐患分类，将仅依据隐患描述检索和判断。');
  return { records, metadata: { id: randomUUID(), fileName, total: records.length, headers,
    labeled: records.length - unlabeled, gradeCounts, warnings } };
}

export async function readDefaultTestDataset(): Promise<ParsedTestDataset> {
  const path = fileURLToPath(new URL(`../../datas/test/${DEFAULT_TEST_NAME}`, import.meta.url));
  try { return parseTestDataset(await readFile(path), DEFAULT_TEST_NAME); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('默认测试集不存在，请放置 datas/test/隐患抽样_抽样50条.csv 或上传自定义 CSV。');
    throw error;
  }
}

/** 与既有 evaluate.ts 相同：只传描述和分类，去掉描述内明确的最终等级声明。 */
export function testCandidateOf(record: Record<string, string>) {
  const clean = (s: string) => s.normalize('NFKC')
    .replace(/(?:属[于]?|判定为|定为|认定为)?\s*[ABCD]\s*级隐患/gi, '')
    .replace(/隐患[等级别]+\s*[为：:]?\s*[ABCD]\s*级?/gi, '');
  return { description: clean(record['隐患描述']).trim(), category: clean(record['隐患分类'] ?? '').trim() };
}
