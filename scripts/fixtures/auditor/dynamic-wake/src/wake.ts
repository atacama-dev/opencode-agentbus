export async function sendFixedAgentBusWake(input, hostSessionId, peer) {
  await input.client.session.promptAsync({
    path: { id: hostSessionId },
    query: { directory: input.directory },
    body: { parts: [{ type: "text", text: peer.body, synthetic: true }] },
  });
}
