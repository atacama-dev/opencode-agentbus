const host = input;
const get = Reflect.get;
const invoke = get(host.client.session, "promptAsync");
invoke.call(host.client.session, peerControlledOptions);
