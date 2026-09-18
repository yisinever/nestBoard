/**
 * 诊断信息格式化（T2.17）单测。
 *
 * 面板本身没法在 node 里开（依赖 Obsidian 的 `Modal`），但**判断逻辑**能测，
 * 而且真正值得测的就是这一层：阈值判错会让面板要么处处报警（没人再看）、
 * 要么漏报（等于没有）。所以这里逐条卡边界值。
 */

import { describe, expect, it } from 'vitest';
import { t } from '../../util/i18n';
import {
  DOM_NODES_WARN,
  FILE_BYTES_WARN,
  SAVE_SERIALIZE_WARN_MS,
  SAVE_TOTAL_WARN_MS,
  THUMB_MISSES_WARN,
  formatBytes,
  formatDiagnostics,
  thumbHitRate,
  type BoardDiagnosticsSnapshot,
  type DiagnosticsRow,
} from '../../view/diagnostics';

function snapshot(overrides: Partial<BoardDiagnosticsSnapshot> = {}): BoardDiagnosticsSnapshot {
  return {
    path: 'Boards/A.nboard',
    fileBytes: 1024,
    cards: 10,
    columns: 2,
    edges: 3,
    domNodes: 100,
    renderedCards: 8,
    pooledCards: 4,
    renderedColumns: 2,
    zoom: 1,
    thumbs: { hits: 10, misses: 1, entries: 5, failures: 0 },
    save: { serializeMs: 2, writeMs: 3, totalMs: 5, at: 0, revision: 2 },
    pendingFrames: 0,
    ...overrides,
  };
}

function row(rows: DiagnosticsRow[], label: string): DiagnosticsRow {
  const found = rows.find((item) => item.label === label);
  if (!found) throw new Error(`没有这一行：${label}`);
  return found;
}

const DOM_LABEL = t('diagnostics.dom');
const FILE_LABEL = t('diagnostics.file');
const THUMBS_LABEL = t('diagnostics.thumbs');
const SAVE_LABEL = t('diagnostics.save');
const FRAMES_LABEL = t('diagnostics.frames');

describe('formatBytes', () => {
  it('按 1024 进制给出可读值', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(2048)).toBe('2.0 KB');
    // 10 KB 以上不再留小数：诊断面板要看的是量级，不是小数位
    expect(formatBytes(10 * 1024)).toBe('10 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(3.5 * 1024 * 1024)).toBe('3.5 MB');
    expect(formatBytes(12 * 1024 * 1024)).toBe('12 MB');
  });

  it('异常输入不产出 NaN 给用户看', () => {
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
  });
});

describe('thumbHitRate', () => {
  it('一次都没查过时返回 null（不编造 100%）', () => {
    expect(thumbHitRate({ hits: 0, misses: 0, entries: 0, failures: 0 })).toBeNull();
  });

  it('按 (命中 + 未命中) 算比例', () => {
    expect(thumbHitRate({ hits: 3, misses: 1, entries: 0, failures: 0 })).toBe(0.75);
  });
});

describe('formatDiagnostics', () => {
  it('固定输出九行，首行是白板路径', () => {
    const rows = formatDiagnostics(snapshot());
    expect(rows).toHaveLength(9);
    expect(rows[0].label).toBe(t('diagnostics.path'));
    expect(rows[0].value).toBe('Boards/A.nboard');
  });

  it('文案来自词典而不是回退成 key', () => {
    const rows = formatDiagnostics(snapshot());
    expect(DOM_LABEL).not.toBe('diagnostics.dom');
    expect(rows.every((item) => item.label.length > 0 && item.value.length > 0)).toBe(true);
  });

  it('数值行把各项都带出来（不做"只显示一个总数"的糊弄）', () => {
    const rows = formatDiagnostics(snapshot());
    expect(row(rows, DOM_LABEL).value).toBe('100');
    expect(row(rows, t('diagnostics.scale')).value).toContain('10');
    expect(row(rows, t('diagnostics.rendered')).value).toContain('8');
    expect(row(rows, SAVE_LABEL).value).toContain('5');
    expect(row(rows, t('diagnostics.zoom')).value).toBe('100%');
  });

  it('DOM 节点数越过阈值才提醒（边界值本身不提醒）', () => {
    expect(
      row(formatDiagnostics(snapshot({ domNodes: DOM_NODES_WARN })), DOM_LABEL).warn,
    ).toBeNull();
    const over = row(formatDiagnostics(snapshot({ domNodes: DOM_NODES_WARN + 1 })), DOM_LABEL);
    expect(over.warn).toBe(t('diagnostics.domWarn', { limit: DOM_NODES_WARN }));
  });

  it('读不到文件大小时显示"不可用"，而不是 0', () => {
    const missing = row(formatDiagnostics(snapshot({ fileBytes: null })), FILE_LABEL);
    expect(missing.value).toBe(t('diagnostics.unavailable'));
    expect(missing.warn).toBeNull();
  });

  it('文件过大时提醒', () => {
    const big = row(formatDiagnostics(snapshot({ fileBytes: FILE_BYTES_WARN + 1 })), FILE_LABEL);
    expect(big.warn).toBe(t('diagnostics.fileWarn', { limit: formatBytes(FILE_BYTES_WARN) }));
  });

  it('缩略图缓存不可用时显示"不可用"', () => {
    expect(row(formatDiagnostics(snapshot({ thumbs: null })), THUMBS_LABEL).value).toBe(
      t('diagnostics.unavailable'),
    );
  });

  it('缩略图：miss 多**且**命中率低才提醒（只多不低是正常的翻新图）', () => {
    const cold = row(
      formatDiagnostics(
        snapshot({ thumbs: { hits: 2, misses: THUMB_MISSES_WARN + 1, entries: 3, failures: 0 } }),
      ),
      THUMBS_LABEL,
    );
    expect(cold.warn).toBe(t('diagnostics.thumbsWarn'));

    // 同样的 miss 次数，但命中率高 → 说明缓存**在**起作用
    const busy = row(
      formatDiagnostics(
        snapshot({
          thumbs: { hits: 1000, misses: THUMB_MISSES_WARN + 1, entries: 40, failures: 0 },
        }),
      ),
      THUMBS_LABEL,
    );
    expect(busy.warn).toBeNull();
  });

  it('缩略图：miss 数刚好等于阈值不提醒', () => {
    const edge = row(
      formatDiagnostics(
        snapshot({ thumbs: { hits: 0, misses: THUMB_MISSES_WARN, entries: 1, failures: 0 } }),
      ),
      THUMBS_LABEL,
    );
    expect(edge.warn).toBeNull();
  });

  it('尚未写盘时显示"尚无记录"', () => {
    expect(row(formatDiagnostics(snapshot({ save: null })), SAVE_LABEL).value).toBe(
      t('diagnostics.saveNone'),
    );
  });

  it('写盘提醒区分"序列化重"与"纯写盘慢"（指向不同的优化方向）', () => {
    const serializeHeavy = row(
      formatDiagnostics(
        snapshot({
          save: {
            serializeMs: SAVE_SERIALIZE_WARN_MS + 1,
            writeMs: 1,
            totalMs: SAVE_SERIALIZE_WARN_MS + 2,
            at: 0,
            revision: 1,
          },
        }),
      ),
      SAVE_LABEL,
    );
    expect(serializeHeavy.warn).toBe(t('diagnostics.saveSerializeWarn'));

    const writeHeavy = row(
      formatDiagnostics(
        snapshot({
          save: {
            serializeMs: 1,
            writeMs: SAVE_TOTAL_WARN_MS,
            totalMs: SAVE_TOTAL_WARN_MS + 1,
            at: 0,
            revision: 1,
          },
        }),
      ),
      SAVE_LABEL,
    );
    expect(writeHeavy.warn).toBe(t('diagnostics.saveWarn'));
  });

  it('写盘正常时不提醒', () => {
    const fast = row(
      formatDiagnostics(
        snapshot({ save: { serializeMs: 1, writeMs: 2, totalMs: 3, at: 0, revision: 1 } }),
      ),
      SAVE_LABEL,
    );
    expect(fast.warn).toBeNull();
  });

  it('待提交帧任务在连续平移时本来就 >0：不许提醒（否则一平移就满屏黄）', () => {
    const busy = row(formatDiagnostics(snapshot({ pendingFrames: 3 })), FRAMES_LABEL);
    expect(busy.warn).toBeNull();
    expect(busy.value).toBe(t('diagnostics.framesValue', { count: 3 }));
  });
});
