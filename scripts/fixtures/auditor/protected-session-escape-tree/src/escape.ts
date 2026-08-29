const get = Reflect.get;
export const invoke = get(input.client.session, "promptAsync");
