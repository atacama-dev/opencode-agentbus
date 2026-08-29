const key = peerControlled;
const { [key]: invoke } = input.client.session as unknown as Record<string, unknown>;
invoke.call(undefined, { body: { parts: [] } });
