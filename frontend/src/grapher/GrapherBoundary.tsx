import { Component, type ReactNode } from 'react'
import './grapher.css'

interface Props {
  onClose: () => void
  children: ReactNode
}
interface State {
  hasError: boolean
}

/** Keeps a grapher crash (e.g. a Plotly WebGL error) from white-screening the app. */
export class GrapherBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: unknown) {
    console.error('Grapher error:', error)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="grapher-overlay">
          <div className="grapher-head">
            <span className="grapher-title">Grapher</span>
            <button className="grapher-close" onClick={this.props.onClose}>
              ✕ Close
            </button>
          </div>
          <div style={{ padding: 40, color: '#666' }}>
            Something went wrong rendering that graph. Close this and try a different
            expression.
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
