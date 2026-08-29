const get = Reflect.get;
const invoke = get(input.client.session, "promptAsync");
invoke.call(input.client.session, { body: { parts: [] } });
