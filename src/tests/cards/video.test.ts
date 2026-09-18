/**
 * 视频卡（`A1`）。
 *
 * 渲染要在真环境里才验得准（真 `<video>`、真的播放器时序），所以这里钉的是**契约与生命周期**
 * 那几件错了很难肉眼发现的事：
 *
 *  1. **内容形状与文件卡同源**：`showSize: false`、路径就是全部内容；
 *  2. **三种画不出画面**各自说的话不一样（还没挑 / 文件不在了 / 拿不到资源 URL）——
 *     "文件不在了"必须带上路径，否则用户不知道是哪一份丢了；
 *  3. **生命周期**：重画与 `destroy()` 都要先停掉上一个播放器 —— 媒体元素被摘出 DOM
 *     之后仍会继续播，少了这一步就是"滚走了还在响"。
 */

import { describe, expect, it, vi } from 'vitest';
import { VIDEO_DEFAULT_SIZE, normalizeVideoCardColor, videoCard } from '../../cards/video';
import type { CardRenderContext } from '../../cards/registry';
import { createCard } from '../../model/factories';
import { dropKindForPath } from '../../model/drop';
import {
  createFakeDocument,
  createFakeElement,
  type FakeDocument,
  type FakeElement,
} from '../helpers/fakeDom';

/** 会记账的媒体元素（假 DOM 里没有媒体方法，就地补上） */
type FakeMedia = FakeElement & {
  pause: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
  removeAttribute: ReturnType<typeof vi.fn>;
  preload?: string;
  playsInline?: boolean;
  controls?: boolean;
  src?: string;
};

function createMediaDoc(): { doc: FakeDocument; media: FakeMedia[] } {
  const doc = createFakeDocument();
  const media: FakeMedia[] = [];
  const base = doc.createElement;
  doc.createElement = (tag: string) => {
    const element = base(tag) as FakeElement;
    if (tag !== 'video' && tag !== 'audio') return element;
    const withMedia = Object.assign(element, {
      play: vi.fn(() => Promise.resolve()),
      pause: vi.fn(),
      load: vi.fn(),
      removeAttribute: vi.fn(),
    }) as unknown as FakeMedia;
    media.push(withMedia);
    return withMedia;
  };
  return { doc, media };
}

function renderVideo(
  path: string,
  options: { url?: string | null; exists?: boolean; shell?: boolean } = {},
): { el: FakeElement; media: FakeMedia[] } {
  const { doc, media } = createMediaDoc();
  const el = createFakeElement(doc);
  const ctx = {
    notes: {
      exists: () => options.exists ?? true,
      resourceUrl: () => (options.url === undefined ? 'app://local/video' : options.url),
    },
    shell: options.shell ? { openPath: vi.fn(async () => true) } : undefined,
  } as unknown as CardRenderContext;

  videoCard.render(el as unknown as HTMLElement, createCard('video', { content: { path } }), ctx);
  return { el, media };
}

const playerOf = (el: FakeElement): FakeElement | undefined =>
  // ★ 占位态的子节点是**文本节点**（没有 `dataset`）⇒ 这里必须容错，否则断言自己先崩
  (el.children as FakeElement[]).find((child) => child?.dataset?.kind !== undefined);

describe('videoCard 定义', () => {
  it('类型 / 图标 / 16:9 默认尺寸 / 默认内容（新建时用它）', () => {
    expect(videoCard.type).toBe('video');
    expect(videoCard.icon).toBe('film');
    expect(videoCard.defaultSize).toEqual(VIDEO_DEFAULT_SIZE);
    // 内容与文件卡同形状，但不画"大小"那一行
    expect(videoCard.createDefaultContent()).toEqual({ path: '', showSize: false });
  });

  it('★ 拖入视频扩展名 ⇒ 落的就是视频卡（不是文件卡）', () => {
    expect(dropKindForPath('assets/clip.mp4')).toBe('video');
    expect(dropKindForPath('a/b/录屏.MOV')).toBe('video');
    // 解不了的容器仍退回文件卡（给了播放器只会是个黑框）
    expect(dropKindForPath('movie.mkv')).toBe('file');
    expect(dropKindForPath('report.pdf')).toBe('file');
  });

  it('导出成 Markdown 用内嵌（`![[…]]`，Obsidian 自己会渲染成播放器）', () => {
    const card = createCard('video', { content: { path: 'assets/clip.mp4' } });
    expect(videoCard.toMarkdown(card, { sourcePath: '' })).toBe('![[assets/clip.mp4]]');
    expect(
      videoCard.toMarkdown(createCard('video', { content: { path: '' } }), { sourcePath: '' }),
    ).toBe('');
  });

  it('★ 默认色是**纯黑**（用户 2026-09-18："卡片颜色全黑，边框也全黑"）：等于全局默认色才掰', () => {
    const fresh = createCard('video', { content: { path: 'a.mp4' }, color: '2' });
    expect(normalizeVideoCardColor(fresh, '2')).toBe(true);
    expect(fresh.color).toBe('#000000');

    // 用户自己挑过的颜色一个字节都不动
    const picked = createCard('video', { content: { path: 'a.mp4' }, color: '4' });
    expect(normalizeVideoCardColor(picked, '2')).toBe(false);
    expect(picked.color).toBe('4');

    // 幂等：已经是黑的 ⇒ 不动（每次开板都会走到这一句）
    expect(normalizeVideoCardColor(fresh, '#000000')).toBe(false);
  });
});

describe('videoCard.render', () => {
  it('有路径 + 拿得到资源 URL ⇒ 建出播放器（复用文件卡那一套）', () => {
    const { el, media } = renderVideo('assets/clip.mp4');

    const player = playerOf(el);
    expect(player?.dataset.kind).toBe('video');
    expect(el.classList.contains('is-missing')).toBe(false);
    expect(media[0]?.preload).toBe('metadata');
    expect(media[0]?.playsInline).toBe(true);
  });

  it('★ 还没挑文件 ⇒ 占位语（不是"文件不存在"，那会指着一个空路径说话）', () => {
    const { el, media } = renderVideo('');
    expect(el.classList.contains('is-missing')).toBe(true);
    expect(el.dataset.placeholder).toBe('true');
    expect(playerOf(el)).toBeUndefined();
    expect(media).toHaveLength(0);
  });

  it('★ 文件不在了 ⇒ 那句话**带上路径**（不说路径就不知道丢的是哪一份）', () => {
    const { el } = renderVideo('assets/gone.mp4', { exists: false });
    expect(el.classList.contains('is-missing')).toBe(true);
    const [text] = el.children as unknown as { textContent?: string }[];
    expect(text?.textContent ?? '').toContain('assets/gone.mp4');
  });

  it('拿不到资源 URL ⇒ 画占位，而不是一个点了没反应的空壳', () => {
    const { el } = renderVideo('assets/clip.mp4', { url: null });
    expect(el.classList.contains('is-missing')).toBe(true);
    expect(playerOf(el)).toBeUndefined();
  });
});

describe('videoCard 的生命周期', () => {
  it('★ `destroy()` 先停播再拆子树（节点被摘出 DOM 后媒体仍会继续播）', () => {
    const { el, media } = renderVideo('assets/clip.mp4');
    const frame = media[0]!;

    videoCard.destroy?.(el as unknown as HTMLElement);

    expect(frame.pause).toHaveBeenCalledTimes(1);
    expect(frame.removeAttribute).toHaveBeenCalledWith('src');
    expect(frame.load).toHaveBeenCalledTimes(1);
    expect(el.children).toHaveLength(0);
  });

  it('★ 重画（槽位换了另一份视频）先停掉上一个播放器', () => {
    const { doc, media } = createMediaDoc();
    const el = createFakeElement(doc);
    const notes = { exists: () => true, resourceUrl: () => 'app://local/next' };
    const ctx = { notes } as unknown as CardRenderContext;

    videoCard.render(
      el as unknown as HTMLElement,
      createCard('video', { content: { path: 'a.mp4' } }),
      ctx,
    );
    videoCard.render(
      el as unknown as HTMLElement,
      createCard('video', { content: { path: 'b.mp4' } }),
      ctx,
    );

    expect(media[0]?.pause).toHaveBeenCalledTimes(1);
    expect(media).toHaveLength(2);
    expect(media[1]?.src).toBe('app://local/next');
  });
});
