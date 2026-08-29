const wake = Reflect.get(input.client.session, "promptAsync");
wake({ body: { parts: [] } });
