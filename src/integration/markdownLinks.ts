/**
 * 让**渲染出来的 Markdown** 里的链接真的能点（白板卡片与脑图节点共用）。
 *
 * ── 为什么必须自己接 ────────────────────────────────────────
 *
 * `MarkdownRenderer.render()` 只负责把 `<a class="internal-link" data-href="…">`
 * **渲染出来**；"点它跳到哪"那一步是**视图**的事 —— 宿主对自定义视图不兜底
 * （与"`⌘Z` 必须自己登记命令"同一条教训，`O25`）。
 * 不接的症状很好认：链接**看着**像链接（有样式、有 `data-href`），点下去什么都不发生。
 *
 * ── 三条规矩 ──────────────────────────────────────────────
 *
 * 1. **内部链接**走 `data-href`（`[[…]]` 里的目标，可能带 `#小节` / `|别名`）交给
 *    `openLinkText` —— 与笔记里点链接同一套解析规则（最短唯一名、别名、大小写）；
 * 2. **开在新标签页**：卡片 / 节点上的链接是"顺路去看看"，把用户正在看的那块板 / 脑图
 *    顶掉是最容易挨骂的那种"功能"（与附件、反链面板同一条取舍）；
 * 3. **其余一概不动**：`#标签`、脚注、嵌入块各有自己的默认行为，抢过来只会更糟。
 */

import type { App } from 'obsidian';

/** 给一块"渲染好的 Markdown"接上链接点击；重复调用只会挂一个监听器 */
export function attachMarkdownLinkHandler(el: HTMLElement, app: App, sourcePath: string): void {
  if (el.dataset.nestboardLinksBound === 'true') return;
  el.dataset.nestboardLinksBound = 'true';

  el.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const internal = target.closest('a.internal-link');
    if (internal instanceof HTMLElement) {
      event.preventDefault();
      // ★ 也要挡住冒泡：卡片 / 节点自己也有点击语义（选中、拖拽），
      //   一次"点链接"不该顺带把宿主那边的事情也办了
      event.stopPropagation();
      const href = internal.getAttribute('data-href') ?? internal.getAttribute('href') ?? '';
      if (href.length > 0) void app.workspace.openLinkText(href, sourcePath, true);
      return;
    }

    const external = target.closest('a.external-link');
    if (external instanceof HTMLAnchorElement) {
      event.preventDefault();
      event.stopPropagation();
      window.open(external.href);
    }
  });
}
