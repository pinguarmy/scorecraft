import { useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { liveNumber, settleNumber } from './number-draft';

// 指针是否按下。提示行会把下面的控件往下推；如果在按下与松开之间插入它，
// 松开时指针已经不在原来的按钮上，这次点击就丢了。所以按下期间先不显示提示。
let pointerDown = false;
if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', () => (pointerDown = true), true);
  window.addEventListener('pointerup', () => (pointerDown = false), true);
  window.addEventListener('pointercancel', () => (pointerDown = false), true);
}

/** 现在显示提示；指针按下时等松开并且这次点击处理完之后再显示。 */
function showWhenPointerReleased(show: () => void) {
  if (!pointerDown) {
    show();
    return;
  }
  const later = () => {
    window.removeEventListener('pointerup', later, true);
    window.removeEventListener('pointercancel', later, true);
    window.setTimeout(show, 0);
  };
  window.addEventListener('pointerup', later, true);
  window.addEventListener('pointercancel', later, true);
}

type Options = {
  /** 当前生效的值。 */
  value: number;
  min: number;
  max: number;
  onCommit: (value: number) => void;
  /** 变化时（例如切换乐谱）清除提示并显示当前值。 */
  resetKey?: unknown;
};

/**
 * 数字输入框：与“跳到小节”一样保留草稿并显示提示。
 * 输入中的完整合法值立即生效；其他内容等到失焦或回车时再确定（见 number-draft.ts）。
 * 没有正在编辑的内容时，输入框跟随外部变化（快捷速度、拖动滑块、切换乐谱）。
 *
 * edited 表示用户改过草稿、还没有确定。只有这时失焦或回车才会提交草稿；否则只是把
 * 输入框恢复为当前值。草稿可能落后于外部变化，不能当作用户的输入去覆盖较新的值。
 *
 * 草稿与外部值的同步都在渲染期间完成，不放在 effect 里：effect 晚于渲染执行，
 * 用户恰好在这之间输入时，刚输入的内容会被迟到的同步盖掉，随后又被当成输入提交。
 */
export function useNumberField({ value, min, max, onCommit, resetKey }: Options) {
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState('');
  const [edited, setEdited] = useState(false);
  const [syncedKey, setSyncedKey] = useState(resetKey);
  const [syncedValue, setSyncedValue] = useState(value);

  if (syncedKey !== resetKey) {
    setSyncedKey(resetKey);
    setSyncedValue(value);
    setDraft(String(value));
    setError('');
    setEdited(false);
  } else if (syncedValue !== value) {
    setSyncedValue(value);
    if (!edited) setDraft(String(value));
  }

  function change(next: string) {
    setEdited(true);
    setDraft(next);
    setError('');
    const live = liveNumber(next, { min, max });
    if (live !== null && live !== value) onCommit(live);
  }

  function settle() {
    if (!edited) {
      setDraft(String(value));
      return;
    }
    setEdited(false);
    const result = settleNumber(draft, { min, max }, value);
    setDraft(String(result.value));
    if (result.message) showWhenPointerReleased(() => setError(result.message));
    else setError('');
    if (result.value !== value) onCommit(result.value);
  }

  return {
    draft,
    error,
    inputProps: {
      value: draft,
      'aria-invalid': error ? true : undefined,
      onChange: (event: ChangeEvent<HTMLInputElement>) => change(event.target.value),
      onBlur: settle,
      onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          settle();
        }
      },
    },
  };
}

export type NumberField = ReturnType<typeof useNumberField>;
