/** Message to show for a failed request; falls back to a short, specific hint. */
export function errorMessage(error: unknown, fallback = 'Something went wrong. Try again.') {
  return error instanceof Error && error.message ? error.message : fallback;
}
