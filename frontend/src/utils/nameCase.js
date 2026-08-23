// Smart case fixer: SHOUTING CAPS -> Title Case, keeps sizes/units lowercase (10MM -> 10mm).
export const smartCase = (name) => {
  if (!name) return name;
  return name
    .split(/\s+/)
    .map((w) => {
      if (w.toLowerCase() === 'x') return 'x';
      if (/\d/.test(w)) return w.toLowerCase();
      if (!/[A-Za-z]/.test(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(' ');
};
