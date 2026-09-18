import { describe, expect, it } from 'vitest';
import {
  ILLEGAL_IN_NAME,
  joinPath,
  normalizeFolder,
  noteNameFrom,
  sanitizeFileName,
  splitName,
  uniquePath,
} from '../../util/fileName';

describe('splitName', () => {
  it('带目录与扩展名：拆出 dir / base / ext', () => {
    expect(splitName('a/b/c.png')).toEqual({ dir: 'a/b', base: 'c', ext: '.png' });
  });

  it('无目录：dir 为空串', () => {
    expect(splitName('c.png')).toEqual({ dir: '', base: 'c', ext: '.png' });
  });

  it('无扩展名：ext 为空串', () => {
    expect(splitName('a/b/c')).toEqual({ dir: 'a/b', base: 'c', ext: '' });
    expect(splitName('a.b/c')).toEqual({ dir: 'a.b', base: 'c', ext: '' });
  });

  it('多点文件名只认最后一个点为扩展名', () => {
    expect(splitName('archive.tar.gz')).toEqual({ dir: '', base: 'archive.tar', ext: '.gz' });
  });

  it('点开头的文件没有扩展名（不能切出空 base）', () => {
    expect(splitName('.gitignore')).toEqual({ dir: '', base: '.gitignore', ext: '' });
  });

  it('空串与尾部斜杠的退化输入', () => {
    expect(splitName('')).toEqual({ dir: '', base: '', ext: '' });
    expect(splitName('a/b/')).toEqual({ dir: 'a/b', base: '', ext: '' });
  });
});

describe('normalizeFolder / joinPath', () => {
  it('去掉末尾多余的斜杠，空串与根斜杠都归一为 ""', () => {
    expect(normalizeFolder('a/b/')).toBe('a/b');
    expect(normalizeFolder('a/b')).toBe('a/b');
    expect(normalizeFolder('a//')).toBe('a');
    expect(normalizeFolder('/')).toBe('');
    expect(normalizeFolder('')).toBe('');
  });

  it('joinPath 拼目录与文件名，folder 为空时不带前缀斜杠', () => {
    expect(joinPath('a/b', 'c.png')).toBe('a/b/c.png');
    expect(joinPath('a/b/', 'c.png')).toBe('a/b/c.png');
    expect(joinPath('', 'c.png')).toBe('c.png');
    expect(joinPath('/', 'c.png')).toBe('c.png');
  });
});

describe('sanitizeFileName', () => {
  it('非法字符换成空格而不是删除', () => {
    expect(sanitizeFileName('a/b')).toBe('a b');
    expect(sanitizeFileName('a:b*c?')).toBe('a b c');
  });

  it('连续空白压成一个空格并 trim', () => {
    expect(sanitizeFileName('  a   b  ')).toBe('a b');
    expect(sanitizeFileName('a\n\tb')).toBe('a b');
  });

  it('结果为空时返回 fallback（默认 未命名，也可由调用方指定）', () => {
    expect(sanitizeFileName('')).toBe('未命名');
    expect(sanitizeFileName('///')).toBe('未命名');
    expect(sanitizeFileName('   ')).toBe('未命名');
    expect(sanitizeFileName('', '粘贴图片')).toBe('粘贴图片');
  });

  it('截断到 80 字符', () => {
    expect(sanitizeFileName('a'.repeat(100))).toHaveLength(80);
    expect(sanitizeFileName('a'.repeat(100))).toBe('a'.repeat(80));
  });
});

describe('noteNameFrom', () => {
  it('与 NotePromoter 的语义一致：非法字符换空格、空标题退化为 未命名', () => {
    expect(noteNameFrom('我的/白板')).toBe('我的 白板');
    expect(noteNameFrom('   ')).toBe('未命名');
    expect(noteNameFrom('a#b^c')).toBe('a b c');
  });
});

describe('ILLEGAL_IN_NAME', () => {
  it('覆盖 Windows / macOS / Obsidian 链接语法的非法字符并集', () => {
    const dirty = String.raw`\/:*?"<>|#^[]`;
    expect(dirty.replace(ILLEGAL_IN_NAME, '')).toBe('');
  });
});

describe('uniquePath', () => {
  it('无冲突时直接用 base + ext', async () => {
    await expect(uniquePath('dir', '名字', '.png', () => false)).resolves.toBe('dir/名字.png');
  });

  it('同名顺延为 名字 2 / 名字 3…', async () => {
    const taken = new Set(['dir/a.png', 'dir/a 2.png']);
    await expect(uniquePath('dir', 'a', '.png', (path) => taken.has(path))).resolves.toBe(
      'dir/a 3.png',
    );
  });

  it('支持异步 exists', async () => {
    const taken = new Set(['a.png']);
    await expect(uniquePath('', 'a', '.png', async (path) => taken.has(path))).resolves.toBe(
      'a 2.png',
    );
  });

  it('★ exists 永远为 true 时命中 1000 次防御上限，不进入死循环', async () => {
    await expect(uniquePath('', 'a', '.png', () => true)).resolves.toBe('a 999.png');
  });
});
