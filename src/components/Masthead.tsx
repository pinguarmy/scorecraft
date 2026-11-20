type Props = {
  /** 窄屏工具面板打开时设为 inert。 */
  inert: boolean;
  onToggleShortcuts: () => void;
};

export function Masthead({ inert, onToggleShortcuts }: Props) {
  return (
    <header className="masthead" inert={inert ? true : undefined}>
      <a className="brand" href="#" onClick={(e) => e.preventDefault()} aria-label="谱间 ScoreCraft">
        <span className="brand-seal">谱</span>
        <span className="brand-name">
          谱间<span>ScoreCraft</span>
        </span>
      </a>
      <div className="masthead-note">给每一页谱，留一点练习的时间。</div>
      <div className="masthead-actions">
        <span className="local-badge">
          <i />
          本地工作台
        </span>
        <button className="icon-button" aria-label="键盘快捷键" title="键盘快捷键" onClick={onToggleShortcuts}>
          ?
        </button>
      </div>
    </header>
  );
}
