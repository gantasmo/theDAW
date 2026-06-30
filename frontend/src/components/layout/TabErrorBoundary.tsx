import React from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface TabErrorBoundaryProps {
  tabName: string;
  children: React.ReactNode;
}

interface TabErrorBoundaryState {
  error: Error | null;
}

export class TabErrorBoundary extends React.Component<TabErrorBoundaryProps, TabErrorBoundaryState> {
  state: TabErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): TabErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[${this.props.tabName}] tab crashed`, error, info.componentStack);
  }

  componentDidUpdate(prevProps: TabErrorBoundaryProps) {
    if (prevProps.tabName !== this.props.tabName && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="absolute inset-0 grid place-items-center bg-[#09070d]">
        <div className="w-[min(520px,90%)] rounded border border-red-400/20 bg-red-500/10 p-4 shadow-xl">
          <div className="flex items-center gap-2 text-red-100">
            <AlertTriangle className="w-4 h-4 text-red-300 shrink-0" />
            <span className="text-[11px] font-black uppercase tracking-widest">
              {this.props.tabName} stopped
            </span>
          </div>
          <div className="mt-2 rounded bg-black/25 px-2 py-1.5 text-[9px] font-mono text-red-100/80 break-words">
            {this.state.error.message || 'Unknown error'}
          </div>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="mt-3 h-8 px-3 inline-flex items-center gap-1.5 rounded border border-white/10 bg-black/20 text-[9px] font-bold uppercase tracking-wider text-zinc-200 hover:bg-white/10"
          >
            <RotateCcw className="w-3 h-3" />
            Retry
          </button>
        </div>
      </div>
    );
  }
}
