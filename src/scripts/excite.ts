// Shared LiDAR-excite constants — the hero scrubber and the site-wide
// pointer field must stay one instrument: same jitter math, same palette.
export const EXCITE_T_SCALE = 0.02;
export const EXCITE_AMP = 2.4;
export const EXCITE_RGB = {
  light: ['37,99,235', '234,88,12', '5,150,105'], // [ground, structure, vegetation]
  dark: ['147,197,253', '255,236,179', '110,231,183'],
} as const;
