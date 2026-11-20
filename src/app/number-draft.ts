// 数字输入框的草稿规则（速度、循环起止小节）。纯函数，可以在 node 测试中直接调用。
//
// 输入过程中不改写用户正在输入的内容：草稿是完整的范围内整数时立即生效，
// 否则先保留为草稿；失焦或回车时再决定最终值，并说明做了什么调整。

export type NumberRange = { min: number; max: number };

/** 草稿是否可以立即生效：去掉空白后是范围内的整数。不能时返回 null。 */
export function liveNumber(draft: string, { min, max }: NumberRange): number | null {
  const text = draft.trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return value >= min && value <= max ? value : null;
}

/**
 * 失焦或回车时确定最终值：
 * - 范围内整数：照用，没有提示；
 * - 超出范围或带小数的数字：取整并限制在范围内；
 * - 空白或无法识别：恢复为当前值。
 * 后两种情况返回一句提示，告诉用户实际采用的值。
 */
export function settleNumber(draft: string, range: NumberRange, current: number): { value: number; message: string } {
  const live = liveNumber(draft, range);
  if (live !== null) return { value: live, message: '' };
  const hint = `请输入 ${range.min} 至 ${range.max} 的整数`;
  const text = draft.trim();
  const number = text ? Number(text) : NaN;
  if (!Number.isFinite(number)) return { value: current, message: `${hint}，已恢复为 ${current}。` };
  const value = Math.max(range.min, Math.min(range.max, Math.round(number)));
  return { value, message: `${hint}，已改为 ${value}。` };
}
