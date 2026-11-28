/**
 * Keeps one view's render error inside that view. React unmounts the subtree
 * of the nearest error boundary when a component throws — and without one
 * that is the root: a single missing helper blanked the whole dashboard for
 * two releases (F3103). Each pane and tab of the shell sits in its own
 * boundary, so the top bar and every other view keep working.
 *
 * A class component on purpose: render-phase error boundaries have no
 * function-component equivalent.
 */

import { Component, type ReactNode } from "react";

interface Props {
  /** Named in the card: "the Insights view crashed". */
  label: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ViewBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="view-error" role="alert">
        <div className="view-error-title">the {this.props.label} view crashed</div>
        <div className="view-error-msg">{this.state.error.message}</div>
        <div className="view-error-actions">
          <span className="dim">The rest of the dashboard keeps working; the server is not affected.</span>
          <button className="banner-btn" onClick={() => this.setState({ error: null })}>
            try again
          </button>
        </div>
      </div>
    );
  }
}
