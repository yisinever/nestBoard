/**
 * 诊断信息（T2.17 / `02 §8.3`）。
 *
 * 面板存在的两个理由：
 *  1. **性能问题没法靠肉眼定位**：「卡」可能是 DOM 节点太多、可能是一次写盘花了 300ms、
 *     也可能是缩略图缓存全 miss 一直在重渲染。没有数字就只能靠猜。
 *  2. **验收要可复现**：§8.1 的帧率目标需要在同一台机器上比"改前 / 改后"的同一组数字，
 *     所以这里只做**事实采集**，不做任何自动优化，也不受任何开关影响 ——
 *     诊断面板一旦"被优化过"，它就只会骗人。
 *
 * ★ 采集与解释分开：`BoardDiagnosticsSnapshot` 只装数字（由视图读自己的内部状态填），
 *   `formatDiagnostics` 才回答"这些数字意味着什么"（纯函数，可单测）。
 */

import type { SaveStats } from '../io/BoardRepository';
import type { ThumbnailStats } from '../io/ThumbnailCache';
import { t } from '../util/i18n';

/** 一次采集到的全部事实；拿不到的项用 `null`（面板显示"不可用"，而不是编个 0） */
export interface BoardDiagnosticsSnapshot {
  /** 白板文件路径 */
  path: string;
  /** 未落盘过（或 `stat` 失败）时为 `null` */
  fileBytes: number | null;

  // —— 模型规模 ——
  cards: number;
  columns: number;
  edges: number;

  // —— 渲染 ——
  /** 画布内的 DOM 节点总数（`querySelectorAll('*')`，含卡片/分栏/覆盖层） */
  domNodes: number;
  /** 已挂载到画布上的卡片节点 */
  renderedCards: number;
  /** 复用池里的空闲卡片节点（不进 DOM，但占内存） */
  pooledCards: number;
  renderedColumns: number;
  /** 当前缩放（1 = 100%） */
  zoom: number;

  // —— 存储与缓存 ——
  thumbs: ThumbnailStats | null;
  save: SaveStats | null;
  /** 帧队列里还没落地的任务数（T2.14）：>0 表示"这一帧还有提交没做完" */
  pendingFrames: number;
}

/** 面板的一行。`warn` = 越过阈值，需要作者注意（面板上高亮） */
export interface DiagnosticsRow {
  label: string;
  value: string;
  /** 说明这一行的数字该往哪看（只在 `warn` 时给，避免正常状态下的噪音） */
  warn: string | null;
}

/** 画布 DOM 节点数的警戒线：到这个量级，一次样式重算就能把帧预算吃光（§8.3） */
export const DOM_NODES_WARN = 3000;
/** 单板文件字节的警戒线：大板写入会成为肉眼可见的停顿 */
export const FILE_BYTES_WARN = 2 * 1024 * 1024;
/** 一次写盘总耗时的警戒线（ms） */
export const SAVE_TOTAL_WARN_MS = 100;
/** 序列化占比警戒线（ms）：超过说明大头在全量 `JSON.stringify`（T2.15） */
export const SAVE_SERIALIZE_WARN_MS = 30;
/** 缩略图缓存 miss 次数的警戒线（配合命中率一起看） */
export const THUMB_MISSES_WARN = 50;

/** 人类可读的字节数。刻意用 1024 进制（文件管理器与 `stat` 都按这个口径） */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** 命中率；一次都没查过时为 `null`（不编造 100%） */
export function thumbHitRate(stats: ThumbnailStats): number | null {
  const total = stats.hits + stats.misses;
  return total === 0 ? null : stats.hits / total;
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

/**
 * 把快照变成"标签 + 数值 + 提醒"的行。
 *
 * ★ 顺序按**排查路径**排，不按数据结构排：先看规模（是不是板子本身太大），
 *   再看渲染（DOM 是否失控），最后看存储与帧（是不是写盘 / 提交拖住了）。
 *   照这个顺序往下看，第一个带提醒的行通常就是原因。
 */
export function formatDiagnostics(snapshot: BoardDiagnosticsSnapshot): DiagnosticsRow[] {
  const rows: DiagnosticsRow[] = [];

  rows.push({ label: t('diagnostics.path'), value: snapshot.path, warn: null });

  rows.push({
    label: t('diagnostics.scale'),
    value: t('diagnostics.scaleValue', {
      cards: snapshot.cards,
      columns: snapshot.columns,
      edges: snapshot.edges,
    }),
    warn: null,
  });

  rows.push({
    label: t('diagnostics.dom'),
    value: String(snapshot.domNodes),
    warn:
      snapshot.domNodes > DOM_NODES_WARN
        ? t('diagnostics.domWarn', { limit: DOM_NODES_WARN })
        : null,
  });

  rows.push({
    label: t('diagnostics.rendered'),
    value: t('diagnostics.renderedValue', {
      cards: snapshot.renderedCards,
      columns: snapshot.renderedColumns,
      pooled: snapshot.pooledCards,
    }),
    warn: null,
  });

  rows.push({ label: t('diagnostics.zoom'), value: percent(snapshot.zoom), warn: null });

  rows.push({
    label: t('diagnostics.file'),
    value:
      snapshot.fileBytes === null ? t('diagnostics.unavailable') : formatBytes(snapshot.fileBytes),
    warn:
      snapshot.fileBytes !== null && snapshot.fileBytes > FILE_BYTES_WARN
        ? t('diagnostics.fileWarn', { limit: formatBytes(FILE_BYTES_WARN) })
        : null,
  });

  rows.push(...thumbRows(snapshot.thumbs));
  rows.push(...saveRows(snapshot.save));

  rows.push({
    label: t('diagnostics.frames'),
    value: t('diagnostics.framesValue', { count: snapshot.pendingFrames }),
    // 「还有待提交任务」在连续平移时是**正常状态**，不是问题：不设提醒
    warn: null,
  });

  return rows;
}

function thumbRows(stats: ThumbnailStats | null): DiagnosticsRow[] {
  if (!stats) {
    return [{ label: t('diagnostics.thumbs'), value: t('diagnostics.unavailable'), warn: null }];
  }
  const rate = thumbHitRate(stats);
  const misses = stats.misses;
  return [
    {
      label: t('diagnostics.thumbs'),
      value: t('diagnostics.thumbsValue', {
        entries: stats.entries,
        hits: stats.hits,
        misses,
        // 渲染失败次数要单独报：`misses` 高可能是"图多"，`failures` 高则一定是**renderer 坏了**
        // （那就是"图片卡一直空着"的根因，跟性能无关，但用户会一起报成"卡"）
        failures: stats.failures,
        rate: rate === null ? '—' : percent(rate),
      }),
      // 只看 miss 次数会误判（一直翻新图 miss 多但命中率也高），
      // 所以两条一起判：miss 多**且**命中率过半没到
      warn:
        misses > THUMB_MISSES_WARN && (rate === null || rate < 0.5)
          ? t('diagnostics.thumbsWarn')
          : null,
    },
  ];
}

function saveRows(stats: SaveStats | null): DiagnosticsRow[] {
  if (!stats) {
    return [{ label: t('diagnostics.save'), value: t('diagnostics.saveNone'), warn: null }];
  }
  const slow = stats.totalMs > SAVE_TOTAL_WARN_MS;
  const serializeHeavy = stats.serializeMs > SAVE_SERIALIZE_WARN_MS;
  return [
    {
      label: t('diagnostics.save'),
      value: t('diagnostics.saveValue', {
        total: Math.round(stats.totalMs),
        serialize: Math.round(stats.serializeMs),
        write: Math.round(stats.writeMs),
      }),
      // 提醒指向**原因**：纯写盘慢该怪磁盘 / 同步，序列化慢才是 T2.15 那类优化要解决的
      warn: serializeHeavy
        ? t('diagnostics.saveSerializeWarn')
        : slow
          ? t('diagnostics.saveWarn')
          : null,
    },
  ];
}
