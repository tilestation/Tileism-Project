// Dual-size display: "1000x1000mm (100x100cm)".
// Data stays in mm — this is a render-time helper only.
export const sizeToCm = (size) => {
  if (!size || typeof size !== 'string') return '';
  const m = size.trim().match(/^(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)(?:\s*x\s*(\d+(?:\.\d+)?))?\s*mm$/i);
  if (!m) return '';
  const toCm = (v) => {
    const n = parseFloat(v) / 10;
    return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
  };
  const parts = [toCm(m[1]), toCm(m[2])];
  if (m[3]) parts.push(toCm(m[3]));
  return `${parts.join('x')}cm`;
};

export const formatSizeDual = (size) => {
  const cm = sizeToCm(size);
  return cm ? `${size} (${cm})` : (size || '');
};
