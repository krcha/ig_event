export { getMaterialState } from './material-background.mjs';
export const DURATION: 18;
export const FPS: 30;
export const READING_START: 2;
export const READING_END: 13.2;
export function getMotionState(scene: unknown, time: number, variant?: number): {
  phase: string; time: number; variant: number; signature: string;
  backgroundScale: number; backgroundRotation: number; ctaProgress: number; ctaOpacity: number;
  rows: Array<{ dx: number; dy: number; textDx: number; textDy: number; textOpacity: number; textScale: number; textRotation: number; timeWidth: number; timeHeight: number; panelPath: string }>;
};
export function drawFrame(context: unknown, scene: unknown, assets: unknown, time: number, variant?: number, options?: {backgroundOnly?: boolean}): ReturnType<typeof getMotionState>;
