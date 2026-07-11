import { Component, ErrorInfo, ReactNode } from 'react';

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}



export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return {
      hasError: true,
      error,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Error caught by ErrorBoundary:', error, errorInfo);

    this.setState({
      error,
      errorInfo,
    });
  }

  handleReset = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="death-screen min-h-screen overflow-hidden flex items-center justify-center p-4 sm:p-8 font-mono text-white">
          <div className="death-tear" aria-hidden="true" />

          <div className="relative z-10 w-full max-w-2xl space-y-6 sm:space-y-8">
            <div className="text-center space-y-4">
              <span className="inline-block bg-[#aaaaaa] px-3 py-1 text-xs sm:text-sm font-bold tracking-[0.3em] text-[#0000aa] uppercase">
                Din &mdash; System Fault
              </span>
              <h1
                className="death-glitch text-4xl sm:text-6xl font-bold tracking-tight uppercase"
                data-text="Fatal Exception"
              >
                Fatal Exception
              </h1>
              <p className="text-base sm:text-lg text-white/90 text-balance">
                A problem has been detected and Din has been halted to prevent
                damage to your session.
              </p>
            </div>

            <div
              role="alert"
              className="bg-white text-[#0000aa] px-4 py-3 sm:px-6 sm:py-4 text-base sm:text-lg font-bold break-words shadow-[6px_6px_0_rgba(0,0,0,0.45)]"
            >
              <span aria-hidden="true">*** STOP: </span>
              {this.state.error?.message || 'Unknown error'}
            </div>

            {this.state.error?.stack && (
              <details className="border border-white/40 bg-black/30">
                <summary className="cursor-pointer select-none px-4 py-3 text-sm font-bold tracking-widest uppercase hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">
                  &gt; Stack trace
                </summary>
                <pre className="px-4 pb-4 text-xs leading-relaxed text-white/80 overflow-auto max-h-48 whitespace-pre-wrap">
                  {this.state.error.stack}
                </pre>
              </details>
            )}

            <div className="flex flex-col sm:flex-row gap-3 sm:gap-4">
              <button
                onClick={this.handleReset}
                className="flex-1 border-2 border-white bg-white px-4 py-3 font-bold tracking-widest uppercase text-[#0000aa] transition-colors hover:bg-transparent hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
              >
                [ Try again ]
              </button>
              <button
                onClick={() => window.location.reload()}
                className="flex-1 border-2 border-white px-4 py-3 font-bold tracking-widest uppercase text-white transition-colors hover:bg-white hover:text-[#0000aa] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
              >
                [ Reboot ]
              </button>
            </div>

            <p className="text-center text-sm text-white/70">
              Press TRY AGAIN to return to Din, or REBOOT to restart
              <span className="death-cursor" aria-hidden="true">_</span>
            </p>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}