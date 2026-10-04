/** Let the HTTP server negotiate each hop's connection lifetime. */
export function normalizeMcpResponseConnection(response: Response): Response {
  // SDK SSE responses set keep-alive explicitly. A proxy can then reuse a
  // socket whose incoming Connection: close already closed Node's parser.
  response.headers.delete("connection");
  return response;
}
