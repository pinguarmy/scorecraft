import React from 'react';

type Props = { children: React.ReactNode };
type State = { error: Error | null };

/** Keeps a render crash from leaving a blank page. Saved scores live in the local
 * library (.data/library); changes not yet written there are backed up in the
 * browser's IndexedDB outbox (see practice/library.ts), so reloading keeps both. */
export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };
  private headingRef = React.createRef<HTMLHeadingElement>();

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    console.error('谱间 渲染出错：', error, info.componentStack);
  }

  componentDidMount() { this.headingRef.current?.focus(); }

  componentDidUpdate(_: Props, previous: State) {
    if (this.state.error && !previous.error) this.headingRef.current?.focus();
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const detail = error.stack?.includes(error.message) ? error.stack : `${error.name}: ${error.message}\n${error.stack ?? ''}`.trim();
    return (
      <main className="error-boundary">
        <div className="error-boundary-card" role="alert">
          <div className="eyebrow">出了点问题</div>
          <h1 ref={this.headingRef} tabIndex={-1}>页面遇到了问题</h1>
          <p>谱间在显示页面时出错了，这一屏没能画出来。</p>
          <p>已经保存的乐谱都在本机谱库里，不会因此丢失。还没来得及保存的更改，会先备份在这个浏览器中，重新载入后可以接着用；只有极少数情况下，最后一步操作可能没有备份上。</p>
          <div className="error-boundary-actions">
            <button type="button" className="button primary" onClick={() => window.location.reload()}>重新载入页面</button>
            <button type="button" className="button quiet" onClick={() => this.setState({ error: null })}>再试一次</button>
          </div>
          <details className="error-boundary-details">
            <summary>错误信息（反馈问题时可附上）</summary>
            <pre>{detail}</pre>
          </details>
        </div>
      </main>
    );
  }
}
