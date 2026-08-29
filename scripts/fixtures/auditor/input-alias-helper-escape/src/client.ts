const host = input;
escapeInput(host);
export function leakInputAlias() {
  return host;
}
