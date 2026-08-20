import { resolveOptionalPositiveInt } from '../utils/optional-config.js';

export function estimateDiffContentTokens(fileData, tokenRatio = 4) {
  const chars = (fileData?.segments || []).reduce((sum, segment) => {
    return sum + String(segment?.content || '').length;
  }, 0);
  return Math.max(1, Math.ceil(chars / Math.max(1, Number(tokenRatio) || 4)));
}

export function packDiffAiJobs(jobs = [], options = {}) {
  const maxRequestTokens = resolveOptionalPositiveInt(options.maxRequestTokens);
  const maxFilesPerBatch = resolveOptionalPositiveInt(options.maxFilesPerBatch);
  const tokenRatio = Number(options.tokenRatio || 4);
  const preambleReserve = Math.max(800, Number(options.preambleReserve || 2800));
  const budget = maxRequestTokens ? Math.max(800, maxRequestTokens - preambleReserve) : undefined;

  const packs = [];
  let current = [];
  let tokens = 0;

  const flush = () => {
    if (current.length > 0) packs.push(current);
    current = [];
    tokens = 0;
  };

  for (const job of jobs) {
    if (!job?.fileData) continue;
    const cost = estimateDiffContentTokens(job.fileData, tokenRatio);
    const segmentCount = Array.isArray(job.fileData.segments) ? job.fileData.segments.length : 0;
    const alone = Boolean(budget) && (cost >= budget * 0.7 || segmentCount > 8);
    if (alone) {
      flush();
      packs.push([job]);
      continue;
    }
    const exceedFiles = maxFilesPerBatch && current.length >= maxFilesPerBatch;
    const exceedTokens = budget && current.length > 0 && tokens + cost > budget;
    if (exceedFiles || exceedTokens) {
      flush();
    }
    current.push(job);
    tokens += cost;
  }
  flush();
  return packs;
}
