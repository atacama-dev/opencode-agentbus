const get = Reflect.get;
const session = get(input.client, "session");
escapeSession(session);
