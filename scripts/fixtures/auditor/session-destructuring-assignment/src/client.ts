let escaped: unknown;
({ session: escaped } = input.client);
consume(escaped);
