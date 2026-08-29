const host = input;
const { client: sdk } = host;
const { session: bus } = sdk;
escapeSession(bus);
