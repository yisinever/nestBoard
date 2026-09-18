/**
 * 色板卡单元测试（T3.04 / `F2.6` / `O19`）。
 *
 * 渲染本身要在真环境里验（尺寸、配色、居中、滚动），这里钉的是几件**一旦错了用户会吃亏**的事：
 *
 *  1. **认色号的规则**：多认（`fee` 当成 `#ffeeee`）会凭空多出一格，
 *     少认（`4C8DFF` 漏掉）会让粘贴进来的一段少几格 —— 两头都得钉死；
 *  2. **粘贴的原子性**：只要有一行认不出来就**一个字都不写**。
 *     悄悄存下"认出来的那部分"才是真正危险的行为（用户以为整段都生效了）；
 *  3. **复制反馈**：点一下必须当场看见"已复制"或"复制失败"，
 *     否则用户会重复点三次，然后发现剪贴板里还是上一次的内容。
 *  4. **渐变（`O07`）**：一格可以是一整行 `linear-gradient(...)`。这里钉两件：
 *     ① **认不出就判错**（提到渐变却解析不出来时，绝不悄悄降级成它的第一个色标 ——
 *     那正是第 2 条说的静默损失）；② 存进去、再点开、再导出，看到的始终是**同一行 CSS**
 *     （编辑态是源码回显，不做表单）。
 *  5. **一卡一色（`O19`）**：**第一格**铺满整张卡（后面几格不上卡面，但要用 `+N` 交代 ——
 *     这与第 2 条是同一条规矩）；吸管取到色是**替换**而不是往下加一格；底色一变，
 *     另一套底色变量与墨色都得跟着换干净（留着上一格就会"同时画两个色"）。
 */

import { describe, expect, it, vi } from 'vitest';
import type { CardRenderContext, CardViewMode, ClipboardBridge } from '../../cards/registry';
import {
  COPY_FEEDBACK_MS,
  parseSwatchText,
  swatchCard,
  swatchColorsAfterPick,
  swatchToText,
} from '../../cards/swatch';
import { createCard } from '../../model/factories';
import type { SwatchContent, SwatchEntry } from '../../model/schema';
import { swatchEntryToText, swatchInkColor } from '../../util/color';
import { t } from '../../util/i18n';
import { type FakeElement, createFakeDocument, createFakeElement } from '../helpers/fakeDom';

// ── 纯逻辑：认色号 ──────────────────────────────────────────────

describe('parseSwatchText', () => {
  it('一行一个色号，统一小写', () => {
    expect(parseSwatchText('#4C8DFF\n#FF6B6B').colors).toEqual(['#4c8dff', '#ff6b6b']);
  });

  it('三位简写展开成六位（存档里只有一种形态，比较就不用管大小写与简写）', () => {
    expect(parseSwatchText('#ABC').colors).toEqual(['#aabbcc']);
  });

  it('裸六位照样认（从设计软件 / 网页里复制出来的经常没有 #）', () => {
    expect(parseSwatchText('4C8DFF').colors).toEqual(['#4c8dff']);
  });

  it('容忍行尾多余文字，取第一个色号', () => {
    expect(parseSwatchText('#4C8DFF /* 主色 */').colors).toEqual(['#4c8dff']);
    expect(parseSwatchText('border: 1px solid #FF0000;').colors).toEqual(['#ff0000']);
  });

  it('空行与纯空白行跳过，且不算"认不出来"', () => {
    const result = parseSwatchText('#4C8DFF\n\n   \n#FF6B6B\n');
    expect(result.colors).toEqual(['#4c8dff', '#ff6b6b']);
    expect(result.rejected).toEqual([]);
  });

  it('裸三位不认：`fee` / `cab` 这类词太像普通单词', () => {
    const result = parseSwatchText('fee');
    expect(result.colors).toEqual([]);
    expect(result.rejected).toEqual(['fee']);
  });

  it('多打一位不算数：`#1234567` 不许从中间截出一段', () => {
    expect(parseSwatchText('#1234567').rejected).toEqual(['#1234567']);
  });

  it('少一位的残号也拒掉（`#12345` 后面那半截不是色号）', () => {
    expect(parseSwatchText('#12345').rejected).toEqual(['#12345']);
  });

  it('认不出的行原样带回来（报"哪一行错了"才修得动）', () => {
    const result = parseSwatchText('#4C8DFF\nrgba(0, 0, 0, .5)\n#FF6B6B');
    expect(result.colors).toEqual(['#4c8dff', '#ff6b6b']);
    expect(result.rejected).toEqual(['rgba(0, 0, 0, .5)']);
  });

  it('重复色号静默去重，且大小写 / 简写视为同一个', () => {
    const result = parseSwatchText('#4C8DFF\n#4c8dff\n#ABC\n#aabbcc');
    expect(result.colors).toEqual(['#4c8dff', '#aabbcc']);
    expect(result.rejected).toEqual([]);
  });

  it('空文本得到空色板（不是一堆空行）', () => {
    expect(parseSwatchText('')).toEqual({ colors: [], rejected: [] });
  });
});

describe('swatchToText', () => {
  it('与 parseSwatchText 互为反函数', () => {
    const colors: SwatchEntry[] = ['#4c8dff', '#ff6b6b', '#0f0f0f'];
    expect(parseSwatchText(swatchToText(colors)).colors).toEqual(colors);
  });
});

// ── 纯逻辑：吸管取到一个色之后（O19） ──────────────────────────

describe('swatchColorsAfterPick', () => {
  const content = (...colors: SwatchEntry[]): SwatchContent => ({ colors, pickedFrom: null });

  it('★ 替换而不是追加：不管原来有几格，取到的色就是这张卡的颜色', () => {
    expect(swatchColorsAfterPick(content('#4c8dff', '#ff6b6b'), '#123456')).toEqual(['#123456']);
  });

  it('空色板取第一笔', () => {
    expect(swatchColorsAfterPick(content(), '#123456')).toEqual(['#123456']);
  });

  it('卡上就是这一个色 → 不用改（`null`：白白写一次只会把文件标脏）', () => {
    expect(swatchColorsAfterPick(content('#123456'), '#123456')).toBeNull();
  });

  it('★ 旧多格卡里那些非第一格的颜色不算"已经有了"：吸到它是有意义的一步（它会成为卡面）', () => {
    expect(swatchColorsAfterPick(content('#4c8dff', '#123456'), '#123456')).toEqual(['#123456']);
  });
});

// ── 纯逻辑：渐变（O07） ────────────────────────────────────────

describe('parseSwatchText · 渐变', () => {
  /** 只取第一格，省掉每条断言都写 `[0]` */
  const firstEntry = (text: string): SwatchEntry => parseSwatchText(text).colors[0];

  /** 造一行渐变并取出它的角度（`angleOf('to top')` 比整段 `toEqual` 好读） */
  const angleOf = (direction: string): number => {
    const entry = firstEntry(`linear-gradient(${direction}, #f00, #00f)`);
    if (typeof entry === 'string') throw new Error('这一行应当是渐变，不该被认成纯色');
    return entry.angle;
  };

  it('一整行 `linear-gradient(...)` 就是一格', () => {
    expect(firstEntry('linear-gradient(90deg, #f00 0%, #00f 100%)')).toEqual({
      type: 'linear',
      angle: 90,
      stops: [
        { color: '#ff0000', position: 0 },
        { color: '#0000ff', position: 100 },
      ],
    });
    expect(parseSwatchText('linear-gradient(90deg, #f00 0%, #00f 100%)').rejected).toEqual([]);
  });

  it('位置可省（均分）：省了就是省了，不补 `0%`', () => {
    const entry = firstEntry('linear-gradient(90deg, #f00, #00f)');
    expect(entry).toEqual({
      type: 'linear',
      angle: 90,
      stops: [{ color: '#ff0000' }, { color: '#0000ff' }],
    });
    // 回写也不许补：补上就把"由 stops 顺序均分"钉死成"从 0% 开始"了
    expect(swatchToText([entry])).toBe('linear-gradient(90deg, #ff0000, #0000ff)');
  });

  it('方向关键词换成角度（对角线取 45 的倍数）', () => {
    expect(angleOf('to top')).toBe(0);
    expect(angleOf('to right')).toBe(90);
    expect(angleOf('to bottom right')).toBe(135);
    expect(angleOf('to left')).toBe(270);
  });

  it('角度收进 `[0, 360)`：负角度与超一圈只有一个存法', () => {
    expect(angleOf('-45deg')).toBe(315);
    expect(angleOf('450deg')).toBe(90);
  });

  it('色标位置超界夹到 0~100（CSS 自己也会夹，丢这一格反而更糟）', () => {
    expect(firstEntry('linear-gradient(90deg, #f00 -20%, #00f 300%)')).toEqual({
      type: 'linear',
      angle: 90,
      stops: [
        { color: '#ff0000', position: 0 },
        { color: '#0000ff', position: 100 },
      ],
    });
  });

  it('大小写与空格照旧宽容（粘贴来源五花八门）', () => {
    expect(firstEntry('LINEAR-GRADIENT( 90DEG ,  #F00  0% , #00F 100% )')).toEqual({
      type: 'linear',
      angle: 90,
      stops: [
        { color: '#ff0000', position: 0 },
        { color: '#0000ff', position: 100 },
      ],
    });
  });

  it('★ 提到 `linear-gradient` 却解析不出来 → 判错，绝不悄悄降级成第一个色标', () => {
    // 少了角度（CSS 里有默认值，但色板只留一种写法：否则同一个渐变有两个等价字符串）
    expect(parseSwatchText('linear-gradient(#f00, #00f)').rejected).toEqual([
      'linear-gradient(#f00, #00f)',
    ]);
    // 只有一个色标
    expect(parseSwatchText('linear-gradient(90deg, #f00)').rejected).toHaveLength(1);
    // 行里还夹着别的话（色板一行的语义就是"一格色"，逗号切分立刻就乱）
    expect(
      parseSwatchText('background: linear-gradient(90deg, #f00, #00f);').rejected,
    ).toHaveLength(1);
  });

  it('行首的无序列表记号剥掉（`toMarkdown` 导出的 `- linear-gradient(...)` 要粘得回来）', () => {
    const result = parseSwatchText('- linear-gradient(90deg, #f00, #00f)\n* #4C8DFF');
    expect(result.rejected).toEqual([]);
    expect(result.colors).toHaveLength(2);
    expect(result.colors[1]).toBe('#4c8dff');
  });

  it('纯色格与渐变格混排：一行一格，几何顺序不变', () => {
    const result = parseSwatchText('#4C8DFF\nlinear-gradient(90deg, #f00, #00f)\n#FF6B6B');
    expect(result.colors).toHaveLength(3);
    expect(result.colors[0]).toBe('#4c8dff');
    expect(typeof result.colors[1]).toBe('object');
    expect(result.colors[2]).toBe('#ff6b6b');
  });

  it('去重的键是文本形态：写法不同（大小写 / 简写 / 空格）算同一格', () => {
    const result = parseSwatchText(
      'linear-gradient(90deg, #f00, #00f)\nlinear-gradient(90DEG , #F00 , #00F)',
    );
    expect(result.colors).toHaveLength(1);
  });
});

describe('swatchEntryToText', () => {
  it('纯色就是色号本身，渐变就是那行 CSS（显示 / 复制 / 导出共用这一份）', () => {
    expect(swatchEntryToText('#4c8dff')).toBe('#4c8dff');
    expect(
      swatchEntryToText({
        type: 'linear',
        angle: 135,
        stops: [
          { color: '#ff0000', position: 0 },
          { color: '#0000ff', position: 100 },
        ],
      }),
    ).toBe('linear-gradient(135deg, #ff0000 0%, #0000ff 100%)');
  });
});

// ── 纯逻辑：底色上的墨色（O19） ────────────────────────────────

describe('swatchInkColor', () => {
  it('★ 浅底给深字、深底给浅字（卡面底色是数据，CSS 猜不出来）', () => {
    expect(swatchInkColor('#ffffff')).toBe('#1f1f1f');
    expect(swatchInkColor('#e0e0e0')).toBe('#1f1f1f');
    expect(swatchInkColor('#000000')).toBe('#f5f5f5');
    expect(swatchInkColor('#1e293b')).toBe('#f5f5f5');
  });

  it('★ 渐变取第一个色标（一眼看过去最先撞上的颜色）', () => {
    const darkFirst: SwatchEntry = {
      type: 'linear',
      angle: 90,
      stops: [
        { color: '#000000', position: 0 },
        { color: '#ffffff', position: 100 },
      ],
    };
    expect(swatchInkColor(darkFirst)).toBe('#f5f5f5');
  });

  it('认不出的色（手改坏的文件）保守地按浅底给深字', () => {
    expect(swatchInkColor('oops')).toBe('#1f1f1f');
  });
});

// ── 渲染 ───────────────────────────────────────────────────────

interface Harness {
  el: FakeElement;
  updateContent: ReturnType<typeof vi.fn>;
  setMode: ReturnType<typeof vi.fn>;
  writeText: ReturnType<typeof vi.fn>;
}

function setup(
  options: {
    colors?: SwatchEntry[];
    mode?: CardViewMode;
    clipboard?: ClipboardBridge | null;
  } = {},
): Harness {
  const el = createFakeElement(createFakeDocument());
  const card = createCard('swatch', {
    content: { colors: options.colors ?? [], pickedFrom: null } satisfies SwatchContent,
  });
  const updateContent = vi.fn();
  const setMode = vi.fn();
  const writeText = vi.fn(async () => true);
  const readText = vi.fn(async () => null);

  const ctx = {
    mode: options.mode ?? 'display',
    updateContent,
    setMode,
    // `readText`（O08）与色板卡无关，但 `ClipboardBridge` 要求它 ——
    // 给一个"读不到"的桩，正好等于"这个环境里读不了剪贴板"
    clipboard:
      options.clipboard === null ? undefined : (options.clipboard ?? { writeText, readText }),
  } as unknown as CardRenderContext;

  swatchCard.render(el as unknown as HTMLElement, card, ctx);
  return { el, updateContent, setMode, writeText };
}

/** 显示态：`el > 底色层 + 色号行` */
function fillOf(el: FakeElement): FakeElement {
  return el.children[0] as FakeElement;
}

function chipOf(el: FakeElement): FakeElement {
  return el.children[1] as FakeElement;
}

/** 按类名找，而不是按下标：`+N` 与复制反馈都是色号行的兄弟，下标会随内容变 */
function childWithClass(parent: FakeElement, className: string): FakeElement {
  return (parent.children as FakeElement[]).find((child) => child.className === className)!;
}

function labelOf(chip: FakeElement): FakeElement {
  return childWithClass(chip, 'nestboard-swatch-hex');
}

/** 复制反馈：色号行里**最后一个**孩子（它只在复制那 1.2 秒里存在） */
function statusOf(chip: FakeElement): FakeElement {
  return (chip.children as FakeElement[])[chip.children.length - 1] as FakeElement;
}

/** 渲染层写给内容槽的墨色（`O19`：底色上的字色） */
function inkOf(el: FakeElement): string {
  return el.style.getPropertyValue('--nestboard-swatch-ink');
}

describe('渲染 · 显示态', () => {
  it('空色板：一句话居中，不留一个空框', () => {
    const { el } = setup();
    expect(el.dataset.placeholder).toBe('true');
    expect(el.textContent).toBe(t('card.swatch.empty'));
  });

  it('★ 第一格色铺满整卡：色值走内容槽的行内变量（颜色是数据，不是样式）', () => {
    const { el } = setup({ colors: ['#4c8dff'] });

    expect(el.classList.contains('is-solid')).toBe(true);
    expect(el.style.getPropertyValue('--nestboard-swatch-color')).toBe('#4c8dff');
    expect(labelOf(chipOf(el)).textContent).toBe('#4c8dff');
  });

  it('★ 底色铺在一片独立的层上（它得铺到卡片的边框以内，不只内容槽那一块）', () => {
    const { el } = setup({ colors: ['#4c8dff'] });

    expect(fillOf(el).className).toBe('nestboard-swatch-fill');
    // 装饰层，读屏读到"一个空 div"没有意义
    expect(fillOf(el).attributes.get('aria-hidden')).toBe('true');
  });

  it('★ 一卡一色：后面几格不上卡面，但用 `+N` 交代出来（藏起来跟丢掉没区别）', () => {
    const { el } = setup({ colors: ['#4c8dff', '#ff6b6b', '#34d399'] });
    const chip = chipOf(el);

    // 卡面只认第一格
    expect(el.style.getPropertyValue('--nestboard-swatch-color')).toBe('#4c8dff');
    expect(labelOf(chip).textContent).toBe('#4c8dff');
    expect(childWithClass(chip, 'nestboard-swatch-more').textContent).toBe(
      t('card.swatch.more', { count: 2 }),
    );
  });

  it('一格不多时没有 `+N`（别让正常卡面多一个零）', () => {
    const { el } = setup({ colors: ['#4c8dff'] });

    expect(
      (chipOf(el).children as FakeElement[]).some(
        (child) => child.className === 'nestboard-swatch-more',
      ),
    ).toBe(false);
  });

  it('有色号时不留占位标记（否则空态样式会压在真内容上）', () => {
    const { el } = setup({ colors: ['#4c8dff'] });
    expect(el.dataset.placeholder).toBeUndefined();
  });

  it('★ 渐变格走 `--nestboard-swatch-gradient`（`background-image`），不占纯色那个变量', () => {
    const gradient: SwatchEntry = {
      type: 'linear',
      angle: 90,
      stops: [
        { color: '#ff0000', position: 0 },
        { color: '#0000ff', position: 100 },
      ],
    };
    const { el } = setup({ colors: [gradient] });

    expect(el.style.getPropertyValue('--nestboard-swatch-color')).toBe('');
    expect(el.style.getPropertyValue('--nestboard-swatch-gradient')).toBe(
      'linear-gradient(90deg, #ff0000 0%, #0000ff 100%)',
    );
  });

  it('★ 渐变改成纯色之后，渐变那个变量要被摘掉（否则底色与渐变会一起画上去）', () => {
    const gradient: SwatchEntry = {
      type: 'linear',
      angle: 90,
      stops: [{ color: '#ff0000' }, { color: '#0000ff' }],
    };
    const el = createFakeElement(createFakeDocument());
    const ctx = { mode: 'display' } as unknown as CardRenderContext;
    const cardWith = (colors: SwatchEntry[]) =>
      createCard('swatch', { content: { colors, pickedFrom: null } satisfies SwatchContent });

    swatchCard.render(el as unknown as HTMLElement, cardWith([gradient]), ctx);
    swatchCard.render(el as unknown as HTMLElement, cardWith(['#4c8dff']), ctx);

    expect(el.style.getPropertyValue('--nestboard-swatch-gradient')).toBe('');
    expect(el.style.getPropertyValue('--nestboard-swatch-color')).toBe('#4c8dff');
  });

  it('★ 墨色由底色算出来：深底给浅字、浅底给深字（`--text-muted` 在深底上看不见）', () => {
    expect(inkOf(setup({ colors: ['#ffffff'] }).el)).toBe('#1f1f1f');
    expect(inkOf(setup({ colors: ['#000000'] }).el)).toBe('#f5f5f5');
  });

  it('★ 清空到一格不剩时，底色与墨色都摘干净（下一帧不许顶着上一格的色）', () => {
    const el = createFakeElement(createFakeDocument());
    const ctx = { mode: 'display' } as unknown as CardRenderContext;
    const cardWith = (colors: SwatchEntry[]) =>
      createCard('swatch', { content: { colors, pickedFrom: null } satisfies SwatchContent });

    swatchCard.render(el as unknown as HTMLElement, cardWith(['#4c8dff']), ctx);
    swatchCard.render(el as unknown as HTMLElement, cardWith([]), ctx);

    expect(el.classList.contains('is-solid')).toBe(false);
    expect(el.style.getPropertyValue('--nestboard-swatch-color')).toBe('');
    expect(el.style.getPropertyValue('--nestboard-swatch-ink')).toBe('');
    expect(el.dataset.placeholder).toBe('true');
  });

  it('渐变格那一行的文字 = 那行 CSS，且与 `title` / `aria-label` / 复制内容**同一份**', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const gradient: SwatchEntry = {
        type: 'linear',
        angle: 135,
        stops: [{ color: '#ff0000' }, { color: '#0000ff' }],
      };
      const { el, writeText } = setup({ colors: [gradient] });
      const chip = chipOf(el);
      const text = 'linear-gradient(135deg, #ff0000, #0000ff)';
      const hint = t('card.swatch.copy', { color: text });

      expect(labelOf(chip).textContent).toBe(text);
      expect(chip.title).toBe(hint);
      expect(chip.attributes.get('aria-label')).toBe(hint);

      chip.emit('click', { stopPropagation: vi.fn() });
      await vi.advanceTimersByTimeAsync(0);

      // 复制出去的就是显示的那句话 —— 用户能一眼核对粘到了什么
      expect(writeText).toHaveBeenCalledWith(text);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('渲染 · 点击复制', () => {
  it('点一行把该色号交给剪贴板，并在这一行上显示"已复制"', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { el, writeText } = setup({ colors: ['#4c8dff'] });
      const chip = chipOf(el);

      chip.emit('click', { stopPropagation: vi.fn() });
      await vi.advanceTimersByTimeAsync(0);

      expect(writeText).toHaveBeenCalledWith('#4c8dff');
      expect(chip.classList.contains('is-copied')).toBe(true);
      expect(statusOf(chip).textContent).toBe(t('card.swatch.copied'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('反馈到点自己收掉，不会常驻', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { el } = setup({ colors: ['#4c8dff'] });
      const chip = chipOf(el);
      chip.emit('click', { stopPropagation: vi.fn() });
      await vi.advanceTimersByTimeAsync(0);

      vi.advanceTimersByTime(COPY_FEEDBACK_MS);

      expect(chip.classList.contains('is-copied')).toBe(false);
      // 只剩色号那一行（反馈节点被摘掉了，不是留着空壳）
      expect(chip.children).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('剪贴板写不进去时明说"复制失败"（不能装作成功）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { el } = setup({
        colors: ['#4c8dff'],
        clipboard: { writeText: async () => false, readText: async () => null },
      });
      const chip = chipOf(el);

      chip.emit('click', { stopPropagation: vi.fn() });
      await vi.advanceTimersByTimeAsync(0);

      expect(chip.classList.contains('is-copy-failed')).toBe(true);
      expect(statusOf(chip).textContent).toBe(t('card.swatch.copyFailed'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('没有剪贴板桥（嵌入视图 / 单测）时退化成"复制失败"，不炸', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { el } = setup({ colors: ['#4c8dff'], clipboard: null });
      const chip = chipOf(el);

      chip.emit('click', { stopPropagation: vi.fn() });
      await vi.advanceTimersByTimeAsync(0);

      expect(chip.classList.contains('is-copy-failed')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('点色号那一行不该被卡片层当成"开始拖卡"', () => {
    const { el } = setup({ colors: ['#4c8dff'] });
    const chip = chipOf(el);
    const event = { stopPropagation: vi.fn() };

    chip.emit('pointerdown', event);

    expect(event.stopPropagation).toHaveBeenCalled();
  });
});

describe('渲染 · 编辑态', () => {
  function editSetup(colors: SwatchEntry[] = ['#4c8dff']) {
    return setup({ colors, mode: 'edit' });
  }

  /** 编辑态：`el > [底色层] + 输入框 + 提示` —— 底色在不在取决于卡上有没有色 */
  function areaOf(el: FakeElement) {
    return childWithClass(el, 'nestboard-swatch-input') as unknown as {
      value: string;
      focused: boolean;
      emit: (type: string, event: unknown) => void;
    };
  }

  function hintOf(el: FakeElement) {
    return childWithClass(el, 'nestboard-swatch-hint');
  }

  it('★ 编辑态也铺着底色（用户正对着它改色号，中途白一下像没保存上）', () => {
    const { el } = editSetup(['#4c8dff']);

    expect(el.classList.contains('is-solid')).toBe(true);
    expect(fillOf(el).className).toBe('nestboard-swatch-fill');
  });

  it('空色板进编辑态就没有底色层（没有色可铺）', () => {
    const { el } = editSetup([]);

    expect(el.children[0]).toBe(areaOf(el));
  });

  it('编辑框预填当前色号，一行一个，并自动聚焦', () => {
    const { el } = editSetup(['#4c8dff', '#ff6b6b']);
    const area = areaOf(el);

    expect(area.value).toBe('#4c8dff\n#ff6b6b');
    expect(area.focused).toBe(true);
  });

  it('★ 渐变格回显成**源码那一行 CSS**（不拆成表单：用户存进来的就是这句话）', () => {
    const { el } = editSetup([
      {
        type: 'linear',
        angle: 90,
        stops: [
          { color: '#ff0000', position: 0 },
          { color: '#0000ff', position: 100 },
        ],
      },
    ]);
    expect(areaOf(el).value).toBe('linear-gradient(90deg, #ff0000 0%, #0000ff 100%)');
  });

  it('渐变行粘进来能存下去，且存的是规范化后的对象（不是原字符串）', () => {
    const { el, updateContent } = editSetup();
    areaOf(el).value = '#4C8DFF\nLINEAR-GRADIENT(90DEG, #F00, #00F)';

    areaOf(el).emit('blur', {});

    expect(updateContent).toHaveBeenCalledWith({
      colors: [
        '#4c8dff',
        { type: 'linear', angle: 90, stops: [{ color: '#ff0000' }, { color: '#0000ff' }] },
      ],
    });
  });

  it('⌘↵ 把改过的内容写回模型并退回显示态', () => {
    const { el, updateContent, setMode } = editSetup();
    const area = areaOf(el);
    area.value = '#4C8DFF\n4c8dff\n#ABC';

    area.emit('keydown', {
      key: 'Enter',
      metaKey: true,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });

    expect(updateContent).toHaveBeenCalledWith({ colors: ['#4c8dff', '#aabbcc'] });
    expect(setMode).toHaveBeenCalledWith('display');
  });

  it('没改过就不写模型（点进点出不该把文件标脏）', () => {
    const { el, updateContent, setMode } = editSetup(['#4c8dff']);

    areaOf(el).emit('keydown', {
      key: 'Enter',
      metaKey: true,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });

    expect(updateContent).not.toHaveBeenCalled();
    expect(setMode).toHaveBeenCalledWith('display');
  });

  it('有一行认不出来就一个字都不写，并指出是哪一行', () => {
    const { el, updateContent, setMode } = editSetup();
    const area = areaOf(el);
    area.value = '#4C8DFF\nrgba(0,0,0,.5)\n#FF6B6B';

    area.emit('keydown', {
      key: 'Enter',
      metaKey: true,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });

    expect(updateContent).not.toHaveBeenCalled();
    expect(setMode).not.toHaveBeenCalled();
    expect(el.classList.contains('is-invalid')).toBe(true);
    expect(hintOf(el).textContent).toBe(t('card.swatch.invalid', { line: 'rgba(0,0,0,.5)' }));
  });

  it('改好之后能接着保存（坏行是"拦一下"，不是"作废这一次编辑"）', () => {
    const { el, updateContent } = editSetup();
    const area = areaOf(el);
    area.value = 'nope';
    area.emit('keydown', {
      key: 'Enter',
      metaKey: true,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });

    area.value = '#123456';
    area.emit('keydown', {
      key: 'Enter',
      metaKey: true,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });

    expect(updateContent).toHaveBeenCalledWith({ colors: ['#123456'] });
  });

  it('Esc 直接退回显示态，不写模型（明确放弃不算静默丢失）', () => {
    const { el, updateContent, setMode } = editSetup();
    const area = areaOf(el);
    area.value = '#123456';
    const event = { key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() };

    area.emit('keydown', event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(updateContent).not.toHaveBeenCalled();
    expect(setMode).toHaveBeenCalledWith('display');
  });

  it('失焦即保存（点走时不许把刚粘的东西丢掉）', () => {
    const { el, updateContent } = editSetup();
    const area = areaOf(el);
    area.value = '#123456\n#654321';

    area.emit('blur', {});

    expect(updateContent).toHaveBeenCalledWith({ colors: ['#123456', '#654321'] });
  });

  it('其余按键不外泄：漏出去会被画布当成"移动 / 删除这张卡"', () => {
    const { el } = editSetup();
    const event = { key: 'ArrowDown', preventDefault: vi.fn(), stopPropagation: vi.fn() };

    areaOf(el).emit('keydown', event);

    expect(event.stopPropagation).toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('输入法组词中不接管按键（此刻的 Esc 是在取消候选词）', () => {
    const { el, setMode } = editSetup();
    const event = {
      key: 'Escape',
      isComposing: true,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    areaOf(el).emit('keydown', event);

    expect(setMode).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('粘贴多行 HEX 一次全收（这就是这张卡存在的理由）', () => {
    const { el, updateContent } = editSetup([]);
    const area = areaOf(el);
    area.value = '#4C8DFF\n#FF6B6B\n#34D399\n#F59E0B';

    area.emit('keydown', {
      key: 'Enter',
      metaKey: true,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });

    expect(updateContent).toHaveBeenCalledWith({
      colors: ['#4c8dff', '#ff6b6b', '#34d399', '#f59e0b'],
    });
  });

  it('提交之后不再响应 blur（DOM 换掉时会补一个 blur 上来）', () => {
    const { el, updateContent } = editSetup();
    const area = areaOf(el);
    area.value = '#123456';
    area.emit('keydown', {
      key: 'Enter',
      metaKey: true,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });

    area.emit('blur', {});

    expect(updateContent).toHaveBeenCalledTimes(1);
  });
});

// ── 收起态：这一格色必须在（O33）────────────────────────────────

describe('收起态（O33）', () => {
  /**
   * 卡片骨架：外壳 `.nestboard-card` + 内容槽。
   *
   * ★ 必须真的搭出这层结构：色卡要靠 `parentElement` 认外壳，而"收起"正是把**内容槽**
   *   整个藏起来（底色层是它孩子，一起没了）。
   */
  const withShell = () => {
    const doc = createFakeDocument();
    const shell = createFakeElement(doc);
    shell.className = 'nestboard-card';
    const el = createFakeElement(doc);
    shell.appendChild(el);
    return { shell, el };
  };

  const ctx = { mode: 'display' } as unknown as CardRenderContext;
  const cardWith = (colors: SwatchEntry[], collapsed?: boolean) =>
    createCard('swatch', {
      content: { colors, pickedFrom: null } satisfies SwatchContent,
      collapsed,
    });

  it('★ 收起时这一格色铺在**卡片外壳**上（内容槽连同底色层都被藏了，不写就是一条白条）', () => {
    const { shell, el } = withShell();
    swatchCard.render(el as unknown as HTMLElement, cardWith(['#4c8dff'], true), ctx);

    expect(shell.classList.contains('has-swatch-color')).toBe(true);
    expect(shell.style.getPropertyValue('--nestboard-swatch-color')).toBe('#4c8dff');
  });

  it('★ 展开态不写外壳：底色照旧由内容槽里那层铺满（两处都写就成了两个来源）', () => {
    const { shell, el } = withShell();
    swatchCard.render(el as unknown as HTMLElement, cardWith(['#4c8dff']), ctx);

    expect(shell.classList.contains('has-swatch-color')).toBe(false);
    expect(shell.style.getPropertyValue('--nestboard-swatch-color')).toBe('');
  });

  it('渐变格收起时写的是渐变变量（样式表按"变量在不在"挑，两种色共用一条规则）', () => {
    const { shell, el } = withShell();
    const gradient: SwatchEntry = {
      type: 'linear',
      angle: 90,
      stops: [{ color: '#ff0000' }, { color: '#0000ff' }],
    };
    swatchCard.render(el as unknown as HTMLElement, cardWith([gradient], true), ctx);

    expect(shell.style.getPropertyValue('--nestboard-swatch-gradient')).toBe(
      swatchEntryToText(gradient),
    );
  });

  it('★ 收起 → 展开时外壳要摘干净（否则留着上一份底色）', () => {
    const { shell, el } = withShell();
    swatchCard.render(el as unknown as HTMLElement, cardWith(['#4c8dff'], true), ctx);
    swatchCard.render(el as unknown as HTMLElement, cardWith(['#4c8dff']), ctx);

    expect(shell.classList.contains('has-swatch-color')).toBe(false);
    expect(shell.style.getPropertyValue('--nestboard-swatch-color')).toBe('');
  });

  it('★ 节点回收时外壳也要摘干净（池子里那个节点会被派给别的类型）', () => {
    const { shell, el } = withShell();
    swatchCard.render(el as unknown as HTMLElement, cardWith(['#4c8dff'], true), ctx);

    swatchCard.destroy?.(el as unknown as HTMLElement);

    expect(shell.classList.contains('has-swatch-color')).toBe(false);
    expect(shell.style.getPropertyValue('--nestboard-swatch-color')).toBe('');
  });

  it('空色板收起时不写外壳（没色可铺，别在别的卡片上留一个标记类）', () => {
    const { shell, el } = withShell();
    swatchCard.render(el as unknown as HTMLElement, cardWith([], true), ctx);

    expect(shell.classList.contains('has-swatch-color')).toBe(false);
  });

  it('槽位不在卡片骨架里（单测 / 嵌入视图）时不炸，只是不写外壳', () => {
    const el = createFakeElement(createFakeDocument());
    expect(() =>
      swatchCard.render(el as unknown as HTMLElement, cardWith(['#4c8dff'], true), ctx),
    ).not.toThrow();
  });
});

// ── 右键菜单 ──────────────────────────────────────────────────

describe('contextMenu', () => {
  const swatch = (locked = false) =>
    createCard('swatch', { content: { colors: [], pickedFrom: null }, locked });

  it('给出「从图片吸色」+「编辑内容」，动作名与视图分发的那一条一致（写错会**静默失效**）', () => {
    // ★ 「编辑内容」（`O35`）由**色卡自己**给出：通用菜单那一项现在只给"双击会进编辑态"的
    //   类型，而色卡双击是弹调色板。可"改色号文本"（多行 / 渐变）这条路必须留着 ——
    //   它走 `editContent`（`editCard(id, true, 'raw')`，**跳过** `activate`，不会被调色板截走）。
    expect(
      swatchCard.contextMenu!(swatch(), { multiple: false }).map((item) => item.action),
    ).toEqual(['pickFromImage', 'editContent']);
  });

  it('未多选、未锁定时可用（空色板也能吸第一笔）', () => {
    expect(swatchCard.contextMenu!(swatch(), { multiple: false })[0].disabled).toBe(false);
  });

  it('多选 / 锁定 → 置灰（位置留着：能力看得见，也看得见为什么点不动）', () => {
    expect(swatchCard.contextMenu!(swatch(), { multiple: true })[0].disabled).toBe(true);
    expect(swatchCard.contextMenu!(swatch(true), { multiple: false })[0].disabled).toBe(true);
  });
});

// ── 导出与拆卸 ─────────────────────────────────────────────────

describe('toMarkdown', () => {
  it('空色板导出空串（不留一个空标题）', () => {
    const card = createCard('swatch', { content: { colors: [], pickedFrom: null } });
    expect(swatchCard.toMarkdown(card, {} as never)).toBe('');
  });

  it('一行一个色号的无序列表（既 grep 得到，也能原样粘回卡片）', () => {
    const card = createCard('swatch', {
      content: { colors: ['#4c8dff', '#ff6b6b'], pickedFrom: null },
    });
    const markdown = swatchCard.toMarkdown(card, {} as never);

    expect(markdown).toBe('- #4c8dff\n- #ff6b6b');
    // 粘回去能认出来 —— 导出与导入闭合
    expect(parseSwatchText(markdown).colors).toEqual(['#4c8dff', '#ff6b6b']);
  });

  it('★ 渐变格导出成那行 CSS，粘回来仍是同一格（导出与导入闭合）', () => {
    const gradient: SwatchEntry = {
      type: 'linear',
      angle: 135,
      stops: [
        { color: '#ff0000', position: 0 },
        { color: '#0000ff', position: 100 },
      ],
    };
    const card = createCard('swatch', { content: { colors: ['#4c8dff', gradient] } });
    const markdown = swatchCard.toMarkdown(card, {} as never);

    expect(markdown).toBe('- #4c8dff\n- linear-gradient(135deg, #ff0000 0%, #0000ff 100%)');
    // 注意导出的是 `- ` 前缀的无序列表，而 `parseSwatchText` 容忍行尾多余文字 ——
    // 粘回编辑框（用户会去掉 `- `）或直接喂给解析器，两条路都得认
    expect(parseSwatchText(markdown).colors).toEqual(['#4c8dff', gradient]);
  });
});

describe('destroy', () => {
  it('摘掉自己加的 class、占位标记与子树（复用池里的节点会串味）', () => {
    const { el } = setup({ colors: ['#4c8dff'] });

    swatchCard.destroy!(el as unknown as HTMLElement);

    expect(el.classList.contains('nestboard-swatch')).toBe(false);
    expect(el.classList.contains('nestboard-swatch-preview')).toBe(false);
    expect(el.dataset.placeholder).toBeUndefined();
    expect(el.children).toHaveLength(0);
  });

  it('★ 行内那三个变量也要摘掉（否则复用出去的节点会顶着上一张卡的色）', () => {
    const { el } = setup({ colors: ['#4c8dff'] });

    swatchCard.destroy!(el as unknown as HTMLElement);

    expect(el.classList.contains('is-solid')).toBe(false);
    expect(el.style.getPropertyValue('--nestboard-swatch-color')).toBe('');
    expect(el.style.getPropertyValue('--nestboard-swatch-gradient')).toBe('');
    expect(el.style.getPropertyValue('--nestboard-swatch-ink')).toBe('');
  });

  it('空色板的占位标记也要摘掉', () => {
    const { el } = setup();

    swatchCard.destroy!(el as unknown as HTMLElement);

    expect(el.dataset.placeholder).toBeUndefined();
  });
});
