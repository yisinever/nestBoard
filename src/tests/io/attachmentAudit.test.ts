import { describe, expect, it } from 'vitest';
import {
  classifyAttachments,
  isAttachmentCandidate,
  isInFolder,
  type AttachmentAuditResult,
} from '../../io/attachmentAudit';

/**
 * T4.05「整理未使用附件」。
 *
 * 这一层被测的理由只有一个：**它决定的是一份"哪些文件看起来可以删"的清单**。
 * 分类错了不会当场出错，而是几天后用户按清单删掉一张别处还在用的图。
 * 所以这里盯得最紧的两件事是：
 *
 *  1. 「别处还在用」必须真的被摘出去（`03 §4` 那句话得落到实现里，不能只写在文档里）；
 *  2. 任何**不确定**的情况都倒向"少报" —— 宁可漏掉一个可清理项，也不要多报一个。
 */

/** 固定 `resolve` 的分类器：带 `/` 的当全路径，短名按 `attachments/` 补全（模拟 Obsidian 的链接解析） */
function audit(
  candidates: string[],
  boardRefs: string[],
  otherRefs: string[],
): AttachmentAuditResult {
  return classifyAttachments({
    candidates,
    boardRefs,
    otherRefs,
    resolve: (raw) => (raw.includes('/') ? raw : `attachments/${raw}`),
  });
}

describe('classifyAttachments', () => {
  const candidates = ['attachments/a.png', 'attachments/b.png', 'attachments/old/c.png'];

  it('三份清单互不重叠，且恰好等于候选集', () => {
    const result = audit(candidates, ['attachments/a.png'], ['attachments/b.png']);

    expect(result.usedByBoard).toEqual(['attachments/a.png']);
    expect(result.usedElsewhere).toEqual(['attachments/b.png']);
    expect(result.unused).toEqual(['attachments/old/c.png']);
  });

  it('★ 别处还在用的，绝不进未使用清单（03 §4 的"用户可能别处还在用"）', () => {
    const result = audit(candidates, [], ['attachments/a.png', 'attachments/b.png']);

    expect(result.unused).toEqual(['attachments/old/c.png']);
    expect(result.usedElsewhere).toEqual(['attachments/a.png', 'attachments/b.png']);
  });

  it('本板与别处同时引用 → 算本板的（优先级的理由是别报成"删了别处会坏"）', () => {
    const result = audit(['attachments/a.png'], ['attachments/a.png'], ['attachments/a.png']);

    expect(result.usedByBoard).toEqual(['attachments/a.png']);
    expect(result.usedElsewhere).toEqual([]);
    expect(result.unused).toEqual([]);
  });

  it('短名与全路径指的是同一个文件（都靠注入的 resolve 归一）', () => {
    const result = audit(['attachments/a.png'], ['a.png'], []);

    expect(result.usedByBoard).toEqual(['attachments/a.png']);
    expect(result.unused).toEqual([]);
  });

  it('★ resolve 解析不出来 → 当成"没引用"（风险全压在少报这一侧）', () => {
    const result = classifyAttachments({
      candidates: ['attachments/a.png'],
      boardRefs: [],
      otherRefs: [],
      // 解析不出来时**不**把它算进"有人引用"：多报一个未使用项，
      // 用户可能删掉一张正在用的图；少报一个，用户只是少清一次垃圾
      resolve: () => null,
    });

    expect(result.unused).toEqual(['attachments/a.png']);
  });

  it('输出的顺序与输入顺序无关（报告要能对照着看，不能每次都不一样）', () => {
    const forward = audit(candidates, [], []);
    const shuffled = audit([...candidates].reverse(), [], []);

    expect(forward.unused).toEqual([
      'attachments/a.png',
      'attachments/b.png',
      'attachments/old/c.png',
    ]);
    expect(shuffled.unused).toEqual(forward.unused);
  });

  it('候选集为空时三份清单都是空的（不抛错：附件目录可能是新库）', () => {
    const result = audit([], ['attachments/a.png'], ['attachments/b.png']);

    expect(result).toEqual({ usedByBoard: [], usedElsewhere: [], unused: [] });
  });
});

describe('isAttachmentCandidate', () => {
  it('笔记与白板都不是附件', () => {
    expect(isAttachmentCandidate('attachments/说明.md')).toBe(false);
    expect(isAttachmentCandidate('attachments/子板.nboard')).toBe(false);
    // 大小写不敏感：`.MD` 在 macOS / Windows 上照样是笔记
    expect(isAttachmentCandidate('attachments/README.MD')).toBe(false);
  });

  it('★ 点开头的路径段一律排除（快照目录最要紧 —— 删了就没得回滚）', () => {
    expect(isAttachmentCandidate('.obsidian/plugins/x/main.js')).toBe(false);
    expect(isAttachmentCandidate('.nestboard-history/nb_a/1.nboard')).toBe(false);
    expect(isAttachmentCandidate('attachments/.nestboard-history/a.png')).toBe(false);
    // 文件名本身带点是合法的（`图 1.2.png`），只有**整段**以点开头才算隐藏
    expect(isAttachmentCandidate('attachments/v1.2.png')).toBe(true);
  });

  it('普通图片 / 文档 / 音视频都算候选', () => {
    expect(isAttachmentCandidate('attachments/a.png')).toBe(true);
    expect(isAttachmentCandidate('attachments/报告.pdf')).toBe(true);
    expect(isAttachmentCandidate('attachments/录音.m4a')).toBe(true);
  });

  it('空路径不算候选', () => {
    expect(isAttachmentCandidate('')).toBe(false);
  });
});

describe('isInFolder', () => {
  it('空目录名 = 整个库（Obsidian 的"库根目录"就是空串）', () => {
    expect(isInFolder('a/b/c.png', '')).toBe(true);
  });

  it('按路径段判边界：attachments-old 不属于 attachments', () => {
    expect(isInFolder('attachments/a.png', 'attachments')).toBe(true);
    expect(isInFolder('attachments/sub/a.png', 'attachments')).toBe(true);
    expect(isInFolder('attachments-old/a.png', 'attachments')).toBe(false);
    expect(isInFolder('attachmentsx/a.png', 'attachments')).toBe(false);
  });

  it('目录名本身算在里面（虽然它是个目录，这里只回答"前缀关系"）', () => {
    expect(isInFolder('attachments', 'attachments')).toBe(true);
  });
});
