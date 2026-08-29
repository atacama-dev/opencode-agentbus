const host = input;
const key = peerControlled;
host.client.session[key]({ body: { parts: [] } });
