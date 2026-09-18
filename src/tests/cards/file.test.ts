/**
 * 文件卡单元测试（T1.53 / `F2-3-7` + T3.10 / `F2-3-8`）。
 *
 * 渲染本身要在真环境里才验得准（真正的 `<span>`、真正的 `isConnected` 时序），
 * 所以这里钉的是**纯逻辑**那几件错了很难肉眼发现的事：
 *   1. **扩展名归一**：点开头的隐藏文件不能被当成"扩展名是 `gitignore`"，
 *      否则 `.gitignore` 会顶着一个 `GITIGNORE` 徽标 —— 那些判定早在 `extensionOf`
 *      的 `dot <= 0` 里定死了，回归时要有测试接着；
 *   2. **大小格式化**：1024 进制、10 以下留一位小数 —— 与系统显示不一致时
 *      用户第一反应是"插件算错了"；
 *   3. **三种状态的判定**顺序：空路径 → 缺失 → 就绪，顺序错了会把空卡说成断链；
 *   4. **能播的白名单**（T3.10）：名单比"像不像媒体"保守得多，多放一个进去
 *      就是给用户一个黑框（`.mkv` 的解码器 Chromium 没有）；
 *   5. **播放器两态**（T3.10）：概览态**不吃指针**（整张卡要能拖）、播放态才吃；
 *      以及**停播**那两条 —— 节点滚出视口时媒体元素仍会继续播，只 `pause()`
 *      不松 `src` 的节点留在复用池里一直握着文件。
 */

import { describe, expect, it, vi } from 'vitest';
import {
  FILE_DEFAULT_SIZE,
  extensionBadgeOf,
  extensionOf,
  fileCard,
  fileNameOf,
  fileState,
  formatFileSize,
  formatFileTime,
  mediaKindOf,
  stopMedia,
} from '../../cards/file';
import type { CardActionContext, CardRenderContext } from '../../cards/registry';
import { createCard } from '../../model/factories';
import {
  createFakeDocument,
  createFakeElement,
  createKeyEvent,
  type FakeDocument,
  type FakeElement,
} from '../helpers/fakeDom';

// ── 纯函数 ────────────────────────────────────────────────────

describe('fileNameOf', () => {
  it('取最后一段', () => {
    expect(fileNameOf('assets/img/photo.png')).toBe('photo.png');
    expect(fileNameOf('photo.png')).toBe('photo.png');
  });

  it('没有斜杠时原样返回；空串返回空串', () => {
    expect(fileNameOf('')).toBe('');
    expect(fileNameOf('README')).toBe('README');
  });
});

describe('extensionOf', () => {
  it('归一为小写、不含点', () => {
    expect(extensionOf('a/b/Report.PDF')).toBe('pdf');
    expect(extensionOf('x.zip')).toBe('zip');
  });

  it('点开头的隐藏文件不算扩展名（`.gitignore` 的点是文件名的一部分）', () => {
    expect(extensionOf('.gitignore')).toBe('');
    expect(extensionOf('dir/.env')).toBe('');
  });

  it('没有扩展名 / 以点结尾都返回空串', () => {
    expect(extensionOf('README')).toBe('');
    expect(extensionOf('note.')).toBe('');
  });
});

describe('extensionBadgeOf', () => {
  it('大写显示；无扩展名给 `?`', () => {
    expect(extensionBadgeOf('photo.png')).toBe('PNG');
    expect(extensionBadgeOf('README')).toBe('?');
  });

  it('超长扩展名只截前 4 个字母（徽标是个小方块，放不下）', () => {
    expect(extensionBadgeOf('a.markdown')).toBe('MARK');
    expect(extensionBadgeOf('a.docx')).toBe('DOCX');
  });
});

describe('formatFileSize', () => {
  it('1KB 以下按字节、取整', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(999)).toBe('999 B');
    expect(formatFileSize(1023)).toBe('1023 B');
  });

  it('按 1024 进制换算（与系统「文件大小」一致）', () => {
    expect(formatFileSize(1024)).toBe('1.0 KB');
    expect(formatFileSize(1024 * 1024)).toBe('1.0 MB');
    expect(formatFileSize(1024 ** 3)).toBe('1.0 GB');
    expect(formatFileSize(1024 ** 4)).toBe('1.0 TB');
  });

  it('10 以下留一位小数、10 以上取整（`1.4 MB` 有信息量，`87.3 MB` 没有）', () => {
    expect(formatFileSize(1024 * 1.4)).toBe('1.4 KB');
    expect(formatFileSize(1024 * 10)).toBe('10 KB');
    expect(formatFileSize(1024 * 87.3)).toBe('87 KB');
  });

  it('拿不到大小的输入返回空串（宁可空着，也不显示 `NaN B`）', () => {
    expect(formatFileSize(-1)).toBe('');
    expect(formatFileSize(Number.NaN)).toBe('');
    expect(formatFileSize(Number.POSITIVE_INFINITY)).toBe('');
  });
});

describe('formatFileTime（`A7` 文件卡第二行）', () => {
  it('定长 `YYYY-MM-DD HH:mm`，月 / 日 / 时 / 分都补零（不补的话这一行会左右抖）', () => {
    expect(formatFileTime(new Date(2026, 8, 8, 9, 5).getTime())).toBe('2026-09-08 09:05');
    expect(formatFileTime(new Date(2026, 11, 31, 23, 59).getTime())).toBe('2026-12-31 23:59');
  });

  it('坏输入返回空串（调用方 `filter` 掉它，不会留下一个孤零零的 `·`）', () => {
    expect(formatFileTime(0)).toBe('');
    expect(formatFileTime(-1)).toBe('');
    expect(formatFileTime(Number.NaN)).toBe('');
    expect(formatFileTime(Number.POSITIVE_INFINITY)).toBe('');
  });
});

describe('fileState', () => {
  const exists = (value: string): boolean => value === 'ok.png';

  it('空路径 → empty（还没指定文件，不是断链）', () => {
    expect(fileState({ path: '' }, exists)).toBe('empty');
    expect(fileState({ path: '' }, null)).toBe('empty');
  });

  it('有 Vault 桥时按 `exists` 分流', () => {
    expect(fileState({ path: 'ok.png' }, exists)).toBe('ready');
    expect(fileState({ path: 'gone.png' }, exists)).toBe('missing');
  });

  it('没有桥（单测 / 嵌入场景）一律当作能读：读不到是运行时才知道的事', () => {
    expect(fileState({ path: 'whatever.png' }, null)).toBe('ready');
  });
});

// ── 卡片定义契约 ──────────────────────────────────────────────

describe('fileCard 定义', () => {
  it('暴露类型 / 默认尺寸 / 默认内容（新建文件卡用它）', () => {
    expect(fileCard.type).toBe('file');
    expect(fileCard.defaultSize).toEqual(FILE_DEFAULT_SIZE);
    expect(fileCard.createDefaultContent()).toEqual({ path: '', showSize: true });
  });

  it('导出为 Markdown 用普通 wikilink 而不是嵌入', () => {
    const card = createCard('file', { content: { path: 'assets/a.pdf', showSize: true } });
    expect(fileCard.toMarkdown(card, { sourcePath: '' })).toBe('[[assets/a.pdf]]');
  });

  it('双击空路径不接管（交给视图，别把一次空双击变成"打开失败"）', () => {
    const card = createCard('file', { content: { path: '', showSize: true } });
    const actionCtx = { sourcePath: '' } as unknown as CardActionContext;
    expect(fileCard.onDoubleClick?.(card, actionCtx)).toBe(false);
  });
});

// ── 媒体：能不能播（T3.10 / `F2-3-8`）────────────────────────

describe('mediaKindOf', () => {
  it('视频 / 音频各归各的（与 Obsidian 能内嵌播放的范围一致）', () => {
    for (const path of ['a.mp4', 'clip.webm', 'a.ogv', 'a.mov']) {
      expect(mediaKindOf(path)).toBe('video');
    }
    for (const path of ['a.mp3', 'a.wav', 'a.m4a', 'a.3gp', 'a.flac', 'a.ogg', 'a.oga', 'a.opus']) {
      expect(mediaKindOf(path)).toBe('audio');
    }
  });

  it('★ 大小写不影响判定（`VIDEO.MP4` 也得能播）', () => {
    expect(mediaKindOf('VIDEO.MP4')).toBe('video');
    expect(mediaKindOf('Podcast.MP3')).toBe('audio');
  });

  it('★ 名单故意保守：Chromium 解不了的容器一律不给播放器（给了就是个黑框）', () => {
    for (const path of ['movie.mkv', 'movie.avi', 'movie.wmv', 'movie.flv', 'movie.m4v']) {
      expect(mediaKindOf(path)).toBeNull();
    }
  });

  it('普通文件、无扩展名、点开头的隐藏文件都不是媒体', () => {
    for (const path of ['a.pdf', 'README', 'a.zip', 'assets/', '.mp4', '.gitignore', '']) {
      expect(mediaKindOf(path)).toBeNull();
    }
  });
});

describe('stopMedia', () => {
  it('停播三件套：`pause()` + 清 `src` + `load()`（只 pause 的话节点留在池子里仍握着文件）', () => {
    const media = {
      pause: vi.fn(),
      removeAttribute: vi.fn(),
      load: vi.fn(),
    } as unknown as HTMLMediaElement;

    stopMedia(media);

    expect(media.pause).toHaveBeenCalledTimes(1);
    expect(media.removeAttribute).toHaveBeenCalledWith('src');
    expect(media.load).toHaveBeenCalledTimes(1);
  });
});

// ── 媒体：播放器两态（T3.10）────────────────────────────────

/** 会记账的媒体元素：`play` / `pause` / `load` 都要能断言 */
type FakeMedia = FakeElement & {
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
  removeAttribute: ReturnType<typeof vi.fn>;
  /** 卡片直接赋在元素上的那几个媒体属性（假 DOM 里就是普通字段） */
  controls?: boolean;
  preload?: string;
  playsInline?: boolean;
  src?: string;
};

/** 假 DOM 只造键事件：指针 / 点击事件借它做一个只关心 `stopPropagation` 的壳 */
const fakeEvent = (): ReturnType<typeof createKeyEvent> => createKeyEvent({ key: '' });

/** 假 DOM 里没有媒体方法，就地给 `video` / `audio` 补上（不改动共用的 `fakeDom.ts`） */
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
      controls: false,
    }) as unknown as FakeMedia;
    media.push(withMedia);
    return withMedia;
  };
  return { doc, media };
}

interface Rendered {
  el: FakeElement;
  media: FakeMedia[];
  contentReady: ReturnType<typeof vi.fn>;
}

function renderFile(
  path: string,
  options: { url?: string | null; showSize?: boolean } = {},
): Rendered {
  const { doc, media } = createMediaDoc();
  const el = createFakeElement(doc);
  const contentReady = vi.fn();
  const ctx = {
    notes: {
      exists: () => true,
      resourceUrl: () => (options.url === undefined ? 'app://local/media' : options.url),
    },
    contentReady,
  } as unknown as CardRenderContext;

  const card = createCard('file', { content: { path, showSize: options.showSize ?? true } });
  fileCard.render(el as unknown as HTMLElement, card, ctx);
  return { el, media, contentReady };
}

/** 播放器根节点（有播放器时它夹在"文件名行"与"大小行"之间） */
const playerOf = (el: FakeElement): FakeElement | undefined =>
  (el.children as FakeElement[]).find((child) => child.dataset.kind !== undefined);

const buttonOf = (root: FakeElement, className: string): FakeElement | undefined =>
  (root.children as FakeElement[]).find((child) => child.classList.contains(className));

describe('音视频卡渲染', () => {
  it('视频：建播放器 + 播放按钮，概览态**不开**原生控件（控件一出现就要吃指针）', () => {
    const { el, media } = renderFile('clip.mp4');

    const player = playerOf(el);
    expect(player?.dataset.kind).toBe('video');
    expect(el.classList.contains('has-media')).toBe(true);

    const [frame] = media;
    expect(frame.preload).toBe('metadata');
    expect(frame.src).toBe('app://local/media');
    expect(frame.controls).toBe(false);
    expect(frame.playsInline).toBe(true);
    expect(buttonOf(player!, 'nestboard-media-play')?.textContent).toBe('▶');
  });

  it('★ 概览态的画面区**不吃指针**：整张卡都要能拖（否则视频卡就没法挪了）', () => {
    const { media } = renderFile('clip.mp4');
    const frame = media[0];

    const idle = fakeEvent();
    frame.emit('pointerdown', idle);
    expect(idle.propagationStopped).toBe(false);
  });

  it('★ 点播放：交给原生控件 + 开始播 + 挡住冒泡（不挡就变成"边拖卡边点播放"）', () => {
    const { el, media } = renderFile('clip.mp4');
    const player = playerOf(el)!;
    const button = buttonOf(player, 'nestboard-media-play')!;

    const down = fakeEvent();
    button.emit('pointerdown', down);
    expect(down.propagationStopped).toBe(true);

    const click = fakeEvent();
    button.emit('click', click);
    expect(click.propagationStopped).toBe(true);
    expect(media[0].controls).toBe(true);
    expect(media[0].play).toHaveBeenCalledTimes(1);
    expect(player.classList.contains('is-playing')).toBe(true);

    // 播放中：播放器自己接管指针，拖动改由文件名那一行发起
    const playing = fakeEvent();
    media[0].emit('pointerdown', playing);
    expect(playing.propagationStopped).toBe(true);
  });

  it('★ 点收起：回到概览态（关控件 + 暂停），指针重新交还给卡片拖动', () => {
    const { el, media } = renderFile('clip.mp4');
    const player = playerOf(el)!;

    const click = fakeEvent();
    buttonOf(player, 'nestboard-media-play')!.emit('click', click);
    buttonOf(player, 'nestboard-media-collapse')!.emit('click', fakeEvent());

    expect(media[0].controls).toBe(false);
    expect(media[0].pause).toHaveBeenCalledTimes(1);
    expect(player.classList.contains('is-playing')).toBe(false);

    const idle = fakeEvent();
    media[0].emit('pointerdown', idle);
    expect(idle.propagationStopped).toBe(false);
  });

  it('音频：一行原生控件常驻可见，不做两态（它没有封面，中间态换不来任何东西）', () => {
    const { el, media } = renderFile('talk.mp3');

    const player = playerOf(el);
    expect(player?.dataset.kind).toBe('audio');
    expect(media[0].controls).toBe(true);
    expect(buttonOf(player!, 'nestboard-media-play')).toBeUndefined();

    // 音频控件永远吃掉指针（不挡的话点播放会变成拖卡片）
    const down = fakeEvent();
    media[0].emit('pointerdown', down);
    expect(down.propagationStopped).toBe(true);
  });

  it('拿到元数据后喊一次 `contentReady()` —— 竖屏视频的高度靠它才量得准', () => {
    const { media, contentReady } = renderFile('clip.mp4');
    media[0].emit('loadedmetadata', fakeEvent());
    expect(contentReady).toHaveBeenCalledTimes(1);
  });

  it('★ 解不开：把播放器换成一句话（`is-unplayable` 只加在播放器自己身上）', () => {
    const { el, media } = renderFile('clip.mp4');
    const player = playerOf(el)!;

    media[0].emit('error', fakeEvent());

    expect(player.classList.contains('is-unplayable')).toBe(true);
    // 播放器整个被撤掉，不留一个"能点但没用"的空壳
    expect(player.children).not.toContain(media[0]);
    // ★ 串味检查：这一刻节点可能已经装着别的卡了，槽位的 class 一个字都不能动
    expect(el.classList.contains('is-missing')).toBe(false);
  });

  it('普通文件卡照旧：没有播放器、没有 `has-media`（升级不能改动已有白板的版面）', () => {
    const { el } = renderFile('report.pdf');
    expect(playerOf(el)).toBeUndefined();
    expect(el.classList.contains('has-media')).toBe(false);
  });

  it('拿不到资源 URL（`resourceUrl` 给不出）时退回图标行，而不是画一个空壳', () => {
    const { el } = renderFile('clip.mp4', { url: null });
    expect(playerOf(el)).toBeUndefined();
    expect(el.classList.contains('has-media')).toBe(false);
  });

  it('断链 / 空路径仍然是那一句话，不会被播放器抢走', () => {
    const { doc, media } = createMediaDoc();
    const el = createFakeElement(doc);
    const ctx = {
      notes: { exists: () => false, resourceUrl: () => 'app://local/media' },
    } as unknown as CardRenderContext;

    fileCard.render(
      el as unknown as HTMLElement,
      createCard('file', { content: { path: 'gone.mp4', showSize: true } }),
      ctx,
    );

    expect(media).toHaveLength(0);
    expect(el.classList.contains('is-missing')).toBe(true);
  });
});

describe('音视频卡的生命周期', () => {
  it('★ `destroy()` 停播：卡片滚出视口时节点被摘出 DOM，而媒体元素摘下来仍会继续播', () => {
    const { el, media } = renderFile('clip.mp4');
    const frame = media[0];

    fileCard.destroy?.(el as unknown as HTMLElement);

    expect(frame.pause).toHaveBeenCalledTimes(1);
    expect(frame.removeAttribute).toHaveBeenCalledWith('src');
    expect(frame.load).toHaveBeenCalledTimes(1);
    expect(el.classList.contains('has-media')).toBe(false);
    expect(el.children).toHaveLength(0);
  });

  it('★ 重画（槽位换了文件）先停掉上一个播放器：否则它会带着上一份文件的 `src` 留在池子里', () => {
    const { el, media } = renderFile('clip.mp4');
    const first = media[0];

    const ctx = {
      notes: { exists: () => true, resourceUrl: () => 'app://local/other' },
      contentReady: vi.fn(),
    } as unknown as CardRenderContext;
    fileCard.render(
      el as unknown as HTMLElement,
      createCard('file', { content: { path: 'other.mp4', showSize: true } }),
      ctx,
    );

    expect(first.pause).toHaveBeenCalledTimes(1);
    expect(first.removeAttribute).toHaveBeenCalledWith('src');
    expect(media).toHaveLength(2);
    expect(media[1].src).toBe('app://local/other');
  });

  it('换成的不是媒体（mp4 → pdf）：播放器撤走，`has-media` 一起摘掉', () => {
    const { el, media } = renderFile('clip.mp4');

    const ctx = {
      notes: { exists: () => true, resourceUrl: () => 'app://local/x' },
      contentReady: vi.fn(),
    } as unknown as CardRenderContext;
    fileCard.render(
      el as unknown as HTMLElement,
      createCard('file', { content: { path: 'a.pdf', showSize: true } }),
      ctx,
    );

    expect(media[0].pause).toHaveBeenCalledTimes(1);
    expect(el.classList.contains('has-media')).toBe(false);
    expect(playerOf(el)).toBeUndefined();
  });
});

describe('mediaCard.measure', () => {
  const measure = (el: FakeElement, path: string): number =>
    fileCard.measure!(
      el as unknown as HTMLElement,
      createCard('file', { content: { path } }),
      {} as CardRenderContext,
    );

  it('媒体卡用 `scrollHeight` 报数（标题行 + 播放器 + 大小行谁多高，是 CSS 说了算）', () => {
    const { doc } = createMediaDoc();
    const el = createFakeElement(doc);
    Object.assign(el, { scrollHeight: 240 });
    expect(measure(el, 'clip.mp4')).toBe(240);
    expect(measure(el, 'talk.mp3')).toBe(240);
  });

  it('★ 普通文件卡不表态（返回 0）：接上 `scrollHeight` 会让已有白板升级后集体变高', () => {
    const { doc } = createMediaDoc();
    const el = createFakeElement(doc);
    Object.assign(el, { scrollHeight: 240 });
    expect(measure(el, 'report.pdf')).toBe(0);
    expect(measure(el, 'README')).toBe(0);
  });
});

// ── 版式（`A7`）：两行信息 + 悬停「打开」──────────────────────

describe('文件卡版式（A7）', () => {
  const rowOf = (el: FakeElement): FakeElement => el.children[0] as FakeElement;
  /** `el > .nestboard-file-main > .nestboard-file-text > .nestboard-file-meta` */
  const metaOf = (el: FakeElement): FakeElement =>
    (rowOf(el).children[1] as FakeElement).children[1] as FakeElement;
  const openOf = (el: FakeElement): FakeElement | undefined =>
    (el.children as FakeElement[]).find((child) => child.classList.contains('nestboard-file-open'));

  const renderWithShell = (
    path: string,
    info: { size: number; mtime: number } | null,
  ): {
    el: FakeElement;
    statInfo: ReturnType<typeof vi.fn>;
    openPath: ReturnType<typeof vi.fn>;
    contentReady: ReturnType<typeof vi.fn>;
  } => {
    const { doc } = createMediaDoc();
    const el = createFakeElement(doc);
    const statInfo = vi.fn(async () => info);
    const openPath = vi.fn(async () => true);
    const contentReady = vi.fn();
    const ctx = {
      notes: { exists: () => true, resourceUrl: () => 'app://local/x' },
      shell: { statInfo, openPath },
      contentReady,
    } as unknown as CardRenderContext;

    fileCard.render(
      el as unknown as HTMLElement,
      createCard('file', { content: { path, showSize: true } }),
      ctx,
    );
    return { el, statInfo, openPath, contentReady };
  };

  it('★ 第二行先建节点、后异步填「大小 · 修改时间」', async () => {
    const { el, statInfo, contentReady } = renderWithShell('report.pdf', {
      size: 1024 * 1024,
      mtime: new Date(2026, 8, 18, 14, 32).getTime(),
    });

    expect(statInfo).toHaveBeenCalledWith('report.pdf');
    // 数据还没回来：是个空节点（样式表 `:empty` 把它整个收掉，卡片不会先矮一下）
    expect(metaOf(el).textContent).toBe('');

    // 假 DOM 的节点没有 `isConnected`（真浏览器里挂在 DOM 上就恒为 true）
    (el as unknown as { isConnected: boolean }).isConnected = true;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(metaOf(el).textContent).toBe('1.0 MB · 2026-09-18 14:32');
    // 一行新内容 ⇒ 卡片层要重量一次高度（T1.38）
    expect(contentReady).toHaveBeenCalledTimes(1);
  });

  it('只有大小 / 什么都没有时，不留一个孤零零的 `·`', async () => {
    const only = renderWithShell('a.pdf', { size: 2048, mtime: 0 });
    (only.el as unknown as { isConnected: boolean }).isConnected = true;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(metaOf(only.el).textContent).toBe('2.0 KB');

    const none = renderWithShell('a.pdf', null);
    (none.el as unknown as { isConnected: boolean }).isConnected = true;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(metaOf(none.el).textContent).toBe('');
  });

  it('★ 「打开」只在有系统能力桥时才画（点了没反应的按钮比不画更糟）', () => {
    // 老 helper 没有 `shell`
    expect(openOf(renderFile('report.pdf').el)).toBeUndefined();
    expect(openOf(renderWithShell('report.pdf', null).el)).toBeDefined();
  });

  it('★ 「打开」按一下走 `openPath` 并挡住冒泡（不挡就变成"边拖卡边打开"）', () => {
    const { el, openPath } = renderWithShell('report.pdf', null);
    const open = openOf(el)!;

    const down = fakeEvent();
    open.emit('pointerdown', down);
    expect(down.propagationStopped).toBe(true);

    const click = fakeEvent();
    open.emit('click', click);
    expect(click.propagationStopped).toBe(true);
    expect(openPath).toHaveBeenCalledWith('report.pdf');
  });
});
