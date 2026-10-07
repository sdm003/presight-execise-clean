import React, { Component } from "react";

export default class ErrorBoundary extends Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    console.error("Directory UI failed to render.");
  }

  render() {
    return this.state.failed ? (
      <main className="message error" role="alert">
        <h1>The directory couldn't be displayed.</h1>
        <p>Please try again. If the problem persists, reload the page.</p>
        <button onClick={() => this.setState({ failed: false })}>
          Try again
        </button>
      </main>
    ) : (
      this.props.children
    );
  }
}
