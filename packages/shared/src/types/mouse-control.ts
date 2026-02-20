export interface MouseMovePayload {
  x: number;
  y: number;
}

export type MouseButton = 'left' | 'right' | 'middle';

export interface MouseClickPayload {
  button: MouseButton;
}

