export const MATERIAL_ARCHETYPES: Readonly<Record<string, number>>;
export function getMaterialArchetype(scene: unknown): number;
export function getMaterialState(scene: unknown, time: number, variant?: number): {
  time: number; variant: number; family: string; signature: string;
  fixedScale: number; rotation: number; maxDisplacement: number; maxBodyDisplacement: number;
  grid: { columns: number; rows: number; triangles: number };
  vertices: Array<{ sourceX: number; sourceY: number; x: number; y: number; dx: number; dy: number; tx: number; ty: number; weight: number; boundary: boolean }>;
  hero: { type: string; progress: number; alpha: number; twist: number; bounds: {left:number;top:number;right:number;bottom:number}; spine: Array<Record<string,number>> };
};
export function drawMaterialBackground(context: unknown, scene: unknown, assets: unknown, time: number, variant?: number): ReturnType<typeof getMaterialState>;
