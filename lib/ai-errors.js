export const AI_CONNECTION_FAILED = 'AI_CONNECTION_FAILED';
export const AI_REVIEW_INCOMPLETE = 'AI_REVIEW_INCOMPLETE';
export const AI_API_FAILED = 'AI_API_FAILED';

export function createAiConnectionError(message, cause) {
  const err = new Error(message);
  err.code = AI_CONNECTION_FAILED;
  if (cause) err.cause = cause;
  return err;
}

export function createIncompleteReviewError(message) {
  const err = new Error(message);
  err.code = AI_REVIEW_INCOMPLETE;
  return err;
}

export function createAiApiError(message, cause) {
  const err = new Error(message);
  err.code = AI_API_FAILED;
  if (cause) err.cause = cause;
  return err;
}

export function isAiFatalError(error) {
  const code = error?.code;
  return code === AI_CONNECTION_FAILED || code === AI_REVIEW_INCOMPLETE || code === AI_API_FAILED;
}

export function isAiConnectionError(error) {
  return error?.code === AI_CONNECTION_FAILED;
}

export function isIncompleteReviewError(error) {
  return error?.code === AI_REVIEW_INCOMPLETE;
}

export function isAiApiError(error) {
  return error?.code === AI_API_FAILED;
}

/** HTTP/provider failures that should fail-closed when AI review is enabled. */
export function isAiProviderHttpFailure(error) {
  if (!error) return false;
  const status = Number(error.status || error.statusCode || error.response?.status);
  if (!Number.isFinite(status)) return false;
  if (status === 401 || status === 403 || status === 407) return true;
  if (status === 429) return true;
  if (status >= 500) return true;
  if (status === 404 || status === 400 || status === 422) return true;
  return false;
}
