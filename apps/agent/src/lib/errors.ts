/**
 * Thrown when a request fails because something upstream is unavailable — an LLM
 * provider, the Python service, a network hop — rather than because the caller sent
 * something wrong.
 *
 * Routes map this to HTTP 503 instead of the default 400. The distinction is not
 * cosmetic: when GitHub Models was retired, every chain failed with a 400 "Bad Request",
 * which reads at the browser as "your input was malformed" and sent debugging down the
 * wrong path entirely. A vendor outage is not the caller's fault and must not claim to be.
 *
 * The message here is for the server log only — routes still return a generic string to
 * the client via toSafeError, so nothing internal leaks.
 */
export class UpstreamUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamUnavailableError';
  }
}
