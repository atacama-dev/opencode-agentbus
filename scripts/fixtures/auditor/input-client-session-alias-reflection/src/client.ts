const host = input;
const sdk = host.client;
const bus = sdk.session;
const get = Reflect.get;
const invoke = get(bus, "promptAsync");
invoke.call(bus, peerControlledOptions);
