const key = peerControlled;
export const part = { [key]: true };
const { [key]: extracted } = peerObject;
consume(extracted);
