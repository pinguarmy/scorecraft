import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

type Options = {
  sheetOpen: boolean;
  setMobileToolsOpen: (open: boolean) => void;
  practiceTriggerRef: RefObject<HTMLButtonElement | null>;
};

/**
 * 键盘快捷键对话框：打开时 Tab 在对话框内循环、Esc 关闭，关闭后焦点回到打开前的元素。
 * 从窄屏工具面板里打开时，先关闭面板，并把焦点归还目标设为“当前练习”按钮。
 */
export function useShortcutsDialog({ sheetOpen, setMobileToolsOpen, practiceTriggerRef }: Options) {
  const [showKeys, setShowKeys] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const shortcutTrigger = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!showKeys) return;
    const before = shortcutTrigger.current;
    function trap(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowKeys(false);
        return;
      }
      if (e.key !== 'Tab') return;
      const buttons = dialogRef.current?.querySelectorAll<HTMLElement>('button, a[href], [tabindex="0"]');
      if (!buttons?.length) return;
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', trap);
    return () => {
      document.removeEventListener('keydown', trap);
      before?.focus();
    };
  }, [showKeys]);

  /** “?” 按钮与“键盘快捷键 ↗”链接：切换对话框。 */
  function toggleKeys() {
    if (!showKeys) {
      shortcutTrigger.current = sheetOpen ? practiceTriggerRef.current : (document.activeElement as HTMLElement | null);
      setMobileToolsOpen(false);
    }
    setShowKeys((v) => !v);
  }

  /** 按 “?” 键打开对话框。 */
  const openFromKeyboard = useCallback(() => {
    shortcutTrigger.current = document.activeElement as HTMLElement | null;
    setShowKeys(true);
  }, []);

  const closeKeys = useCallback(() => setShowKeys(false), []);

  return { showKeys, dialogRef, toggleKeys, openFromKeyboard, closeKeys };
}
