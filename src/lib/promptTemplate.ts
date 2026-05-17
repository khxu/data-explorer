export function extractPlaceholders(template: string): string[] {
  const placeholders: string[] = [];
  const seen = new Set<string>();
  const regex = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(template)) !== null) {
    const name = match[1];
    if (!seen.has(name)) {
      seen.add(name);
      placeholders.push(name);
    }
  }

  return placeholders;
}

export function unknownPlaceholders(template: string, columns: string[]): string[] {
  const available = new Set(columns);
  return extractPlaceholders(template).filter((name) => !available.has(name));
}
