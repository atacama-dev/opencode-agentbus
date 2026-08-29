export class AgentBusWakeCoordinator {
  constructor(input, resolveDirectory) {
    this.input = input;
    this.resolveDirectory = resolveDirectory;
  }

  async resolveInitialActivity(hostSessionId) {
    const directory = this.resolveDirectory(hostSessionId);
    if (directory === undefined) return;
    const response = await this.input.client.session.status({
      query: { directory: directory },
    });
    return response.data;
  }
}
