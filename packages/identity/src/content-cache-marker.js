const validated = new WeakSet();

/** Marks a payload that validateContentPayload produced or that the room write
 * path validated (including a Durable Object buffered update). A WeakSet never
 * changes the object's own properties, so JSON encoding and structuredClone
 * stay exactly as before; a clone is a different object and is never trusted. */
export function markValidatedPayload(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) validated.add(value);
  return value;
}

export function isValidatedPayload(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && validated.has(value));
}
