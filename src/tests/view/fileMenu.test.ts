/**
 * 文件树右键菜单的排布测试（O12；`C4` 补脑图那一项）。
 *
 * 钉三件事，都是"点一遍才发现"的那类错误：
 *
 *  * **有哪些项**：文件夹要有「在此新建 nestboard」**与**「在此新建 nestmind」
 *    （`C4`，用户 2026-09-18）；普通文件**不该**有它们（那儿没有"这里"）；
 *  * **顺序与分组**：`.canvas` 的「导入为白板」要在「添加到白板」之前且有分隔线，
 *    而"收件箱 / 添加到白板"同组不分家（它们是一件事的两种落点）；
 *  * **分隔线不在第一项之前**：菜单顶上多一条线是最容易被忽略的排印事故。
 *
 * ★ 动作绑定（`main.ts` 的 `Record<FileMenuAction, …>`）不在这里测：那张表漏一项
 *   就编译不过，比断言更牢。
 */

import { describe, expect, it } from 'vitest';
import { fileMenuItems } from '../../view/interact/fileMenu';
import type { FileMenuContext, FileMenuTarget } from '../../view/interact/fileMenu';

/** 压成一行看排布：`|` 表示这一项之前有分隔线 */
function layout(target: FileMenuTarget, ctx: Partial<FileMenuContext> = {}): string {
  return fileMenuItems(target, { homeConfigured: false, ...ctx })
    .map((item) => `${item.separatorBefore ? '| ' : ''}${item.id}`)
    .join(' ');
}

const FILE = { folder: false, conflict: false } as const;

describe('fileMenuItems × 分组', () => {
  it('文件夹：两条"在此新建"（白板 + 脑图）连着排，且顶头不带分隔线', () => {
    expect(layout({ folder: true, extension: '', conflict: false })).toBe(
      'newBoardHere newMindHere',
    );
  });

  it('★ 只有文件夹才有"在此新建"：文件上摆这一项是说不通的（那儿没有"这里"）', () => {
    for (const extension of ['md', 'canvas', 'nboard', 'png']) {
      const ids = fileMenuItems(
        { folder: false, extension, conflict: false },
        { homeConfigured: true },
      ).map((item) => item.id);
      expect(ids, extension).not.toContain('newBoardHere');
      expect(ids, extension).not.toContain('newMindHere');
    }
  });

  it('普通笔记：收件箱与「添加到白板」同组（配了 Home 才有收件箱）', () => {
    expect(layout({ ...FILE, extension: 'md' }, { homeConfigured: true })).toBe(
      'addToUnsorted addToBoard',
    );
    expect(layout({ ...FILE, extension: 'md' })).toBe('addToBoard');
  });

  it('.canvas：「导入为白板」排在「添加到白板」之前，中间一条分隔线', () => {
    expect(layout({ ...FILE, extension: 'canvas' })).toBe('importCanvas | addToBoard');
  });

  it('.nboard：删除白板自成一组，与"当卡片用"分开', () => {
    expect(layout({ ...FILE, extension: 'nboard' }, { homeConfigured: true })).toBe(
      'addToUnsorted addToBoard | deleteBoard',
    );
  });

  it('同步冲突副本：独占整份菜单（旁边不摆添加到白板 / 删除）', () => {
    expect(layout({ ...FILE, extension: 'md', conflict: true }, { homeConfigured: true })).toBe(
      'viewConflict',
    );
  });

  it('任何目标的第一项都不带分隔线', () => {
    const targets: FileMenuTarget[] = [
      { folder: true, extension: '', conflict: false },
      { ...FILE, extension: 'md' },
      { ...FILE, extension: 'canvas' },
      { ...FILE, extension: 'nboard' },
      { ...FILE, extension: 'png' },
      { ...FILE, extension: 'md', conflict: true },
    ];
    for (const target of targets) {
      const items = fileMenuItems(target, { homeConfigured: true });
      expect(items.length, JSON.stringify(target)).toBeGreaterThan(0);
      expect(items[0]?.separatorBefore, JSON.stringify(target)).toBe(false);
    }
  });

  it('每一项都带标题与图标（空标题会渲染成一条看不见的菜单项）', () => {
    const items = fileMenuItems({ ...FILE, extension: 'nboard' }, { homeConfigured: true });
    for (const item of items) {
      expect(item.title.length, item.id).toBeGreaterThan(0);
      expect(item.icon.length, item.id).toBeGreaterThan(0);
    }
  });
});
