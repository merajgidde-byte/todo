import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  public state: ErrorBoundaryState = {
    hasError: false,
    errorMessage: '',
  };

  public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error.message || 'An unexpected error occurred.',
    };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('Application ErrorBoundary caught:', error, errorInfo);
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  public render(): ReactNode {
    if (this.state.hasError) {
      const isQuotaError = this.state.errorMessage.includes('Quota exceeded');

      return (
        <div className="flex min-h-dvh items-center justify-center bg-[#f6f7f9] p-4 text-[#0f172a] dark:bg-[#0b1120] dark:text-[#f1f5f9]">
          <div className="w-full max-w-md rounded-[14px] border border-[#dde2ea] bg-white p-6 shadow-sm dark:border-[#233044] dark:bg-[#111827]">
            <h1 className="text-lg font-bold">
              {isQuotaError ? 'Daily Firestore Quota Reached' : 'Something went wrong'}
            </h1>
            <p className="mt-2 text-sm text-[#475569] dark:text-[#cbd5e1]">
              {isQuotaError
                ? 'Your Firestore free-tier daily quota has been exceeded. Quota resets the next day.'
                : 'Taskline encountered an unexpected error while syncing your data.'}
            </p>
            <button
              type="button"
              onClick={this.handleReload}
              className="mt-4 inline-flex min-h-[44px] items-center justify-center rounded-[6px] bg-[#1d4ed8] px-4 py-2 text-sm font-semibold text-white hover:bg-[#1e40af] dark:bg-[#60a5fa] dark:text-[#0b1120] dark:hover:bg-[#93c5fd]"
            >
              Reload Application
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
