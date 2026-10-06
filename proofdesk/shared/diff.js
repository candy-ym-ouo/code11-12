// 文本差异（LCS）。优先按词切分（Intl.Segmenter，支持中日韩按字），
// 不可用时退化为逐字符。返回 ['eq'|'del'|'ins', text] 段序列。

function tokenize(text) {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const seg = new Intl.Segmenter('zh', { granularity: 'word' });
    return [...seg.segment(String(text))].map((d) => d.segment);
  }
  return Array.from(String(text));
}

function lcs(a, b) {
  const n = a.length;
  const m = b.length;
  // 滚动数组
  let prev = new Int32Array(m + 1);
  let cur = new Int32Array(m + 1);
  const back = new Uint8Array(n * m); // 1=左上 2=上 3=左
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        back[(i - 1) * m + (j - 1)] = 1;
      } else if (prev[j] >= cur[j - 1]) {
        cur[j] = prev[j];
        back[(i - 1) * m + (j - 1)] = 2;
      } else {
        cur[j] = cur[j - 1];
        back[(i - 1) * m + (j - 1)] = 3;
      }
    }
    [prev, cur] = [cur, prev];
    cur.fill(0);
  }
  const ops = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const d = back[(i - 1) * m + (j - 1)];
    if (d === 1) {
      ops.push(['eq', a[i - 1]]);
      i--;
      j--;
    } else if (d === 2) {
      ops.push(['del', a[i - 1]]);
      i--;
    } else {
      ops.push(['ins', b[j - 1]]);
      j--;
    }
  }
  while (i > 0) ops.push(['del', a[--i]]);
  while (j > 0) ops.push(['ins', b[--j]]);
  ops.reverse();

  // 合并相邻同类
  const merged = [];
  for (const [kind, tok] of ops) {
    const last = merged[merged.length - 1];
    if (last && last[0] === kind) last[1] += tok;
    else merged.push([kind, tok]);
  }
  return merged;
}

export function diffText(oldText, newText) {
  const a = tokenize(oldText ?? '');
  const b = tokenize(newText ?? '');
  if (a.length * b.length > 4_000_000) {
    // 超长文本退化为整体替换，避免内存膨胀
    return [
      oldText ? ['del', String(oldText)] : null,
      newText ? ['ins', String(newText)] : null,
    ].filter(Boolean);
  }
  return lcs(a, b);
}
