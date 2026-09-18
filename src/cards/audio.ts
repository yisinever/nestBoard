/**
 * 音频卡（`A2`，用户 2026-09-18："支持音频播放器卡片 —— 本地音频：播放 / 调进度 /
 * 音量调节 / 漂亮的卡片样式（播放时留声机旋转）"）。
 *
 * ── 卡面长什么样 ─────────────────────────────────────────────
 *
 * 一张**唱片**（CSS 画的同心圆纹路 + 中央标签）+ 底下一行控制：播放 / 暂停、
 * 可点的进度条、时间、音量滑杆 + 静音。**播放时唱片转起来**（`.is-playing` 驱动
 * CSS 动画）—— 这就是"留声机"。
 *
 * ★ 唱片用 CSS 画、不用图片：跟着主题深浅自动变，也不必往插件包里塞一张 png。
 * ★ 转速用 `animation-play-state` 而不是"重新启动动画"：暂停时**停在当前角度**，
 *   接着播是接着转 —— 每次暂停都归零会让人以为"它跳回去了"。
 * ★ 与文件卡那套`<audio controls>` 的关系：那条路留着不动（老文件卡照旧），
 *   这张卡是**新建时**用的：拖一个 mp3 进来，落下的就是一张唱片。
 * ★ 时长 / 进度都从**元素自身**读（`duration` / `currentTime`），不额外解码一遍文件头。
 */

import type { CardColor, CardOf } from '../model/schema';
import type { Size } from '../util/geometry';
import { t } from '../util/i18n';
import { fileNameOf, formatFileSize, stopMedia } from './file';
import type { CardRenderContext, CardTypeDefinition } from './registry';

/** 默认尺寸：**9:10**（用户 2026-09-18）：唱片是圆的，卡片略高于宽才给下面那行控制条留出地方 */
export const AUDIO_DEFAULT_SIZE: Size = { width: 198, height: 220 };

/**
 * 新建音频卡的**默认颜色**：`#FE232D`（用户 2026-09-18："音频卡的默认颜色改成 #FE232D"）。
 *
 * ★ 一档醒目的红 —— 既然胶碟是用户要求**全黑**的（见 `.nestboard-record`），
 *   卡面能"露色"的地方就只剩这层底色 / 边框，所以默认得挑个一眼看得见的色，
 *   而不是之前的近黑 `#261f1b`（那版在深色画布上几乎看不出有颜色，
 *   于是"选了红一刷新又变回没色"—— 见下面 `normalizeAudioCardColor` 的改法）。
 * ★ 与图片卡 / 视频卡同一套机制（见 `VIDEO_DEFAULT_COLOR`）：底色与边框都跟卡片颜色走，
 *   这里只负责把**新建的那张**掰成这个色；用户挑过的颜色一个字都不动。
 */
export const AUDIO_DEFAULT_COLOR = '#FE232D';

/** 老版本音频卡留下的近黑默认色：迁移到红默认色时认这个 */
const AUDIO_LEGACY_DEFAULT_COLOR = '#261f1b';

/**
 * 把音频卡颜色归位（与 `normalizeVideoCardColor` 同一条"只动默认值、不动用户挑的"的纪律）。
 *
 * ★ 之前（2026-09-18）的判据是"等于全局默认色 → 回退成音频默认色"：
 *   于是用户**主动选了红**、而全局默认色恰好也是红时，一刷新就被判成"还在默认值"又掰回黑，
 *   表现就是"选了红色还是没改色"。这里改成只认**老版本那个具体的近黑色**
 *   `#261f1b` 做迁移 —— 用户挑过的任何颜色（主题色 / 自定义 HEX）一律保留。
 */
export function normalizeAudioCardColor(card: CardOf<'audio'>, _fallback: CardColor): boolean {
  if (card.color === AUDIO_DEFAULT_COLOR) return false;
  if (card.color !== AUDIO_LEGACY_DEFAULT_COLOR) return false;
  card.color = AUDIO_DEFAULT_COLOR;
  return true;
}

const AUDIO_CLASSES = ['nestboard-audio', 'is-missing', 'is-playing'] as const;

/** 每个槽位上现挂着的 `<audio>`（`destroy` 时要停：节点被摘出 DOM 后它仍会继续播） */
const players = new WeakMap<HTMLElement, HTMLMediaElement>();

export const audioCard: CardTypeDefinition<'audio'> = {
  type: 'audio',

  get displayName(): string {
    return t('card.type.audio');
  },

  icon: 'disc',
  /**
   * 新建音频卡的默认主色：`#FE232D`（用户 2026-09-18）。
   *
   * ★ 只影响新建：已存在的音频卡一个字节都不动（老卡的归位走 `normalizeAudioCardColor`）。
   */
  defaultColor: AUDIO_DEFAULT_COLOR,
  defaultSize: AUDIO_DEFAULT_SIZE,

  createDefaultContent() {
    return { path: '', showSize: false };
  },

  render(el: HTMLElement, card, ctx: CardRenderContext): void {
    el.classList.add('nestboard-audio');
    el.classList.remove('is-missing', 'is-playing');
    delete el.dataset.placeholder;

    // 上一次挂在这个槽位上的播放器：重画前先停（否则它会带着上一份文件的 src 继续播）
    const previous = players.get(el);
    if (previous) {
      stopMedia(previous);
      players.delete(el);
    }

    const doc = el.ownerDocument;
    const { path } = card.content;

    const exists = path.length > 0 && ctx.notes ? ctx.notes.exists(path) : path.length > 0;
    const url = exists ? (ctx.notes?.resourceUrl(path) ?? null) : null;

    if (url === null) {
      el.classList.add('is-missing');
      el.dataset.placeholder = 'true';
      el.replaceChildren(
        doc.createTextNode(
          path.length === 0 || exists ? t('card.audio.empty') : t('card.file.missing', { path }),
        ),
      );
      return;
    }

    const media = doc.createElement('audio');
    media.src = url;
    // 只读头部：时长要早点知道，但不必把整首歌解出来
    media.preload = 'metadata';
    players.set(el, media);

    // ── 唱片 ──
    const record = doc.createElement('div');
    record.className = 'nestboard-record';
    const label = doc.createElement('div');
    label.className = 'nestboard-record-label';
    label.textContent = '♪';
    record.appendChild(label);

    // ── 标题（文件名，一行）──
    const title = doc.createElement('div');
    title.className = 'nestboard-audio-title';
    title.textContent = fileNameOf(path);
    title.title = path;

    // ── 控制条 ──
    const bar = doc.createElement('div');
    bar.className = 'nestboard-audio-bar';

    const play = doc.createElement('button');
    play.type = 'button';
    play.className = 'nestboard-audio-play';
    play.textContent = '▶';
    play.title = t('card.media.play');
    play.setAttribute('aria-label', t('card.media.play'));

    const seek = doc.createElement('div');
    seek.className = 'nestboard-audio-seek';
    seek.setAttribute('role', 'slider');
    seek.setAttribute('aria-label', t('card.audio.seek'));
    const filled = doc.createElement('div');
    filled.className = 'nestboard-audio-progress';
    const knob = doc.createElement('div');
    knob.className = 'nestboard-audio-knob';
    seek.append(filled, knob);

    const time = doc.createElement('span');
    time.className = 'nestboard-audio-time';

    const mute = doc.createElement('button');
    mute.type = 'button';
    mute.className = 'nestboard-audio-mute';
    mute.textContent = '🔊';
    mute.setAttribute('aria-label', t('card.audio.mute'));

    const volume = doc.createElement('input');
    volume.type = 'range';
    volume.className = 'nestboard-audio-volume';
    volume.min = '0';
    volume.max = '1';
    volume.step = '0.05';
    volume.value = '1';
    volume.setAttribute('aria-label', t('card.audio.volume'));

    bar.append(play, seek, time, mute, volume);
    el.replaceChildren(record, title, bar);

    wireAudioControls({ media, root: el, play, seek, filled, knob, time, mute, volume, ctx });
  },

  contextMenu(card, menuCtx) {
    const bordered = card.showBorder !== false;
    return [
      {
        id: 'audio-open',
        title: t('card.file.open'),
        icon: 'external-link',
        disabled: menuCtx.multiple || card.content.path.length === 0,
        // 与文件 / 视频卡同一个动作名：最终走到本定义的 `onDoubleClick`
        action: 'openSource',
      },
      // 「取消边框」（用户 2026-09-18："背景和边框颜色同改"，也给了取消这一档）
      {
        id: 'audio-border',
        title: bordered ? t('menu.card.hideBorder') : t('menu.card.showBorder'),
        icon: bordered ? 'square-dashed' : 'square',
        disabled: menuCtx.multiple || card.locked,
        action: 'toggleCardBorder',
      },
    ];
  },

  onDoubleClick(card, ctx): boolean {
    const path = card.content.path;
    if (path.length === 0) return false;
    const notes = ctx.notes;
    if (notes && !notes.exists(path)) return false;
    if (!ctx.shell) return false;
    void ctx.shell.openPath(path);
    return true;
  },

  /** 导出成 Markdown 用内嵌：Obsidian 自己会把它渲染成一个播放器 */
  toMarkdown(card): string {
    const path = card.content.path;
    if (path.length === 0) return '';
    return `![[${path}]]`;
  },

  destroy(el: HTMLElement): void {
    el.classList.remove(...AUDIO_CLASSES);
    delete el.dataset.placeholder;
    const media = players.get(el);
    if (media) {
      stopMedia(media);
      players.delete(el);
    }
    el.replaceChildren();
  },
};

/** 控制条的接线（拆出来只是为了让 `render` 读起来还是"画一张卡"的形状） */
function wireAudioControls(parts: {
  media: HTMLMediaElement;
  root: HTMLElement;
  play: HTMLElement;
  seek: HTMLElement;
  filled: HTMLElement;
  knob: HTMLElement;
  time: HTMLElement;
  mute: HTMLElement;
  volume: HTMLInputElement;
  ctx: CardRenderContext;
}): void {
  const { media, root, play, seek, filled, knob, time, mute, volume, ctx } = parts;

  /** 往进度条上写比例（0~1）。**只有这一处**改这条线的宽度，三处调用都走它 */
  const paint = (ratio: number): void => {
    const percent = `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
    filled.style.width = percent;
    knob.style.left = percent;
  };

  const paintTime = (): void => {
    const total = media.duration;
    const now = media.currentTime;
    time.textContent = Number.isFinite(total)
      ? `${formatClock(now)} / ${formatClock(total)}`
      : formatClock(now);
  };

  const paintPlaying = (playing: boolean): void => {
    root.classList.toggle('is-playing', playing);
    play.textContent = playing ? '⏸' : '▶';
    play.title = t(playing ? 'card.audio.pause' : 'card.media.play');
    play.setAttribute('aria-label', play.title);
  };

  const toggle = (): void => {
    if (media.paused) {
      // `play()` 的 promise 必须接住：被自动播放策略拒绝时它是**未处理的拒绝**
      void media.play().catch(() => undefined);
    } else {
      media.pause();
    }
  };

  // 按钮与滑块都要挡住冒泡（`pointerdown` 挡卡片层的拖动，`click` 挡选中 / 双击）
  for (const node of [play, seek, mute, volume]) {
    node.addEventListener('pointerdown', (event: Event) => event.stopPropagation());
  }

  play.addEventListener('click', (event: Event) => {
    event.stopPropagation();
    toggle();
  });

  // 进度条：点哪跳哪（`pointerdown` 就跳，不等 `click` —— 拖进度的人不松手也该动）
  seek.addEventListener('pointerdown', (event: Event) => {
    event.stopPropagation();
    const rect = seek.getBoundingClientRect();
    if (rect.width <= 0 || !Number.isFinite(media.duration)) return;
    const at = (event as PointerEvent).clientX - rect.left;
    media.currentTime = (Math.max(0, Math.min(rect.width, at)) / rect.width) * media.duration;
    paintTime();
  });

  mute.addEventListener('click', (event: Event) => {
    event.stopPropagation();
    media.muted = !media.muted;
    paintMute();
  });

  volume.addEventListener('input', () => {
    media.volume = Number(volume.value);
    // 拖到 0 之外就顺手解除静音（用户刚表达了"我要听到声音"）
    if (media.muted && media.volume > 0) media.muted = false;
    paintMute();
  });

  const paintMute = (): void => {
    const silent = media.muted || media.volume === 0;
    mute.textContent = silent ? '🔇' : '🔊';
    mute.setAttribute('aria-label', t(silent ? 'card.audio.unmute' : 'card.audio.mute'));
    volume.value = String(media.volume);
  };

  media.addEventListener('play', () => paintPlaying(true));
  media.addEventListener('pause', () => paintPlaying(false));
  media.addEventListener('ended', () => paintPlaying(false));
  // 元数据到手：时长与总进度终于说得准了（也顺势让卡片层知道"内容落地了"）
  media.addEventListener('loadedmetadata', () => {
    paintTime();
    paint(0);
    ctx.contentReady?.();
  });
  media.addEventListener('timeupdate', () => {
    const total = media.duration;
    if (Number.isFinite(total) && total > 0) paint(media.currentTime / total);
    paintTime();
  });
  // 音量可能被**别处**改（系统媒体键 / 播放器自己）：跟着回写一次，UI 不会说谎
  media.addEventListener('volumechange', () => {
    paintMute();
    ctx.contentReady?.();
  });

  paintPlaying(false);
  paintMute();
  paintTime();
  paint(0);
}

/** 秒 → `m:ss`（一小时以上给 `h:mm:ss`）。坏值给 `--:--`，不留一个 `NaN:NaN` */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const total = Math.floor(seconds);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** 大小那一行用不到音频卡，但保留一个引用避免 `formatFileSize` 被误删（导出用得上） */
void formatFileSize;
