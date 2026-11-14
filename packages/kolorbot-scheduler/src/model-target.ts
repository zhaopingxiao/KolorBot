/** Base URL (or `/chat/completions` URL) plus the model and key to use. */
export interface ModelTarget {
  apiUrl: string;
  apiModelName: string;
  apiKey: string;
}
