import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { liveNumber, settleNumber } from './number-draft';

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
 * 未聚焦时跟随外部变化（快捷速度、拖动滑块、切换乐谱）。
 */
export function useNumberField({ value, min, max, onCommit, resetKey }: Options) {
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState('');
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setDraft(String(value));
  }, [value]);
  useEffect(() => {
    setDraft(String(value));
    setError('');
    // 只在 resetKey 变化时执行。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  function change(next: string) {
    setDraft(next);
    setError('');
    const live = liveNumber(next, { min, max });
    if (live !== null && live !== value) onCommit(live);
  }

  function settle() {
    const result = settleNumber(draft, { min, max }, value);
    setDraft(String(result.value));
    setError(result.message);
    if (result.value !== value) onCommit(result.value);
  }

  return {
    draft,
    error,
    inputProps: {
      value: draft,
      'aria-invalid': error ? true : undefined,
      onChange: (event: ChangeEvent<HTMLInputElement>) => change(event.target.value),
      onFocus: () => {
        focused.current = true;
      },
      onBlur: () => {
        focused.current = false;
        settle();
      },
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
