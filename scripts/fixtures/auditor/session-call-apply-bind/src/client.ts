input.client.session.status.call(input.client.session, {});
input.client.session.list.apply(input.client.session, [{}]);
const rebound = input.client.session.status.bind(input.client.session);
rebound({});
