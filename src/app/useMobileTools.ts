import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

/** 与 styles 中窄屏断点一致。 */
const COMPACT_QUERY = '(max-width: 999px)';

/** 此刻是否为窄屏布局。异步流程结束时要用它，而不是流程开始那次渲染里的 compactLayout。 */
export const isCompactLayout = () => window.matchMedia(COMPACT_QUERY).matches;

const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], summary, [tabindex="0"]';

/** practice：当前练习；tools：当前练习下方的声音、校对、导出（不展开任何一项）；其余为对应分区并展开。 */
export type ToolsSection = 'practice' | 'tools' | 'review' | 'sound' | 'export';

/** 窄屏面板（.inspector-settings）的 id，供触发按钮的 aria-controls 使用。 */
export const TOOLS_PANEL_ID = 'practice-tools';

/**
 * 窄屏布局下的“练习与工具”底部面板：
 * 跟踪断点、打开时锁定页面滚动并把焦点限制在面板内，关闭后焦点回到打开它的按钮。
 * 宽屏下 openTools 只负责展开对应分区并滚动过去。
 */
export function useMobileTools(reviewRef: RefObject<HTMLDetailsElement | null>) {
  const [mobileToolsOpen, setMobileToolsOpen] = useState(false);
  const [compactLayout, setCompactLayout] = useState(isCompactLayout);
  // openTools 常被长时间的异步流程（识别、打开扫描）在结束时调用，那时它来自较早的渲染；
  // 面板是否打开从这个同步副本读取。
  const openRef = useRef(false);
  openRef.current = mobileToolsOpen;
  const toolsRef = useRef<HTMLDivElement>(null);
  const practiceTriggerRef = useRef<HTMLButtonElement>(null);
  const toolsTriggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const media = window.matchMedia(COMPACT_QUERY);
    const update = () => {
      setCompactLayout(media.matches);
      if (!media.matches) setMobileToolsOpen(false);
    };
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    if (!compactLayout || !mobileToolsOpen) return;
    const panel = toolsRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // 可聚焦元素：可见，且不在已折叠的 <details> 里（折叠分区自身的 summary 除外）。
    const focusable = () =>
      Array.from(panel?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter((element) => {
        if (!element.checkVisibility()) return false;
        for (let ancestor = element.parentElement; ancestor && ancestor !== panel; ancestor = ancestor.parentElement) {
          if (
            ancestor instanceof HTMLDetailsElement &&
            !ancestor.open &&
            ancestor.querySelector(':scope > summary') !== element
          ) {
            return false;
          }
        }
        return true;
      });
    const frame = requestAnimationFrame(() => (focusable()[0] ?? panel)?.focus());
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        setMobileToolsOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) {
        event.preventDefault();
        panel?.focus();
        return;
      }
      if (event.shiftKey && (document.activeElement === first || !panel?.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !panel?.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKey, true);
    return () => {
      cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKey, true);
      toolsTriggerRef.current?.focus({ preventScroll: true });
    };
  }, [compactLayout, mobileToolsOpen]);

  /** 打开（窄屏）或滚动到（宽屏）指定分区，并展开对应的 <details>。 */
  function openTools(section: ToolsSection = 'practice') {
    const compact = isCompactLayout();
    if (!openRef.current) {
      toolsTriggerRef.current =
        document.activeElement instanceof HTMLElement && document.activeElement !== document.body
          ? document.activeElement
          : practiceTriggerRef.current;
    }
    if (section === 'review' && reviewRef.current) reviewRef.current.open = true;
    if (section === 'sound') {
      const target = document.querySelector<HTMLDetailsElement>('.sound-settings');
      if (target) target.open = true;
    }
    if (section === 'export') {
      const target = document.querySelector<HTMLDetailsElement>('.export-settings');
      if (target) target.open = true;
    }
    if (compact) {
      openRef.current = true;
      setMobileToolsOpen(true);
    }
    const id =
      section === 'practice' ? 'current-practice' : section === 'tools' ? 'sound-settings' : section + '-settings';
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const target = document.getElementById(id);
        if (isCompactLayout()) {
          const panel = toolsRef.current;
          if (panel && target) {
            const headerHeight = panel.querySelector('.mobile-tools-header')?.getBoundingClientRect().height ?? 0;
            panel.scrollTop +=
              target.getBoundingClientRect().top - panel.getBoundingClientRect().top - headerHeight - 12;
          }
        } else {
          target?.scrollIntoView({ block: 'start', behavior: 'instant' });
        }
      }),
    );
  }

  /** 窄屏且面板打开时，面板外的区域设为 inert。 */
  const sheetOpen = compactLayout && mobileToolsOpen;

  return {
    compactLayout,
    mobileToolsOpen,
    setMobileToolsOpen,
    sheetOpen,
    toolsRef,
    practiceTriggerRef,
    openTools,
  };
}

export type MobileTools = ReturnType<typeof useMobileTools>;
