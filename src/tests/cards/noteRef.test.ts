/**
 * 引用卡的卡内轻量编辑（T2.01 / `F2-2-3`）。
 *
 * 这里钉的不是"编辑器能不能打字"（那是 `MiniMarkdownEditor.test.ts` 的事），
 * 而是**写回这一步的安全性** —— 它是目前唯一会去改用户**已有笔记**的动作：
 *
 *  1. 必须以"进入编辑时读到的那一版"为基准做 CAS，而不是拿新内容直接盖上去；
 *  2. 冲突 / 文件消失 / 写入失败时，用户写过的字**一个都不能丢**；
 *  3. 那条"没写进去"的提示必须给得出一个出口，否则就成了死结。
 *
 * 单测跑在 node 环境（无 DOM），假节点见 `helpers/fakeDom.ts`。
 */

import { describe, expect, it, vi, type Mock } from 'vitest';
import type { App, Component } from 'obsidian';
import { noteRefCard } from '../../cards/noteRef';
import type { CardRenderContext, NoteWriteResult, VaultBridge } from '../../cards/registry';
import { createCard } from '../../model/factories';
import type { CardOfType } from '../../model/schema';
import { t } from '../../util/i18n';
import {
  createFakeDocument,
  createFakeElement,
  createKeyEvent,
  type FakeElement,
  type FakeTextarea,
} from '../helpers/fakeDom';

const PATH = '资料/项目笔记.md';
const DISK = '原文';

/** 让链式 `then` 跑完（`read()` 是异步的，编辑器要等它回来才挂） */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface Setup {
  el: FakeElement;
  ctx: CardRenderContext;
  card: CardOfType<'noteRef'>;
  writeIfUnchanged: Mock;
  setMode: Mock;
}

function setup(options: { disk?: string; write?: NoteWriteResult } = {}): Setup {
  const disk = options.disk ?? DISK;
  const writeIfUnchanged = vi.fn(async () => options.write ?? 'written');
  // `exists` 必须给：断链判定在编辑态之前就跑，缺了它假桥接会当场抛错
  const notes = {
    exists: () => true,
    read: async () => disk,
    writeIfUnchanged,
  } as unknown as VaultBridge;
  const setMode = vi.fn();
  const ctx: CardRenderContext = {
    app: {} as unknown as App,
    sourcePath: '',
    component: {} as unknown as Component,
    renderMarkdown: async () => {},
    zoom: 1,
    mode: 'edit',
    updateContent: () => {},
    updateCard: () => {},
    setMode,
    contentReady: () => {},
    notes,
  };
  return {
    el: createFakeElement(createFakeDocument()),
    ctx,
    card: createCard('noteRef', {
      content: { path: PATH, subpath: null, mode: 'summary', excerptLines: 6 },
    }),
    writeIfUnchanged,
    setMode,
  };
}

/** 内容槽 → 布局盒 → 编辑器宿主 → textarea（有提示条时宿主排在它后面） */
function textareaOf(el: FakeElement): FakeTextarea {
  const box = el.children[0] as FakeElement;
  const host = box.children[box.children.length - 1] as FakeElement;
  const textarea = host.children[0] as FakeTextarea;
  textarea.focus();
  return textarea;
}

/** 草稿提示条；没有草稿时不存在 */
function conflictBarOf(el: FakeElement): FakeElement | null {
  const box = el.children[0] as FakeElement;
  const first = box.children[0] as FakeElement;
  return first.className === 'nestboard-note-ref-conflict' ? first : null;
}

function render(setup_: Setup): void {
  noteRefCard.render(setup_.el as unknown as HTMLElement, setup_.card, setup_.ctx);
}

/** 改掉正文后按 ⌘Enter 提交，并等异步写回跑完 */
async function submit(el: FakeElement, value: string): Promise<void> {
  const textarea = textareaOf(el);
  textarea.value = value;
  textarea.emit('keydown', createKeyEvent({ key: 'Enter', metaKey: true }));
  await flush();
}

describe('引用卡内联编辑：写回（T2.01）', () => {
  it('编辑态：读到源笔记后把正文交给轻量编辑器', async () => {
    const s = setup({ disk: '源正文' });
    render(s);
    await flush();

    const textarea = textareaOf(s.el);
    expect(textarea.className).toBe('nestboard-mde-input');
    expect(textarea.value).toBe('源正文');
    expect(textarea.focused).toBe(true);
  });

  it('提交时以"进入编辑时读到的那一版"为基准做 CAS，而不是直接覆盖', async () => {
    const s = setup({ disk: DISK });
    render(s);
    await flush();

    await submit(s.el, '改过了');

    expect(s.writeIfUnchanged).toHaveBeenCalledWith(PATH, DISK, '改过了');
  });

  it('写成功：只退回显示态，不再要回编辑态', async () => {
    const s = setup({ disk: DISK });
    render(s);
    await flush();
    await submit(s.el, '改过了');

    expect(s.setMode).toHaveBeenCalledWith('display');
    expect(s.setMode).not.toHaveBeenCalledWith('edit');
  });
});

describe('引用卡内联编辑：草稿保护（T2.01）', () => {
  it('冲突：一个字都没写，而是把草稿留下并重开编辑态', async () => {
    const s = setup({ write: 'conflict' });
    render(s);
    await flush();
    await submit(s.el, '我写的');

    // 编辑器自己按约定退回显示态，随后由失败的写回分支重新要回编辑态
    expect(s.setMode).toHaveBeenCalledWith('display');
    expect(s.setMode).toHaveBeenCalledWith('edit');
  });

  it('重开编辑态时：提示条 + 用户写的草稿一起还回来', async () => {
    const s = setup({ write: 'conflict' });
    render(s);
    await flush();
    await submit(s.el, '我写的');

    // 模拟视图在 `setMode('edit')` 之后重画同一个槽位
    render(s);
    await flush();

    const bar = conflictBarOf(s.el);
    expect(bar).not.toBeNull();
    expect((bar?.children[0] as FakeElement).textContent).toBe(t('card.noteRef.conflict'));
    // ★ 关键断言：用户打的字还在，而不是被磁盘上的旧内容顶掉
    expect(textareaOf(s.el).value).toBe('我写的');
  });

  it('写入失败：同样留下草稿（失败原因不影响"不丢字"这条底线）', async () => {
    const s = setup({ write: 'failed' });
    render(s);
    await flush();
    await submit(s.el, '我写的');
    render(s);
    await flush();

    expect((conflictBarOf(s.el)?.children[0] as FakeElement).textContent).toBe(
      t('card.noteRef.writeFailed'),
    );
    expect(textareaOf(s.el).value).toBe('我写的');
  });

  it('源笔记已不存在：措辞换成"文件没了"，草稿照留', async () => {
    const s = setup({ write: 'missing' });
    render(s);
    await flush();
    await submit(s.el, '我写的');
    render(s);
    await flush();

    expect((conflictBarOf(s.el)?.children[0] as FakeElement).textContent).toBe(
      t('card.noteRef.writeMissing'),
    );
    expect(textareaOf(s.el).value).toBe('我写的');
  });

  it('点「丢弃」：提示条消失，编辑器回到磁盘上的内容', async () => {
    const s = setup({ write: 'conflict' });
    render(s);
    await flush();
    await submit(s.el, '我写的');
    render(s);
    await flush();

    const discard = conflictBarOf(s.el)?.children[1] as FakeElement;
    expect(discard.textContent).toBe(t('card.noteRef.discard'));
    discard.emit('click', { stopPropagation: () => {} });

    expect(conflictBarOf(s.el)).toBeNull();
    expect(textareaOf(s.el).value).toBe(DISK);
  });

  it('写成功之后草稿被清掉：下一次编辑不再翻出旧草稿', async () => {
    const s = setup({ write: 'conflict' });
    render(s);
    await flush();
    await submit(s.el, '我写的');

    // 让同一张卡的下一次写回成功
    s.writeIfUnchanged.mockResolvedValue('written');
    render(s);
    await flush();
    await submit(s.el, '最终版');
    render(s);
    await flush();

    expect(conflictBarOf(s.el)).toBeNull();
    expect(textareaOf(s.el).value).toBe(DISK);
  });
});
