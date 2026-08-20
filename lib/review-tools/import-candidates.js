import fs from 'fs';
import path from 'path';

export const IMPORT_EXTS = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.json',
  '.py', '.pyi', '.go', '.java', '.kt', '.php', '.rs', '.rb', '.cs', '.cpp', '.c', '.h', '.hpp'
];

export function tryFileCandidates(baseNoExt) {
  const hits = [];
  try {
    if (fs.existsSync(baseNoExt) && fs.statSync(baseNoExt).isFile()) hits.push(baseNoExt);
  } catch (e) {
    return hits;
  }
  for (const ext of IMPORT_EXTS) {
    const file = baseNoExt + ext;
    try {
      if (fs.existsSync(file) && fs.statSync(file).isFile()) hits.push(file);
    } catch (e) {
      // ignore
    }
  }
  try {
    if (fs.existsSync(baseNoExt) && fs.statSync(baseNoExt).isDirectory()) {
      for (const name of ['index', 'Index', 'mod']) {
        for (const ext of IMPORT_EXTS) {
          const file = path.join(baseNoExt, `${name}${ext}`);
          if (fs.existsSync(file) && fs.statSync(file).isFile()) hits.push(file);
        }
      }
      const goMain = path.join(baseNoExt, `${path.basename(baseNoExt)}.go`);
      if (fs.existsSync(goMain) && fs.statSync(goMain).isFile()) hits.push(goMain);
    }
  } catch (e) {
    // ignore
  }
  return hits;
}
