export function assertionWrappedEscape() {
  return ((input.client as unknown as { session: unknown }).session as unknown as object);
}
