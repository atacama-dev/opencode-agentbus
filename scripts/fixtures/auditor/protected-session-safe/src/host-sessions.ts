export async function listHostSessionRegistrations(input) {
  const response = await input.client.session.list({
    query: { directory: input.directory },
  });
  return response.data;
}

export async function resolveForegroundHostSession(input, context) {
  const sessions = await input.client.session.list({
    query: { directory: context.directory },
  });
  const project = await input.client.project.current({
    query: { directory: context.directory },
  });
  return { project, sessions };
}
