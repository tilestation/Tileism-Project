// Root ESLint config — lets `eslint` run from /app (lint gates, CI) using the
// frontend's flat config with patterns re-rooted to ./frontend.
const frontend = require("./frontend/eslint.config.js");

module.exports = [
  { ignores: ["backend/**", "memory/**", "test_reports/**", "tests/**", "**/node_modules/**", "**/build/**"] },
  ...frontend.map((entry) => ({
    ...entry,
    ...(entry.files ? { files: entry.files.map((f) => `frontend/${f}`) } : {}),
    ...(entry.ignores ? { ignores: entry.ignores.map((i) => `frontend/${i}`) } : {}),
  })),
];
