export async function sendFixedAgentBusWake(input, hostSessionId, count) {
  await input.client.session.promptAsync({
    path: { id: hostSessionId },
    query: { directory: input.directory },
    body: {
      parts: [
        {
          type: "text",
          text: `Agent Bus has ${count} pending messages. Call agentbus_receive.`,
          synthetic: true,
        },
      ],
    },
  });
}
