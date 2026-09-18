import { describe, expect, it } from 'vitest';

import { DROP_OUT_HIGHLIGHT_CLASS, dropFolderOf, noteMarkdownOf } from '../../model/dragOut';

describe('DROP_OUT_HIGHLIGHT_CLASS', () => {
  it('是一个具体类名（`integration/` 加、`styles.css` 画，两边取同一处）', () => {
    expect(DROP_OUT_HIGHLIGHT_CLASS).toBe('nestboard-drop-out-target');
  });
});

describe('dropFolderOf（T6.10 / F6-04）', () => {
  it('落在文件夹上 → 就是它自己', () => {
    expect(dropFolderOf('Notes', true)).toBe('Notes');
    expect(dropFolderOf('Notes/Sub', true)).toBe('Notes/Sub');
  });

  it('落在文件上 → 它所在的目录（滚到哪个文件上松手是常态）', () => {
    expect(dropFolderOf('Notes/A.md', false)).toBe('Notes');
    expect(dropFolderOf('attachments/img/p.png', false)).toBe('attachments/img');
  });

  it("根目录下的文件 → `''`（全库统一用空串表示根，而不是 `'/'`）", () => {
    expect(dropFolderOf('A.md', false)).toBe('');
  });

  it("根目录本身 → `''`", () => {
    expect(dropFolderOf('', true)).toBe('');
  });

  it('去掉首尾空白与结尾多余的斜杠', () => {
    expect(dropFolderOf('  Notes/Sub/  ', true)).toBe('Notes/Sub');
    expect(dropFolderOf('Notes//', true)).toBe('Notes');
  });

  it('没有斜杠的文件名只截到空串（不会把文件名当目录）', () => {
    expect(dropFolderOf('readme', false)).toBe('');
  });
});

describe('noteMarkdownOf', () => {
  it('正文原样返回（只去掉首尾空白）', () => {
    expect(noteMarkdownOf('  # 标题\n正文 \n')).toBe('# 标题\n正文');
  });

  it('空 / 只有空白 → null（否则会写出一堆空文件，用户只会以为"导出坏了"）', () => {
    expect(noteMarkdownOf('')).toBeNull();
    expect(noteMarkdownOf('   \n\t\r\n ')).toBeNull();
  });

  it('换行统一成 `\\n`', () => {
    expect(noteMarkdownOf('a\r\nb\rc')).toBe('a\nb\nc');
  });
});
