const descriptor = Object.getOwnPropertyDescriptor(
  input.client.session as unknown as object,
  "promptAsync",
);
descriptor?.value.call(input.client.session, { body: { parts: [] } });
