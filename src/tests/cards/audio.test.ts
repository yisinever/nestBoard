/**
 * 音频卡（`A2`，"留声机"）。
 *
 * 钉三件事（都是"看着能跑、其实错"的那类）：
 *
 *  1. **播放态是类 + 图标一起换**（`.is-playing` 让唱片转，图标换成暂停）——
 *     只换其中一个，用户就会看到"图标说在放、唱片不转"；
 *  2. **进度条只有一处改宽度**（`paint`）：三处调用各写一份，迟早出现
 *     "拖了进度但填充条没动"；
 *  3. **生命周期**：重画与 `destroy()` 都要先停掉上一个 `<audio>`（摘出 DOM 后仍会继续播）。
 */

import { describe, expect, it, vi } from 'vitest';
import {
  AUDIO_DEFAULT_SIZE,
  audioCard,
  formatClock,
  normalizeAudioCardColor,
} from '../../cards/audio';
import type { CardRenderContext } from '../../cards/registry';
import { createCard } from '../../model/factories';
import { dropKindForPath } from '../../model/drop';
import {
  createFakeDocument,
  createFakeElement,
  type FakeDocument,
  type FakeElement,
} from '../helpers/fakeDom';

type FakeMedia = FakeElement & {
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
  removeAttribute: ReturnType<typeof vi.fn>;
  paused: boolean;
  muted: boolean;
  volume: number;
  currentTime: number;
  duration: number;
  preload?: string;
  src?: string;
};

function createMediaDoc(): { doc: FakeDocument; media: FakeMedia[] } {
  const doc = createFakeDocument();
  const media: FakeMedia[] = [];
  const base = doc.createElement;
  doc.createElement = (tag: string) => {
    const element = base(tag) as FakeElement;
    if (tag !== 'audio' && tag !== 'video') return element;
    const withMedia = Object.assign(element, {
      play: vi.fn(() => Promise.resolve()),
      pause: vi.fn(),
      load: vi.fn(),
      removeAttribute: vi.fn(),
      paused: true,
      muted: false,
      volume: 1,
      currentTime: 0,
      duration: 0,
    }) as unknown as FakeMedia;
    media.push(withMedia);
    return withMedia;
  };
  return { doc, media };
}

function renderAudio(
  path: string,
  options: { url?: string | null; exists?: boolean } = {},
): { el: FakeElement; media: FakeMedia[] } {
  const { doc, media } = createMediaDoc();
  const el = createFakeElement(doc);
  const ctx = {
    notes: {
      exists: () => options.exists ?? true,
      resourceUrl: () => (options.url === undefined ? 'app://local/audio' : options.url),
    },
  } as unknown as CardRenderContext;

  audioCard.render(el as unknown as HTMLElement, createCard('audio', { content: { path } }), ctx);
  return { el, media };
}

/** 按类名在子树里找第一个（假 DOM 没有 `querySelector`） */
function find(el: FakeElement, className: string): FakeElement | undefined {
  if (el.classList.contains(className)) return el;
  for (const child of el.children as FakeElement[]) {
    const hit = find(child, className);
    if (hit) return hit;
  }
  return undefined;
}

describe('audioCard 定义', () => {
  it('类型 / 图标 / 正方形默认尺寸 / 默认内容', () => {
    expect(audioCard.type).toBe('audio');
    expect(audioCard.icon).toBe('disc');
    expect(audioCard.defaultSize).toEqual(AUDIO_DEFAULT_SIZE);
    expect(audioCard.createDefaultContent()).toEqual({ path: '', showSize: false });
  });

  it('★ 拖入音频扩展名 ⇒ 落音频卡；`.mkv` 这类仍退文件卡', () => {
    expect(dropKindForPath('assets/talk.mp3')).toBe('audio');
    expect(dropKindForPath('a/b/录音.M4A')).toBe('audio');
    expect(dropKindForPath('clip.mp4')).toBe('video');
    expect(dropKindForPath('movie.mkv')).toBe('file');
  });

  it('导出成 Markdown 用内嵌（Obsidian 自己会渲染成播放器）', () => {
    const card = createCard('audio', { content: { path: 'assets/talk.mp3' } });
    expect(audioCard.toMarkdown(card, { sourcePath: '' })).toBe('![[assets/talk.mp3]]');
  });

  it('★ 默认色是 `#FE232D`（用户 2026-09-18）：老版本的近黑 `#261f1b` 迁过去，挑过的不动', () => {
    // 老版本音频卡留下的近黑 → 迁到新默认红
    const legacy = createCard('audio', { content: { path: 'a.mp3' }, color: '#261f1b' });
    expect(normalizeAudioCardColor(legacy, '2')).toBe(true);
    expect(legacy.color).toBe('#FE232D');

    // 用户**主动挑过**的颜色一个字节都不动（哪怕它恰好等于全局默认色）——
    // 这正是"选了红、一刷新又变回去"那条报障的根因
    const picked = createCard('audio', { content: { path: 'a.mp3' }, color: '2' });
    expect(normalizeAudioCardColor(picked, '2')).toBe(false);
    expect(picked.color).toBe('2');

    // 幂等：已经是新默认色 ⇒ 不动（每次开板都会走到这一句）
    const fresh = createCard('audio', { content: { path: 'a.mp3' }, color: '#FE232D' });
    expect(normalizeAudioCardColor(fresh, '2')).toBe(false);
  });
});

describe('formatClock', () => {
  it('秒 → `m:ss`；一小时以上补 `h:`', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(9)).toBe('0:09');
    expect(formatClock(75)).toBe('1:15');
    expect(formatClock(3661)).toBe('1:01:01');
  });

  it('坏值给 `--:--`（不留一个 `NaN:NaN` 在卡面上）', () => {
    expect(formatClock(Number.NaN)).toBe('--:--');
    expect(formatClock(-1)).toBe('--:--');
    expect(formatClock(Number.POSITIVE_INFINITY)).toBe('--:--');
  });
});

describe('audioCard.render', () => {
  it('有路径 ⇒ 唱片 + 控制条，音频元素只读头部（`preload=metadata`）', () => {
    const { el, media } = renderAudio('assets/talk.mp3');

    expect(find(el, 'nestboard-record')).toBeDefined();
    expect(find(el, 'nestboard-audio-play')?.textContent).toBe('▶');
    expect(media[0]?.preload).toBe('metadata');
    expect(media[0]?.src).toBe('app://local/audio');
    expect(el.classList.contains('is-missing')).toBe(false);
  });

  it('还没挑文件 ⇒ 占位语，不建播放器', () => {
    const { el, media } = renderAudio('');
    expect(el.classList.contains('is-missing')).toBe(true);
    expect(media).toHaveLength(0);
  });

  it('文件不在了 ⇒ 那句话带上路径', () => {
    const { el } = renderAudio('assets/gone.mp3', { exists: false });
    const [text] = el.children as unknown as { textContent?: string }[];
    expect(text?.textContent ?? '').toContain('assets/gone.mp3');
  });
});

describe('audioCard 控制条', () => {
  const emit = (media: FakeMedia, type: string): void => {
    media.emit(type, { stopPropagation: () => {}, preventDefault: () => {} });
  };

  it('★ 点播放 ⇒ 起播；`play` 事件把"在放"写进类名与图标', () => {
    const { el, media } = renderAudio('assets/talk.mp3');
    const play = find(el, 'nestboard-audio-play')!;
    play.emit('click', { stopPropagation: () => {} });

    expect(media[0]?.play).toHaveBeenCalledTimes(1);

    // 事件由元素自己发出来（真实运行时浏览器发；这里手动）
    media[0]!.paused = false;
    emit(media[0]!, 'play');
    expect(el.classList.contains('is-playing')).toBe(true);
    expect(play.textContent).toBe('⏸');

    media[0]!.paused = true;
    emit(media[0]!, 'pause');
    expect(el.classList.contains('is-playing')).toBe(false);
    expect(play.textContent).toBe('▶');
  });

  it('★ 进度条：`timeupdate` 之后填充与滑块一起动（只有一处改宽度）', () => {
    const { el, media } = renderAudio('assets/talk.mp3');
    media[0]!.duration = 100;
    media[0]!.currentTime = 25;
    emit(media[0]!, 'timeupdate');

    expect(find(el, 'nestboard-audio-progress')?.style.getPropertyValue('width')).toBe('25%');
    expect(find(el, 'nestboard-audio-knob')?.style.getPropertyValue('left')).toBe('25%');
    // 时间那句话跟着走（`0:25 / 1:40`）
    expect(find(el, 'nestboard-audio-time')?.textContent).toBe('0:25 / 1:40');
  });

  it('★ 点进度条哪一段就跳到哪（`pointerdown` 生效，拖到一半松手也认）', () => {
    const { el, media } = renderAudio('assets/talk.mp3');
    media[0]!.duration = 200;

    const seek = find(el, 'nestboard-audio-seek')!;
    Object.assign(seek, { getBoundingClientRect: () => ({ left: 0, width: 100 }) });

    seek.emit('pointerdown', { stopPropagation: () => {}, clientX: 30 });
    expect(media[0]!.currentTime).toBeCloseTo(60);
  });

  it('★ 静音按钮：切换 `muted` 并换图标（图标与真实状态不许各说各话）', () => {
    const { el, media } = renderAudio('assets/talk.mp3');
    const mute = find(el, 'nestboard-audio-mute')!;

    mute.emit('click', { stopPropagation: () => {} });
    expect(media[0]!.muted).toBe(true);
    emit(media[0]!, 'volumechange');
    expect(mute.textContent).toBe('🔇');

    mute.emit('click', { stopPropagation: () => {} });
    emit(media[0]!, 'volumechange');
    expect(media[0]!.muted).toBe(false);
    expect(mute.textContent).toBe('🔊');
  });
});

describe('audioCard 生命周期', () => {
  it('★ `destroy()` 先停播再拆子树', () => {
    const { el, media } = renderAudio('assets/talk.mp3');
    const frame = media[0]!;

    audioCard.destroy?.(el as unknown as HTMLElement);

    expect(frame.pause).toHaveBeenCalledTimes(1);
    expect(frame.removeAttribute).toHaveBeenCalledWith('src');
    expect(frame.load).toHaveBeenCalledTimes(1);
    expect(el.children).toHaveLength(0);
  });

  it('★ 重画（换另一份音频）先停掉上一个播放器', () => {
    const { doc, media } = createMediaDoc();
    const el = createFakeElement(doc);
    const ctx = {
      notes: { exists: () => true, resourceUrl: () => 'app://local/next' },
    } as unknown as CardRenderContext;

    audioCard.render(
      el as unknown as HTMLElement,
      createCard('audio', { content: { path: 'a.mp3' } }),
      ctx,
    );
    audioCard.render(
      el as unknown as HTMLElement,
      createCard('audio', { content: { path: 'b.mp3' } }),
      ctx,
    );

    expect(media[0]?.pause).toHaveBeenCalledTimes(1);
    expect(media).toHaveLength(2);
  });
});
