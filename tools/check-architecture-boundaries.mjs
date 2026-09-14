#!/usr/bin/env node
// Prueba básica de arquitectura (AC-03): la UI nunca debe importar directo de infrastructure.
// Uso: node tools/check-architecture-boundaries.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const UI_DIR = 'src/ui';
const FORBIDDEN_PATTERN = /from\s+['"].*\/infrastructure\//;

function walk(dir) {
  const entries = readdirSync(dir);
  const files = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const s = statSync(fullPath);
    if (s.isDirectory()) files.push(...walk(fullPath));
    else if (/\.(ts|tsx)$/.test(entry)) files.push(fullPath);
  }
  return files;
}

const violations = [];
for (const file of walk(UI_DIR)) {
  const content = readFileSync(file, 'utf8');
  const lines = content.split('\n');
  lines.forEach((line, i) => {
    if (FORBIDDEN_PATTERN.test(line)) {
      violations.push(`${file}:${i + 1}: ${line.trim()}`);
    }
  });
}

if (violations.length > 0) {
  console.error('FAIL: UI importa directo de infrastructure, saltándose application:');
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
} else {
  console.log('PASS: ningún archivo en src/ui importa directo de infrastructure.');
  process.exit(0);
}
