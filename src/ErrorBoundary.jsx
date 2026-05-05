import React from 'react';
import { reportError, copyDiagnostics } from './errors.js';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { caught: false, error: null, copying: false, copied: false };
    this._handleCopy = this._handleCopy.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { caught: true, error };
  }

  componentDidCatch(error, info) {
    reportError('DMG-E003', {
      message: error?.message || String(error),
      stack: error?.stack,
      componentStack: info?.componentStack,
    });
  }

  async _handleCopy() {
    this.setState({ copying: true, copied: false });
    try {
      await copyDiagnostics({ errorCode: 'DMG-E003', errorMessage: this.state.error?.message });
      this.setState({ copying: false, copied: true });
      setTimeout(() => this.setState({ copied: false }), 2500);
    } catch {
      this.setState({ copying: false });
    }
  }

  render() {
    if (!this.state.caught) return this.props.children;

    const { error, copying, copied } = this.state;
    return (
      <div className="boot-fatal" role="alert">
        <div className="boot-card">
          <h1>Something went wrong</h1>
          <p>The app hit an unexpected error. Refresh to try again.</p>
          {error?.message && (
            <pre>{String(error.message)}</pre>
          )}
          <p className="boot-sub">
            Error code: DMG-E003. If this keeps happening, try clearing site data or use another browser.
          </p>
          <div style={{ marginTop: '1rem', display: 'flex', gap: '0.625rem', flexWrap: 'wrap' }}>
            <button
              onClick={() => window.location.reload()}
              style={{ padding: '0.5rem 1.25rem', cursor: 'pointer', borderRadius: '6px',
                background: 'var(--brown, #8B4513)', color: '#fff', border: 'none',
                fontWeight: 600, fontSize: '14px' }}
            >
              Refresh page
            </button>
            <button
              onClick={this._handleCopy}
              disabled={copying}
              style={{ padding: '0.5rem 1.25rem', cursor: copying ? 'default' : 'pointer',
                borderRadius: '6px', background: '#f5f0eb',
                color: 'var(--brown, #8B4513)', border: '1px solid #EED9B0',
                fontWeight: 600, fontSize: '14px' }}
            >
              {copied ? 'Copied!' : copying ? 'Copying…' : 'Copy diagnostics'}
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
