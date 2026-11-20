import type { RefObject } from 'react';
import { Icon } from './Icon';

type Props = {
  dialogRef: RefObject<HTMLElement | null>;
  onClose: () => void;
};

/** 键盘快捷键说明。焦点陷阱与 Esc 由 useShortcutsDialog 负责；点击背景关闭。 */
export function ShortcutsDialog({ dialogRef, onClose }: Props) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="keys-title"
        className="shortcut-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="section-heading">
          <h2 id="keys-title">手不离琴，也能练习</h2>
          <button autoFocus className="icon-button" onClick={onClose} aria-label="关闭快捷键">
            <Icon name="close" />
          </button>
        </div>
        <dl>
          <div>
            <dt>
              <kbd>Space</kbd>
            </dt>
            <dd>播放 / 暂停</dd>
          </div>
          <div>
            <dt>
              <kbd>←</kbd> <kbd>→</kbd>
            </dt>
            <dd>上一 / 下一小节</dd>
          </div>
          <div>
            <dt>
              <kbd>Home</kbd>
            </dt>
            <dd>回到开头</dd>
          </div>
          <div>
            <dt>
              <kbd>M</kbd>
            </dt>
            <dd>节拍器开关</dd>
          </div>
          <div>
            <dt>
              <kbd>L</kbd>
            </dt>
            <dd>循环开关</dd>
          </div>
          <div>
            <dt>
              <kbd>?</kbd>
            </dt>
            <dd>查看快捷键</dd>
          </div>
        </dl>
        <p>在输入框、选择框或按钮上操作时，不接管按键。</p>
        <button className="button ink full-width" onClick={onClose}>
          回到乐谱
        </button>
      </section>
    </div>
  );
}
