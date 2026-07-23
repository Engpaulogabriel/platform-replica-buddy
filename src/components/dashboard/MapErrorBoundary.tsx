import React from "react";

interface MapErrorBoundaryProps {
  children: React.ReactNode;
}

interface MapErrorBoundaryState {
  hasError: boolean;
}

export class MapErrorBoundary extends React.Component<MapErrorBoundaryProps, MapErrorBoundaryState> {
  state: MapErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): MapErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    console.error("Map render error:", error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-[450px] rounded-lg border border-border bg-card flex items-center justify-center text-sm text-muted-foreground">
          Não foi possível carregar o mapa agora.
        </div>
      );
    }

    return this.props.children;
  }
}
