// 原稿导入解析（前后端共享；前端解析后逐段提交）
// 支持：
//  1. SRT：  序号 + 00:00:01,000 --> 00:00:04,000 + 文本行
//  2. 带行内时间码的纯文本，形如：
//       [00:00:03] 那年冬天，祖父把木箱抬进了堂屋。
//       00:15  他说，这是他从关外带回来的……
//  3. 无时间码：按空行分自然段（start/end 留空，稍后对齐或等距填充）

import { parseTC } from './timecode.js';

const SRT_RANGE =
  /(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}|\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}|\d{1,2}:\d{2}[.,]\d{1,3})/;

/**
 * @param {string} raw
 * @returns {{format:string, segments:Array<{index?:number,start:number|null,end:number|null,text:string}>}}
 */
export function parseTranscript(raw) {
  const text = String(raw ?? '').replace(/^﻿/, '').replace(/\r\n/g, '\n');

  if (SRT_RANGE.test(text)) return { format: 'srt', segments: parseSrt(text) };

  const inline = parseInlineTC(text);
  if (inline) return { format: 'inline-tc', segments: inline };

  return { format: 'paragraphs', segments: parseParagraphs(text) };
}

function parseSrt(text) {
  const blocks = text.split(/\n{2,}/);
  const out = [];
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    let li = 0;
    if (/^\d+$/.test(lines[0])) li = 1;
    const range = lines[li]?.match(SRT_RANGE);
    if (!range) continue;
    const start = parseTC(range[1]);
    const end = parseTC(range[2]);
    const body = lines.slice(li + 1).join('\n').trim();
    if (body) out.push({ start, end, text: body });
  }
  return out;
}

const INLINE_TC =
  /^\s*[[【]?\s*(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\s*[\]】]?\s*(.*)$/;

function parseInlineTC(text) {
  const lines = text.split('\n');
  const out = [];
  let hits = 0;
  let current = null;
  for (const line of lines) {
    const m = line.match(INLINE_TC);
    if (m && parseTC(m[1]) != null) {
      hits++;
      if (current) out.push(current);
      current = { start: parseTC(m[1]), end: null, text: (m[2] || '').trim() };
    } else if (current && line.trim()) {
      current.text += (current.text ? '\n' : '') + line.trim();
    }
  }
  if (current) out.push(current);
  if (hits === 0 || out.length === 0) return null;
  // 用下一段起点补齐终点
  out.forEach((s, i) => {
    if (s.end == null && i + 1 < out.length) s.end = out[i + 1].start;
  });
  return out;
}

function parseParagraphs(text) {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => ({ start: null, end: null, text: p }));
}
